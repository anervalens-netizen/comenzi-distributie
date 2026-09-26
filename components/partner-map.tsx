'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import {
  createMapResourceHealth,
  mapResourceKey,
  type MapResourceEvent,
} from '@/lib/partner-map-health';
import type { Map as MapLibreMap, GeoJSONSource, Popup } from 'maplibre-gl';
import type { MapBounds, PartnerMapData } from '@/lib/partner-map-types';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

const empty = (): PartnerMapData => ({
  type: 'FeatureCollection',
  features: [],
});
const SOURCE = 'partners';
export default function PartnerMap({
  filters,
  bounds,
  styleUrl,
  refreshKey,
  onSelect,
}: {
  filters: string;
  bounds: MapBounds | null | undefined;
  styleUrl: string;
  refreshKey: number;
  onSelect: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    map = useRef<MapLibreMap | null>(null),
    select = useRef(onSelect);
  const [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [dataError, setDataError] = useState(''),
    [resourceError, setResourceError] = useState(''),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  const boundsKey = JSON.stringify(bounds);
  useEffect(() => {
    select.current = onSelect;
  }, [onSelect]);
  useEffect(() => {
    let cancelled = false,
      styleLoaded = false,
      popup: Popup | undefined,
      hover: Popup | undefined,
      observer: ResizeObserver | undefined;
    const health = createMapResourceHealth((degraded) => {
      if (!cancelled)
        setResourceError(
          degraded
            ? 'Unele resurse ale hărții nu au putut fi încărcate. Harta poate fi incompletă; lista și fișele rămân disponibile.'
            : '',
        );
    });
    void import('maplibre-gl')
      .then((L) => {
        if (cancelled || !host.current) return;
        setReady(false);
        setLoading(true);
        setError('');
        setDataError('');
        setResourceError('');
        // V6 ESM workers must go through Vite's worker pipeline, including shared code.
        L.setWorkerUrl(workerUrl);
        const m = new L.Map({
          container: host.current,
          style: styleUrl,
          center: [24.96, 45.94],
          zoom: 5.5,
          minZoom: 2,
          maxZoom: 19,
          renderWorldCopies: false,
          dragRotate: false,
          touchPitch: false,
          attributionControl: { compact: true },
        });
        map.current = m;
        m.touchZoomRotate.disableRotation();
        m.addControl(
          new L.NavigationControl({ showCompass: false }),
          'top-right',
        );
        observer = new ResizeObserver(() => m.resize());
        observer.observe(host.current);
        m.on('error', (event) => {
          if (cancelled) return;
          if (!styleLoaded) {
            setError(
              'Harta de fundal nu poate fi încărcată. Lista și fișele partenerilor rămân disponibile.',
            );
            return;
          }
          const resource = event as typeof event & MapResourceEvent;
          const sourceId = resource.sourceId;
          const tileId = resource.tile?.tileID?.canonical;
          // One bounded retry for a failed tile (including glyph-dependent tiles).
          // Only successful data for that same resource confirms recovery; idle
          // and unrelated successful tiles also occur during a provider outage.
          health.fail(
            mapResourceKey(resource),
            sourceId && tileId
              ? () => {
                  if (m.getSource(sourceId)) m.refreshTiles(sourceId, [tileId]);
                }
              : undefined,
          );
        });
        m.on('sourcedata', (event) => {
          if (cancelled) return;
          if (
            (event.sourceDataType === 'content' &&
              event.tile?.state === 'loaded') ||
            (event.sourceDataType === 'metadata' && !event.tile)
          )
            health.recover(mapResourceKey(event));
        });
        m.on('webglcontextlost', () => {
          if (!cancelled)
            setError(
              'Afișarea hărții a fost întreruptă. Reîncearcă sau folosește lista.',
            );
        });
        m.on('style.load', () => {
          if (cancelled) return;
          styleLoaded = true;
          m.addSource(SOURCE, {
            type: 'geojson',
            data: empty(),
            cluster: true,
            clusterRadius: 50,
            clusterMaxZoom: 15,
          });
          m.addLayer({
            id: 'partner-clusters',
            type: 'circle',
            source: SOURCE,
            filter: ['has', 'point_count'],
            paint: {
              'circle-color': '#176b62',
              'circle-radius': [
                'step',
                ['get', 'point_count'],
                19,
                100,
                24,
                1000,
                30,
              ],
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
            },
          });
          m.addLayer({
            id: 'partner-counts',
            type: 'symbol',
            source: SOURCE,
            filter: ['has', 'point_count'],
            layout: {
              'text-field': ['get', 'point_count_abbreviated'],
              'text-font': ['Noto Sans Regular'],
              'text-size': 13,
              'text-allow-overlap': true,
            },
            paint: { 'text-color': '#ffffff' },
          });
          m.addLayer({
            id: 'partner-points',
            type: 'circle',
            source: SOURCE,
            filter: ['!', ['has', 'point_count']],
            paint: {
              'circle-radius': 7,
              'circle-color': [
                'case',
                ['get', 'approximate'],
                '#f0ad35',
                '#2da792',
              ],
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            },
          });
          hover = new L.Popup({ closeButton: false, closeOnClick: false });
          popup = new L.Popup({ closeButton: true, closeOnClick: true });
          m.on('movestart', () => {
            hover?.remove();
            popup?.remove();
          });
          for (const layer of ['partner-clusters', 'partner-points']) {
            m.on('mouseenter', layer, () => {
              m.getCanvas().style.cursor = 'pointer';
            });
            m.on('mouseleave', layer, () => {
              m.getCanvas().style.cursor = '';
              hover?.remove();
            });
          }
          m.on('mousemove', 'partner-points', (e) => {
            const p = e.features?.[0];
            if (p?.geometry.type === 'Point')
              hover
                ?.setLngLat(p.geometry.coordinates as [number, number])
                .setText(
                  String(p.properties.name) +
                    (p.properties.approximate ? ' · poziție aproximativă' : ''),
                )
                .addTo(m);
          });
          m.on('click', 'partner-points', (e) => {
            hover?.remove();
            popup?.remove();
            const points = [
              ...new Map(
                (e.features || []).map((p) => [String(p.properties.id), p]),
              ).values(),
            ];
            if (points.length === 1) {
              select.current(String(points[0].properties.id));
              return;
            }
            // Several work locations can share coordinates. Never silently select the first.
            const choices = document.createElement('div');
            choices.className = 'partner-map-choices';
            const title = document.createElement('strong');
            title.textContent = `${points.length} puncte suprapuse`;
            choices.appendChild(title);
            for (const p of points.slice(0, 30)) {
              const button = document.createElement('button');
              button.type = 'button';
              button.textContent = String(p.properties.name);
              button.onclick = () => {
                select.current(String(p.properties.id));
                popup?.remove();
              };
              choices.appendChild(button);
            }
            if (points.length > 30) {
              const note = document.createElement('p');
              note.textContent =
                'Primele 30. Restrânge selecția folosind căutarea din listă.';
              choices.appendChild(note);
            }
            popup?.setLngLat(e.lngLat).setDOMContent(choices).addTo(m);
          });
          m.on('click', 'partner-clusters', async (e) => {
            const p = e.features?.[0];
            if (!p || p.geometry.type !== 'Point') return;
            try {
              const zoom = await (
                m.getSource(SOURCE) as GeoJSONSource
              ).getClusterExpansionZoom(Number(p.properties.cluster_id));
              if (!cancelled)
                m.easeTo({
                  center: p.geometry.coordinates as [number, number],
                  zoom: Math.min(zoom, 19),
                });
            } catch {
              /* A newer filter may have replaced the cluster index. */
            }
          });
          m.on('idle', () => {
            // Small diagnostics for browser acceptance; never create one DOM marker per client.
            if (!host.current || cancelled) return;
            const points = m.queryRenderedFeatures({
              layers: ['partner-points'],
            });
            host.current.dataset.renderedPoints = String(points.length);
            host.current.dataset.renderedApproximate = String(
              points.filter((p) => p.properties.approximate).length,
            );
            host.current.dataset.renderedClusters = String(
              m.queryRenderedFeatures({ layers: ['partner-clusters'] }).length,
            );
          });
          setReady(true);
          setError('');
        });
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setError(
            'Harta necesită WebGL disponibil în browser. Poți folosi în continuare lista și fișele.',
          );
        }
      });
    return () => {
      cancelled = true;
      health.dispose();
      observer?.disconnect();
      hover?.remove();
      popup?.remove();
      map.current?.remove();
      map.current = null;
    };
  }, [styleUrl, retry]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    let cancelled = false,
      controller: AbortController | undefined,
      timer: ReturnType<typeof setTimeout>;
    const source = () => m.getSource(SOURCE) as GeoJSONSource | undefined;
    void source()
      ?.setData(empty())
      .catch(() => {});
    if (host.current) host.current.dataset.featureCount = '0';
    if (boundsKey === undefined) return;
    const box = JSON.parse(boundsKey) as MapBounds | null;
    m.stop();
    if (box)
      m.fitBounds(
        [
          [box[0], box[1]],
          [box[2], box[3]],
        ],
        { padding: 40, maxZoom: 15, duration: 0 },
      );
    else m.jumpTo({ center: [24.96, 45.94], zoom: 5.5 });
    const fetchArea = async () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      setLoading(true);
      const b = m.getBounds(),
        dx = (b.getEast() - b.getWest()) * 0.25,
        dy = (b.getNorth() - b.getSouth()) * 0.25;
      const bbox = [
        Math.max(-180, b.getWest() - dx),
        Math.max(-90, b.getSouth() - dy),
        Math.min(180, b.getEast() + dx),
        Math.min(90, b.getNorth() + dy),
      ]
        .map((n) => n.toFixed(6))
        .join(',');
      try {
        const data = await api<PartnerMapData>(
          `partner/map?${filters}&bbox=${bbox}`,
          'GET',
          undefined,
          request.signal,
        );
        if (cancelled || request.signal.aborted) return;
        await source()?.setData(data);
        if (cancelled || request.signal.aborted) return;
        setDataError('');
        if (host.current)
          host.current.dataset.featureCount = String(data.features.length);
        setLoading(false);
      } catch (e) {
        if (cancelled || request.signal.aborted) return;
        void source()
          ?.setData(empty())
          .catch(() => {});
        if (host.current) host.current.dataset.featureCount = '0';
        setLoading(false);
        setDataError((e as Error).message);
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      controller?.abort();
      timer = setTimeout(() => void fetchArea(), 180);
    };
    m.on('moveend', schedule);
    void fetchArea();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      m.off('moveend', schedule);
    };
  }, [ready, filters, boundsKey, refreshKey]);

  return (
    <div className="partner-map-wrap">
      <div
        ref={host}
        className="partner-map"
        aria-label="Harta partenerilor localizați"
        data-map-engine="maplibre"
        data-map-status={ready ? 'ready' : 'loading'}
      />
      {loading && !error && !dataError && !resourceError && (
        <output className="partner-map-status">Se încarcă harta…</output>
      )}
      {(error || dataError || resourceError) && (
        <div className="partner-map-status" role="alert">
          {error || dataError || resourceError}{' '}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            Reîncearcă
          </button>
        </div>
      )}
      <p className="muted partner-map-legend">
        Cercurile numerotate grupează punctele din zona încărcată. Apasă pentru
        apropiere. Galben: poziție aproximativă.
      </p>
    </div>
  );
}
