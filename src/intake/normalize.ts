// Intake normalization (CHANGE-02 §2) — MANY PARSERS, ONE MODEL. Every accepted
// input is folded into a single ExtractedProjectData; the pipeline reads only
// that. Provenance is recorded per field so a mis-parse (LLM program read, IFC
// extraction) is visible and correctable at Gate 0 before the pipeline drafts.

import type { Env } from '../env';
import { aiEnabled } from '../shared/ai';
import type {
  DrawingRow,
  EPDElement,
  EPDFinish,
  EPDMaterial,
  EPDProvenance,
  EPDSpace,
  ExtractedProjectData,
  ModeContext,
  ProgressEvent,
} from '../shared/types';
import { detectFileType, type FileType } from './filetype';
import { extractIfc } from './ifc';
import { extractProgram } from './program';
import { parseTableAsync } from './table';
import { extractDocxText, extractPdfText } from './text';
import { parseCobie } from './cobie';

// CHANGE-05 §1 — 'bim-classification' is now just a COBie workbook slot (the OmniClass
// carrier). A COBie workbook uploaded as 'finish-schedule' is auto-detected too.
export type InputKind =
  | 'finish-schedule'
  | 'bim-ifc'
  | 'bim-classification'
  | 'drawings'
  | 'program'
  | 'standards'
  | 'ref-spec';

export interface RawInput {
  kind: InputKind;
  filename: string;
  bytes: Uint8Array;
}

export interface NormalizeResult {
  data: ExtractedProjectData;
  perInput: { filename: string; kind: InputKind; parseStatus: 'parsed' | 'rejected'; reason?: string }[];
  // Objective 2 — narrate-on-return progress log for the Intake step (does NOT
  // change ExtractedProjectData; purely informational).
  events: ProgressEvent[];
}

export async function normalizeInputs(
  env: Env,
  ctx: ModeContext,
  projectId: string,
  inputs: RawInput[],
): Promise<NormalizeResult> {
  const spaces = new Map<string, EPDSpace>();
  const finishes: EPDFinish[] = [];
  const materials = new Map<string, EPDMaterial>();
  // CHANGE-05 §4.1 — element features (aggregated by ifcType|keyword across inputs).
  const elements = new Map<string, EPDElement>();
  const drawings: DrawingRow[] = [];
  const drawingsIndex: ExtractedProjectData['drawingsIndex'] = [];
  const generalNotes: string[] = [];
  const provenance: EPDProvenance[] = [];
  let program: ExtractedProjectData['program'] = {};
  const perInput: NormalizeResult['perInput'] = [];
  const events: ProgressEvent[] = [];
  const emit = (message: string, count?: number, total?: number) =>
    events.push({ stage: 'parse', message, count, total, at: new Date().toISOString() });

  const addSpace = (s: EPDSpace) => {
    const cur = spaces.get(s.id);
    spaces.set(s.id, { ...cur, ...s, id: s.id });
  };
  // Merge element features by ifcType|keyword: sum counts, union typeNames (cap 8).
  const addElement = (e: EPDElement) => {
    const key = `${e.ifcType}|${e.keyword}`;
    const cur = elements.get(key);
    if (!cur) {
      elements.set(key, { ...e });
      return;
    }
    cur.count += e.count;
    const names = new Set([...(cur.typeNames ?? []), ...(e.typeNames ?? [])]);
    cur.typeNames = names.size ? [...names].slice(0, 8) : undefined;
  };

  for (const inp of inputs) {
    const det = detectFileType(inp.filename, inp.bytes);
    if (det.rejected || !det.type) {
      // Say plainly when an input is rejected (proprietary/unsupported).
      emit(`Rejected ${inp.filename} — ${det.reason ?? 'unsupported format'}.`);
      perInput.push({ filename: inp.filename, kind: inp.kind, parseStatus: 'rejected', reason: det.reason });
      continue;
    }
    const type = det.type;
    try {
      await handleInput(env, ctx, inp, type, {
        addSpace,
        addFinish: (f) => finishes.push(f),
        addMaterial: (m) => materials.set(m.category, m),
        addElement,
        addDrawing: (d) => drawings.push(d),
        addDrawingIndex: (d) => drawingsIndex.push(d),
        addNote: (n) => generalNotes.push(n),
        setProgram: (p) => (program = p),
        prov: (field, source, confidence) => provenance.push({ field, source, confidence }),
        emit,
      });
      perInput.push({ filename: inp.filename, kind: inp.kind, parseStatus: 'parsed' });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      emit(`Could not parse ${inp.filename} — ${reason}.`);
      perInput.push({ filename: inp.filename, kind: inp.kind, parseStatus: 'rejected', reason });
    }
  }

  // CHANGE-05 §1/§4.1 — COBie feature pass (the OmniClass classification path is
  // reverted). Any COBie workbook (whatever slot it arrived in) contributes spaces,
  // per-space finishes, and free-text product/system features for the SEC matcher —
  // no OmniClass code, no crosswalk.
  for (const inp of inputs) {
    const det = detectFileType(inp.filename, inp.bytes);
    if (det.type !== 'xlsx') continue;
    // Products + spaces only (fast path). The per-space finish extraction reads the
    // large COBie Attribute sheet and is opt-in elsewhere; the SEC matcher selects
    // from spaces + product features, so it is not needed here.
    const parsed = await parseCobie(inp.bytes);
    if (!parsed.isCobie) continue;
    emit(`Reading spaces and product features from the COBie workbook (${inp.filename})…`);
    for (const s of parsed.spaces) addSpace(s);
    for (const p of parsed.products) addElement(p);
    emit(
      `Extracted ${parsed.spaces.length} space(s) and ${parsed.products.reduce((n, p) => n + p.count, 0)} product/system feature(s) (${parsed.products.length} kind(s)) from the COBie workbook.`,
      parsed.products.length,
    );
    if (parsed.spaces.length) provenance.push({ field: 'spaces', source: 'xlsx', confidence: 1.0 });
    if (parsed.products.length) provenance.push({ field: 'elements', source: 'xlsx', confidence: 0.9 });
    break;
  }

  const data: ExtractedProjectData = {
    projectId,
    spaces: [...spaces.values()],
    finishes,
    materials: [...materials.values()],
    elements: [...elements.values()],
    program,
    drawingsIndex,
    generalNotes,
    drawings,
    provenance,
  };
  return { data, perInput, events };
}

interface Sink {
  addSpace: (s: EPDSpace) => void;
  addFinish: (f: EPDFinish) => void;
  addMaterial: (m: EPDMaterial) => void;
  addElement: (e: EPDElement) => void;
  addDrawing: (d: DrawingRow) => void;
  addDrawingIndex: (d: ExtractedProjectData['drawingsIndex'][number]) => void;
  addNote: (n: string) => void;
  setProgram: (p: ExtractedProjectData['program']) => void;
  prov: (field: string, source: string, confidence: number) => void;
  emit: (message: string, count?: number, total?: number) => void;
}

async function handleInput(env: Env, ctx: ModeContext, inp: RawInput, type: FileType, sink: Sink): Promise<void> {
  switch (inp.kind) {
    case 'finish-schedule': {
      if (type !== 'csv' && type !== 'xlsx')
        throw new Error(`finish schedule must be CSV or XLSX (got ${type})`);
      const rows = await parseTableAsync(type, inp.bytes);
      sink.emit(`Parsing the finish schedule — ${rows.length} row(s) read…`, rows.length, rows.length);
      let n = 0;
      let added = 0;
      for (const r of rows) {
        const room = pick(r, ['room', 'space', 'room number', 'space id']);
        const substrate = pick(r, ['substrate', 'material', 'surface']);
        if (!room && !substrate) continue;
        // Synthesize one id and use it for BOTH the space and the finish's
        // spaceRef — otherwise a row with a substrate but no room left the finish
        // pointing at '' while the space got a `space-N` id (orphaned linkage).
        const spaceId = room || `space-${++n}`;
        sink.addSpace({ id: spaceId, name: pick(r, ['name', 'space name']) || undefined });
        sink.addFinish({
          spaceRef: spaceId,
          substrate,
          finish: pick(r, ['finish', 'system', 'coating']) || 'paint',
          sheen: pick(r, ['sheen', 'gloss']) || undefined,
          location: pick(r, ['location', 'surface']) || undefined,
        });
        added++;
        const shown = pick(r, ['shown_finish', 'shownfinish', 'drawing finish', 'drawn finish']);
        if (shown) sink.addDrawing({ room, shownFinish: shown });
      }
      // Count/message must agree: report finishes found out of rows scanned (a
      // COBie handover workbook in this slot often yields 0 finish rows — that is
      // honest, and the outline still comes from the COBie/IFC feature pass).
      sink.emit(`Read the finish schedule — found ${added} finish assignment(s) in ${rows.length} row(s) scanned.`, added, rows.length);
      sink.prov('finishes', type, 1.0);
      sink.prov('spaces', type, 1.0);
      break;
    }
    case 'bim-classification': {
      // A COBie workbook (XLSX). CHANGE-05 §1: no OmniClass code is read — the
      // COBie feature pass in normalizeInputs extracts spaces/finishes/products.
      if (type !== 'xlsx')
        throw new Error(`COBie input must be an XLSX workbook (got ${type})`);
      sink.emit('Received COBie workbook — extracting spaces, finishes, and product features…');
      break;
    }
    case 'bim-ifc': {
      if (type !== 'ifc') throw new Error(`BIM input must be IFC (got ${type}); export IFC from Revit`);
      sink.emit('Extracting IfcSpace, IfcMaterial, and building elements from the IFC model…');
      const ex = await extractIfc(env, inp.bytes);
      for (const s of ex.spaces) sink.addSpace(s);
      for (const m of ex.materials) sink.addMaterial(m);
      for (const e of ex.elements) sink.addElement(e);
      const elementTotal = ex.elements.reduce((n, e) => n + e.count, 0);
      sink.emit(
        `Extracted ${ex.spaces.length} space(s), ${ex.materials.length} material(s), and ${elementTotal} building element(s) (${ex.elements.length} type(s)) from the IFC model.`,
        ex.spaces.length,
      );
      sink.prov('spaces', ex.source, ex.source === 'ifc-container' ? 1.0 : 0.8);
      sink.prov('materials', ex.source, ex.source === 'ifc-container' ? 1.0 : 0.8);
      if (ex.elements.length) sink.prov('elements', ex.source, ex.source === 'ifc-container' ? 1.0 : 0.8);
      break;
    }
    case 'drawings': {
      if (type === 'csv' || type === 'xlsx') {
        // A drawings schedule export with room + shown finish (spec-vs-drawing).
        for (const r of await parseTableAsync(type, inp.bytes)) {
          const room = pick(r, ['room', 'space']);
          const shown = pick(r, ['shown_finish', 'shownfinish', 'finish', 'drawing finish']);
          if (room && shown) sink.addDrawing({ room, shownFinish: shown });
        }
        sink.prov('drawings', type, 1.0);
      } else if (type === 'pdf' || type === 'ifc') {
        const text = type === 'pdf' ? extractPdfText(inp.bytes) : new TextDecoder().decode(inp.bytes);
        const scanned = noteIfScanned(type, text, sink, inp.filename);
        indexDrawingSheets(text, sink);
        sink.prov('drawingsIndex', type, scanned ? 0.3 : 0.7);
      }
      break;
    }
    case 'program': {
      const text = extractDocumentText(type, inp.bytes);
      const scanned = noteIfScanned(type, text, sink, inp.filename);
      sink.emit(`Reading the project program with structured extraction${aiEnabled(env) ? '' : ' (deterministic)'}…`);
      const program = await extractProgram(env, ctx, text);
      sink.setProgram(program);
      const usedLlm = aiEnabled(env); // same predicate extractProgram gates on
      sink.prov('program', usedLlm ? 'llm' : type, scanned ? 0.3 : usedLlm ? 0.8 : 0.6);
      break;
    }
    case 'standards': {
      // Known agency criteria are seeded from D1 (P100/DGS). Firm-specific
      // standards would be LLM-extracted to `criteria` marked derived — out of
      // the demo's scope; we record a note so the reviewer sees it was received.
      sink.addNote(`Client standards received (${inp.filename}) — agency criteria load from D1; firm-specific extraction deferred.`);
      sink.prov('generalNotes', type, 0.5);
      break;
    }
    case 'ref-spec': {
      // Supplementary reference specs feed SECONDARY (house-language) retrieval —
      // never authoritative validation. Noted here; embedding handled on upload.
      sink.addNote(`Reference precedent received (${inp.filename}) — indexed for secondary retrieval only.`);
      sink.prov('generalNotes', type, 0.5);
      break;
    }
  }
}

function extractDocumentText(type: FileType, bytes: Uint8Array): string {
  if (type === 'docx') return extractDocxText(bytes);
  if (type === 'pdf') return extractPdfText(bytes);
  return new TextDecoder().decode(bytes);
}

// Scanned/raster PDFs are now ACCEPTED (Rev D). We still can't extract their text
// in-Worker, so we record a low-confidence note (visible + correctable at Gate 0)
// instead of rejecting — the reviewer can supply the missing facts by hand.
// Returns true when the input looked scanned.
function noteIfScanned(type: FileType, text: string, sink: Sink, filename: string): boolean {
  if (type === 'pdf' && text.replace(/\s/g, '').length < 24) {
    sink.addNote(
      `Scanned/raster PDF accepted (${filename}) — no text was extractable (no OCR performed). Confirm or fill the affected fields at Gate 0.`,
    );
    return true;
  }
  return false;
}

function indexDrawingSheets(text: string, sink: Sink): void {
  // Sheet references like "A-601 Finish Schedule".
  const re = /\b([A-Z]{1,2}-?\d{2,3})\b\s*[-–:]?\s*([A-Z][A-Za-z /&]{3,40})?/g;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(text)) && count < 50) {
    sink.addDrawingIndex({ sheet: m[1], title: (m[2] || '').trim() || undefined });
    count++;
  }
  for (const line of text.split('\n')) if (/\bnote\b/i.test(line) && line.length < 200) sink.addNote(line.trim());
}

function pick(row: Record<string, string>, keys: string[]): string {
  for (const k of Object.keys(row)) {
    const norm = k.toLowerCase().trim();
    if (keys.includes(norm)) return (row[k] ?? '').trim();
  }
  return '';
}
