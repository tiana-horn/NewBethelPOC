// Dependency-free raw-DEFLATE inflate (RFC 1951) + a ZIP reader — the READ
// counterpart to shared/zip.ts. Intake needs to read DOCX and XLSX (ZIPs of
// deflated XML) and some FlateDecode PDF streams; Workers have no unzip. This is
// a faithful port of the tiny-inflate (tinf) algorithm, sufficient for the
// office formats intake ingests. (POC scope: not a full zlib.)

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_BITS = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CLC_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

class Tree {
  table = new Uint16Array(16); // number of codes of each length
  trans = new Uint16Array(288); // code -> symbol
}

class Reader {
  i = 0;
  tag = 0;
  bitcount = 0;
  // Growable output buffer. A plain number[] with millions of `.push` calls is
  // pathologically slow on large streams (a 1.7 MB COBie inflates to ~20 MB) —
  // a capacity-doubling Uint8Array keeps inflate linear and fast.
  out = new Uint8Array(1 << 16);
  len = 0;
  ltree = new Tree();
  dtree = new Tree();
  constructor(public s: Uint8Array) {}
  pushByte(v: number): void {
    if (this.len >= this.out.length) {
      const bigger = new Uint8Array(this.out.length * 2);
      bigger.set(this.out);
      this.out = bigger;
    }
    this.out[this.len++] = v;
  }
  getbit(): number {
    if (this.bitcount-- === 0) {
      this.tag = this.s[this.i++];
      this.bitcount = 7;
    }
    const bit = this.tag & 1;
    this.tag >>>= 1;
    return bit;
  }
  readBits(num: number, base: number): number {
    if (!num) return base;
    while (this.bitcount < 24) {
      this.tag |= (this.s[this.i++] ?? 0) << this.bitcount;
      this.bitcount += 8;
    }
    const val = this.tag & (0xffff >>> (16 - num));
    this.tag >>>= num;
    this.bitcount -= num;
    return val + base;
  }
}

function buildFixedTrees(lt: Tree, dt: Tree): void {
  let i: number;
  for (i = 0; i < 7; i++) lt.table[i] = 0;
  lt.table[7] = 24;
  lt.table[8] = 152;
  lt.table[9] = 112;
  for (i = 0; i < 24; i++) lt.trans[i] = 256 + i;
  for (i = 0; i < 144; i++) lt.trans[24 + i] = i;
  for (i = 0; i < 8; i++) lt.trans[24 + 144 + i] = 280 + i;
  for (i = 0; i < 112; i++) lt.trans[24 + 144 + 8 + i] = 144 + i;
  for (i = 0; i < 5; i++) dt.table[i] = 0;
  dt.table[5] = 32;
  for (i = 0; i < 32; i++) dt.trans[i] = i;
}

function buildTree(t: Tree, lengths: number[] | Uint8Array, off: number, num: number): void {
  const offs = new Uint16Array(16);
  let i: number;
  let sum = 0;
  for (i = 0; i < 16; i++) t.table[i] = 0;
  for (i = 0; i < num; i++) t.table[lengths[off + i]]++;
  t.table[0] = 0;
  for (i = 0; i < 16; i++) {
    offs[i] = sum;
    sum += t.table[i];
  }
  for (i = 0; i < num; i++) if (lengths[off + i]) t.trans[offs[lengths[off + i]]++] = i;
}

function decodeSymbol(d: Reader, t: Tree): number {
  let sum = 0;
  let cur = 0;
  let len = 0;
  do {
    cur = 2 * cur + d.getbit();
    len++;
    sum += t.table[len];
    cur -= t.table[len];
  } while (cur >= 0);
  return t.trans[sum + cur];
}

function decodeTrees(d: Reader, lt: Tree, dt: Tree): void {
  const lengths = new Uint8Array(288 + 32);
  const hlit = d.readBits(5, 257);
  const hdist = d.readBits(5, 1);
  const hclen = d.readBits(4, 4);
  let i: number;
  for (i = 0; i < 19; i++) lengths[i] = 0;
  const codeTree = new Tree();
  for (i = 0; i < hclen; i++) lengths[CLC_ORDER[i]] = d.readBits(3, 0);
  buildTree(codeTree, lengths, 0, 19);
  for (let num = 0; num < hlit + hdist; ) {
    const sym = decodeSymbol(d, codeTree);
    if (sym === 16) {
      const prev = lengths[num - 1];
      for (let length = d.readBits(2, 3); length; length--) lengths[num++] = prev;
    } else if (sym === 17) {
      for (let length = d.readBits(3, 3); length; length--) lengths[num++] = 0;
    } else if (sym === 18) {
      for (let length = d.readBits(7, 11); length; length--) lengths[num++] = 0;
    } else {
      lengths[num++] = sym;
    }
  }
  buildTree(lt, lengths, 0, hlit);
  buildTree(dt, lengths, hlit, hdist);
}

function inflateBlock(d: Reader, lt: Tree, dt: Tree): void {
  for (;;) {
    const sym = decodeSymbol(d, lt);
    if (sym === 256) return;
    if (sym < 256) {
      d.pushByte(sym);
    } else {
      const s = sym - 257;
      const length = d.readBits(LENGTH_BITS[s], LENGTH_BASE[s]);
      const ds = decodeSymbol(d, dt);
      const dist = d.readBits(DIST_BITS[ds], DIST_BASE[ds]);
      const start = d.len - dist;
      for (let k = 0; k < length; k++) d.pushByte(d.out[start + k]);
    }
  }
}

function inflateUncompressed(d: Reader): void {
  // Skip to byte boundary.
  while (d.bitcount > 8) {
    d.i--;
    d.bitcount -= 8;
  }
  d.bitcount = 0;
  const length = d.s[d.i] | (d.s[d.i + 1] << 8);
  d.i += 4; // length + one's-complement
  for (let k = 0; k < length; k++) d.pushByte(d.s[d.i++]);
}

export function inflateRaw(data: Uint8Array): Uint8Array {
  const d = new Reader(data);
  let bfinal: number;
  do {
    bfinal = d.getbit();
    const btype = d.readBits(2, 0);
    if (btype === 0) inflateUncompressed(d);
    else if (btype === 1) {
      buildFixedTrees(d.ltree, d.dtree);
      inflateBlock(d, d.ltree, d.dtree);
    } else if (btype === 2) {
      decodeTrees(d, d.ltree, d.dtree);
      inflateBlock(d, d.ltree, d.dtree);
    } else {
      throw new Error('inflate: invalid block type');
    }
  } while (!bfinal);
  return d.out.slice(0, d.len);
}

// zlib-wrapped stream (2-byte header + adler32 trailer) — used by PDF FlateDecode.
export function inflateZlib(data: Uint8Array): Uint8Array {
  return inflateRaw(data.subarray(2));
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

// Read a ZIP by walking local file headers. Handles method 0 (store) and 8
// (deflate) — all a DOCX/XLSX uses. Data-descriptor entries (flag bit 3) are not
// expected in office files written by Word/Excel and are not supported.
//
// `include` — when provided, entries whose name fails the predicate are SKIPPED
// (not inflated). Pure-JS DEFLATE is slow on large streams, so a COBie workbook
// (whose Attribute sheet alone is ~5.5 MB) must not decompress sheets the caller
// will not read. The compressed size is in the local header, so skipping is free.
export function unzip(bytes: Uint8Array, include?: (name: string) => boolean): ZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  let p = 0;
  while (p + 4 <= bytes.length && dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true);
    const compSize = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const name = dec.decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const dataStart = p + 30 + nameLen + extraLen;
    if (!include || include(name)) {
      const comp = bytes.subarray(dataStart, dataStart + compSize);
      out.push({ name, data: method === 0 ? comp : inflateRaw(comp) });
    }
    p = dataStart + compSize;
  }
  return out;
}

export function unzipText(bytes: Uint8Array, entryName: string): string | null {
  const e = unzip(bytes).find((x) => x.name === entryName);
  return e ? new TextDecoder().decode(e.data) : null;
}

// ---- Native (C-fast) inflate via the platform DecompressionStream ------------
// The pure-JS inflate above is fine for the small parts a DOCX/PDF needs, but it
// is orders of magnitude too slow for a large COBie workbook (megabytes of
// deflated XML). Both the Workers runtime and Node expose DecompressionStream;
// use it when present, falling back to the sync port otherwise.
export async function inflateRawAsync(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') return inflateRaw(data);
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(data).body!.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Async counterpart to unzip() using the native inflate — for large archives.
export async function unzipAsync(bytes: Uint8Array, include?: (name: string) => boolean): Promise<ZipEntry[]> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  let p = 0;
  while (p + 4 <= bytes.length && dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true);
    const compSize = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const name = dec.decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const dataStart = p + 30 + nameLen + extraLen;
    if (!include || include(name)) {
      const comp = bytes.subarray(dataStart, dataStart + compSize);
      out.push({ name, data: method === 0 ? comp : await inflateRawAsync(comp) });
    }
    p = dataStart + compSize;
  }
  return out;
}
