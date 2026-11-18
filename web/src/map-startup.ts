// Small pieces of the layer map's start-up (map.ts), kept free of MapLibre so they
// can be tested: when the data layer has drawn, which open is still current, and
// which whole-file layers are read on the page to frame the view.

type MapEvents = {
  on(type: string, fn: (e?: unknown) => void): unknown;
  off(type: string, fn: (e?: unknown) => void): unknown;
  isSourceLoaded(id: string): boolean;
};

/** Calls `cb` once, on the frame after a tile of `sourceId` loads with all its visible
 *  tiles in, so the data is on screen; or at `idle` if that comes first (nothing in
 *  view to draw, or the source failed). Returns a cancel function. */
export function onFirstRender(map: MapEvents, sourceId: string, cb: () => void): () => void {
  let drawn = false;
  const onData = (e?: unknown) => {
    const ev = e as { sourceId?: string; tile?: unknown } | undefined;
    // A metadata event can report the source loaded before any tile is asked for.
    if (ev?.sourceId === sourceId && ev.tile && map.isSourceLoaded(sourceId)) drawn = true;
  };
  const onRender = () => { if (drawn) finish(); };
  const cancel = () => {
    map.off('sourcedata', onData);
    map.off('render', onRender);
    map.off('idle', finish);
  };
  function finish() {
    cancel();
    cb();
  }
  map.on('sourcedata', onData);
  map.on('render', onRender);
  map.on('idle', finish);
  return cancel;
}

/** Each layer open (and each close) starts a new generation; async work from an
 *  older one checks isCurrent after every await and stops if it is not. */
export function openGenerations(): { next: () => number; isCurrent: (g: number) => boolean } {
  let current = 0;
  return { next: () => ++current, isCurrent: (g) => g === current };
}

/** Whole-file (GeoJSON) layers at or under this size are read on the page to find
 *  their extent. Community layers get map tiles from 8 MB (scripts/bake_community.py),
 *  so every whole-file community layer, often one city or district, is framed. */
export const FRAME_FROM_FILE_MAX = 8 * 1024 * 1024;

/** True when the file is small enough to read on the page for framing; larger ones
 *  (national layers) go to MapLibre by URL, parsed in its worker, and open on India. */
export function framesFromFile(bytes: number | null | undefined): boolean {
  return !!bytes && bytes <= FRAME_FROM_FILE_MAX;
}
