// Tabular intake (CHANGE-02 §2) — room/finish schedules arrive as CSV or XLSX.
// Both normalize to the same Record<string,string>[] shape the finish-schedule
// normalizer consumes, so downstream code never cares which format it was.

import { parseCsv } from '../shared/csv';
import { unzip, unzipAsync } from '../shared/inflate';

type ZipEntry = ReturnType<typeof unzip>[number];

// Parse the first worksheet of an XLSX into header-keyed rows. Reads
// sharedStrings + the sheet cells; enough for a finish schedule. (POC scope:
// first sheet only, no formulas/styles.)
export function parseXlsx(bytes: Uint8Array): Record<string, string>[] {
  // Inflate ONLY sheet1 + sharedStrings (a finish schedule is one sheet). On a
  // COBie workbook uploaded here, this avoids decompressing the ~20 MB of other
  // sheets just to read the first one.
  const entries = unzip(bytes, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/worksheets/sheet1.xml');
  const shared = readSharedStrings(entries);
  const sheetXml = firstSheetXml(entries);
  if (!sheetXml) return [];

  // Collect cells as grid[rowIndex][colIndex] = value.
  const grid: Record<number, Record<number, string>> = {};
  const cellRe = /<c\s+r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>|<c\s+r="([A-Z]+)(\d+)"([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(sheetXml))) {
    const colRef = m[1] ?? m[5];
    const rowRef = m[2] ?? m[6];
    const attrs = m[3] ?? m[7] ?? '';
    const inner = m[4] ?? '';
    if (!colRef || !rowRef) continue;
    const r = parseInt(rowRef, 10) - 1;
    const c = colToIndex(colRef);
    const isShared = /\bt="s"/.test(attrs);
    const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
    const tm = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/); // inline string
    let val = '';
    if (vm) val = isShared ? shared[parseInt(vm[1], 10)] ?? '' : vm[1];
    else if (tm) val = tm[1];
    (grid[r] ??= {})[c] = unescapeXml(val).trim();
  }

  const rowIdx = Object.keys(grid).map(Number).sort((a, b) => a - b);
  if (rowIdx.length === 0) return [];
  const headerRow = grid[rowIdx[0]];
  const maxCol = Math.max(...Object.values(grid).flatMap((row) => Object.keys(row).map(Number)));
  const headers: string[] = [];
  for (let c = 0; c <= maxCol; c++) headers[c] = (headerRow[c] ?? `col${c}`).trim();

  const out: Record<string, string>[] = [];
  for (let i = 1; i < rowIdx.length; i++) {
    const row = grid[rowIdx[i]];
    const rec: Record<string, string> = {};
    let any = false;
    for (let c = 0; c <= maxCol; c++) {
      const v = row[c] ?? '';
      if (v) any = true;
      rec[headers[c]] = v;
    }
    if (any) out.push(rec);
  }
  return out;
}

export function parseTable(type: 'csv' | 'xlsx', bytes: Uint8Array): Record<string, string>[] {
  return type === 'xlsx' ? parseXlsx(bytes) : parseCsv(new TextDecoder().decode(bytes));
}

// Async, native-inflate variant of parseXlsx (first sheet only). The sync pure-JS
// inflate BLOCKS the Workers event loop on a large workbook (a COBie's 1.33 MB
// sharedStrings freezes the whole isolate); the request path must use this.
export async function parseXlsxAsync(bytes: Uint8Array): Promise<Record<string, string>[]> {
  const entries = await unzipAsync(bytes, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/worksheets/sheet1.xml');
  const shared = readSharedStrings(entries);
  const sheetXml = firstSheetXml(entries);
  return sheetXml ? sheetRows(sheetXml, shared) : [];
}

export async function parseTableAsync(type: 'csv' | 'xlsx', bytes: Uint8Array): Promise<Record<string, string>[]> {
  return type === 'xlsx' ? parseXlsxAsync(bytes) : parseCsv(new TextDecoder().decode(bytes));
}

// CHANGE-04 §3.1 — a COBie workbook is many sheets (Facility/Space/Type/System/
// Attribute/PickLists/…), not one finish schedule. `parseXlsx` above reads only
// the first sheet; the OmniClass parser needs named sheets by their tab name.
// Returns header-keyed rows for each requested sheet (or all sheets if none
// requested). Inflates the container ONCE and resolves tab-name -> part via the
// workbook + its rels (the sheetN.xml order is NOT guaranteed to match tabs).
export function parseXlsxSheets(bytes: Uint8Array, wanted?: string[]): Record<string, Record<string, string>[]> {
  // Pass 1 — inflate ONLY the metadata (+ sharedStrings), never the sheets. On a
  // COBie workbook the sheets total ~20 MB; pure-JS DEFLATE of all of them is the
  // difference between a snappy parse and a multi-minute hang.
  const meta = unzip(bytes, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml');
  const shared = readSharedStrings(meta);
  const wb = decodeEntry(meta, 'xl/workbook.xml');
  const rels = decodeEntry(meta, 'xl/_rels/workbook.xml.rels');
  if (!wb) return {};

  // rId -> target path (e.g. 'worksheets/sheet3.xml').
  const relMap = new Map<string, string>();
  if (rels) for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) relMap.set(m[1], m[2]);

  // Resolve the requested tab names to their worksheet part paths.
  const targets: { name: string; path: string }[] = [];
  for (const m of wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"/g)) {
    const name = unescapeXml(m[1]);
    if (wanted && !wanted.includes(name)) continue;
    const target = relMap.get(m[2]);
    if (!target) continue;
    targets.push({ name, path: target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}` });
  }

  // Pass 2 — inflate ONLY the worksheet parts we actually need.
  const paths = new Set(targets.map((t) => t.path));
  const sheetEntries = unzip(bytes, (n) => paths.has(n));
  const out: Record<string, Record<string, string>[]> = {};
  for (const t of targets) {
    const xml = decodeEntry(sheetEntries, t.path);
    if (xml) out[t.name] = sheetRows(xml, shared);
  }
  return out;
}

// Async, native-inflate variant of parseXlsxSheets — for large workbooks (COBie)
// where the pure-JS inflate is too slow. Same selective two-pass strategy, but
// uses the platform DecompressionStream.
export async function parseXlsxSheetsAsync(bytes: Uint8Array, wanted?: string[]): Promise<Record<string, Record<string, string>[]>> {
  const meta = await unzipAsync(bytes, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml');
  const shared = readSharedStrings(meta);
  const wb = decodeEntry(meta, 'xl/workbook.xml');
  const rels = decodeEntry(meta, 'xl/_rels/workbook.xml.rels');
  if (!wb) return {};
  const relMap = new Map<string, string>();
  if (rels) for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) relMap.set(m[1], m[2]);
  const targets: { name: string; path: string }[] = [];
  for (const m of wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"/g)) {
    const name = unescapeXml(m[1]);
    if (wanted && !wanted.includes(name)) continue;
    const target = relMap.get(m[2]);
    if (!target) continue;
    targets.push({ name, path: target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}` });
  }
  const paths = new Set(targets.map((t) => t.path));
  const sheetEntries = await unzipAsync(bytes, (n) => paths.has(n));
  const out: Record<string, Record<string, string>[]> = {};
  for (const t of targets) {
    const xml = decodeEntry(sheetEntries, t.path);
    if (xml) out[t.name] = sheetRows(xml, shared);
  }
  return out;
}

function decodeEntry(entries: ZipEntry[], name: string): string | null {
  const e = entries.find((x) => x.name === name);
  return e ? new TextDecoder().decode(e.data) : null;
}

// Parse one worksheet's XML into header-keyed rows (shared logic factored from
// parseXlsx so both the single-sheet and multi-sheet paths behave identically).
function sheetRows(sheetXml: string, shared: string[]): Record<string, string>[] {
  const grid: Record<number, Record<number, string>> = {};
  const cellRe = /<c\s+r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>|<c\s+r="([A-Z]+)(\d+)"([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(sheetXml))) {
    const colRef = m[1] ?? m[5];
    const rowRef = m[2] ?? m[6];
    const attrs = m[3] ?? m[7] ?? '';
    const inner = m[4] ?? '';
    if (!colRef || !rowRef) continue;
    const r = parseInt(rowRef, 10) - 1;
    const c = colToIndex(colRef);
    const isShared = /\bt="s"/.test(attrs);
    const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
    const tm = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
    let val = '';
    if (vm) val = isShared ? shared[parseInt(vm[1], 10)] ?? '' : vm[1];
    else if (tm) val = tm[1];
    (grid[r] ??= {})[c] = unescapeXml(val).trim();
  }
  const rowIdx = Object.keys(grid).map(Number).sort((a, b) => a - b);
  if (rowIdx.length === 0) return [];
  const headerRow = grid[rowIdx[0]];
  const maxCol = Math.max(...Object.values(grid).flatMap((row) => Object.keys(row).map(Number)));
  const headers: string[] = [];
  for (let c = 0; c <= maxCol; c++) headers[c] = (headerRow[c] ?? `col${c}`).trim();
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < rowIdx.length; i++) {
    const row = grid[rowIdx[i]];
    const rec: Record<string, string> = {};
    let any = false;
    for (let c = 0; c <= maxCol; c++) {
      const v = row[c] ?? '';
      if (v) any = true;
      rec[headers[c]] = v;
    }
    if (any) rows.push(rec);
  }
  return rows;
}

function readSharedStrings(entries: ZipEntry[]): string[] {
  const e = entries.find((x) => x.name === 'xl/sharedStrings.xml');
  const xml = e ? new TextDecoder().decode(e.data) : null;
  if (!xml) return [];
  const out: string[] = [];
  // Match both `<si>…</si>` and a self-closed `<si/>` (some producers emit the
  // latter for a blank cell). Shared strings are referenced BY INDEX from the
  // sheet, so a skipped empty entry would shift every later string — push '' to
  // keep the array aligned.
  const siRe = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml))) {
    if (m[1] === undefined) {
      out.push(''); // self-closed <si/> — an empty shared string
      continue;
    }
    // An <si> may hold multiple <t> runs (rich text); concatenate them.
    const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]);
    out.push(unescapeXml(parts.join('')));
  }
  return out;
}

function firstSheetXml(entries: ZipEntry[]): string | null {
  const sheet =
    entries.find((e) => e.name === 'xl/worksheets/sheet1.xml') ??
    entries.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
  return sheet ? new TextDecoder().decode(sheet.data) : null;
}

function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function unescapeXml(s: string): string {
  // &amp; must decode LAST or `&amp;lt;` double-decodes to `<`.
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_x, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}
