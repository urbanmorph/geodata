// Shared spinner + rotating-verb loader. Used by the map overlay
// (large, centred) and the filter panel (inline next to text).
//
// Themed verb sets capture the "what's happening" feel of each phase so
// long waits never feel dead. Pick a set or pass your own.

import { escapeHtml } from './util';

export const VERBS_MAP = [
  'Triangulating polygons…',
  'Plotting boundaries…',
  'Surveying terrain…',
  'Drawing meridians…',
  'Tessellating tiles…',
  'Decoding vector layers…',
  'Stitching coastlines…',
  'Resolving projections…',
  'Charting villages…',
  'Geolocating features…',
];

export const VERBS_ENGINE = [
  'Booting the SQL engine…',
  'Streaming the database runtime…',
  'Unpacking columnar reader…',
  'Warming the query planner…',
  'Loading parquet decoder…',
  'Spinning up the worker…',
  'Compiling the WASM core…',
  'Hooking the file system…',
];

export const VERBS_COUNT = [
  'Scanning parquet footer…',
  'Reading row-group stats…',
  'Counting matches…',
  'Tallying rows…',
  'Skipping irrelevant pages…',
  'Resolving page indices…',
];

export const VERBS_EXPORT = [
  'Filtering rows in your browser…',
  'Streaming column chunks…',
  'Compressing with ZSTD…',
  'Packaging the parquet…',
  'Stitching row groups…',
  'Building your download…',
  'Sealing the blob…',
];

export const VERBS_GEOJSON = [
  'Filtering rows in your browser…',
  'Loading geospatial helpers…',
  'Decoding WKB geometries…',
  'Serialising features…',
  'Stitching the FeatureCollection…',
  'Sealing the blob…',
];

export const VERBS_KML = [
  'Filtering rows in your browser…',
  'Loading geospatial helpers…',
  'Translating to Google Earth…',
  'Wrapping placemarks…',
  'Encoding XML…',
  'Sealing the KML envelope…',
];

export const VERBS_VERIFY = [
  'Reading the file…',
  'Parsing geometries…',
  'Counting features…',
  'Checking the CRS…',
  'Sniffing properties…',
  'Putting features on the map…',
];

export const VERBS_VERIFY_KMZ = [
  'Unzipping the KMZ…',
  'Locating the KML inside…',
  'Parsing the KML…',
];

export const VERBS_VERIFY_PARQUET = [
  'Booting the SQL engine…',
  'Streaming parquet pages…',
  'Decoding WKB geometries…',
  'Building the feature list…',
];

export const VERBS_VERIFY_FETCH = [
  'Resolving the URL…',
  'Streaming bytes from the host…',
  'Reading the response…',
];

export const VERBS_VERIFY_RENDER = [
  'Tiling the geometry…',
  'Painting polygons…',
  'Plotting features…',
  'Fitting the bounds…',
  'Stroking edges…',
];

type Handle = { dismiss: () => void; setVerbs: (v: string[]) => void };

/** Big centred overlay (map: covers the container with a blurred backdrop). */
export function overlayLoader(container: HTMLElement, verbs: string[]): Handle {
  let i = Math.floor(Math.random() * verbs.length);
  let active = verbs;
  const root = document.createElement('div');
  root.className = 'map-loader';
  root.innerHTML = `<div class="map-loader__ring" aria-hidden="true"></div><div class="map-loader__verb" role="status" aria-live="polite">${escapeHtml(active[i])}</div>`;
  container.appendChild(root);
  const verbEl = root.querySelector('.map-loader__verb') as HTMLElement;
  const timer = window.setInterval(() => {
    i = (i + 1) % active.length;
    verbEl.textContent = active[i];
  }, 1400);
  return {
    dismiss() {
      clearInterval(timer);
      root.classList.add('fade');
      setTimeout(() => root.remove(), 240);
    },
    setVerbs(v: string[]) {
      active = v;
      i = 0;
      verbEl.textContent = active[i];
    },
  };
}

/** Compact inline pill (filter panel: small ring + rotating verb on one line). */
export function inlineLoader(target: HTMLElement, verbs: string[]): Handle {
  let i = Math.floor(Math.random() * verbs.length);
  let active = verbs;
  target.innerHTML = `<span class="il"><span class="il__ring" aria-hidden="true"></span><span class="il__verb" role="status" aria-live="polite">${escapeHtml(active[i])}</span></span>`;
  const verbEl = target.querySelector('.il__verb') as HTMLElement;
  const timer = window.setInterval(() => {
    i = (i + 1) % active.length;
    verbEl.textContent = active[i];
  }, 1400);
  return {
    dismiss() {
      clearInterval(timer);
    },
    setVerbs(v: string[]) {
      active = v;
      i = 0;
      verbEl.textContent = active[i];
    },
  };
}
