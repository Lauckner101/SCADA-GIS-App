# SCADA GIS App

A complete SCADA system: 309 simulated field devices written in C, a Go backend that polls them over Modbus TCP and stores their history, and a React HMI that shows every device on a map, flags dangerous measurements, and allows you to open and close reclosers.

The whole system is deployed on AWS. The simulated sensors and the backend are running together in a Docker container on an EC2 Linux server. The HMI is deployed from S3 and CloudFront. The HMI and backend communicate over HTTPS.

**Live HMI:** [https://d25m41ei7b1ynm.cloudfront.net/] (https://d25m41ei7b1ynm.cloudfront.net/)


## Features

- **Map view** of all 309 devices (62 reclosers, 147 line posts, 100 transformer monitors) on a MapLibre map, with transmission lines coloured based on voltage.
- **Live readings** for every device, every second, with online, offline, open and warning states shown by icon colour.
- **Warning detection.** voltage more than 10% above nominal or current above the line's rated ampacity gives of a warning.
- **Warnings and Recent warnings lists.** Devices currently in warning, and devices that were in warning within the last 10 minutes.
- **Recloser control.** Open or close a recloser (the state is read back from the device after the command).
- **Historical data panel.** A list of a device's last 500 readings, with warning readings highlighted in red.

## Architecture

- **Sensors** (C): each device is its own individual process. The Modbus TCP server connects to its simulated IP (127.0.0.2 up to 127.0.1.56) on port 502.
- **Backend** (Go): one thread per device, reads the device's identity once per connection and then reads its measurements every second. Readings are stored in a SQL database for historical data recall.
- **HMI** (React and TypeScript): requests data from and sends commands to the backend.


## Device types

| Type code | Name | Reports |
|---|---|---|
| 1 | `linepost` | current, voltage, phase angle |
| 2 | `transformer` | load current, primary voltage, secondary voltage |
| 3 | `acr` | open/closed |


## Modbus Registers

| Address | Registers | Type | Contents |
|---|---|---|---|
| 0, 2, 4 | 2 each | float32 | one for each sensor measrument |
| 0 | 1 | uint16 | recloser (0 = open, 1 = closed) |
| 10 | 1 | uint16 | device type |
| 11, 13 | 2 each | float32 | latitude, longitude |
| 20 | 16 | bytes | device id |

Reclosers receive commands by writing coil 0 (function code 0x05): `0xFF00` closes, `0x0000` opens.


## Running (on windows)

### 1. Sensors

Build the simulator:

```bash
gcc -Wall -Wextra -O2 -o sensor.exe sensor.c -lws2_32 -lm
```

Run all 309 devices:

```bash
./run_sensors.ps1
```

### 2. Backend

```bash
# in /backend
go run .
```

### 3. Frontend

```bash
# in /frontend/GIS-App
npm install
npm run dev
```

## Known limitations
- Need to streamline backend requests for device data (put all device data requests in one message)
- No frontend authentication (deliberate so anyone can view the HMI)
- Warning detection and line voltage determination done on the frontend (should be delegated to individual devices and communicated to frontend)
