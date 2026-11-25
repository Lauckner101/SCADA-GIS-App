// panel data/functions for history, warnings, etc.

import { typeLabels, capitalize, formatValue, warningsFor } from './sensors';
import type { Sensor, HistoryView, HistoryEntry } from './sensors';

// Hover highlight for clickable rows
export const HOVER_CSS = `
.hover-row { background: white; }
.hover-row:hover:not(:disabled) { background: #f3f4f6; }
`;

// ---- History panel -------------

const thStyle: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  background: '#f3f4f6',
  padding: '6px 8px',
  textAlign: 'right',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid #d1d5db',
};
const tdStyle: React.CSSProperties = {
  padding: '4px 8px',
  textAlign: 'right',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid #e5e7eb',
  fontVariantNumeric: 'tabular-nums',
};


export function HistoryPanel({
  view,
  nominalVolts,
  ratedAmps,
  onRefresh,
  onClose,
}: {
  view: HistoryView;
  nominalVolts?: number; 
  ratedAmps?: number;
  onRefresh: () => void;
  onClose: () => void;
}) {
  // what a stored reading had out of range
  const entryWarnings = (e: HistoryEntry) => warningsFor(e.data, nominalVolts, ratedAmps);
  const isRecloser = view.type === 'acr';

  const columns: { name: string; unit: string }[] = [];
  for (const e of view.entries) {
    for (const m of e.data ?? []) {
      if (!columns.some((c) => c.name === m.name)) columns.push({ name: m.name, unit: m.unit });
    }
  }

  // backend sends oldest first, so reverse data
  const rows = [...view.entries].reverse();

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 500,
        maxWidth: '100vw',
        zIndex: 3,
        display: 'flex',
        flexDirection: 'column',
        background: 'white',
        color: '#111',
        fontSize: 13,
        boxShadow: '-2px 0 8px rgba(0,0,0,0.3)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: '1px solid #d1d5db',
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{view.id} history</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            {view.type ? (typeLabels[view.type] ?? view.type) + ' · ' : ''}
            {view.entries.length} readings
            {view.fetchedAt && ` · loaded ${view.fetchedAt.toLocaleTimeString()}`}
          </div>
        </div>
        <button
          onClick={onRefresh}
          disabled={view.loading}
          style={{
            padding: '4px 12px',
            borderRadius: 4,
            border: '1px solid #9ca3af',
            background: '#f3f4f6',
            color: '#111',
            cursor: view.loading ? 'default' : 'pointer',
          }}
        >
          {view.loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          onClick={onClose}
          aria-label="Close history"
          style={{
            padding: '2px 8px',
            border: 'none',
            background: 'white',
            color: '#111',
            fontSize: 20,
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      </div>

      {view.error && (
        <div style={{ padding: '8px 12px', color: '#b91c1c' }}>{view.error}</div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        {!view.error && view.loading && view.entries.length === 0 && (
          <div style={{ padding: 12, opacity: 0.7 }}>Loading…</div>
        )}
        {!view.error && !view.loading && view.entries.length === 0 && (
          <div style={{ padding: 12, opacity: 0.7 }}>No readings stored for this device yet.</div>
        )}
        {view.entries.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, textAlign: 'left' }}>Time</th>
                {isRecloser ? (
                  <th style={thStyle}>State</th>
                ) : (
                  columns.map((c) => (
                    <th key={c.name} style={thStyle}>
                      {capitalize(c.name.replace(/_/g, ' '))} ({c.unit})
                    </th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr
                  key={e.timestamp}
                  style={entryWarnings(e).length > 0 ? { background: '#fee2e2', color: '#991b1b' } : undefined}
                  title={entryWarnings(e).join(', ') || undefined}
                >
                  <td style={{ ...tdStyle, textAlign: 'left' }}>
                    {new Date(e.timestamp).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                      hour12: false,
                    })}
                  </td>
                  {isRecloser ? (
                    <td style={tdStyle}>{e.state ? capitalize(e.state) : '–'}</td>
                  ) : (
                    columns.map((c) => {
                      const m = e.data?.find((x) => x.name === c.name);
                      return (
                        <td key={c.name} style={tdStyle}>
                          {m ? formatValue(m.value) : '–'}
                        </td>
                      );
                    })
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// warning panels, adjust automatically to avoid overlap or extending off screen
export function DeviceListPanel({
  title,
  titleColor,
  items,
  emptyText,
  onPick,
}: {
  title: string;
  titleColor: string;
  items: { sensor: Sensor; lines: string[] }[];
  emptyText: string;
  onPick: (s: Sensor) => void;
}) {
  return (
    <div
      style={{
        pointerEvents: 'auto',
        flex: '0 1 auto',
        minHeight: 56,
        overflowY: 'auto',
        padding: '8px 12px',
        borderRadius: 6,
        background: 'white',
        color: '#111',
        fontSize: 13,
        boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {title}
        {items.length > 0 && ` (${items.length})`}
      </div>
      {items.length === 0 && <div style={{ opacity: 0.7 }}>{emptyText}</div>}
      {items.map(({ sensor, lines }) => (
        <button
          key={sensor.id}
          className="hover-row"
          onClick={() => onPick(sensor)}
          style={{
            display: 'block',
            width: 'calc(100% + 24px)', // cancels the box's 12px side padding
            margin: '0 -12px',
            padding: '4px 12px',
            border: 'none',
            borderTop: '1px solid #e5e7eb',
            color: '#111',
            fontSize: 13,
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <div style={{ fontWeight: 600, color: titleColor }}>{sensor.id}</div>
          {lines.map((l) => (
            <div key={l} style={{ fontSize: 12, opacity: 0.8 }}>
              {l}
            </div>
          ))}
        </button>
      ))}
    </div>
  );
}