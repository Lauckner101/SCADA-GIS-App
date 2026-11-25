import { useEffect, useRef, useState } from 'react';
import Map, { Marker, Popup, Source, Layer } from 'react-map-gl/maplibre';
import type { MapLayerMouseEvent, MapRef } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { iconFor, LEGEND } from './icons';
import { initialSensors, POLL_MS, LINES_URL, AMPS_PER_VOLT, typeLabels, statusColor, capitalize, formatValue, warningsOf, lastWarningIn, isRecentlyWarned, agoLabel, statusOf, statusLabel, parseLines, nearestLineKv, readSensor, readHistory, sendCommand } from './sensors';
import type { Sensor, HistoryView, Line } from './sensors';
import { HistoryPanel, DeviceListPanel, HOVER_CSS } from './panels';

const MAX_SEARCH_RESULTS = 50; // for search bar
const SEARCH_ZOOM = 15; // map zoom when clicking on searched/warned item

export default function App() {
  const [sensors, setSensors] = useState<Sensor[]>(initialSensors);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const mapRef = useRef<MapRef>(null);
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<Line[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null); // recloser with a command in sent
  const [commandError, setCommandError] = useState<{ id: string; message: string } | null>(null);
  const [history, setHistory] = useState<HistoryView | null>(null); // for opening history panel
  const historyRequest = useRef(0); // allows stale reply be ignored
  const backfilled = useRef(new Set<string>()); // devices whose history was already scanned on load
  const [lineInfo, setLineInfo] = useState<{
    lng: number;
    lat: number;
    props: Record<string, any>;
  } | null>(null);

  // polls every sensor once per interval (The next round occurs after the current one finishes to avoid build up of slow replies).
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      const results = await Promise.all(
        initialSensors.map(async (s) => ({ id: s.id, update: await readSensor(s.id) })),
      );
      if (cancelled) return;
      const now = Date.now();
      setSensors((prev) =>
        prev.map((s) => {
          const r = results.find((x) => x.id === s.id);
          if (!r) return s;
          const merged = { ...s, ...r.update };

          // remember when the device was last in warning list (see isRecentlyWarned).
          const warnings = warningsOf(merged);
          if (warnings.length > 0) {
            merged.lastWarnedAt = now;
            merged.lastWarnings = warnings;
          }
          return merged;
        }),
      );
      timer = window.setTimeout(poll, POLL_MS);
    };

    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  // Loads the power lines once at page load
  useEffect(() => {
    let cancelled = false;
    fetch(LINES_URL)
      .then((res) => res.json())
      .then((geojson) => {
        if (!cancelled) setLines(parseLines(geojson));
      })
      .catch((err) => console.error('Could not load power line map data:', err));
    return () => {
      cancelled = true;
    };
  }, []);

  // once a sensor has a location and the lines are loaded, we find its nearest line and store that line's voltage and ampacity on the sensor data. runs once per sensor and skips once with existing voltages.
  useEffect(() => {
    if (!lines) return;
    const pending = sensors.filter(
      (s) => s.latitude !== undefined && s.longitude !== undefined && s.nominalVolts === undefined,
    );
    if (pending.length === 0) return;

    const found: Record<string, number> = {}; // sensor id linked to line kV
    for (const s of pending) {
      const kv = nearestLineKv(s.longitude!, s.latitude!, lines);
      if (kv !== undefined) found[s.id] = kv;
    }
    if (Object.keys(found).length === 0) return;

    // sets found values
    setSensors((prev) =>
      prev.map((s) => {
        const kv = found[s.id];
        if (kv === undefined || s.nominalVolts !== undefined) return s;
        const volts = kv * 1000;
        return { ...s, nominalVolts: volts, ratedAmps: volts * AMPS_PER_VOLT };
      }),
    );
  }, [lines, sensors]);

  // On page load, rebuild the "recent warnings" list from stored history. Each
  // line post and transformer has its history requested once, as soon as its
  // nearest line is known (the thresholds are needed to judge a reading). Only
  // the last 10 minutes of the (up to 500) stored readings are considered. A
  // warning seen live in the meantime wins if it is newer.


  // rebuilds recent warnings list on page reload. each sensors (not including reclosers) 
  // have their historical data requested once, once the line voltage/current is found, the last 500 entires are pulled and analyzed for warning levels.
  useEffect(() => {
    for (const s of sensors) {
      const nominal = s.nominalVolts;
      const rated = s.ratedAmps;
      if (s.type === undefined || s.type === 'acr' || nominal === undefined || rated === undefined) continue;
      if (backfilled.current.has(s.id)) continue;
      backfilled.current.add(s.id);

      const id = s.id;
      readHistory(id).then((result) => {
        if ('error' in result) return;
        const found = lastWarningIn(result.entries, nominal, rated);
        if (!found) return;
        setSensors((prev) =>
          prev.map((x) =>
            x.id === id && found.at > (x.lastWarnedAt ?? 0)
              ? { ...x, lastWarnedAt: found.at, lastWarnings: found.warnings }
              : x,
          ),
        );
      });
    }
  }, [sensors]);


  // Looks up the state on every frame so the open popup stays live
  const selected = sensors.find((s) => s.id === selectedId);
  const historySensor = history ? sensors.find((s) => s.id === history.id) : undefined;

  // detect if backend is unreachable, every failed request indicates this
  const backendDown = sensors.every((s) => s.error === 'Backend unreachable');
  const warned = sensors.map((s) => ({ sensor: s, reasons: warningsOf(s) })).filter((w) => w.reasons.length > 0);
  const nowMs = Date.now();
  const recentlyWarned = sensors.filter((s) => isRecentlyWarned(s, nowMs)).sort((a, b) => b.lastWarnedAt! - a.lastWarnedAt!); // most recent first

  // search matches on based on id and ignores casing, hides when no text in search
  const trimmedQuery = query.trim().toLowerCase();
  const matches = trimmedQuery ? sensors.filter((s) => s.id.toLowerCase().includes(trimmedQuery)) : [];
  const shownMatches = matches.slice(0, MAX_SEARCH_RESULTS);

  // Zoom the map to a sensor and open its popup when clicked
  const goToSensor = (s: Sensor) => {
    if (s.latitude === undefined || s.longitude === undefined) return;
    mapRef.current?.flyTo({ center: [s.longitude, s.latitude], zoom: SEARCH_ZOOM, duration: 1500 });
    setLineInfo(null);
    setSelectedId(s.id);
    setQuery(''); // clear search
  };

  // open or close a recloser, after extra popup is confirmed
  const handleCommand = async (s: Sensor, command: 'open' | 'close') => {
    if (!window.confirm(`${capitalize(command)} recloser ${s.id}?`)) return;
    setPendingId(s.id);
    setCommandError(null);
    const result = await sendCommand(s.id, command);
    setPendingId(null);
    if ('error' in result) {
      setCommandError({ id: s.id, message: result.error });
      return;
    }
    // Show the state the device reported right away instead of waiting for the next poll (sensors send state after reciving command as acknowledgement).
    setSensors((prev) => prev.map((x) => (x.id === s.id ? { ...x, state: result.state } : x)));
  };

  // requests history and shows it in the panel. Used for both the first load and Refresh. Rows already shown stay on screen during a refresh.
  const loadHistory = async (id: string, type?: string) => {
    const req = ++historyRequest.current;
    setHistory((prev) =>
      prev && prev.id === id
        ? { ...prev, loading: true, error: undefined }
        : { id, type, entries: [], loading: true },
    );
    const result = await readHistory(id);
    if (req !== historyRequest.current) return;
    setHistory((prev) => {
      if (!prev || prev.id !== id) return prev;
      if ('error' in result) return { ...prev, loading: false, error: result.error };
      return {
        ...prev,
        type: result.type,
        entries: result.entries,
        loading: false,
        error: undefined,
        fetchedAt: new Date(),
      };
    });
  };

  const closeHistory = () => {
    historyRequest.current++; // drop any reply still on its way
    setHistory(null);
  };

  const handleMapClick = (e: MapLayerMouseEvent) => {
    const feature = e.features?.[0];
    if (feature) {
      setLineInfo({
        lng: e.lngLat.lng,
        lat: e.lngLat.lat,
        props: feature.properties ?? {},
      });
    } else {
      setLineInfo(null);
    }
  };

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      <style>{HOVER_CSS}</style>
      <Map
        ref={mapRef}
        initialViewState={{ longitude: -113.49, latitude: 53.55, zoom: 8 }}
        style={{ width: '100%', height: '100%' }}
        mapStyle="https://tiles.openfreemap.org/styles/liberty"
        interactiveLayerIds={['power-lines-layer']}
        onClick={handleMapClick}
        onError={(e) => console.error('Map error:', e)}
      >
        <Source id="power-lines" type="geojson" data="/powerlines.geojson">
          <Layer
            id="power-lines-layer"
            type="line"
            paint={{
              'line-color': [
                'match', ['get', 'VOLTAGE'],
                '500kV', '#7c3aed',
                '240kV', '#e11d48',
                '138kV', '#f97316',
                '69kV',  '#eab308',
                '#6b7280', // fallback
              ],
              'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.5, 12, 4],
            }}
          />
        </Source>

        {/* sensor gets a marker once the backend has told us where it is */}
        {sensors.map((s) =>
          s.latitude === undefined || s.longitude === undefined ? null : (
            <Marker
              key={s.id}
              latitude={s.latitude}
              longitude={s.longitude}
              anchor="center"
              onClick={(e) => {
                e.originalEvent.stopPropagation();
                setSelectedId(s.id);
              }}
            >
              {(() => {
                const Icon = iconFor(s);
                return (
                  <Icon
                    size={28}
                    color={statusColor[statusOf(s)]}
                    style={{
                      cursor: 'pointer',
                      // White outline for icon
                      filter: 'drop-shadow(1px 0 0 white) drop-shadow(-1px 0 0 white) drop-shadow(0 1px 0 white) drop-shadow(0 -1px 0 white)',
                    }}
                  />
                );
              })()}
            </Marker>
          ),
        )}

        {selected && selected.latitude !== undefined && selected.longitude !== undefined && (
          <Popup
            latitude={selected.latitude}
            longitude={selected.longitude}
            anchor="bottom"
            offset={18}
            onClose={() => setSelectedId(null)}
          >
            <div style={{ minWidth: 200, color: '#111' }}>
              <strong>{selected.id}</strong>
              <div>Type: {selected.type ? (typeLabels[selected.type] ?? selected.type) : 'Unknown'}</div>
              {selected.data?.map((m) => (
                <div key={m.name}>
                  {capitalize(m.name.replace(/_/g, ' '))}: {formatValue(m.value)} {m.unit}
                </div>
              ))}
              {selected.nominalVolts !== undefined && selected.ratedAmps !== undefined && (
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  Line: {formatValue(selected.nominalVolts / 1000)} kV, rated {formatValue(selected.ratedAmps)} A
                </div>
              )}
              <div>
                Status:{' '}
                <span style={{ color: statusColor[statusOf(selected)], fontWeight: 600 }}>
                  {statusLabel(selected)}
                </span>
              </div>
              {warningsOf(selected).map((w) => (
                <div key={w} style={{ color: '#b91c1c', fontWeight: 600, fontSize: 12 }}>
                  {w}
                </div>
              ))}
              {isRecentlyWarned(selected) && (
                <div style={{ color: '#c2410c', fontSize: 12 }}>
                  <div style={{ fontWeight: 600 }}>Last warning {agoLabel(selected.lastWarnedAt!)}:</div>
                  {selected.lastWarnings?.map((w) => (
                    <div key={w}>{w}</div>
                  ))}
                </div>
              )}
              {selected.error && (
                <div style={{ color: '#b91c1c', fontSize: 12 }}>{selected.error}</div>
              )}
              {selected.type === 'acr' && (
                <div style={{ marginTop: 8 }}>
                  <button
                    onClick={() => handleCommand(selected, selected.state === 'open' ? 'close' : 'open')}
                    disabled={
                      pendingId === selected.id ||
                      statusOf(selected) === 'offline' ||
                      (selected.state !== 'open' && selected.state !== 'closed')
                    }
                    style={{
                      padding: '4px 12px',
                      borderRadius: 4,
                      border: '1px solid #9ca3af',
                      background: '#f3f4f6',
                      color: '#111',
                      cursor: 'pointer',
                    }}
                  >
                    {pendingId === selected.id
                      ? 'Sending…'
                      : selected.state === 'open'
                        ? 'Close recloser'
                        : 'Open recloser'}
                  </button>
                  {commandError?.id === selected.id && (
                    <div style={{ color: '#b91c1c', fontSize: 12, marginTop: 4 }}>
                      {commandError.message}
                    </div>
                  )}
                </div>
              )}
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={() => loadHistory(selected.id, selected.type)}
                  style={{
                    padding: '4px 12px',
                    borderRadius: 4,
                    border: '1px solid #9ca3af',
                    background: '#f3f4f6',
                    color: '#111',
                    cursor: 'pointer',
                  }}
                >
                  Historical Data
                </button>
              </div>
              {selected.timestamp && (
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  Updated {new Date(selected.timestamp).toLocaleTimeString()}
                </div>
              )}
            </div>
          </Popup>
        )}

        {lineInfo && (
          <Popup longitude={lineInfo.lng} latitude={lineInfo.lat} onClose={() => setLineInfo(null)}>
            <div style={{ color: '#111' }}>
              <strong>Transmission line</strong>
              <div>Voltage: {String(lineInfo.props.VOLTAGE)}</div>
            </div>
          </Popup>
        )}
      </Map>

      {/* Search bar, find a device by id and fly to it */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          right: history ? 512 : 12, // beside the history panel when it is open
          zIndex: 1,
          width: 240,
          fontSize: 13,
          color: '#111',
        }}
      >
        <input
          type="text"
          value={query}
          placeholder="Search devices by id…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shownMatches.length > 0) goToSensor(shownMatches[0]);
            if (e.key === 'Escape') setQuery('');
          }}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '8px 12px',
            borderRadius: 6,
            border: 'none',
            background: 'white',
            color: '#111',
            fontSize: 13,
            boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
          }}
        />
        {trimmedQuery && (
          <div
            style={{
              marginTop: 4,
              maxHeight: 260,
              overflowY: 'auto',
              borderRadius: 6,
              background: 'white',
              boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
            }}
          >
            {shownMatches.length === 0 && <div style={{ padding: '8px 12px', opacity: 0.7 }}>No matches</div>}
            {shownMatches.map((s) => {
              const located = s.latitude !== undefined && s.longitude !== undefined;
              return (
                <button
                  key={s.id}
                  className="hover-row"
                  onClick={() => goToSensor(s)}
                  disabled={!located}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: '6px 12px',
                    border: 'none',
                    color: '#111',
                    fontSize: 13,
                    textAlign: 'left',
                    cursor: located ? 'pointer' : 'default',
                    opacity: located ? 1 : 0.5,
                  }}
                >
                  <span>{s.id}</span>
                  <span style={{ opacity: 0.6 }}>
                    {located ? (s.type ? (typeLabels[s.type] ?? s.type) : '') : 'No location yet'}
                  </span>
                </button>
              );
            })}
            {matches.length > shownMatches.length && (
              <div style={{ padding: '6px 12px', opacity: 0.6 }}>
                Showing {shownMatches.length} of {matches.length}. Keep typing to narrow it down.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Left column: legend, warnings list, and recent warnings list*/}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          bottom: 36,
          width: 260,
          zIndex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none', // only the boxes take clicks
        }}
      >
        {/* Legend */}
        <div
          style={{
            pointerEvents: 'auto',
            flex: 'none',
            padding: '8px 12px',
            borderRadius: 6,
            background: 'white',
            color: '#111',
            fontSize: 13,
            boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Legend</div>
          {LEGEND.map(({ Icon, label }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
              <Icon size={20} color="#374151" />
              <span>{label}</span>
            </div>
          ))}
        </div>
        <DeviceListPanel
          title="Warnings"
          titleColor={statusColor.warning}
          items={warned.map(({ sensor, reasons }) => ({ sensor, lines: reasons }))}
          emptyText="No devices in warning"
          onPick={goToSensor}
        />
        <DeviceListPanel
          title="Recent warnings (last 10 mins)"
          titleColor={statusColor.recent}
          items={recentlyWarned.map((sensor) => ({
            sensor,
            lines: [`Last warning ${agoLabel(sensor.lastWarnedAt!, nowMs)}`],
          }))}
          emptyText="No recent warnings"
          onPick={goToSensor}
        />
      </div>

      {/* backend detected to be down*/}
      {backendDown && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 2,
            padding: '8px 16px',
            borderRadius: 6,
            background: '#fef2f2',
            color: '#b91c1c',
            border: '1px solid #fca5a5',
            fontSize: 13,
            fontWeight: 600,
            boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
          }}
        >
          Backend unreachable. Retrying…
        </div>
      )}

      {/* historical data for device selected */}
      {history && (
        <HistoryPanel
          view={history}
          nominalVolts={historySensor?.nominalVolts}
          ratedAmps={historySensor?.ratedAmps}
          onRefresh={() => loadHistory(history.id, history.type)}
          onClose={closeHistory}
        />
      )}
    </div>
  );
}