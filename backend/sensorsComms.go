// this file contains everything that communicates with the individual sensors

package main

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"
	"github.com/simonvetter/modbus" // library for modbus operations
)

const (
	maxBackoff = 10 * time.Second

	// input register map
	regMeasure    = 0  // first measurement or ACR state
	regDeviceType = 10 // uint16
	regLat        = 11 // float32
	regLon        = 13 // float32
	regID         = 20 
	idBytes       = 32 // 16 registers = 32 bytes

	coilRecloser = 0 // true to close, false to open
)

// describes what different devices report
type deviceKind struct {
	Name     string
	Labels   []string // one float32 measurement each
	Units    []string
	Recloser bool // reports a state register instead of measurements
}

// maps the device type to its description
var kinds = map[uint16]deviceKind{
	1: {
		Name:   "linepost",
		Labels: []string{"current", "voltage", "phase"},
		Units:  []string{"A", "V", "deg"},
	},
	2: {
		Name:   "transformer",
		Labels: []string{"load_current", "primary_voltage", "secondary_voltage"},
		Units:  []string{"A", "V", "V"},
	},
	3: {
		Name:     "acr",
		Recloser: true,
	},
}

// self reported data from a device
type deviceInfo struct {
	ID       string
	Kind     deviceKind
	Lat, Lon float64
}

// opens a modbus tcp connection to a device
func connect(addr string, timeout time.Duration) (*modbus.ModbusClient, error) {
	c, err := modbus.NewClient(&modbus.ClientConfiguration{URL: "tcp://" + addr, Timeout: timeout})
	if err != nil {
		return nil, err
	}
	c.SetEncoding(modbus.BIG_ENDIAN, modbus.HIGH_WORD_FIRST)
	if err := c.Open(); err != nil {
		return nil, err
	}
	return c, nil
}

// rounds to 5 decimal places for lat and lon
func round5(x float64) float64 {
	return math.Round(x*1e5) / 1e5
}

//reads the device's static id registers
func readInfo(c *modbus.ModbusClient) (deviceInfo, error) {
	var info deviceInfo

	code, err := c.ReadRegister(regDeviceType, modbus.INPUT_REGISTER)
	if err != nil {
		return info, err
	}
	lat, err := c.ReadFloat32(regLat, modbus.INPUT_REGISTER)
	if err != nil {
		return info, err
	}
	lon, err := c.ReadFloat32(regLon, modbus.INPUT_REGISTER)
	if err != nil {
		return info, err
	}
	raw, err := c.ReadBytes(regID, idBytes, modbus.INPUT_REGISTER)
	if err != nil {
		return info, err
	}

	kind, ok := kinds[code]
	if !ok {
		return info, fmt.Errorf("unsupported device type code %d", code)
	}

	info.Kind = kind
	info.Lat, info.Lon = round5(float64(lat)), round5(float64(lon))
	info.ID = strings.TrimRight(string(raw), "\x00 ")
	return info, nil
}

// keeps one device connected and polled until ctx is cancelled
func pollDevice(ctx context.Context, d *device, reg *registry, db *store, interval, timeout time.Duration, out *printer) {
	backoff := time.Second

	for ctx.Err() == nil {
		c, err := connect(d.addr, timeout)
		var info deviceInfo
		if err == nil {
			info, err = readInfo(c)
			if err != nil {
				c.Close()
			} else if err = reg.bind(info.ID, d); err != nil {
				c.Close()
			}
		}
		if err != nil {
			out.printf("[!] %s: %v, retrying in %s\n", d.addr, err, backoff)
			if !sleep(ctx, backoff) {
				return
			}
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
			continue
		}
		backoff = time.Second

		// The device row needs to exist before any of its readings are saved
		if err := db.saveDevice(info, d.addr, time.Now()); err != nil {
			out.printf("[db] %s: could not save device: %v\n", info.ID, err)
		}

		d.setConnected(true)
		out.printf("[+] %s connected: %s (%s) at (%.5f, %.5f)\n", d.addr, info.ID, info.Kind.Name, info.Lat, info.Lon)

		err = pollLoop(ctx, c, info, d, db, interval)
		c.Close()
		d.setConnected(false)
		if ctx.Err() != nil {
			return
		}
		out.printf("[-] %s (%s): %v, reconnecting\n", info.ID, d.addr, err)
	}
}

// converts the ACR state register to text.
func stateName(v uint16) string {
	switch v {
	case 0:
		return "open"
	case 1:
		return "closed"
	}
	return "unknown"
}

// reads the live data for one device in a single modbus request (ACR's return close/open state)
func readDevice(c *modbus.ModbusClient, kind deviceKind) ([]float32, string, error) {
	if kind.Recloser {
		s, err := c.ReadRegister(regMeasure, modbus.INPUT_REGISTER)
		if err != nil {
			return nil, "", err
		}
		return nil, stateName(s), nil
	}

	vals, err := c.ReadFloat32s(regMeasure, uint16(len(kind.Labels)), modbus.INPUT_REGISTER)
	if err != nil {
		return nil, "", err
	}
	return vals, "", nil
}

// writes an open/close command to a recloser and reads the state
func runCommand(c *modbus.ModbusClient, info deviceInfo, cmd command) result {
	res := result{ID: info.ID}

	if !info.Kind.Recloser {
		res.Err = fmt.Errorf("%s is a %s, not a recloser", info.ID, info.Kind.Name)
		return res
	}
	if err := c.WriteCoil(coilRecloser, cmd.Close); err != nil {
		res.Err = fmt.Errorf("command failed: %w", err)
		return res
	}
	state, err := c.ReadRegister(regMeasure, modbus.INPUT_REGISTER)
	if err != nil {
		res.Err = fmt.Errorf("command sent, but reading the state back failed: %w", err)
		return res
	}
	res.State = stateName(state)
	return res
}

// reads device on every tick, stores each reading in the database, and handles commands in between (until a poll fails or ctx is cancelled)
func pollLoop(ctx context.Context, c *modbus.ModbusClient, info deviceInfo, d *device, db *store, interval time.Duration) error {
	t := time.NewTicker(interval)
	defer t.Stop()

	for {
		vals, state, err := readDevice(c, info.Kind)
		if err != nil {
			return err
		}
		r := reading{Time: time.Now().UTC(), Info: info, Values: vals, State: state}
		d.store(r)
		db.saveReading(r)

	wait:
		for {
			select {
			case <-ctx.Done():
				return nil
			case <-t.C:
				break wait
			case cmd := <-d.cmds:
				res := runCommand(c, info, cmd)
				if res.Err == nil {
					// updates the stored state now so an immediate read is accurate
					d.store(reading{Time: time.Now().UTC(), Info: info, State: res.State})
				}
				cmd.reply <- res
			}
		}
	}
}

// sleep waits for duration or until ctx had been cancelled
func sleep(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}