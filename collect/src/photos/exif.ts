// The two things a collect photo keeps from the camera: where and when it was
// taken. readExif pulls them (and the orientation) out of a JPEG; writeExif puts
// only those back into a resized JPEG. Resizing in a canvas drops every EXIF tag,
// so the phone's make, model, serial and owner name never leave the phone.
// Small on purpose: just these tags, no library.

export interface PhotoPlace {
  lat?: number;
  lng?: number;
  /** "YYYY-MM-DDTHH:MM:SS", with "+05:30" when the camera recorded its offset. */
  takenAt?: string;
}
export interface ExifInfo extends PhotoPlace { orientation?: number; }

const TAG = {
  orientation: 0x0112, exifIfd: 0x8769, gpsIfd: 0x8825,
  dateTimeOriginal: 0x9003, offsetTimeOriginal: 0x9011,
  gpsVersion: 0x0000, latRef: 0x0001, lat: 0x0002, lngRef: 0x0003, lng: 0x0004,
} as const;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/** The APP1 "Exif" segment of a JPEG: [start of its TIFF header, end], or null. */
function findExif(b: Uint8Array): [number, number] | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda || marker === 0xd9) return null; // image data: no EXIF before it
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      return [i + 10, Math.min(i + 2 + len, b.length)];
    }
    i += 2 + len;
  }
  return null;
}

/** Never throws: a damaged or cut-off photo just has no place or time. */
export function readExif(bytes: ArrayBuffer | Uint8Array): ExifInfo {
  try { return parseExif(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); } catch { return {}; }
}

function parseExif(b: Uint8Array): ExifInfo {
  const seg = findExif(b);
  if (!seg) return {};
  const [base, end] = seg;
  const magic = b[base] === 0x49 ? [0x49, 0x49, 0x2a, 0x00] : [0x4d, 0x4d, 0x00, 0x2a];
  if (base + 8 > end || magic.some((x, k) => b[base + k] !== x)) return {};
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const le = b[base] === 0x49; // "II" little-endian, "MM" big-endian
  const u16 = (o: number) => v.getUint16(o, le);
  const u32 = (o: number) => v.getUint32(o, le);
  const inRange = (o: number, n: number) => o >= base && o + n <= end;

  // Every entry of one IFD: tag → [type, count, where its value is].
  const ifd = (off: number): Map<number, [number, number, number]> => {
    const out = new Map<number, [number, number, number]>();
    const at = base + off;
    if (!inRange(at, 2)) return out;
    const n = u16(at);
    for (let k = 0; k < n; k++) {
      const e = at + 2 + k * 12;
      if (!inRange(e, 12)) break;
      const type = u16(e + 2), count = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      out.set(u16(e), [type, count, size <= 4 ? e + 8 : base + u32(e + 8)]);
    }
    return out;
  };
  const ascii = (e?: [number, number, number]): string | undefined => {
    if (!e || !inRange(e[2], e[1])) return undefined;
    return String.fromCharCode(...b.subarray(e[2], e[2] + e[1])).replace(/\0.*$/s, '').trim() || undefined;
  };
  const rationals = (e?: [number, number, number]): number[] | undefined => {
    if (!e || e[0] !== 5 || !inRange(e[2], e[1] * 8)) return undefined;
    return Array.from({ length: e[1] }, (_, k) => { const d = u32(e[2] + k * 8 + 4); return d ? u32(e[2] + k * 8) / d : NaN; });
  };

  const out: ExifInfo = {};
  const ifd0 = ifd(u32(base + 4));
  const o = ifd0.get(TAG.orientation);
  if (o && inRange(o[2], 2)) out.orientation = u16(o[2]);

  const exifPtr = ifd0.get(TAG.exifIfd);
  if (exifPtr && inRange(exifPtr[2], 4)) {
    const ex = ifd(u32(exifPtr[2]));
    const dt = ascii(ex.get(TAG.dateTimeOriginal))?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (dt && dt[1] !== '0000') {
      const off = ascii(ex.get(TAG.offsetTimeOriginal));
      out.takenAt = `${dt[1]}-${dt[2]}-${dt[3]}T${dt[4]}:${dt[5]}:${dt[6]}${off && /^[+-]\d{2}:\d{2}$/.test(off) ? off : ''}`;
    }
  }

  const gpsPtr = ifd0.get(TAG.gpsIfd);
  if (gpsPtr && inRange(gpsPtr[2], 4)) {
    const g = ifd(u32(gpsPtr[2]));
    const deg = (r?: number[]) => (r && r.length === 3 && r.every(Number.isFinite) ? r[0] + r[1] / 60 + r[2] / 3600 : undefined);
    const lat = deg(rationals(g.get(TAG.lat)));
    const lng = deg(rationals(g.get(TAG.lng)));
    if (lat !== undefined && lng !== undefined && !(lat === 0 && lng === 0) && lat <= 90 && lng <= 180) {
      out.lat = ascii(g.get(TAG.latRef)) === 'S' ? -lat : lat;
      out.lng = ascii(g.get(TAG.lngRef)) === 'W' ? -lng : lng;
    }
  }
  return out;
}

// ---- writing ------------------------------------------------------------------

type Entry = { tag: number; type: number; count: number; data: number[] };

const asciiEntry = (tag: number, s: string): Entry =>
  ({ tag, type: 2, count: s.length + 1, data: [...s].map((c) => c.charCodeAt(0)).concat(0) });

/** Degrees as three rationals (deg, min, sec × 1000), big-endian bytes. */
function dmsEntry(tag: number, value: number): Entry {
  const a = Math.abs(value);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = Math.round(((a - d) * 60 - m) * 60 * 1000);
  const data: number[] = [];
  for (const [num, den] of [[d, 1], [m, 1], [s, 1000]]) data.push(...be32(num), ...be32(den));
  return { tag, type: 5, count: 3, data };
}
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/** One IFD at `start` (offset from the TIFF header), values after its entries. */
function ifdBytes(entries: Entry[], start: number): number[] {
  const sorted = [...entries].sort((x, y) => x.tag - y.tag);
  const head: number[] = [...be16(sorted.length)];
  const tail: number[] = [];
  let dataAt = start + 2 + sorted.length * 12 + 4;
  for (const e of sorted) {
    head.push(...be16(e.tag), ...be16(e.type), ...be32(e.count));
    if (e.data.length <= 4) head.push(...e.data, ...Array(4 - e.data.length).fill(0));
    else {
      head.push(...be32(dataAt));
      tail.push(...e.data);
      if (e.data.length % 2) tail.push(0); // keep offsets even
      dataAt += e.data.length + (e.data.length % 2);
    }
  }
  return [...head, 0, 0, 0, 0, ...tail];
}

/** "2026-10-24T09:15:00+05:30" → ["2026:10:24 09:15:00", "+05:30"]. */
function exifTime(iso: string): [string, string | null] | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?([+-]\d{2}:\d{2}|Z)?$/);
  if (!m) return null;
  return [`${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6] ?? '00'}`, m[7] === 'Z' ? '+00:00' : m[7] ?? null];
}

/** The JPEG with a fresh EXIF block holding only the place and time given
 *  (any EXIF it had is removed). Unchanged when there is nothing to write. */
export function writeExif(jpeg: Uint8Array, place: PhotoPlace): Uint8Array {
  const time = place.takenAt ? exifTime(place.takenAt) : null;
  const gps = place.lat !== undefined && place.lng !== undefined && Number.isFinite(place.lat) && Number.isFinite(place.lng);
  const stripped = stripExif(jpeg);
  if (!time && !gps) return stripped;

  // Layout (offsets from the TIFF header): header 8, IFD0, Exif IFD, GPS IFD.
  const exifEntries: Entry[] = time ? [asciiEntry(0x9003, time[0]), ...(time[1] ? [asciiEntry(0x9011, time[1])] : [])] : [];
  const gpsEntries: Entry[] = gps ? [
    { tag: 0x0000, type: 1, count: 4, data: [2, 3, 0, 0] },
    asciiEntry(0x0001, place.lat! < 0 ? 'S' : 'N'), dmsEntry(0x0002, place.lat!),
    asciiEntry(0x0003, place.lng! < 0 ? 'W' : 'E'), dmsEntry(0x0004, place.lng!),
  ] : [];
  const ifd0Count = (time ? 1 : 0) + (gps ? 1 : 0);
  const ifd0Len = 2 + ifd0Count * 12 + 4;
  const exifAt = 8 + ifd0Len;
  const exifIfd = time ? ifdBytes(exifEntries, exifAt) : [];
  const gpsAt = exifAt + exifIfd.length;
  const gpsIfd = gps ? ifdBytes(gpsEntries, gpsAt) : [];
  const ifd0 = ifdBytes([
    ...(time ? [{ tag: 0x8769, type: 4, count: 1, data: be32(exifAt) }] : []),
    ...(gps ? [{ tag: 0x8825, type: 4, count: 1, data: be32(gpsAt) }] : []),
  ], 8);
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, ...be32(8), ...ifd0, ...exifIfd, ...gpsIfd];
  const app1 = [0xff, 0xe1, ...be16(tiff.length + 8), 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];

  const out = new Uint8Array(stripped.length + app1.length);
  out.set(stripped.subarray(0, 2), 0);
  out.set(app1, 2);
  out.set(stripped.subarray(2), 2 + app1.length);
  return out;
}

/** The JPEG without any APP1 (EXIF/XMP) segment. */
export function stripExif(jpeg: Uint8Array): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const parts: Uint8Array[] = [jpeg.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= jpeg.length && jpeg[i] === 0xff && jpeg[i + 1] !== 0xda) {
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (jpeg[i + 1] !== 0xe1) parts.push(jpeg.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(jpeg.subarray(i));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
