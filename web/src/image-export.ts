export function imageFilename(layerId: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  // YYYYMMDD-HHmm: short, sortable, filesystem-friendly.
  const stamp =
    now.getUTCFullYear().toString() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    '-' +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes());
  const safe = layerId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `bharatlas-${safe}-${stamp}.png`;
}

type CaptureMap = {
  once(type: 'idle' | 'render', fn: () => void): unknown;
  triggerRepaint(): void;
  getCanvas(): Pick<HTMLCanvasElement, 'toBlob'>;
};

/** The map as a PNG. Maps don't keep their drawing buffer (preserveDrawingBuffer
 *  costs every frame), so the WebGL canvas is readable only during the frame
 *  that drew it: wait for the tiles to settle, then read it inside the next
 *  'render' event. toBlob copies the pixels when called, then encodes. */
export async function captureMapPng(map: CaptureMap): Promise<Blob> {
  await new Promise<void>((resolve) => {
    map.once('idle', () => resolve());
    map.triggerRepaint();
  });
  return new Promise<Blob>((resolve, reject) => {
    map.once('render', () => {
      map.getCanvas().toBlob((b) => (b ? resolve(b) : reject(new Error('the map canvas was empty'))), 'image/png');
    });
    map.triggerRepaint();
  });
}
