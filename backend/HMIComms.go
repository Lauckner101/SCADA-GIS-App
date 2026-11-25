// This file covers everything that talks to the frontend over http.
//
// There is only one endpoint /api. The request and reply formats are outlined in the header comment of main.go. The HMI never sees the device ip, only the device id.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"strings"
	"time"
)

const (
	maxRequestBytes = 4096 // reject large request inputs
	timeFormat      = "2006-01-02T15:04:05.000Z"
	historyLimit    = 500 // limit to readings returned by history request
)

// request from the front end
type hmiRequest struct {
	Command string `json:"command"` // read, open, close, or history
	ID      string `json:"id"`
}

// response to a command
type hmiResponse struct {
	OK    bool   `json:"ok"`
	ID    string `json:"id"`
	State string `json:"state,omitempty"`
	Error string `json:"error,omitempty"`
}

// a measurement sent in read reply
type measurement struct {
	Name  string  `json:"name"`
	Value float32 `json:"value"`
	Unit  string  `json:"unit"`
}

// response to a successfull read
type readResponse struct {
	OK        bool          `json:"ok"`
	ID        string        `json:"id"`
	Type      string        `json:"type"`
	Lat       float64       `json:"lat"`
	Lon       float64       `json:"lon"`
	Timestamp string        `json:"timestamp"`
	Connected bool          `json:"connected"`
	State     string        `json:"state,omitempty"` // for reclosers
	Data      []measurement `json:"data,omitempty"`  // contains list of measurments
}

// an entry in the list of historical values being sent to front end
type historyEntry struct {
	Timestamp string        `json:"timestamp"`
	State     string        `json:"state,omitempty"` // recloser
	Data      []measurement `json:"data,omitempty"`  // line post / transformer
}

// full reply to successfull history request
type historyResponse struct {
	OK      bool           `json:"ok"`
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	History []historyEntry `json:"history"` // list of historical readings
}


// withCORS lets any website call the API from a browser. It adds the CORS headers to every reply and answers the browser's OPTIONS preflight
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}


// build for https server frontend interacts with
func newHTTPServer(ctx context.Context, reg *registry, db *store, out *printer) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/api", func(w http.ResponseWriter, r *http.Request) {
		handleAPI(w, r, reg, db, out)
	})
	return &http.Server{
		Handler:           withCORS(mux),
		BaseContext:       func(net.Listener) context.Context { return ctx }, // derive from ctx, so in flight requests cancelled when backend is down.
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
	}
}

// Sends v as a JSON reply with the http status
func writeJSON(writer http.ResponseWriter, status int, v any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	json.NewEncoder(writer).Encode(v)
}


// serves POST /api
func handleAPI(w http.ResponseWriter, r *http.Request, reg *registry, db *store, out *printer) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, hmiResponse{Error: "use POST"})
		return
	}

	// cors now handeled elsewhere
	if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
		writeJSON(w, http.StatusUnsupportedMediaType, hmiResponse{Error: "Content-Type must be application/json"})
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeJSON(w, http.StatusRequestEntityTooLarge, hmiResponse{Error: "request body too large"})
		} else {
			writeJSON(w, http.StatusBadRequest, hmiResponse{Error: "could not read request body"})
		}
		return
	}

	resp := handleRequest(r.Context(), reg, db, strings.TrimSpace(string(body)), r.RemoteAddr, out)
	writeJSON(w, http.StatusOK, resp)
}

// validates a frontend request and returns the reply to send
func handleRequest(ctx context.Context, reg *registry, db *store, line, remote string, out *printer) any {
	var req hmiRequest
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		return hmiResponse{Error: "invalid JSON"}
	}
	id := strings.TrimSpace(req.ID)
	resp := hmiResponse{ID: id}

	cmd := strings.ToLower(strings.TrimSpace(req.Command))
	if cmd == "" {
		cmd = "read"
	}
	if cmd != "read" && cmd != "open" && cmd != "close" && cmd != "history" {
		resp.Error = `command must be "read", "open", "close" or "history"`
		return resp
	}

	if cmd == "history" {
		return handleHistory(db, id, remote, out)
	}

	dev, ok := reg.lookup(id)
	if !ok {
		resp.Error = "unknown device id"
		return resp
	}

	if cmd == "read" {
		return handleRead(dev, id)
	}

	// open / close
	res, err := dev.send(ctx, cmd == "close")
	if res.ID != "" {
		resp.ID = res.ID
	}
	if err != nil {
		resp.Error = err.Error()
		out.printf("[hmi] %s: %s %s -> error: %s\n", remote, cmd, id, resp.Error)
		return resp
	}
	resp.OK = true
	resp.State = res.State
	out.printf("[hmi] %s: %s %s -> ok, %s is %s\n", remote, cmd, id, res.ID, res.State)
	return resp
}

// finds device based on name (linepost, etc.)
func kindNamed(name string) (deviceKind, bool) {
	for _, k := range kinds {
		if k.Name == name {
			return k, true
		}
	}
	return deviceKind{}, false
}

// builds the reply for a history request oldest first.
func handleHistory(db *store, id, remote string, out *printer) any {
	typ, rows, err := db.history(id, historyLimit)
	if errors.Is(err, errUnknownDevice) {
		return hmiResponse{ID: id, Error: "unknown device id"}
	}
	if err != nil {
		out.printf("[hmi] %s: history %s -> error: %v\n", remote, id, err)
		return hmiResponse{ID: id, Error: "could not read history"}
	}

	kind, _ := kindNamed(typ)
	entries := make([]historyEntry, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		e := historyEntry{Timestamp: time.UnixMilli(r.TS).UTC().Format(timeFormat)}
		if kind.Recloser {
			if r.State.Valid {
				e.State = r.State.String
			}
		} else {
			for j, label := range kind.Labels {
				if v, ok := r.value(label); ok {
					e.Data = append(e.Data, measurement{Name: label, Value: float32(v), Unit: kind.Units[j]})
				}
			}
		}
		entries = append(entries, e)
	}
	return historyResponse{OK: true, ID: id, Type: typ, History: entries}
}

// handleRead builds the reply for a data request from frontend, takes the device's latest reading
func handleRead(dev *device, id string) any {
	r, connected, ok := dev.snapshot()
	if !ok {
		return hmiResponse{ID: id, Error: "no data yet"}
	}

	resp := readResponse{
		OK:        true,
		ID:        r.Info.ID,
		Type:      r.Info.Kind.Name,
		Lat:       r.Info.Lat,
		Lon:       r.Info.Lon,
		Timestamp: r.Time.Format(timeFormat),
		Connected: connected,
	}
	if r.Info.Kind.Recloser {
		resp.State = r.State
	} else {
		resp.Data = make([]measurement, len(r.Values))
		for i, v := range r.Values {
			resp.Data[i] = measurement{
				Name:  r.Info.Kind.Labels[i],
				Value: v,
				Unit:  r.Info.Kind.Units[i],
			}
		}
	}
	return resp
}