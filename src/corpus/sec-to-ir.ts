// CHANGE-04 (working-prototype expansion) — a GENERAL UFGS `.SEC` -> SectionIR
// converter. This is what makes "every section this project needs drafts from
// real UFGS corpus" a property of the SYSTEM, not of any one hand-authored
// fixture: it works on ANY of the 703 real SpecsIntact section files the same
// way, so a firm's own building (any OmniClass mix, any division) gets real
// drafted text without a rebuild per project.
//
// Design: a single-pass token scan over each PART's body (PRT/SPT/TAI/TXT/OLI/
// NTE are the only structural tags that matter; TXT/OLI/NTE never nest, so a
// non-greedy capture is safe for their inner content). A top-level SPT (direct
// child of a PRT) becomes an Article; a NESTED SPT (a subpart within a subpart)
// is FLATTENED into the enclosing Article as a heading paragraph, because the
// SectionIR model is two levels (Article > Paragraph) by design (CHANGE-01/03).
//
// What this does NOT attempt: emulate a full SpecsIntact renderer. Formatting-
// only tags (BRK/AST/HL3/table markup) are dropped; bracket semantics beyond
// "optional span" / "designer fill" are not distinguished (real UFGS bracket
// conventions vary too much to classify safely without inventing intent); a
// handful of TAI (tailoring) OPT values outside the two modeled axes (agency,
// delivery) are preserved INLINE with a visible disclosure marker rather than
// silently included or excluded — never a silent guess (mirrors G10's discipline
// applied here to tailoring instead of classification).

import type { Paragraph, Part, Article, SectionIR, Selection } from '../shared/types';
import { extractBracketSelections, flattenInertBrackets } from '../shared/brackets';
import { parseSecHeader, parseSecReferences, parseSecSubmittals } from './sec-parser';

export interface SecToIrResult {
  ir: SectionIR;
  edition: string | null; // header edition, e.g. 'February 2021' (G7 — data, not model recall)
  warnings: string[]; // notes-to-designer dropped with no selection to attach to,
                        // multi-agency tailoring simplified to the first listed, etc.
}

const AGENCY_OPT: Record<string, 'ARMY' | 'NAVY' | 'AIRFORCE'> = {
  ARMY: 'ARMY',
  NAVY: 'NAVY',
  'AIR FORCE': 'AIRFORCE',
  AIRFORCE: 'AIRFORCE',
  USAF: 'AIRFORCE',
};
function mapAgencyOpt(opt: string): 'ARMY' | 'NAVY' | 'AIRFORCE' | null {
  const first = opt.split(',')[0]?.trim().toUpperCase();
  return AGENCY_OPT[first] ?? null;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_x, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

// Collapse <MET>x</MET><ENG>y</ENG> leaf pairs into plain "x (y)" dual-unit
// text (metric-then-imperial, the UFGS document's own convention) BEFORE
// tokenizing — both are simple leaf tags with plain content, never nested, so a
// global pass is safe and keeps the main walker free of a third unit concern.
// (Full ctx.units-driven single/dual TOGGLE rendering remains separate future
// work — Part 7 — this only ensures the source's own numbers are not lost.)
function collapseUnits(xml: string): string {
  // MET/ENG content is plain numeric/text, never nested tags — bound the inner
  // capture to non-'<' characters. `[\s\S]*?` here would be a correctness bug:
  // if a <MET> ever lacks an IMMEDIATELY-following <ENG> (elsewhere in a 700+
  // section corpus, not guaranteed), the non-greedy group backtracks across
  // every intervening tag hunting for the next valid pair — silently deleting
  // whole articles' worth of SPT/TTL structure in between.
  return xml
    .replace(/<MET>([^<]*)<\/MET>\s*<ENG>([^<]*)<\/ENG>/g, (_m, met, eng) => `${stripTags(met)} (${stripTags(eng)})`)
    .replace(/<MET>([^<]*)<\/MET>/g, (_m, met) => stripTags(met))
    .replace(/<ENG>([^<]*)<\/ENG>/g, (_m, eng) => stripTags(eng));
}
function stripTags(s: string): string {
  return unescapeXml(s.replace(/<[^>]+>/g, ''));
}

function indexToLetter(n: number): string {
  // 0->A, 1->B, ..., 25->Z, 26->AA, 27->AB, ... (paragraph ids beyond 26 items).
  let s = '';
  let x = n;
  do {
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return s;
}

// Inline TAI handling within one paragraph's raw text: a TAI wrapping the
// ENTIRE paragraph becomes real Paragraph.tailoring when the OPT maps to a
// modeled agency (clean, structural case — also used for the SPT-wrapping case
// below via the same stack). A PARTIAL span (mid-sentence) or a non-agency OPT
// is flattened INLINE (never dropped) with a visible "[OPT]" disclosure marker,
// since sub-paragraph exclusion isn't representable in this IR and guessing
// applicability would misrepresent the source.
function resolveInlineTai(raw: string): { text: string; wholeSpanAgency: 'ARMY' | 'NAVY' | 'AIRFORCE' | null } {
  const taiRe = /<TAI\s+OPT="([^"]*)"\s*>([\s\S]*?)<\/TAI>/g;
  let wholeSpanAgency: 'ARMY' | 'NAVY' | 'AIRFORCE' | null = null;
  const trimmedRaw = raw.trim();
  const soleMatch = raw.match(/^\s*<TAI\s+OPT="([^"]*)"\s*>([\s\S]*)<\/TAI>\s*$/);
  if (soleMatch && soleMatch[0].trim() === trimmedRaw) {
    const agency = mapAgencyOpt(soleMatch[1]);
    if (agency) return { text: soleMatch[2], wholeSpanAgency: agency };
  }
  const text = raw.replace(taiRe, (_m, opt: string, inner: string) => {
    const agency = mapAgencyOpt(opt);
    // Flatten inline; disclose non-agency (unmodeled axis) options so a partial
    // span is never silently presented as universally applicable.
    return agency ? inner : `[${opt.trim()}] ${inner}`;
  });
  return { text, wholeSpanAgency };
}

interface WalkCtx {
  section: string;
  warnings: string[];
}

// Build one Paragraph from a TXT/OLI's raw inner XML. Handles inline RID/SUB
// (flattened to their plain designation/item text — the REFERENCES/SUBMITTALS
// articles own the STRUCTURED refRequests/subRequests, so an inline citation
// elsewhere is prose, not a second request), brackets -> Selections, and the
// "shall"/"must" mandatory/locked heuristic already used by the hand-authored
// fixtures (a real UFGS convention, not invented here).
function makeParagraph(
  raw: string,
  id: string,
  sourceRef: string,
  ctx: WalkCtx,
  pendingNote: string | null,
  structuralTaiAgency: 'ARMY' | 'NAVY' | 'AIRFORCE' | null,
  structuralTaiMarker: string | null,
): Paragraph {
  const { text: inlineResolved, wholeSpanAgency } = resolveInlineTai(raw);
  let text = inlineResolved
    .replace(/<RID>([\s\S]*?)<\/RID>/g, (_m, d) => stripTags(d))
    .replace(/<SUB>([\s\S]*?)<\/SUB>/g, (_m, d) => stripTags(d));
  text = stripTags(text).replace(/\s+/g, ' ').trim();
  if (structuralTaiMarker) text = `[${structuralTaiMarker}] ${text}`;

  // Brackets -> Selections via the shared classifier: nested-aware, and inert
  // grammar (`[s]`, `[and]`, `[,]`) is flattened into the prose rather than
  // surfaced as a bogus decision (CHANGE-07 follow-up). No literal `[`/`]`
  // survives, so the freeze-path G13 scan stays a hard fail.
  const extracted = extractBracketSelections(text, (n) => `${id}-b${n + 1}`);
  text = extracted.text;
  const selections: Selection[] = extracted.selections;

  // CHANGE-06 §4 (C3) — an orphan Note-to-Designer (one with no bracket/selection
  // to attach to) is RETAINED as a review-only annotation on this paragraph, not
  // dropped. It never reaches issued output (the emitter gates designerNotes on
  // review mode). A note WITH a bracket still rides on that selection as before.
  let designerNotes: string[] | undefined;
  if (pendingNote) {
    if (selections.length > 0) selections[0].note = pendingNote;
    else designerNotes = [pendingNote];
  }

  const mandatory = /\b(shall|must)\b/i.test(text);
  const agency = wholeSpanAgency ?? structuralTaiAgency;
  const paragraph: Paragraph = {
    id,
    text,
    sourceRef,
    locked: mandatory,
    mandatory,
    ...(selections.length ? { selections } : {}),
    ...(designerNotes ? { designerNotes } : {}),
  };
  if (agency)
    paragraph.tailoring = { requirementId: `tai-${id}`, axis: 'agency', includeWhen: { agency } };
  return paragraph;
}

// Token stream for one PART's body: TTL (article/heading titles), SPT open/
// close (article/subpart boundaries), TAI open/close (structural tailoring
// scope), TXT/OLI (paragraph content), NTE (note-to-designer — attached to the
// paragraph it precedes as review-only designerNotes; NEVER issued, CHANGE-06 §4).
const TOKEN_RE =
  /<TTL>([\s\S]*?)<\/TTL>|<SPT>|<\/SPT>|<TAI\s+OPT="([^"]*)"\s*>|<\/TAI>|<TXT>([\s\S]*?)<\/TXT>|<OLI>([\s\S]*?)<\/OLI>|<NTE>([\s\S]*?)<\/NTE>/g;

function walkPart(body: string, section: string, partNum: number, ctx: WalkCtx): Article[] {
  const articles: Article[] = [];
  let currentArticle: Article | null = null;
  let articleCounter = 0;
  let paragraphCounter = 0;
  let sptDepth = 0;
  let awaitingTitleForDepth: number | null = null;
  let pendingNote: string | null = null;
  const taiStack: { opt: string; agency: 'ARMY' | 'NAVY' | 'AIRFORCE' | null }[] = [];

  const ensureArticle = (): Article => {
    if (currentArticle) return currentArticle;
    articleCounter++;
    currentArticle = { id: `${partNum}.${articleCounter}`, title: 'GENERAL', paragraphs: [] };
    articles.push(currentArticle);
    paragraphCounter = 0;
    return currentArticle;
  };

  const finalizeArticle = () => {
    currentArticle = null;
  };

  const structTai = (): { agency: 'ARMY' | 'NAVY' | 'AIRFORCE' | null; marker: string | null } => {
    for (let i = taiStack.length - 1; i >= 0; i--) {
      const t = taiStack[i];
      if (t.agency) return { agency: t.agency, marker: null };
      return { agency: null, marker: t.opt }; // innermost non-agency scope discloses
    }
    return { agency: null, marker: null };
  };

  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(body))) {
    if (m[1] !== undefined) {
      // TTL — consumed only right after an SPT-open (awaitingTitleForDepth set).
      // Flatten inert bracket grammar (`[s]`, `[and]`) in titles too — a title is
      // issued verbatim (docx.ts) but the general paragraph walk never runs it
      // through the bracket classifier; a genuine option bracket is left for the
      // G13 title scan to catch (CHANGE-07 follow-up).
      const title = flattenInertBrackets(stripTags(m[1]).trim());
      if (awaitingTitleForDepth === 1) {
        articleCounter++;
        currentArticle = { id: `${partNum}.${articleCounter}`, title, paragraphs: [] };
        articles.push(currentArticle);
        paragraphCounter = 0;
      } else if (awaitingTitleForDepth !== null && awaitingTitleForDepth > 1) {
        // Nested subpart: flatten as a heading-only paragraph in the CURRENT
        // article (SectionIR has no third nesting level — CHANGE-01/03 decision).
        const art = ensureArticle();
        const { agency, marker } = structTai();
        const hid = `${art.id}.${indexToLetter(paragraphCounter++)}`;
        art.paragraphs.push({
          id: hid,
          text: marker ? `${title} [${marker}]` : title,
          sourceRef: `ufgs:${section}:${art.id}`,
          locked: false,
          mandatory: false,
          ...(agency ? { tailoring: { requirementId: `tai-${hid}`, axis: 'agency', includeWhen: { agency } } } : {}),
        });
      }
      awaitingTitleForDepth = null;
      continue;
    }
    if (m[0] === '<SPT>') {
      sptDepth++;
      awaitingTitleForDepth = sptDepth;
      continue;
    }
    if (m[0] === '</SPT>') {
      sptDepth = Math.max(0, sptDepth - 1);
      if (sptDepth === 0) finalizeArticle();
      continue;
    }
    if (m[2] !== undefined) {
      taiStack.push({ opt: m[2], agency: mapAgencyOpt(m[2]) });
      continue;
    }
    if (m[0] === '</TAI>') {
      taiStack.pop();
      continue;
    }
    if (m[3] !== undefined || m[4] !== undefined) {
      const art = ensureArticle();
      const { agency, marker } = structTai();
      const id = `${art.id}.${indexToLetter(paragraphCounter++)}`;
      const p = makeParagraph(m[3] ?? m[4], id, `ufgs:${section}:${art.id}`, ctx, pendingNote, agency, marker);
      pendingNote = null;
      art.paragraphs.push(p);
      continue;
    }
    if (m[5] !== undefined) {
      const npr = [...m[5].matchAll(/<NPR>([\s\S]*?)<\/NPR>/g)].map((x) => stripTags(x[1])).join(' ');
      if (npr) pendingNote = npr;
      continue;
    }
  }
  // A trailing NTE (no following TXT/OLI) is still retained review-only, attached
  // to the last paragraph in this part rather than silently lost (CHANGE-06 §4).
  if (pendingNote) {
    const lastArt = articles[articles.length - 1];
    const lastPara = lastArt?.paragraphs[lastArt.paragraphs.length - 1];
    if (lastPara) (lastPara.designerNotes ??= []).push(pendingNote);
    else ctx.warnings.push(`trailing note-to-designer with no paragraph in PART ${partNum}: ${pendingNote.slice(0, 120)}`);
  }
  return articles;
}

function partTitleAndNumber(rawTtl: string, fallbackNum: number): { num: 1 | 2 | 3; title: string } {
  const m = stripTags(rawTtl).match(/PART\s*(\d+)\s*(.*)/i);
  const num = m ? (parseInt(m[1], 10) as 1 | 2 | 3) : (fallbackNum as 1 | 2 | 3);
  const title = flattenInertBrackets((m ? m[2].trim() : stripTags(rawTtl).trim()));
  return { num, title: title || `PART ${num}` };
}

// Override an Article's paragraphs with the STRUCTURED references/submittals
// derived by the already-tested sec-parser functions (Part 6.1/6.2), reusing
// proven extraction instead of re-deriving REF/LST/ITM semantics generically —
// those regions have distinctive shapes (REF blocks; LST/ITM group+item pairs)
// that the general TXT/OLI walk does not (and should not) try to parse.
function overrideReferencesArticle(article: Article, xml: string, section: string): void {
  const refs = parseSecReferences(xml);
  if (refs.length === 0) return;
  article.paragraphs = [
    {
      id: `${article.id}.A`,
      text: 'The publications listed below form a part of this specification to the extent referenced. The publications are referred to within the text by the basic designation only.',
      sourceRef: `ufgs:${section}:${article.id}`,
      locked: false,
      mandatory: false,
      refRequests: refs.map((r) => ({ org: r.org, designation: r.designation })),
      references: [],
    },
  ];
}
function overrideSubmittalsArticle(article: Article, xml: string, section: string): void {
  const subs = parseSecSubmittals(xml);
  if (subs.length === 0) return;
  article.paragraphs = [
    {
      id: `${article.id}.A`,
      text: 'Government approval is required for submittals with a "G" classification. Submit the following in accordance with Section 01 33 00 SUBMITTAL PROCEDURES:',
      sourceRef: `ufgs:${section}:${article.id}`,
      locked: false,
      mandatory: false,
      subRequests: subs.map((s) => ({ sdCode: s.sdCode, item: s.item, classification: s.classification || undefined })),
      submittals: [],
    },
  ];
}

export function secToSectionIR(xml: string, fallbackSection: string): SecToIrResult {
  const header = parseSecHeader(xml);
  const section = header?.section ?? fallbackSection;
  const stlMatch = xml.match(/<STL>([\s\S]*?)<\/STL>/);
  const title = stlMatch ? flattenInertBrackets(stripTags(stlMatch[1]).trim()) : section;

  const collapsed = collapseUnits(xml);
  const warnings: string[] = [];
  const ctx: WalkCtx = { section, warnings };
  const parts: Part[] = [];

  const prtRe = /<PRT>([\s\S]*?)<\/PRT>/g;
  let pm: RegExpExecArray | null;
  let seq = 0;
  while ((pm = prtRe.exec(collapsed))) {
    seq++;
    const body = pm[1];
    const ttlMatch = body.match(/^<TTL>([\s\S]*?)<\/TTL>/);
    const { num, title: partTitle } = partTitleAndNumber(ttlMatch ? ttlMatch[1] : `PART ${seq}`, seq);
    const contentStart = ttlMatch ? ttlMatch[0].length : 0;
    const articles = walkPart(body.slice(contentStart), section, num, ctx);
    for (const a of articles) {
      const t = a.title.trim().toUpperCase();
      if (t === 'REFERENCES') overrideReferencesArticle(a, xml, section);
      else if (t === 'SUBMITTALS') overrideSubmittalsArticle(a, xml, section);
    }
    parts.push({ part: num, title: partTitle, articles });
  }

  return { ir: { section, title, tagProfile: 'specsintact', parts }, edition: header?.edition ?? null, warnings };
}
