// Fewer, larger parquet reads. hyparquet fetches each requested column chunk on
// its own, and on Workers every R2 read waits for one of six connections: a point
// profile reading 30 layers spent most of its time queued. `coalesced` reads the
// chunks a call will need in as few ranges as possible (neighbours joined across
// small gaps) and serves hyparquet's slices from them.
import type { AsyncBuffer, FileMetaData } from 'hyparquet';

export interface ByteRange { start: number; end: number }

/** Join ranges closer than this... */
export const MERGE_GAP = 1 << 20;
/** ...unless the joined read would pass this. */
export const MERGE_MAX = 16 << 20;

/** The byte ranges of `columns`' chunks in the row groups that overlap rows [rowStart, rowEnd). */
export function chunkRanges(metadata: FileMetaData, columns: string[], rowStart: number, rowEnd: number): ByteRange[] {
  const out: ByteRange[] = [];
  let groupStart = 0;
  for (const rg of metadata.row_groups) {
    const groupEnd = groupStart + Number(rg.num_rows);
    if (groupEnd > rowStart && groupStart < rowEnd) {
      for (const c of rg.columns) {
        const m = c.meta_data;
        if (!m || !columns.includes(m.path_in_schema[0])) continue;
        const start = Number(m.dictionary_page_offset || m.data_page_offset);
        out.push({ start, end: start + Number(m.total_compressed_size) });
      }
    }
    groupStart = groupEnd;
  }
  return out;
}

/** Ranges sorted and joined where the gap is at most `gap` and the result at most `max` bytes. */
export function mergeRanges(ranges: ByteRange[], gap = MERGE_GAP, max = MERGE_MAX): ByteRange[] {
  const out: ByteRange[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start - last.end <= gap && Math.max(last.end, r.end) - last.start <= max) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** `file`, with `ranges` read up front (joined) and slices inside them served from those reads. */
export function coalesced(file: AsyncBuffer, ranges: ByteRange[]): AsyncBuffer {
  const runs = mergeRanges(ranges).map((r) => {
    const data = Promise.resolve(file.slice(r.start, r.end));
    data.catch(() => {}); // a failed read fails the slice that needs it, not the isolate
    return { ...r, data };
  });
  return {
    byteLength: file.byteLength,
    async slice(start: number, end = file.byteLength) {
      const run = runs.find((r) => r.start <= start && end <= r.end);
      if (!run) return file.slice(start, end);
      return (await run.data).slice(start - run.start, end - run.start);
    },
  };
}
