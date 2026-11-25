// Code that manages data persistance useing sqlite

//  tables:
//	- devices: keyed by id, contains device data as well as last seen info. this table updates everytime a device connects.
//	- readings: keyed by id and timestamp, one row for every successfull poll of a device, contains following data:
 
//	            current_a            current/load current
//	            voltage_v            voltage/primary voltage
//	            phase_deg            phase
//	            secondary_voltage_v  secondary_voltage
//	            state                open/closed


// polled readings written by one goroutine using a queue, so that polling interactions don't wait on table writes.

package main

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"
	_ "modernc.org/sqlite" // library used for sqlite
)

const (
	queueSize     = 8192        // readings waiting to be written
	batchSize     = 500         // writes as soon as this many are waiting
	flushInterval = time.Second // writes after this time limit
)

// table creations (can repeat)
var schema = []string{
	`CREATE TABLE IF NOT EXISTS devices (
		id         TEXT PRIMARY KEY,
		type       TEXT NOT NULL,
		addr       TEXT NOT NULL,
		lat        REAL NOT NULL,
		lon        REAL NOT NULL,
		first_seen INTEGER NOT NULL,
		last_seen  INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS readings (
		device_id           TEXT NOT NULL REFERENCES devices(id),
		ts                  INTEGER NOT NULL,
		current_a           REAL,
		voltage_v           REAL,
		phase_deg           REAL,
		secondary_voltage_v REAL,
		state               TEXT,
		PRIMARY KEY (device_id, ts)
	) WITHOUT ROWID`,
}

const upsertDevice = `
INSERT INTO devices (id, type, addr, lat, lon, first_seen, last_seen)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	type      = excluded.type,
	addr      = excluded.addr,
	lat       = excluded.lat,
	lon       = excluded.lon,
	last_seen = excluded.last_seen`

// second readings for the same device in the same millisecond is dropped
const insertReading = `
INSERT OR IGNORE INTO readings
	(device_id, ts, current_a, voltage_v, phase_deg, secondary_voltage_v, state)
VALUES (?, ?, ?, ?, ?, ?, ?)`

// errUnknownDevice is returned for unknown id
var errUnknownDevice = errors.New("unknown device")

// readingRow is one reading as it is stored.
type readingRow struct {
	DeviceID         string
	TS               int64 // UTC
	Current          sql.NullFloat64
	Voltage          sql.NullFloat64
	Phase            sql.NullFloat64
	SecondaryVoltage sql.NullFloat64
	State            sql.NullString
}

// store is the open database and background writer
type store struct {
	db      *sql.DB
	queue   chan readingRow
	done    chan struct{} // closed when the writer has finished
	dropped atomic.Int64  // readings dropped because the queue was full
	out     *printer
}

// openStore opens (creating if needed) the database file, creates the tables, and starts the background writer
func openStore(path string, out *printer) (*store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}

	// Settings for every connection: wait up to 5 s if the file is busy, use the write-ahead log, relax fsync
	dsn := path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)" +
		"&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite allows one writer at a time, so we have the single connection allow one caller at a time
	db.SetMaxOpenConns(1)

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	for _, stmt := range schema {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return nil, fmt.Errorf("create schema: %w", err)
		}
	}

	s := &store{
		db:    db,
		queue: make(chan readingRow, queueSize),
		done:  make(chan struct{}),
		out:   out,
	}
	go s.writer()
	return s, nil
}

// saveDevice records a device that has just connected, adds/updates row in devices table. writes to devices table right away (only activated on device connect).
func (s *store) saveDevice(info deviceInfo, addr string, seen time.Time) error {
	ms := seen.UnixMilli()
	_, err := s.db.Exec(upsertDevice, info.ID, info.Kind.Name, addr, info.Lat, info.Lon, ms, ms)
	return err
}

// saveReading queues poll results waiting to be written, increments dropped count if queue is full
func (s *store) saveReading(r reading) {
	select {
	case s.queue <- newRow(r):
	default:
		s.dropped.Add(1)
	}
}

// close writes out everything still queued and closes the db, is called once all savereading routines are finished
func (s *store) close() {
	close(s.queue)
	<-s.done
	if err := s.db.Close(); err != nil {
		s.out.printf("[db] close: %v\n", err)
	}
}

// column returns the column that holds a measurement, by the label the devicekind gives. this si where we match columns to the device label
func (r *readingRow) column(label string) *sql.NullFloat64 {
	switch label {
	case "current", "load_current":
		return &r.Current
	case "voltage", "primary_voltage":
		return &r.Voltage
	case "phase":
		return &r.Phase
	case "secondary_voltage":
		return &r.SecondaryVoltage
	}
	return nil
}

// value returns the measurement for a given label.
func (r *readingRow) value(label string) (float64, bool) {
	if c := r.column(label); c != nil && c.Valid {
		return c.Float64, true
	}
	return 0, false
}

// the history function returns the last set number of entries for a specific device. the limit is currently set to 500 entries returned.
func (s *store) history(id string, limit int) (string, []readingRow, error) {
	var kind string
	err := s.db.QueryRow(`SELECT type FROM devices WHERE id = ?`, id).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, errUnknownDevice
	}
	if err != nil {
		return "", nil, err
	}

	// sort by newest first so limit keeps the latest rows, we reverse later
	rs, err := s.db.Query(`
		SELECT ts, current_a, voltage_v, phase_deg, secondary_voltage_v, state
		FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT ?`, id, limit)
	if err != nil {
		return "", nil, err
	}
	defer rs.Close()

	rows := make([]readingRow, 0, limit)
	for rs.Next() {
		r := readingRow{DeviceID: id}
		if err := rs.Scan(&r.TS, &r.Current, &r.Voltage, &r.Phase, &r.SecondaryVoltage, &r.State); err != nil {
			return "", nil, err
		}
		rows = append(rows, r)
	}
	if err := rs.Err(); err != nil {
		return "", nil, err
	}
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	return kind, rows, nil
}

// newRow converts results from poll into row data for the db
func newRow(r reading) readingRow {
	row := readingRow{DeviceID: r.Info.ID, TS: r.Time.UnixMilli()}

	for i, v := range r.Values {
		if i >= len(r.Info.Kind.Labels) {
			break
		}
		if c := row.column(r.Info.Kind.Labels[i]); c != nil {
			*c = sql.NullFloat64{Float64: cleanFloat(v), Valid: true}
		}
	}
	if r.State != "" {
		row.State = sql.NullString{String: r.State, Valid: true}
	}
	return row
}

// cleanFloat widens a float32 to float64 without adding extra decimal digits.
func cleanFloat(v float32) float64 {
	f, err := strconv.ParseFloat(strconv.FormatFloat(float64(v), 'g', -1, 32), 64)
	if err != nil {
		return float64(v)
	}
	return f
}

// writer collects readings in the queue and writes them in batches until the queue is closed, then it just writes what is left
func (s *store) writer() {
	defer close(s.done)

	batch := make([]readingRow, 0, batchSize)
	tick := time.NewTicker(flushInterval)
	defer tick.Stop()

	for {
		select {
		case row, ok := <-s.queue:
			if !ok {
				s.flush(batch)
				return
			}
			batch = append(batch, row)
			if len(batch) >= batchSize {
				s.flush(batch)
				batch = batch[:0]
			}
		case <-tick.C:
			s.flush(batch)
			batch = batch[:0]
		}
	}
}

// flush writes a batch in one transaction, doesnt stop if a failure occurs, just prints a notify
func (s *store) flush(rows []readingRow) {
	if n := s.dropped.Swap(0); n > 0 {
		s.out.printf("[db] write queue full, dropped %d readings\n", n)
	}
	if len(rows) == 0 {
		return
	}

	tx, err := s.db.Begin()
	if err != nil {
		s.out.printf("[db] begin: %v (%d readings lost)\n", err, len(rows))
		return
	}
	stmt, err := tx.Prepare(insertReading)
	if err != nil {
		tx.Rollback()
		s.out.printf("[db] prepare: %v (%d readings lost)\n", err, len(rows))
		return
	}

	failed := 0
	var firstErr error
	for _, r := range rows {
		_, err := stmt.Exec(r.DeviceID, r.TS, r.Current, r.Voltage, r.Phase, r.SecondaryVoltage, r.State)
		if err != nil {
			failed++
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	stmt.Close()

	if err := tx.Commit(); err != nil {
		s.out.printf("db: %v (%d readings lost)\n", err, len(rows))
		return
	}
	if failed > 0 {
		s.out.printf("db: %d of %d readings not saved: %v\n", failed, len(rows), firstErr)
	}
}