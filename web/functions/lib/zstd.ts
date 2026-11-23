/**
 * hyparquet's decompressors with ZSTD in WebAssembly.
 *
 * hyparquet-compressors decodes ZSTD with fzstd, pure JS; it and hyparquet's
 * page decoding were the CPU of a point lookup (0.5 to 1.2 s CPU an answer in
 * production). zstd-wasm-decoder's build of the reference zstd decodes the
 * same pages 3 to 5 times cheaper (Node, 23 Nov 2026: 303 ms against 65 ms for
 * one 67 MB lithology row group), to the same bytes. On a preview the median
 * cpuTime of /ground fell from 340-430 ms to 170-180 ms, /surface from
 * 400-520 ms to 230-240 ms.
 *
 * Workers cannot compile WebAssembly from bytes at run time, so the module is
 * imported: Pages' bundler turns a .wasm import into a WebAssembly.Module
 * (vitest.config.ts does the same for tests). One decoder per isolate; its
 * calls are synchronous, so concurrent requests never share its state.
 *
 * parquet-column-stream.ts keeps fzstd's streaming decoder for the export's
 * huge geometry pages: a stream spans awaits, so it would need a decoder of its
 * own, and each holds 16 MB of wasm memory.
 */
import type { Compressors } from 'hyparquet';
import { compressors as jsCompressors } from 'hyparquet-compressors';
import { decompress as fzstd } from 'fzstd';
import { ZstdDecoder } from 'zstd-wasm-decoder/cloudflare';
// The package's own "./wasm-perf" export names a file it does not ship, so
// the module is imported by path. Same file the "./cloudflare" entry imports.
// @ts-expect-error a .wasm import has no types; it is a WebAssembly.Module.
import zstdWasm from '../../node_modules/zstd-wasm-decoder/_esm/zstd-decoder-perf.wasm';

let decoder: ZstdDecoder | undefined;

function decodeZstd(input: Uint8Array, outputLength: number): Uint8Array {
  decoder ??= new ZstdDecoder({ maxSrcSize: 0, maxDstSize: 0 }).init(zstdWasm as WebAssembly.Module);
  try {
    return decoder.decompressSync(input, outputLength);
  } catch {
    // The decoder's memory is a fixed ring buffer sized for windows up to
    // level 19's; a frame it refuses still decodes, in JS.
    return fzstd(input);
  }
}

export const compressors: Compressors = { ...jsCompressors, ZSTD: decodeZstd };
