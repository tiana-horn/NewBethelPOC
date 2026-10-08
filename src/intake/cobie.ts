// CHANGE-05 §1 — COBie intake parser. The OmniClass classification path is
// REVERTED (licensed CSI IP): this no longer reads `Category` codes or resolves a
// crosswalk. It is a deterministic table parse for the free features the SEC
// matcher (§4) needs — spaces, per-space finishes (Attribute sheet), and
// free-text product features from Type/System descriptive text (§4.1).

import { parseXlsxSheetsAsync } from './table';
import type { EPDElement, EPDFinish, EPDSpace } from '../shared/types';

function firstHeaderKey(row: Record<string, string>, names: string[]): string {
  for (const k of Object.keys(row)) if (names.includes(k.trim())) return k;
  return '';
}
function cell(row: Record<string, string>, names: string[]): string {
  const k = firstHeaderKey(row, names);
  return k ? (row[k] ?? '').trim() : '';
}

export interface ParsedCobie {
  isCobie: boolean;
  spaces: EPDSpace[];
  finishes: EPDFinish[];
  // CHANGE-05 §4.1 — free-text product features (license-clean; no OmniClass code).
  products: EPDElement[];
}

// Deterministic parse of a COBie workbook. No DB, no LLM. Reads Space/Type/System
// `Category` columns for classification and Space + Attribute for finishes. Safe
// on a non-COBie xlsx: returns { isCobie: false } when the COBie sheet set is
// absent, so the caller can fall back to the direct finish-schedule parser.
// `finishes` — also read the COBie Attribute sheet for per-space finish products
// (Part 10.1). That sheet is large (~5.5 MB on the clinic workbook) and pure-JS
// inflate is slow, so it is OPT-IN: the classification/outline path (Stage 2/3)
// does not need it and stays fast without it.
export async function parseCobie(bytes: Uint8Array, opts: { finishes?: boolean } = {}): Promise<ParsedCobie> {
  const wanted = ['Facility', 'Space', 'Type', 'System', ...(opts.finishes ? ['Attribute'] : [])];
  const sheets = await parseXlsxSheetsAsync(bytes, wanted);
  const isCobie = !!(sheets['Space'] && (sheets['Type'] || sheets['System']));
  const out: ParsedCobie = { isCobie, spaces: [], finishes: [], products: [] };
  if (!isCobie) return out;

  // ---- Spaces. Name is the space ref (e.g. '1A01'); Description is the function. ----
  for (const r of sheets['Space'] ?? []) {
    const name = cell(r, ['Name']);
    if (!name) continue;
    out.spaces.push({ id: name, name: cell(r, ['Description']) || undefined, occupancy: cell(r, ['RoomTag', 'UsableHeight']) || undefined });
  }

  // ---- Finishes from the COBie Attribute sheet (Part 0.1 / Part 10.1), only when
  // requested. Real per-space finish data lives here (FloorMaterial/WallMaterial/
  // BaseMaterial), NOT in the IFC. Keyed by RowName -> the space it belongs to. ----
  if (opts.finishes) out.finishes = finishesFromAttributes(sheets['Attribute'] ?? []);

  // CHANGE-05 §4.1 — free-text product features (independent of the OmniClass
  // block above, which §1 reverts): read Type + System descriptive text.
  out.products = productsFromCobie(sheets['Type'] ?? [], sheets['System'] ?? []);
  return out;
}

// The human-readable portion of a COBie `Category` cell — the text after the
// colon (e.g. 'Unitary Air Conditioning Equipment'). The numeric OmniClass code
// before the colon is deliberately DROPPED (§1 licensing line — we never carry
// or ship the numbering taxonomy).
function categoryTitle(raw: string): string {
  const i = (raw ?? '').indexOf(':');
  return i >= 0 ? raw.slice(i + 1).trim() : '';
}

// CHANGE-05 §4.1 — free-text product features from COBie Type/System rows, the
// license-clean replacement for the reverted OmniClass code path. We read only
// the DESCRIPTIVE text the modeler entered — the Type Name/Description/ModelNumber
// and the human-readable TITLE of Category — as lexical features for the SEC
// matcher; we never read the numeric code and ship no OmniClass list, so §1's
// licensing line holds. Emitted in the same EPDElement shape as IFC elements.
// NOTE (honest, for the matcher's threshold): the strongest COBie descriptor is
// the Category title, which is descriptive English in the project's own file; the
// modeler's Name/Description ('AC Unit Type 1', 'Horiz. D.X. Fan Coil') alone are
// weaker signal than the IFC element keywords. Products aggregate by descriptor.
export function productsFromCobie(
  typeRows: Record<string, string>[],
  systemRows: Record<string, string>[],
): EPDElement[] {
  const agg = new Map<string, { ifcType: string; keyword: string; count: number; names: Set<string> }>();
  const clean = (s: string) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const isNoise = (s: string) => !s || s.includes('@') || /^n\/?a$/i.test(s);
  const add = (source: string, name: string, category: string, description: string, model: string) => {
    const descriptor = clean((categoryTitle(category) || description || name).toLowerCase());
    if (!descriptor) return;
    const key = `${source}|${descriptor}`;
    let e = agg.get(key);
    if (!e) {
      e = { ifcType: source, keyword: descriptor, count: 0, names: new Set() };
      agg.set(key, e);
    }
    e.count++;
    for (const raw of [name, description, model]) {
      const v = clean(raw);
      if (!isNoise(v) && e.names.size < 8) e.names.add(v);
    }
  };
  for (const r of typeRows) add('CobieType', cell(r, ['Name']), cell(r, ['Category']), cell(r, ['Description']), cell(r, ['ModelNumber']));
  for (const r of systemRows) add('CobieSystem', cell(r, ['Name']), cell(r, ['Category']), cell(r, ['Description']), '');
  return [...agg.values()]
    .map((e) => ({ ifcType: e.ifcType, keyword: e.keyword, count: e.count, typeNames: e.names.size ? [...e.names] : undefined }))
    .sort((a, b) => b.count - a.count);
}

// Collapse the Attribute rows into one finish per space, reading the named
// finish products COBie carries (e.g. 'INTERFACE - CARIBBEAN #3080 ANTIQUA').
function finishesFromAttributes(attrs: Record<string, string>[]): EPDFinish[] {
  const bySpace = new Map<string, { floor?: string; wall?: string; base?: string; ceiling?: string }>();
  for (const r of attrs) {
    const sheet = cell(r, ['SheetName']);
    if (sheet && sheet !== 'Space') continue; // only space-scoped finish attributes
    const space = cell(r, ['RowName']);
    const name = cell(r, ['Name']);
    const value = cell(r, ['Value']);
    if (!space || !name || !value) continue;
    const slot = bySpace.get(space) ?? {};
    if (/^FloorMaterial$/i.test(name)) slot.floor = value;
    else if (/^WallMaterial(-North)?$/i.test(name)) slot.wall = slot.wall ?? value;
    else if (/^BaseMaterial$/i.test(name)) slot.base = value;
    else if (/^CeilingMaterial$/i.test(name)) slot.ceiling = value;
    bySpace.set(space, slot);
  }
  const out: EPDFinish[] = [];
  for (const [space, s] of bySpace) {
    if (s.wall) out.push({ spaceRef: space, substrate: 'gypsum board', finish: s.wall, location: 'walls' });
    if (s.floor) out.push({ spaceRef: space, substrate: 'floor', finish: s.floor, location: 'floor' });
    if (s.ceiling) out.push({ spaceRef: space, substrate: 'ceiling', finish: s.ceiling, location: 'ceiling' });
  }
  return out;
}
