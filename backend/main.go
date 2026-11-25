// this is the file for the main functions of the modbus server

// The devices polled are built into the program: 309 addresses, from
// 127.0.0.2 up to 127.0.0.254 and then 127.0.1.1 up to 127.0.1.56


// Device register map:

//	Addr   Regs  Type     Contents
//	0      2     float32  linepost / transformer: 1st measurement
//	2      2     float32  linepost / transformer: 2nd measurement
//	4      2     float32  linepost / transformer: 3rd measurement
//	0      1     uint16   acr: state, 0 = open, 1 = closed
//	10     1     uint16   device type code
//	11     2     float32  latitude
//	13     2     float32  longitude
//	20     16    bytes    device id, ASCII, NUL-padded
// reclosers are commanded by writing coil 0 (true = close, false = open).


// --------------- frontend json format:
//
//	request:  {"id":"LP-001"}
//	          {"command":"read","id":"LP-001"}


//	reply (line post / transformer):
//	  {"ok":true,"id":"LP-001","type":"linepost",
//	   "lat":53.5461,"lon":-113.4938,"timestamp":"2026-11-17T18:22:31.250Z",
//	   "connected":true,
//	   "data":[{"name":"current","value":251.204,"unit":"A"},
//	           {"name":"voltage","value":7203.418,"unit":"V"},
//	           {"name":"phase","value":20.113,"unit":"deg"}]}


//	reply (recloser):
//	  {"ok":true,"id":"ACR-001","type":"acr",
//	   "lat":53.548,"lon":-113.496,"timestamp":"2026-11-17T18:22:31.250Z",
//	   "connected":true,"state":"closed"}


// open/close recloser:
//		request: {"command":"open","id":"ACR-001"}
//		reply: {"ok":true,"id":"ACR-001","state":"open"}


// history requests:
//		request: {"command":"history","id":"LP-001"}
//		reply (line post / transformer):
//	  		{"ok":true,"id":"LP-001","type":"linepost",
//	   		"history":[
//	     	{"timestamp":"2026-11-17T18:22:30.250Z",
//	      		"data":[{"name":"current","value":251.1,"unit":"A"},
//	              {"name":"voltage","value":7203.1,"unit":"V"},
//	              {"name":"phase","value":20.1,"unit":"deg"}]}, ...]}


//		reply (recloser):
//	  		{"ok":true,"id":"ACR-001","type":"acr", "history":[{"timestamp":"2026-11-17T18:22:30.250Z","state":"closed"}, ...]}


package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

const (
	defaultPort = "502"
	cmdTimeout  = 5 * time.Second // how long the frontend waits for a device to act on a command
	deviceCount = 309 // number of simulated sensors
)

// latest data received from a sensor
type reading struct {
	Time   time.Time
	Info   deviceInfo
	Values []float32 // measurements
	State  string    // open/close
}

// an open/close request
type command struct {
	Close bool
	reply chan result // buffer so the poll never blocks on a request that gave up
}

// answer to an open/close command
type result struct {
	ID    string
	State string // open/close
	Err   error
}

// instance of polled sensor device
type device struct {
	addr string
	cmds chan command // send succeeds only is device is connected and listening
	id string
	mu sync.RWMutex
	latest *reading
	connected bool
}

// records newest reading
func (d *device) store(r reading) {
	d.mu.Lock()
	d.latest = &r
	d.mu.Unlock()
}

func (d *device) setConnected(v bool) {
	d.mu.Lock()
	d.connected = v
	d.mu.Unlock()
}

// returns latest reading and/or if device is currently connected
func (d *device) snapshot() (r reading, connected, ok bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	if d.latest == nil {
		return reading{}, d.connected, false
	}
	return *d.latest, d.connected, true
}

// send hands a command to the device and waits for response
func (d *device) send(ctx context.Context, closeIt bool) (result, error) {
	cmd := command{Close: closeIt, reply: make(chan result, 1)}

	timer := time.NewTimer(cmdTimeout)
	defer timer.Stop()

	select {
	case d.cmds <- cmd:
	case <-timer.C:
		return result{}, errors.New("device not connected")
	case <-ctx.Done():
		return result{}, errors.New("backend shutting down")
	}

	select {
	case r := <-cmd.reply:
		return r, r.Err
	case <-timer.C:
		return result{}, errors.New("timed out waiting for device")
	case <-ctx.Done():
		return result{}, errors.New("backend shutting down")
	}
}

// registry maps device ids to devices
type registry struct {
	mu   sync.RWMutex
	byID map[string]*device
}

func newRegistry() *registry {
	return &registry{byID: make(map[string]*device)}
}

// bind registers d to a device id. The first device to claim an id is the one who keeps it
func (r *registry) bind(id string, d *device) error {
	if id == "" {
		return errors.New("device reported an empty id")
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	if owner, taken := r.byID[id]; taken && owner != d {
		return fmt.Errorf("device id %q is already used by %s", id, owner.addr)
	}
	if d.id != "" && d.id != id {
		delete(r.byID, d.id)
	}
	d.id = id
	r.byID[id] = d
	return nil
}

// finds device binded to specified id.
func (r *registry) lookup(id string) (*device, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	d, ok := r.byID[id]
	return d, ok
}

// makes output lines in terminal from different goroutines avoid colliding
type printer struct {
	mu sync.Mutex
}

func (p *printer) printf(format string, args ...any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	fmt.Printf(format, args...)
}

// returns ip address of ith device
func deviceAddr(i int) string {
	n := i + 1 // 127.0.0.1 not included
	return fmt.Sprintf("127.0.%d.%d", n/254, n%254+1)
}

// returns the device list as a list of ip's
func builtinDeviceAddrs() []string {
	addrs := make([]string, 0, deviceCount)
	for i := 0; i < deviceCount; i++ {
		addrs = append(addrs, deviceAddr(i))
	}
	return addrs
}

func main() {
	httpAddr := flag.String("http", "127.0.0.1:8080", "address for the API used by the frontend (host:port)")
	dbPath := flag.String("db", "scada.db", "path of the SQLite database file (created if missing)")
	interval := flag.Duration("interval", time.Second, "time between polls of each device")
	timeout := flag.Duration("timeout", 2*time.Second, "modbus request/connect timeout")
	flag.Parse()

	out := &printer{}

	// builds the device list
	reg := newRegistry()
	var ordered []*device
	for _, ip := range builtinDeviceAddrs() {
		addr := net.JoinHostPort(ip, defaultPort)
		ordered = append(ordered, &device{addr: addr, cmds: make(chan command)})
	}

	ln, err := net.Listen("tcp", *httpAddr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen on %s: %v\n", *httpAddr, err)
		os.Exit(1)
	}

	db, err := openStore(*dbPath, out)
	if err != nil {
		ln.Close()
		fmt.Fprintf(os.Stderr, "open database %s: %v\n", *dbPath, err)
		os.Exit(1)
	}

	// shut down on ctr c
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var wg sync.WaitGroup

	for _, d := range ordered {
		wg.Add(1)
		go func(d *device) {
			defer wg.Done()
			pollDevice(ctx, d, reg, db, *interval, *timeout, out)
		}(d)
	}

	srv := newHTTPServer(ctx, reg, db, out)
	wg.Add(2)
	go func() {
		defer wg.Done()
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			out.printf("[!] HTTP server error: %v\n", err)
		}
	}()
	go func() {
		defer wg.Done()
		<-ctx.Done()
		sc, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(sc)
	}()

	out.printf("SCADA backend polling %d devices (%s to %s) every %s, saving to %s, HTTP API on http://%s/api (Ctrl+C to stop)\n",
		len(ordered), deviceAddr(0), deviceAddr(deviceCount-1), *interval, *dbPath, ln.Addr())

	wg.Wait()

	// at this point every poller closed, so write remaining queue to db and close
	db.close()
	out.printf("Backend stopped.\n")
}