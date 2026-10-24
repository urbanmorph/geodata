// A photo made ready on the phone before it is kept or sent: resized to about
// 300 KB (150 KB with Data saver), its place and time kept in it, and nothing
// else from the camera (the canvas drops every EXIF tag; exif.ts writes back
// only those two). Its place and time also travel alongside, for the server.
import { readExif, writeExif, type PhotoPlace } from './exif';
import type { QueuedPhoto } from '../outbox';

export type PhotoMeta = QueuedPhoto['meta'];

export function sizeFor(dataSaver: boolean): { bytes: number; edge: number } {
  return dataSaver ? { bytes: 150_000, edge: 1024 } : { bytes: 300_000, edge: 1600 };
}

export function fitWithin(w: number, h: number, edge: number): [number, number] {
  const k = Math.min(1, edge / Math.max(w, h));
  return [Math.round(w * k), Math.round(h * k)];
}

/** The place and time as the server takes them (an exact moment, in UTC). */
export function photoMeta(place: PhotoPlace, source: 'camera' | 'gallery'): PhotoMeta {
  const out: PhotoMeta = {};
  if (place.lat !== undefined && place.lng !== undefined) { out.lat = place.lat; out.lng = place.lng; }
  if (place.takenAt) {
    const t = new Date(place.takenAt); // no offset = the phone's local time, which is what the camera meant
    if (Number.isFinite(t.getTime())) out.taken_at = t.toISOString();
  }
  out.source = source;
  return out;
}

/** The photo as bytes (kept and sent) and as a Blob (shown). */
export interface PreparedPhoto { bytes: ArrayBuffer; blob: Blob; meta: PhotoMeta; }

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("This photo can't be read. Try taking it again.")); };
    img.src = url; // an <img> applies the camera's rotation itself
  });
}

const toJpeg = (c: HTMLCanvasElement, q: number): Promise<Blob> =>
  new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't save the photo"))), 'image/jpeg', q));

export async function preparePhoto(file: File, opts: { dataSaver: boolean; source: 'camera' | 'gallery' }): Promise<PreparedPhoto> {
  // EXIF sits at the start of the file: no need to read a whole 5 MB photo for it.
  const place: PhotoPlace = file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name) ? readExif(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer())) : {};
  const img = await loadImage(file);
  const target = sizeFor(opts.dataSaver);
  let edge = target.edge;
  let blob: Blob | null = null;
  // Lower the quality first, then the size, until it fits.
  for (let round = 0; round < 4 && !blob; round++) {
    const [w, h] = fitWithin(img.naturalWidth, img.naturalHeight, edge);
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
    for (const q of [0.82, 0.72, 0.62]) {
      const b = await toJpeg(canvas, q);
      if (b.size <= target.bytes || (round === 3 && q === 0.62)) { blob = b; break; }
    }
    edge = Math.round(edge * 0.8);
  }
  const out = writeExif(new Uint8Array(await blob!.arrayBuffer()), place);
  const bytes = out.slice().buffer as ArrayBuffer;
  return { bytes, blob: new Blob([bytes], { type: 'image/jpeg' }), meta: photoMeta(place, opts.source) };
}

/** Whether the photo seems to show a face, where the phone can tell (Chrome's
 *  built-in face detection); null where it can't. Nothing is downloaded for it. */
export async function mayShowFace(blob: Blob): Promise<boolean | null> {
  const FD = (globalThis as { FaceDetector?: new (o?: object) => { detect(i: ImageBitmapSource): Promise<unknown[]> } }).FaceDetector;
  if (!FD || typeof createImageBitmap !== 'function') return null;
  try {
    const faces = await new FD({ fastMode: true, maxDetectedFaces: 1 }).detect(await createImageBitmap(blob));
    return faces.length > 0;
  } catch { return null; }
}
