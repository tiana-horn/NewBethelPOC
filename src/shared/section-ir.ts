// Section IR helpers: traversal, selection rendering, and the locked-span
// integrity check that backs guardrail G2 (a locked span is ANY span with
// locked:true — mandatory UFGS language or an unalterable front-end document).
//
// Selection placeholders are embedded inline in Paragraph.text as `{{id}}`
// tokens. Rendering substitutes each with the resolved value, or a legible
// unresolved form ([opt | opt] / [_____]).

import type { Article, Paragraph, Part, SectionIR, Selection } from './types';
import { repairSeams } from './bracket-bridge';

export function cloneIR(ir: SectionIR): SectionIR {
  return structuredClone(ir);
}

export function* eachParagraph(
  ir: SectionIR,
): Generator<{ part: Part; article: Article; paragraph: Paragraph }> {
  for (const part of ir.parts)
    for (const article of part.articles)
      for (const paragraph of article.paragraphs) yield { part, article, paragraph };
}

export function findParagraph(ir: SectionIR, id: string): Paragraph | undefined {
  for (const { paragraph } of eachParagraph(ir)) if (paragraph.id === id) return paragraph;
  return undefined;
}

export function findSelection(ir: SectionIR, id: string): Selection | undefined {
  for (const { paragraph } of eachParagraph(ir))
    for (const selection of paragraph.selections ?? [])
      if (selection.id === id) return selection;
  return undefined;
}

export function allSelections(ir: SectionIR): { paragraph: Paragraph; selection: Selection }[] {
  const out: { paragraph: Paragraph; selection: Selection }[] = [];
  for (const { paragraph } of eachParagraph(ir))
    for (const selection of paragraph.selections ?? []) out.push({ paragraph, selection });
  return out;
}

// Collect review-only Notes-to-Designer (orphan NTDs with no bracket). For the
// review UI + resolution log ONLY; these never appear in issued output.
export function collectDesignerNotes(ir: SectionIR): { paragraphId: string; notes: string[] }[] {
  const out: { paragraphId: string; notes: string[] }[] = [];
  for (const { paragraph } of eachParagraph(ir))
    if (paragraph.designerNotes?.length) out.push({ paragraphId: paragraph.id, notes: paragraph.designerNotes });
  return out;
}

export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export function selectionDisplay(s: Selection): string {
  if (s.kind === 'fill') {
    return s.value != null && s.value !== '' ? s.value : '[_____]';
  }
  if (s.resolved && s.resolved.length) return joinList(s.resolved);
  return `[${(s.options ?? []).join(' | ')}]`;
}

export function isSelectionResolved(s: Selection): boolean {
  return s.kind === 'fill' ? s.value != null && s.value !== '' : !!(s.resolved && s.resolved.length);
}

export function resolveParagraphText(p: Paragraph): string {
  let t = p.text;
  for (const s of p.selections ?? []) t = t.split(`{{${s.id}}}`).join(selectionDisplay(s));
  // An OMITTED selection substitutes to '' and an included list item can carry
  // its own commas; repairSeams normalizes the resulting seams so the issued
  // sentence reads grammatically. Conservative + idempotent.
  return repairSeams(t);
}

// ---- Guardrail G2: locked spans must be byte-identical before and after
// resolution. Any span with locked:true is covered. ----
export function lockedSpanMap(ir: SectionIR): Record<string, string> {
  const m: Record<string, string> = {};
  for (const { paragraph } of eachParagraph(ir)) if (paragraph.locked) m[paragraph.id] = paragraph.text;
  return m;
}

// A locked span that SURVIVES must be byte-identical. A locked paragraph
// legitimately OMITTED by a recorded tailoring decision is not a violation (pass
// its id in `ignoreRemoved`); a locked paragraph that vanished for any OTHER
// reason IS a violation, as is any text change.
export function lockedSpansUnchanged(
  before: SectionIR,
  after: SectionIR,
  ignoreRemoved: Set<string> = new Set(),
): { ok: boolean; changed: string[] } {
  const b = lockedSpanMap(before);
  const a = lockedSpanMap(after);
  const changed: string[] = [];
  for (const id of Object.keys(b)) {
    if (id in a) {
      if (a[id] !== b[id]) changed.push(id); // text mutated
    } else if (!ignoreRemoved.has(id)) {
      changed.push(id); // removed, and NOT by a recorded tailoring omit
    }
  }
  return { ok: changed.length === 0, changed };
}
