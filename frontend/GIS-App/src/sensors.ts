// device objects and properties

// named value from a line post or transformer monitor.
export type Measurement = { name: string; value: number; unit: string };

// past reading from the backends history reply.
export type HistoryEntry = {
  timestamp: string;
  state?: string; // reclosers
  data?: Measurement[]; // line posts and transformer monitors (can be missing values)
};

// The history panel's content
export type HistoryView = {
  id: string;
  type?: string;
  entries: HistoryEntry[];
  loading: boolean;
  error?: string;
  fetchedAt?: Date;
};

// A sensor starts out with only id's, everything else is filled out from backend comms
export type Sensor = {
  id: string;
  type?: string; // "linepost", "transformer", "acr"
  latitude?: number;
  longitude?: number;
  timestamp?: string; // when the backend last got data from the device
  connected?: boolean; // if the backend currently connected to the device
  state?: string; // reclosers only (open/close)
  data?: Measurement[]; // line posts and transformer data
  error?: string; // set when the last request failed
  nominalVolts?: number; // voltage of the nearest power line
  ratedAmps?: number; // ampacity set to nominalVolts * 2 / 1000
  lastWarnedAt?: number; // ms timestamp of the last poll where the device was in warning
  lastWarnings?: string[]; // warning message
};

// Builds ids for all devices (they follow a pattern so we just need the total of each type, and can build)
export const makeIds = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(3, '0')}`);

// there are 62 reclosers, 147 line posts, and 100 transformer monitors
export const DEVICE_IDS: string[] = [
  ...makeIds('ACR', 62),
  ...makeIds('LP', 147),
  ...makeIds('TX', 100),
];

export const initialSensors: Sensor[] = DEVICE_IDS.map((id) => ({ id }));

// requests to backend are posted here as JSON, using the same request/reply format as the backend's listener'.
export const API_URL = '/api';
export const POLL_MS = 1000;

export const typeLabels: Record<string, string> = {
  linepost: 'Line post',
  transformer: 'Transformer monitor',
  acr: 'Recloser',
};

export type Status = 'online' | 'open' | 'warning' | 'recent' | 'offline';
export const statusColor: Record<Status, string> = {
  online: '#22c55e',
  open: '#f5f10b',
  warning: '#ef4444',
  recent: '#f97316',
  offline: '#9ca3af',
};

// Warning thresholds
export const VOLTAGE_WARN_RATIO = 1.1;
export const CURRENT_WARN_RATIO = 1.0;
export const AMPS_PER_VOLT = 2 / 1000; // how line current is determined from line voltage

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const formatValue = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export const isOffline = (s: Sensor) => Boolean(s.error) || s.connected === false;

// What is out of range in one set of measurements, given the nominal voltage and ampacity
export function warningsFor(
  data: Measurement[] | undefined,
  nominalVolts: number | undefined,
  ratedAmps: number | undefined,
): string[] {
  if (!data || nominalVolts === undefined || ratedAmps === undefined) return [];
  const valueOf = (...names: string[]) => data.find((m) => names.includes(m.name))?.value;
  const out: string[] = [];

  const volts = valueOf('voltage', 'primary_voltage');
  if (volts !== undefined && volts > nominalVolts * VOLTAGE_WARN_RATIO) {
    out.push(`Voltage ${((volts / nominalVolts - 1) * 100).toFixed(1)}% above nominal`);
  }
  const amps = valueOf('current', 'load_current');
  if (amps !== undefined && amps > ratedAmps * CURRENT_WARN_RATIO) {
    out.push(`Current at ${((amps / ratedAmps) * 100).toFixed(0)}% of rated`);
  }
  return out;
}

// what is out of range for a sensor
export function warningsOf(s: Sensor): string[] {
  if (isOffline(s)) return [];
  return warningsFor(s.data, s.nominalVolts, s.ratedAmps);
}

// how long after its last warning a device that is back in range stays in the recent warning category
export const RECENT_WARN_MS = 10 * 60 * 1000;

// true if warned within above timeframe
export function isRecentlyWarned(s: Sensor, now: number = Date.now()): boolean {
  return (
    s.lastWarnedAt !== undefined &&
    now - s.lastWarnedAt <= RECENT_WARN_MS &&
    !isOffline(s) &&
    warningsOf(s).length === 0
  );
}

export function agoLabel(ms: number, now: number = Date.now()): string {
  const mins = Math.floor((now - ms) / 60000);
  return mins < 1 ? 'less than 1 min ago' : `${mins} min ago`;
}

// scans history of a device to find the last warning value (for loading up recent warnings list on page load/reload)
export function lastWarningIn(entries: HistoryEntry[], nominalVolts: number, ratedAmps: number, now: number = Date.now() ): { at: number; warnings: string[] } | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const at = Date.parse(entries[i].timestamp);
    if (Number.isNaN(at)) continue;
    if (now - at > RECENT_WARN_MS) break; // everything before this is older than the check range
    const warnings = warningsFor(entries[i].data, nominalVolts, ratedAmps);
    if (warnings.length > 0) return { at, warnings };
  }
  return undefined;
}

export function statusOf(s: Sensor): Status {
  if (isOffline(s)) return 'offline';
  if (warningsOf(s).length > 0) return 'warning';
  if (isRecentlyWarned(s)) return 'recent';
  if (s.state === 'open') return 'open';
  return 'online';
}

export function statusLabel(s: Sensor): string {
  const status = statusOf(s);
  if (status === 'offline') return 'Offline';
  if (status === 'warning') return 'Warning';
  if (status === 'recent') return 'Recent warning';
  return s.state ? capitalize(s.state) : 'Online';
}



// ---- nearest power line calculation ---------------------
// TODO: this portion of code was built before the ~300 sensor locations were decided, and the line voltage included in their device data. Sensor devices now contain their line voltages and thus a more
// apt structure would have said line voltage data be communicated to the modbus server, and to this HMI. However, until this restructuring is made, the HMI determines line voltage itself from the geojson data
// of the tranmission lines. Warnings should also be determined in the sensors themselves, and communicated in polled responses, not done here on the frontend.

export const LINES_URL = '/powerlines.geojson';

// takes line from file with required data
export type Line = { kv: number; coords: number[][] }; // coords are [longitude, latitude]

// Flatten the Geojson into lines for future checks
export function parseLines(geojson: any): Line[] {
  const lines: Line[] = [];
  for (const f of geojson?.features ?? []) {
    const kv = parseFloat(String(f.properties?.VOLTAGE));
    if (Number.isNaN(kv)) continue;
    const g = f.geometry;
    if (g?.type === 'LineString') lines.push({ kv, coords: g.coordinates });
    else if (g?.type === 'MultiLineString') for (const part of g.coordinates) lines.push({ kv, coords: part });
  }
  return lines;
}

// Voltage (in kV) of the line segment closest to a point
export function nearestLineKv(lon: number, lat: number, lines: Line[]): number | undefined {
  const k = Math.cos((lat * Math.PI) / 180);
  let bestDist = Infinity;
  let bestKv: number | undefined;

  for (const line of lines) {
    const c = line.coords;
    for (let i = 0; i < c.length - 1; i++) {
      // segment end points relative to the sensor, so the sensor is at (0, 0).
      const ax = (c[i][0] - lon) * k;
      const ay = c[i][1] - lat;
      const dx = (c[i + 1][0] - lon) * k - ax;
      const dy = c[i + 1][1] - lat - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const dist = px * px + py * py;
      if (dist < bestDist) {
        bestDist = dist;
        bestKv = line.kv;
      }
    }
  }
  return bestKv;
}

// request the backend for the latest data for a device
export async function readSensor(id: string): Promise<Partial<Sensor>> {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'read', id }),
    });
    const body = await res.json();
    if (!body.ok) return { error: body.error ?? 'The backend rejected the request' };
    return {
      type: body.type,
      latitude: body.lat,
      longitude: body.lon,
      timestamp: body.timestamp,
      connected: body.connected,
      state: body.state,
      data: body.data,
      error: undefined,
    };
  } catch {
    return { error: 'Backend unreachable' };
  }
}

// Ask the backend for a device's stored history (set standard is last 500 entries)
export async function readHistory( id: string ): Promise<{ type: string; entries: HistoryEntry[] } | { error: string }> {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'history', id }),
    });
    const body = await res.json();
    if (!body.ok) return { error: body.error ?? 'The backend rejected the request' };
    return { type: body.type, entries: body.history ?? [] };
  } catch {
    return { error: 'Backend unreachable' };
  }
}

// Ask the backend to open or close one recloser, if success, backend sends read state of said recloser
export async function sendCommand(id: string, command: 'open' | 'close'): Promise<{ state: string } | { error: string }> {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, id }),
    });
    const body = await res.json();
    if (!body.ok) return { error: body.error ?? 'The backend rejected the command' };
    return { state: body.state };
  } catch {
    return { error: 'Backend unreachable' };
  }
}