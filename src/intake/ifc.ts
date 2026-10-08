// IFC intake (CHANGE-02 §2). IFC (ISO-10303-21 "STEP") is a TEXT format, so the
// spaces/materials the spec needs can be extracted directly. Production uses
// IfcOpenShell in a container (env.IFC binding, extends the render-container
// pattern); when that binding is absent we parse the SPF text in-Worker. Either
// way we extract ONLY IfcSpace / IfcMaterial — a data extraction, not a model
// viewer (§7: no full geometry). `.rvt`/`.dwg` never reach here (see filetype).

import type { Env } from '../env';
import type { EPDElement, EPDMaterial, EPDSpace } from '../shared/types';

export interface IfcExtract {
  spaces: EPDSpace[];
  materials: EPDMaterial[];
  elements: EPDElement[]; // CHANGE-05 §4.1 — element features for SEC-catalog matching
  source: 'ifc-container' | 'ifc-spf';
}

export async function extractIfc(env: Env, bytes: Uint8Array): Promise<IfcExtract> {
  // Container path (IfcOpenShell) when bound — verifiable, handles IFCZIP/IFCXML.
  const ifc = (env as { IFC?: { getByName(n: string): { fetch(u: string, i: RequestInit): Promise<Response> } } }).IFC;
  if (ifc) {
    try {
      const res = await ifc.getByName('ifc').fetch('http://ifc/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/x-step' },
        body: bytes,
      });
      if (res.ok) {
        const j = (await res.json()) as { spaces?: EPDSpace[]; materials?: EPDMaterial[]; elements?: EPDElement[] };
        return { spaces: j.spaces ?? [], materials: j.materials ?? [], elements: j.elements ?? [], source: 'ifc-container' };
      }
    } catch {
      /* fall through to the in-Worker SPF parse */
    }
  }
  return { ...parseIfcSpf(new TextDecoder().decode(bytes)), source: 'ifc-spf' };
}

// Parse the STEP text directly. IFCSPACE params: GlobalId, OwnerHistory,
// Name(2), Description(3), ..., LongName(7). IFCMATERIAL: Name(0). These arg
// positions are stable across IFC2X3 and IFC4/4.3 (the shared IfcRoot -> IfcObject
// -> IfcProduct -> IfcSpatial* prefix is identical up to LongName; verified against
// the real IFC4X3_ADD2 EXPRESS schema and the IFC2X3 clinic export).
export function parseIfcSpf(text: string): { spaces: EPDSpace[]; materials: EPDMaterial[]; elements: EPDElement[] } {
  const spaces: EPDSpace[] = [];
  const materials: EPDMaterial[] = [];
  const seenSpace = new Set<string>();
  const seenMat = new Set<string>();

  const spaceRe = /#(\d+)\s*=\s*IFCSPACE\s*\(([\s\S]*?)\)\s*;/gi;
  let m: RegExpExecArray | null;
  while ((m = spaceRe.exec(text))) {
    const args = splitStepArgs(m[2]);
    const name = stepStr(args[2]) || stepStr(args[7]) || `space-${m[1]}`;
    const longName = stepStr(args[7]);
    const id = name;
    if (seenSpace.has(id)) continue;
    seenSpace.add(id);
    spaces.push({ id, name: longName || name });
  }

  const matRe = /#\d+\s*=\s*IFCMATERIAL\s*\(([\s\S]*?)\)\s*;/gi;
  while ((m = matRe.exec(text))) {
    const args = splitStepArgs(m[1]);
    const name = stepStr(args[0]);
    if (!name || seenMat.has(name)) continue;
    seenMat.add(name);
    materials.push({ category: name });
  }
  return { spaces, materials, elements: parseIfcElements(text) };
}

// CHANGE-05 §4.1 — building-element feature extraction for SEC-catalog selection.
// Reads the element ENTITY types below + their Revit type name (STEP arg[2],
// stable IFC2X3<->4.3), aggregated by type into EPDElement[]. This is a LEXICAL
// feature source for the Stage-2 matcher (keyword/typeNames vs. a section's title
// + PART 1 scope) — NOT authoritative content: nothing here is emitted as spec
// text, so G1/G7 are unaffected. Extend the map to cover more divisions.
const ELEMENT_TYPES: Record<string, { ifcType: string; keyword: string }> = {
  IFCDOOR: { ifcType: 'IfcDoor', keyword: 'door' }, // -> Div 08 (08 11 00 steel doors / 08 14 00 wood)
  IFCWINDOW: { ifcType: 'IfcWindow', keyword: 'window' }, // -> Div 08
  IFCWALL: { ifcType: 'IfcWall', keyword: 'wall' }, // -> Div 09 partitions / Div 04 masonry
  IFCWALLSTANDARDCASE: { ifcType: 'IfcWall', keyword: 'wall' }, // folded into wall
  IFCCURTAINWALL: { ifcType: 'IfcCurtainWall', keyword: 'curtain wall' }, // -> 08 44 00
  IFCROOF: { ifcType: 'IfcRoof', keyword: 'roof' }, // -> Div 07
  IFCSLAB: { ifcType: 'IfcSlab', keyword: 'slab' }, // -> Div 03
  IFCSTAIR: { ifcType: 'IfcStair', keyword: 'stair' }, // -> Div 05
  IFCSTAIRFLIGHT: { ifcType: 'IfcStair', keyword: 'stair' },
  IFCRAILING: { ifcType: 'IfcRailing', keyword: 'railing' }, // -> 05 52 00
  IFCBEAM: { ifcType: 'IfcBeam', keyword: 'beam' }, // -> Div 05 structural steel / 03 concrete
  IFCCOLUMN: { ifcType: 'IfcColumn', keyword: 'column' }, // -> Div 05 / 03
  IFCPLATE: { ifcType: 'IfcPlate', keyword: 'plate' },
  IFCFURNISHINGELEMENT: { ifcType: 'IfcFurnishingElement', keyword: 'furnishing' }, // -> Div 12
  IFCCOVERING: { ifcType: 'IfcCovering', keyword: 'covering' }, // keyword refined by PredefinedType below
};

// IfcCovering.PredefinedType (an enum arg like `.CEILING.`) distinguishes ceiling
// vs. flooring vs. cladding — a strong Division 09/07 signal — so it overrides the
// base 'covering' keyword when present.
const COVERING_KEYWORD: Record<string, string> = {
  CEILING: 'ceiling', // -> 09 51 00 acoustical ceilings
  FLOORING: 'flooring', // -> 09 65 00 resilient / 09 68 00 carpet
  CLADDING: 'cladding', // -> Div 07
  ROOFING: 'roofing', // -> Div 07
  SKIRTINGBOARD: 'skirting',
  MOLDING: 'molding',
  INSULATION: 'insulation',
  MEMBRANE: 'membrane',
};

export function parseIfcElements(text: string): EPDElement[] {
  const tokens = Object.keys(ELEMENT_TYPES);
  const re = new RegExp(`#\\d+\\s*=\\s*(${tokens.join('|')})\\s*\\(([\\s\\S]*?)\\)\\s*;`, 'gi');
  const agg = new Map<string, { ifcType: string; keyword: string; count: number; names: Set<string> }>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const token = m[1].toUpperCase();
    const def = ELEMENT_TYPES[token];
    if (!def) continue;
    const args = splitStepArgs(m[2]);
    let keyword = def.keyword;
    if (token === 'IFCCOVERING') {
      // PredefinedType is the enum-shaped arg (e.g. `.CEILING.`); take the last one.
      const pd = args
        .map((a) => a.trim().match(/^\.([A-Z_]+)\.$/)?.[1])
        .filter((v): v is string => !!v && v !== 'NOTDEFINED')
        .pop();
      keyword = (pd && COVERING_KEYWORD[pd]) || 'covering';
    }
    const key = `${def.ifcType}|${keyword}`;
    let e = agg.get(key);
    if (!e) {
      e = { ifcType: def.ifcType, keyword, count: 0, names: new Set() };
      agg.set(key, e);
    }
    e.count++;
    const name = cleanTypeName(stepStr(args[2])); // arg[2] = Name (Revit family/type string)
    if (name && e.names.size < 8) e.names.add(name);
  }
  return [...agg.values()]
    .map((e) => ({ ifcType: e.ifcType, keyword: e.keyword, count: e.count, typeNames: e.names.size ? [...e.names] : undefined }))
    .sort((a, b) => b.count - a.count);
}

// Strip the trailing `:<instance-id>` Revit appends and cap length, keeping the
// lexically-useful family/type text (e.g. 'M_Single-Flush:0915 x 2134mm').
function cleanTypeName(s: string): string {
  return s.replace(/:\d+\s*$/, '').trim().slice(0, 80);
}

// Split a STEP parameter list on top-level commas (ignoring commas inside
// quoted strings and nested parens).
function splitStepArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === "'") {
        if (s[i + 1] === "'") {
          cur += s[++i];
        } else inStr = false;
      }
    } else if (c === "'") {
      inStr = true;
      cur += c;
    } else if (c === '(') {
      depth++;
      cur += c;
    } else if (c === ')') {
      depth--;
      cur += c;
    } else if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function stepStr(arg: string | undefined): string {
  if (!arg) return '';
  const t = arg.trim();
  if (t === '$' || t === '*') return '';
  const m = t.match(/^'([\s\S]*)'$/);
  return m ? m[1].replace(/''/g, "'").replace(/\\X2\\([0-9A-F]{4})\\X0\\/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))) : t;
}
