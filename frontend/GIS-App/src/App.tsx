import { useState } from 'react';
import Map, { Marker, Popup, Source, Layer } from 'react-map-gl/maplibre';
import type { MapLayerMouseEvent } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';

type Sensor = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  status: 'ok' | 'warning' | 'alarm';
  reading: string;
  updated: string;
};

const sensors: Sensor[] = [
  { id: 'pt-101', name: 'Pressure Transmitter 101', latitude: 53.55, longitude: -113.49, status: 'ok', reading: '412 kPa', updated: '12:04:31' },
  { id: 'ft-202', name: 'Flow Meter 202', latitude: 53.58, longitude: -113.42, status: 'warning', reading: '38.2 L/s', updated: '12:04:29' },
  { id: 'lt-303', name: 'Tank Level 303', latitude: 53.52, longitude: -113.55, status: 'alarm', reading: '96 %', updated: '12:04:30' },
];

const statusColor = { ok: '#22c55e', warning: '#f59e0b', alarm: '#ef4444' };

export default function App() {
  const [selected, setSelected] = useState<Sensor | null>(null);
  const [lineInfo, setLineInfo] = useState<{
    lng: number;
    lat: number;
    props: Record<string, any>;
  } | null>(null);

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
    <div style={{ width: '100vw', height: '100vh' }}>
      <Map
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
                '#6b7280', // fallback for anything else
              ],
              'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.5, 12, 4],
            }}
          />
        </Source>

        {sensors.map((s) => (
          <Marker
            key={s.id}
            latitude={s.latitude}
            longitude={s.longitude}
            anchor="center"
            onClick={(e) => {
              e.originalEvent.stopPropagation();
              setSelected(s);
            }}
          >
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: statusColor[s.status],
                border: '2px solid white',
                boxShadow: '0 0 4px rgba(0,0,0,0.5)',
                cursor: 'pointer',
              }}
            />
          </Marker>
        ))}

        {selected && (
          <Popup
            latitude={selected.latitude}
            longitude={selected.longitude}
            anchor="bottom"
            offset={14}
            onClose={() => setSelected(null)}
          >
            <div style={{ minWidth: 180, color: '#111' }}>
              <strong>{selected.name}</strong>
              <div>ID: {selected.id}</div>
              <div>Reading: {selected.reading}</div>
              <div>
                Status:{' '}
                <span style={{ color: statusColor[selected.status], fontWeight: 600 }}>
                  {selected.status.toUpperCase()}
                </span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Updated {selected.updated}</div>
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
    </div>
  );
}