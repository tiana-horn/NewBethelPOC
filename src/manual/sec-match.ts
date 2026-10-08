// CHANGE-05 §4 — the SEC-catalog lexical matcher (prototype). Replaces the
// reverted OmniClass crosswalk: it selects candidate UFGS sections by matching
// the project's extracted FEATURES (space functions, finishes, materials, and the
// IFC/COBie element+product features from §4.1) against each section's TITLE +
// PART 1 SCOPE text — the free, non-proprietary SEC catalog. No OmniClass, no
// licensed data, no model authoring: this is a deterministic TF-IDF-style ranking
// whose only output is "which real SEC file to draft", so G1/G7 are unaffected.
//
// This is the lexical pass (§4.2, always available, no index). CHANGE-06 §3 (C4)
// adds the optional embedding recall enhancement over a `ufgs` Vectorize namespace
// (built at ufgs-bulk ingest) — see sec-embed.ts. That pass is REMOTE-ONLY and
// blends into these candidates; this lexical pass remains the offline floor.

import { parseSecHeader, secToPlainText } from '../corpus/sec-parser';
import type { EPDElement, ExtractedProjectData } from '../shared/types';

export interface SecCatalogEntry {
  section: string; // '09 90 00'
  title: string; // 'Paints and Coatings'
  scopeText?: string; // PART 1 scope text (tags stripped)
  r2Key?: string; // == ufgs_corpus_section.r2_key (for secFileRef)
}
export interface SecCandidate {
  section: string;
  title: string;
  secFileRef?: string;
  matchBasis: string; // human-readable: which features drove the match
  confidence: number; // 0..1
}
export interface FeatureTerm {
  text: string;
  weight: number;
  kind: string; // 'element' | 'product' | 'finish' | 'material' | 'space' — for matchBasis
}

export interface MatchOptions {
  titleWeight: number;
  scopeWeight: number;
  scopeIdfMin: number; // a scope token only counts if it is this distinctive (IDF >=)
  topN: number; // a section scores on its top-N feature contributions (anti-noise)
  k: number; // confidence saturation constant: confidence = score / (score + k)
  threshold: number; // minimum confidence to be a candidate
  maxCandidates: number;
}
export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  titleWeight: 3,
  scopeWeight: 0.6,
  scopeIdfMin: 4, // ~ token in < ~2.5% of sections; drops 'wall'/'system'/'control' noise
  topN: 4,
  k: 22,
  threshold: 0.25,
  maxCandidates: 60,
};

// Feature kinds whose text is a specific product/room STRING (not a descriptor):
// too noisy to match against scope bodies, so they score on TITLE hits only.
const TITLE_ONLY_KINDS = new Set(['element-name', 'product-name', 'space']);

// ---- Tokenization ---------------------------------------------------------

// Structural/boilerplate words carry no selection signal; drop them. Domain-common
// words ('system', 'equipment') are NOT listed — IDF down-weights them naturally.
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'by', 'as', 'at', 'be',
  'is', 'are', 'this', 'that', 'shall', 'must', 'section', 'work', 'general', 'part', 'provide',
  'include', 'including', 'used', 'use', 'submittals', 'submittal', 'references', 'reference',
  'other', 'per', 'not', 'all', 'any', 'each', 'from', 'which', 'type', 'unit', 'units',
]);

// Conservative singularization so 'doors'->'door', 'coatings'->'coating',
// 'fixtures'->'fixture'. Leaves 'ss' words and short words alone. (Does not handle
// '-ies'; a real build would use a proper stemmer — noted.)
function singular(w: string): string {
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}
export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    const t = singular(raw);
    if (t.length < 3 || STOP.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// ---- Feature extraction from the normalized intake -------------------------

// Salience from instance count: more instances = a slightly stronger signal, but
// bounded (log) so 429 fire-alarm devices don't swamp 9 doors.
function salience(count: number | undefined): number {
  return 1 + Math.log10(1 + Math.max(0, count ?? 1));
}

export function extractFeatureTerms(epd: Partial<ExtractedProjectData> | null): FeatureTerm[] {
  // Dedupe by lowercased text (269 identical 'paint' finishes must count ONCE),
  // keeping the strongest weight and a stable kind. This is essential: without it
  // a repeated feature swamps the ranking.
  const byText = new Map<string, FeatureTerm>();
  const add = (text: string, weight: number, kind: string) => {
    const key = (text ?? '').trim().toLowerCase();
    if (!key) return;
    const cur = byText.get(key);
    if (!cur || weight > cur.weight) byText.set(key, { text: text.trim(), weight, kind });
  };
  const el = (e: EPDElement, base: number, kind: string, nameKind: string) => {
    const s = salience(e.count);
    add(e.keyword, base * s, kind);
    for (const n of e.typeNames ?? []) add(n, base * 0.4 * s, nameKind);
  };
  for (const e of epd?.elements ?? []) {
    // COBie products are tagged CobieType/CobieSystem; IFC elements use Ifc* types.
    if (e.ifcType.startsWith('Cobie')) el(e, 3, 'product', 'product-name');
    else el(e, 3, 'element', 'element-name');
  }
  for (const f of epd?.finishes ?? []) {
    if (f.finish) add(f.finish, 2.5, 'finish');
    if (f.substrate) add(f.substrate, 1, 'material');
  }
  for (const m of epd?.materials ?? []) add(m.category, 1.5, 'material');
  for (const s of epd?.spaces ?? []) if (s.name) add(s.name, 0.5, 'space');
  return [...byText.values()];
}

// ---- The index + matcher ---------------------------------------------------

interface IndexedSection {
  entry: SecCatalogEntry;
  titleTokens: Set<string>;
  scopeTokens: Set<string>;
}
export interface SecIndex {
  sections: IndexedSection[];
  idf: Map<string, number>;
}

export function buildSecIndex(catalog: SecCatalogEntry[]): SecIndex {
  const sections: IndexedSection[] = catalog.map((entry) => ({
    entry,
    titleTokens: new Set(tokenize(entry.title)),
    scopeTokens: new Set(tokenize(entry.scopeText ?? '')),
  }));
  // Document frequency across title ∪ scope, then smoothed IDF.
  const df = new Map<string, number>();
  for (const s of sections) {
    for (const t of new Set([...s.titleTokens, ...s.scopeTokens])) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = sections.length || 1;
  const idf = new Map<string, number>();
  for (const [t, c] of df) idf.set(t, Math.log((n + 1) / (c + 1)) + 1);
  return { sections, idf };
}

export function matchSections(
  features: FeatureTerm[],
  index: SecIndex,
  options: Partial<MatchOptions> = {},
): SecCandidate[] {
  const opt = { ...DEFAULT_MATCH_OPTIONS, ...options };
  const idf = (t: string) => index.idf.get(t) ?? Math.log((index.sections.length + 1) / 1) + 1;

  const candidates: SecCandidate[] = [];
  for (const s of index.sections) {
    const contrib: { text: string; kind: string; field: 'title' | 'scope'; w: number }[] = [];
    for (const f of features) {
      const tokens = tokenize(f.text);
      if (tokens.length === 0) continue;
      const inTitle = tokens.filter((t) => s.titleTokens.has(t));
      // Scope only counts DISTINCTIVE tokens (high IDF), and never for the noisy
      // product/room-string kinds — those score on title hits only.
      const scopeAllowed = !TITLE_ONLY_KINDS.has(f.kind);
      const inScope = scopeAllowed
        ? tokens.filter((t) => !s.titleTokens.has(t) && s.scopeTokens.has(t) && idf(t) >= opt.scopeIdfMin)
        : [];
      if (inTitle.length === 0 && inScope.length === 0) continue;
      const titleW = inTitle.reduce((a, t) => a + idf(t), 0);
      const scopeW = inScope.reduce((a, t) => a + idf(t), 0);
      // Phrase-coherence: reward a feature whose whole phrase lands in the title
      // (e.g. 'unitary air conditioning equipment' fully matching a title).
      const frac = inTitle.length / tokens.length;
      const c = f.weight * (opt.titleWeight * titleW * (0.5 + frac) + opt.scopeWeight * scopeW);
      if (c <= 0) continue;
      contrib.push({ text: f.text, kind: f.kind, field: inTitle.length ? 'title' : 'scope', w: c });
    }
    if (contrib.length === 0) continue;
    // Anti-noise: score on the section's TOP-N feature contributions, not the sum
    // over hundreds of features — otherwise a section that weakly touches many
    // features outranks one that strongly matches a few.
    contrib.sort((a, b) => b.w - a.w);
    let score = contrib.slice(0, opt.topN).reduce((a, x) => a + x.w, 0);
    // Title-coverage factor: how much of the section's OWN title the features
    // explain. Demotes a generic keyword ('door') matching a long tangential title
    // ('Corrosion Control Hangar Doors') below a concise on-target one ('Wood
    // Doors'), so one keyword doesn't flood the list with every section in a family.
    const matchedTitle = new Set<string>();
    for (const t of s.titleTokens) if (features.some((f) => tokenize(f.text).includes(t))) matchedTitle.add(t);
    const coverage = s.titleTokens.size ? matchedTitle.size / s.titleTokens.size : 0;
    score *= 0.4 + 0.6 * coverage;
    const confidence = score / (score + opt.k);
    if (confidence < opt.threshold) continue;
    const basis = contrib
      .slice(0, 3)
      .map((x) => `${x.kind}:'${x.text}'→${x.field}`)
      .join('; ');
    candidates.push({
      section: s.entry.section,
      title: s.entry.title,
      secFileRef: s.entry.r2Key,
      matchBasis: basis,
      confidence: Math.round(confidence * 1000) / 1000,
    });
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates.slice(0, opt.maxCandidates);
}

// ---- Production catalog: build from D1 `ufgs_corpus_section` ----------------
// The section number + title are the always-available catalog (one query, no R2).
// PART 1 scope is left undefined here (it lives in the R2 IR); the lexical pass
// works on title alone — verified to select the same divisions as title+scope on
// the real clinic. A future enrichment stores a `scope_text` column at ingest.
export async function buildSecCatalogFromDb(db: D1Database): Promise<SecCatalogEntry[]> {
  const res = await db
    .prepare(`SELECT section, title, r2_key AS r2Key FROM ufgs_corpus_section`)
    .all<{ section: string; title: string | null; r2Key: string | null }>();
  return (res.results ?? []).map((r) => ({ section: r.section, title: r.title ?? r.section, r2Key: r.r2Key ?? undefined }));
}

// ---- Prototype bridge: build a catalog entry straight from a `.SEC` file ----
// Production builds the catalog from `ufgs_corpus_section` (section, title) + the
// section's PART 1 scope in its R2 IR JSON. For the file-based prototype/tests we
// derive the same shape directly from the raw SpecsIntact XML.
export function secCatalogEntryFromXml(xml: string, fallbackSection: string, r2Key?: string): SecCatalogEntry {
  const header = parseSecHeader(xml);
  const section = header?.section ?? fallbackSection;
  const stl = xml.match(/<STL>([\s\S]*?)<\/STL>/);
  const title = stl ? stl[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : section;
  // PART 1 scope: the plain text between the PART 1 and PART 2 markers (bounded so
  // we don't fold PART 2/3 product+execution text into the selection scope).
  const plain = secToPlainText(xml);
  const i1 = plain.search(/PART\s*1\b/i);
  const i2 = plain.search(/PART\s*2\b/i);
  const start = i1 >= 0 ? i1 : 0;
  const end = i2 > start ? i2 : Math.min(plain.length, start + 4000);
  const scopeText = plain.slice(start, end);
  return { section, title, scopeText, r2Key };
}
