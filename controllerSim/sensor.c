/* Simulated SCADA field devices
 *
 * Three device types (--type):
 *      linepost: reports current, voltage, and phase angle
 *      transformer: Reports load current, incoming/primary voltage, and secondary voltage.
 *      acr: Automatic circuit recloser
 *
 * Supported function codes:
 *      0x03/0x04: read holding/input registers (both return the same table)
 *      0x05: write single coil (for ACR's): coil 0, 0xFF00 = close, 0x0000 = open
 * 
 * 
 *  modbus Register map:
 *
 *     Addr  Regs  Type     Contents
 *     0     2     float32  current
 *     2     2     float32  voltage, primary voltage
 *     4     2     float32  phase angle, secondary voltage
 * 
 *     0     1     uint16   state, 0 = open, 1 = closed (for ACR's)
 *
 *     10    1     uint16   device type: 1 = linepost, 2 = transformer, 3 = acr
 *     11    2     float32  latitude
 *     13    2     float32  longitude
 *     20    16    bytes    device id
 *
 *
 * Build:
 *   gcc -Wall -Wextra -O2 -o sensor.exe sensor.c -lws2_32 -lm
 *
 * Usage:
 *   ./sensor.exe --type <linepost|transformer|acr> --lat 53.5461 --lon -113.4938 --bind 127.0.0.2 [--voltage 138kV] [--port 502] [--id NAME]
 */


#if defined(_MSC_VER) && !defined(_CRT_SECURE_NO_WARNINGS)
#define _CRT_SECURE_NO_WARNINGS
#endif

// windows/linux cross compatibility for both local dev and linux server deployment
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif

#include <errno.h>
#include <math.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>


#ifdef _WIN32 // ---------------------- windows libraries
  #ifndef _WIN32_WINNT
  #define _WIN32_WINNT 0x0600
  #endif
  #define WIN32_LEAN_AND_MEAN
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #include <windows.h>
  #include <process.h>
  #ifdef _MSC_VER
    #pragma comment(lib, "ws2_32.lib")
  #endif
  typedef SOCKET sock_t;
  #define BAD_SOCK   INVALID_SOCKET
  #define close_sock closesocket
  #define get_pid    _getpid
#else // ------------------------------------ linux libraries
  #include <arpa/inet.h>
  #include <netinet/in.h>
  #include <sys/select.h>
  #include <sys/socket.h>
  #include <sys/types.h>
  #include <unistd.h>
  typedef int sock_t;
  #define BAD_SOCK   (-1)
  #define close_sock close
  #define get_pid    getpid
#endif


#define PI 3.14159265358979323846

// base parameters
#define DEFAULT_VOLTAGE_KV 138.0
#define NOMINAL_PHASE_DEG 20.0
#define XFMR_TURNS_RATIO 30.0   // primary to secondary ratio

// set variation sizes
#define VOLTAGE_SWELL 0.01 
#define VOLTAGE_NOISE (8.0/7200.0)
#define LP_CURRENT_SWING 0.40
#define LP_CURRENT_NOISE 0.012
#define XFMR_CURRENT_SWING (40.0/120.0) 
#define XFMR_CURRENT_NOISE (2.0/120.0)
#define XFMR_LOAD_DROP 0.005
#define XFMR_SEC_NOISE (0.2 / 240.0)


// different voltage and current swell boosts to simulate a wide range of operating devices (including problematic ones)
#define VBOOST_MIN          0.01
#define VBOOST_T1_MAX       0.08
#define VBOOST_T2_MAX       0.10
#define VBOOST_MAX          0.15
#define VBOOST_SPLIT1       0.870
#define VBOOST_SPLIT2       0.970  // top 3%

#define LOAD_MIN            0.40
#define LOAD_T1_MAX         0.90
#define LOAD_T2_MAX         1.00   // above this is dangerous
#define LOAD_MAX            1.15
#define LOAD_SPLIT1         0.8775
#define LOAD_SPLIT2         0.9775 // top 2.25% of devices


#define FLEET_LINEPOSTS 147
#define FLEET_TRANSFORMERS 100

// modbus constants
#define DEFAULT_PORT 502
#define MAX_CLIENTS 4
#define MBAP_LEN 7
#define MAX_ADU 260
#define FC_READ_HOLDING 0x03
#define FC_READ_INPUT 0x04
#define FC_WRITE_COIL 0x05
#define EX_ILLEGAL_FUNC 0x01
#define EX_ILLEGAL_ADDR 0x02
#define EX_ILLEGAL_VALUE 0x03
#define COIL_ON 0xFF00
#define COIL_OFF 0x0000

// register map
#define REG_ACR_STATE 0
#define REG_TYPE 10
#define REG_LAT 11
#define REG_LON 13
#define REG_ID 20
#define ID_BYTES 32
#define NUM_REGS 36
#define COIL_ACR 0


// device types
typedef enum {
    DEV_LINE_POST   = 0,
    DEV_TRANSFORMER = 1,
    DEV_ACR         = 2
} dev_type_t;


typedef struct {
    const char *name;
    int         nvals;       // measurements
    const char *label[3];
    const char *unit[3];
} type_info_t;


static const type_info_t TYPES[] = {
    { "linepost",    3, { "current",      "voltage",         "phase" },
                        { "A",            "V",               "deg"   } },
    { "transformer", 3, { "load_current", "primary_voltage", "secondary_voltage" },
                        { "A",            "V",               "V"     } },
    { "acr",         0, { "", "", "" },
                        { "", "", "" } }
};

typedef struct {
    dev_type_t type;
    char       id[64];
    double     lat;
    double     lon;
    double     voltage_v;   // line voltage
    char       bind_addr[64];
    int        port;
} config_t;


// running device simulation values
typedef struct {
    config_t cfg;
    double   t0;        // start time
    int      closed;    // 1 = closed, 0 = open
    uint64_t polls;

    
    double   v_peak;
    double   v_boost; // voltage swell
    double   i_peak;  // peak current as fraction of ampacity
    double   i_level; // average current as fraction of ampacity
} device_t;


typedef struct {
    sock_t  fd;
    uint8_t buf[MAX_ADU + 64];
    int     len;
} client_t;


static volatile sig_atomic_t g_running = 1;


static void handle_signal(int sig) {
    (void)sig;
    g_running = 0;
}


// ----  helpers ------

static double rand_uniform(void) {
    return ((double)rand() + 1.0) / ((double)RAND_MAX + 2.0);
}

// Gaussian noise using box-muller and above uniform samples
static double rand_gauss(double sigma) {
    double u1 = rand_uniform();
    double u2 = rand_uniform();
    return sigma * sqrt(-2.0 * log(u1)) * cos(2.0 * PI * u2);
}

// ---------------- starting levels

// split device u values into specific skews (differnet classes of voltage and current boosts/swells)
static double three_tier(double u, double split1, double split2, double v0, double v1, double v2, double v3, double skew0, double skew2) {
    if (u < split1)
        return v0 + (v1 - v0) * pow(u / split1, skew0);
    if (u < split2)
        return v1 + (v2 - v1) * ((u - split1) / (split2 - split1));
    return v2 + (v3 - v2) * pow((u - split2) / (1.0 - split2), skew2);
}


// calucates position of device in sensor fleet counting LP-001 as 0, TX-001 as 147 and TX-100 as 246
static int fleet_index(const char *id) {
    int n;
    if (strncmp(id, "LP-", 3) == 0) {
        n = atoi(id + 3);
        if (n >= 1 && n <= FLEET_LINEPOSTS) return n - 1;
    } else if (strncmp(id, "TX-", 3) == 0) {
        n = atoi(id + 3);
        if (n >= 1 && n <= FLEET_TRANSFORMERS) return FLEET_LINEPOSTS + n - 1;
    }
    return -1;
}

// random number across entire sensor list, makes sure the same sensor gets the same number every time.
static double level_fraction(int index, double multiplier, double offset) {
    double x;

    if (index < 0) return rand_uniform();
    x = (double)(index + 1) * multiplier + offset;
    return x - floor(x);
}

// picks voltages and currents for the device on creation
static void choose_levels(device_t *dev) {
    int    idx = fleet_index(dev->cfg.id);
    double swing;

    dev->v_peak = dev->v_boost = 0.0;
    dev->i_peak = dev->i_level = 0.0;
    if (dev->cfg.type == DEV_ACR) return;

    dev->v_peak  = three_tier(level_fraction(idx, 0.6180339887498949, 0.20), VBOOST_SPLIT1, VBOOST_SPLIT2, VBOOST_MIN, VBOOST_T1_MAX, VBOOST_T2_MAX, VBOOST_MAX, 1.5, 1.0);
    dev->v_boost = dev->v_peak - VOLTAGE_SWELL;

    dev->i_peak  = three_tier(level_fraction(idx, 0.7548776662466927, 0.25), LOAD_SPLIT1, LOAD_SPLIT2, LOAD_MIN, LOAD_T1_MAX, LOAD_T2_MAX, LOAD_MAX, 1.3, 1.0);
    swing = (dev->cfg.type == DEV_LINE_POST) ? LP_CURRENT_SWING : XFMR_CURRENT_SWING;
    dev->i_level = dev->i_peak / (1.0 + swing); // swing tops at peak
}



// ---- Device models ------------------------

// gets nominal current from line voltage
static double nominal_current(double volts) {
    return volts * 2.0 / 1000.0;
}

// get voltage value for poll
static double sample_primary_voltage(double nominal_v, double boost, double t) {
    return nominal_v * (1.0 + boost + VOLTAGE_SWELL * sin(2.0 * PI * t / 60.0))
           + rand_gauss(nominal_v * VOLTAGE_NOISE);
}

// returns device measurments for a server poll
static void sample_device(const device_t *dev, double t, double out[3]) {
    double nominal_v = dev->cfg.voltage_v;
    double nominal_i = nominal_current(nominal_v); // ampacity
    double level_i   = nominal_i * dev->i_level; // average current

    switch (dev->cfg.type) {
    case DEV_LINE_POST:
        out[0] = level_i * (1.0 + LP_CURRENT_SWING * sin(2.0 * PI * t / 120.0))
                 + rand_gauss(level_i * LP_CURRENT_NOISE);
        if (out[0] < 0.0) out[0] = 0.0;
        out[1] = sample_primary_voltage(nominal_v, dev->v_boost, t);
        out[2] = NOMINAL_PHASE_DEG + 5.0 * sin(2.0 * PI * t / 90.0)
                 + rand_gauss(0.3);
        break;
    case DEV_TRANSFORMER:
        out[0] = level_i * (1.0 + XFMR_CURRENT_SWING * sin(2.0 * PI * t / 90.0))
                 + rand_gauss(level_i * XFMR_CURRENT_NOISE);
        if (out[0] < 0.0) out[0] = 0.0;
        out[1] = sample_primary_voltage(nominal_v, dev->v_boost, t);

        // secondary follows primary, with a small drop under load
        out[2] = out[1] / XFMR_TURNS_RATIO * (1.0 - XFMR_LOAD_DROP * out[0] / nominal_i)
                 + rand_gauss(nominal_v / XFMR_TURNS_RATIO * XFMR_SEC_NOISE);
        break;
    case DEV_ACR:
    default:
        break;
    }
}

static double monotonic_seconds(void) {
#ifdef _WIN32 // windows instance
    static LARGE_INTEGER freq;
    LARGE_INTEGER now;
    if (freq.QuadPart == 0) QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&now);
    return (double)now.QuadPart / (double)freq.QuadPart;
#else // linux instance
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
#endif
}


// -------------------- Register table ----------

// stores a float32 across 2 registers
static void put_float32(uint16_t *regs, float f) {
    uint32_t u;
    memcpy(&u, &f, sizeof u);
    regs[0] = (uint16_t)(u >> 16);
    regs[1] = (uint16_t)(u & 0xFFFF);
}

// fills the register table, including device sample values
static void build_registers(const device_t *dev, uint16_t regs[NUM_REGS], double vals[3]) {
    const config_t     *cfg = &dev->cfg;
    const type_info_t  *ti  = &TYPES[cfg->type];
    size_t n = strlen(cfg->id);

    memset(regs, 0, NUM_REGS * sizeof regs[0]);
    memset(vals, 0, 3 * sizeof vals[0]);

    sample_device(dev, monotonic_seconds() - dev->t0, vals);
    for (int i = 0; i < ti->nvals; i++)
        put_float32(&regs[2 * i], (float)vals[i]);
    if (cfg->type == DEV_ACR)
        regs[REG_ACR_STATE] = dev->closed ? 1 : 0;

    regs[REG_TYPE] = (uint16_t)(cfg->type + 1);
    put_float32(&regs[REG_LAT], (float)cfg->lat);
    put_float32(&regs[REG_LON], (float)cfg->lon);

    if (n > ID_BYTES) n = ID_BYTES;
    for (size_t i = 0; i < n; i++) {
        unsigned ch = (unsigned char)cfg->id[i];
        regs[REG_ID + i / 2] |= (uint16_t)(ch << ((i % 2 == 0) ? 8 : 0));
    }
}






// ------------------ modbus tcp handling ----------

static int send_all(sock_t fd, const uint8_t *buf, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        int n = (int)send(fd, (const char *)buf + sent, (int)(len - sent), 0);
        if (n < 0) {
#ifndef _WIN32
            if (errno == EINTR) continue;
#endif
            return -1;
        }
        sent += (size_t)n;
    }
    return 0;
}


// Handle one complete request frame (MBAP header + PDU) and send the reply.
static int handle_frame(sock_t fd, device_t *dev, const uint8_t *req, int total) {
    uint8_t rsp[MAX_ADU];
    uint8_t fc   = req[7];
    int exc  = 0;
    int plen = 0; // PDU length

    // MBAP header: echos back transaction id and unit id, protocol id = 0 for modbus
    rsp[0] = req[0]; // transaction id
    rsp[1] = req[1]; // transaction id
    rsp[2] = 0; // protocol id
    rsp[3] = 0; // protocol id
    rsp[6] = req[6]; // unit id

    if (fc == FC_READ_HOLDING || fc == FC_READ_INPUT) {
        if (total < 12) {
            exc = EX_ILLEGAL_VALUE;
        } else {
            unsigned start = ((unsigned)req[8]  << 8) | req[9];
            unsigned qty   = ((unsigned)req[10] << 8) | req[11];

            if (qty < 1 || qty > 125) {
                exc = EX_ILLEGAL_VALUE;
            } else if (start + qty > NUM_REGS) {
                exc = EX_ILLEGAL_ADDR;
            } else {
                uint16_t regs[NUM_REGS];
                double   vals[3];

                build_registers(dev, regs, vals);

                rsp[7] = fc;
                rsp[8] = (uint8_t)(qty * 2);
                for (unsigned i = 0; i < qty; i++) {
                    rsp[9 + 2 * i]     = (uint8_t)(regs[start + i] >> 8);
                    rsp[9 + 2 * i + 1] = (uint8_t)(regs[start + i] & 0xFF);
                }
                plen = 2 + (int)(qty * 2);

                // log when measurment block requested
                if (start == 0) {
                    const type_info_t *ti = &TYPES[dev->cfg.type];
                    printf("[poll] #%llu", (unsigned long long)dev->polls);
                    if (dev->cfg.type == DEV_ACR) {
                        printf(" state = %s", dev->closed ? "CLOSED" : "OPEN");
                    } else {
                        for (int i = 0; i < ti->nvals; i++)
                            printf(" %s=%.3f %s", ti->label[i], vals[i], ti->unit[i]);
                    }
                    printf("\n");
                    fflush(stdout);
                    dev->polls++;
                }
            }
        }
    } else if (fc == FC_WRITE_COIL) {
        if (dev->cfg.type != DEV_ACR) { // only acr types accept commands
            exc = EX_ILLEGAL_FUNC;
        } else if (total < 12) {
            exc = EX_ILLEGAL_VALUE;
        } else {
            unsigned addr = ((unsigned)req[8]  << 8) | req[9];
            unsigned val  = ((unsigned)req[10] << 8) | req[11];

            if (addr != COIL_ACR) {
                exc = EX_ILLEGAL_ADDR;
            } else if (val != COIL_ON && val != COIL_OFF) {
                exc = EX_ILLEGAL_VALUE;
            } else {
                dev->closed = (val == COIL_ON);
                printf("[cmd] %s -> %s\n", dev->cfg.id, dev->closed ? "CLOSED" : "OPEN");
                fflush(stdout);

                // reply echos request
                memcpy(&rsp[7], &req[7], 5);
                plen = 5;
            }
        }
    } else {
        exc = EX_ILLEGAL_FUNC;
    }

    if (exc) {
        rsp[7] = (uint8_t)(fc | 0x80);
        rsp[8] = (uint8_t)exc;
        plen = 2;
    }

    rsp[4] = (uint8_t)((plen + 1) >> 8);   /* length = unit id + PDU */
    rsp[5] = (uint8_t)((plen + 1) & 0xFF);
    return send_all(fd, rsp, (size_t)(7 + plen));
}


static void drop_client(client_t *c) {
    close_sock(c->fd);
    c->fd  = BAD_SOCK;
    c->len = 0;
    //printf("[net] backend disconnected\n");
    fflush(stdout);
}


// read request and process what was recieved
static void service_client(client_t *c, device_t *dev) {
    int n = (int)recv(c->fd, (char *)c->buf + c->len, (int)(sizeof c->buf - (size_t)c->len), 0);
    if (n < 0) {
#ifndef _WIN32
        if (errno == EINTR) return;
#endif
        drop_client(c);
        return;
    }
    if (n == 0) {
        drop_client(c);
        return;
    }
    c->len += n;

    while (c->len >= MBAP_LEN) {
        int length = (c->buf[4] << 8) | c->buf[5];   // unit id + PDU
        int total;

        if (length < 2 || length > MAX_ADU - 6) {     // invalid so drop
            drop_client(c);
            return;
        }
        total = 6 + length;
        if (c->len < total) break;   // wait for the rest

        if (handle_frame(c->fd, dev, c->buf, total) != 0) {
            drop_client(c);
            return;
        }
        memmove(c->buf, c->buf + total, (size_t)(c->len - total));
        c->len -= total;
    }
}




// ------------------- ---- Networking --------------------------------

static sock_t listen_on(const char *ip, int port) {
    struct sockaddr_in addr;
    sock_t fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd == BAD_SOCK) return BAD_SOCK;

#ifndef _WIN32
    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof yes);
#endif

    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port   = htons((unsigned short)port);
    if (inet_pton(AF_INET, ip, &addr.sin_addr) != 1) {
        close_sock(fd);
        return BAD_SOCK;
    }

    if (bind(fd, (struct sockaddr *)&addr, sizeof addr) != 0 ||
        listen(fd, 4) != 0) {
        close_sock(fd);
        return BAD_SOCK;
    }
    return fd;
}





// -------------------------argument parsing for sensor setup

static void parse_type(const char *s, config_t *cfg) {
    if (strcmp(s, "transformer") == 0)  cfg->type = DEV_TRANSFORMER;
    else if (strcmp(s, "acr") == 0)     cfg->type = DEV_ACR;
    else                                cfg->type = DEV_LINE_POST;
}


static void parse_args(int argc, char **argv, config_t *cfg) {
    memset(cfg, 0, sizeof *cfg);
    cfg->port = DEFAULT_PORT;
    strcpy(cfg->bind_addr, "127.0.0.1");
    cfg->voltage_v = DEFAULT_VOLTAGE_KV * 1000.0;

    for (int i = 1; i + 1 < argc; i += 2) {
        const char *name = argv[i];
        const char *val  = argv[i + 1];

        if      (strcmp(name, "--type") == 0) parse_type(val, cfg);
        else if (strcmp(name, "--lat")  == 0) cfg->lat = atof(val);
        else if (strcmp(name, "--lon")  == 0) cfg->lon = atof(val);
        else if (strcmp(name, "--port") == 0) cfg->port = atoi(val);
        else if (strcmp(name, "--bind") == 0) strcpy(cfg->bind_addr, val);
        else if (strcmp(name, "--id")   == 0) strcpy(cfg->id, val);
        else if (strcmp(name, "--voltage") == 0)
            cfg->voltage_v = atof(val) * 1000.0;
    }

    if (cfg->id[0] == '\0')
        snprintf(cfg->id, sizeof cfg->id, "%s-%ld", TYPES[cfg->type].name, (long)get_pid());
}






// ------------------------------------------- Main ------------------

int main(int argc, char **argv) {
    device_t dev;
    memset(&dev, 0, sizeof dev);
    parse_args(argc, argv, &dev.cfg);
    dev.closed = 1;                       // acr start closed                    
    dev.t0 = monotonic_seconds();

#ifdef _WIN32 // windows
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
#else // linux
    signal(SIGPIPE, SIG_IGN);
#endif


    srand((unsigned)time(NULL) ^ (unsigned)get_pid());
    choose_levels(&dev);

#ifdef _WIN32 // windows
    signal(SIGINT,   handle_signal);   // Ctrl c
    signal(SIGBREAK, handle_signal);   // Ctrl Break and console close
#else // linux
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = handle_signal;
    sigaction(SIGINT,  &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
#endif

    sock_t lfd = listen_on(dev.cfg.bind_addr, dev.cfg.port);
    if (lfd == BAD_SOCK) {
        fprintf(stderr, "Could not listen on %s:%d (address in use or not available)\n", dev.cfg.bind_addr, dev.cfg.port);
        return 1;
    }

    printf("Device %s (%s) at %.6f, %.6f -> modbus TCP server on %s:%d\n",
           dev.cfg.id, TYPES[dev.cfg.type].name, dev.cfg.lat, dev.cfg.lon,
           dev.cfg.bind_addr, dev.cfg.port);
    if (dev.cfg.type == DEV_ACR)
        printf("ACR state: CLOSED\n");
    else
        printf("Levels: voltage peaks %+.1f%% above nominal, current peaks at %.0f%% of ampacity%s\n",
               dev.v_peak * 100.0, dev.i_peak * 100.0,
               dev.i_peak > LOAD_T2_MAX ? " (OVERLOAD)" : "");
    printf("Press ctrl c to stop\n");
    fflush(stdout);

    client_t clients[MAX_CLIENTS];
    for (int i = 0; i < MAX_CLIENTS; i++) {
        clients[i].fd  = BAD_SOCK;
        clients[i].len = 0;
    }

    while (g_running) {
        fd_set rfds;
        sock_t maxfd = lfd;
        struct timeval tv;

        FD_ZERO(&rfds);
        FD_SET(lfd, &rfds);
        for (int i = 0; i < MAX_CLIENTS; i++) {
            if (clients[i].fd == BAD_SOCK) continue;
            FD_SET(clients[i].fd, &rfds);
            if (clients[i].fd > maxfd) maxfd = clients[i].fd;
        }

        tv.tv_sec  = 0;
        tv.tv_usec = 100000;   // wakes every 100ms so ctrl c is responded to quickly

        if (select((int)maxfd + 1, &rfds, NULL, NULL, &tv) <= 0)
            continue;

        if (FD_ISSET(lfd, &rfds)) {
            sock_t nfd = accept(lfd, NULL, NULL);
            if (nfd != BAD_SOCK) {
                int placed = 0;
                for (int i = 0; i < MAX_CLIENTS; i++) {
                    if (clients[i].fd != BAD_SOCK) continue;
                    clients[i].fd  = nfd;
                    clients[i].len = 0;
                    placed = 1;
                    printf("[net] backend connected\n");
                    fflush(stdout);
                    break;
                }
                if (!placed) close_sock(nfd); // closes if too many clients
            }
        }

        for (int i = 0; i < MAX_CLIENTS; i++) {
            if (clients[i].fd != BAD_SOCK && FD_ISSET(clients[i].fd, &rfds))
                service_client(&clients[i], &dev);
        }
    }

    printf("\nshutting down device %s\n", dev.cfg.id);
    for (int i = 0; i < MAX_CLIENTS; i++)
        if (clients[i].fd != BAD_SOCK) close_sock(clients[i].fd);
    close_sock(lfd);

#ifdef _WIN32
    WSACleanup();
#endif
    return 0;
}