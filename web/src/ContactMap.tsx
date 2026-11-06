import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LocationShare } from './types';
export function ContactMap({
  locations,
  names,
}: {
  locations: LocationShare[];
  names: Record<string, string>;
}) {
  const container = useRef<HTMLDivElement>(null),
    map = useRef<L.Map | null>(null),
    markers = useRef<L.LayerGroup | null>(null);
  const [tileError, setTileError] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    const instance = L.map(container.current, { scrollWheelZoom: false }).setView([34, 105], 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
      referrerPolicy: 'strict-origin-when-cross-origin',
    })
      .on('tileerror', () => setTileError(true))
      .addTo(instance);
    map.current = instance;
    markers.current = L.layerGroup().addTo(instance);
    const resize = new ResizeObserver(() => instance.invalidateSize());
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      instance.remove();
      map.current = null;
      markers.current = null;
    };
  }, []);
  const fingerprint = JSON.stringify(locations);
  useEffect(() => {
    const instance = map.current,
      group = markers.current;
    if (!instance || !group) return;
    group.clearLayers();
    const bounds: L.LatLngTuple[] = [];
    for (const point of locations) {
      const coords: L.LatLngTuple = [point.latitude, point.longitude];
      bounds.push(coords);
      const label = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = names[point.userId] || '联系人';
      label.append(title);
      const detail = document.createElement('p');
      detail.textContent = `约 ${Math.round(point.accuracy)} 米范围 · ${new Date(point.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新`;
      label.append(detail);
      L.circle(coords, {
        radius: Math.min(point.accuracy, 50000),
        weight: 1,
        color: '#668a75',
        fillOpacity: 0.1,
      }).addTo(group);
      L.marker(coords, {
        icon: L.divIcon({
          className: 'contact-map-pin',
          html: '<span>✦</span>',
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        }),
      })
        .bindPopup(label)
        .addTo(group);
    }
    if (bounds.length) instance.fitBounds(bounds, { padding: [48, 48], maxZoom: 13 });
  }, [fingerprint, JSON.stringify(names)]);
  return (
    <>
      <div ref={container} className="contact-map" aria-label="联系人共享位置地图" />
      {tileError && (
        <p className="field-help">
          底图暂未能加载。下方坐标列表仍可查看；地图需要设备能访问 OpenStreetMap。
        </p>
      )}
    </>
  );
}
