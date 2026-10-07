// SpecsIntact-style XML emitter. Emits valid-looking markup (not full round-trip
// fidelity — see blueprint §13). Tags: <SEC>, <PART>, <ART>, <PARA>, <REF>/<RTL>,
// <SUB>, <NTE> (Note to the Designer).
//
// Guardrail G1 is enforced STRUCTURALLY here: the emitter renders <REF>/<SUB>
// ONLY from the validated, D1-backed lists it is handed, and throws if the IR
// references an id that is not a live row. It can never emit an invented
// designation, date, or submittal item.

import { eachParagraph, resolveParagraphText } from './section-ir';
import type { ModeContext, ReferenceRow, SectionIR, SubmittalRegisterRow } from './types';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface EmitInput {
  references: ReferenceRow[]; // validated UMRL rows (dated publications list)
  register: SubmittalRegisterRow[]; // validated UMSL-backed register rows
  // Notes-to-Designer (<NTE>) are emitted ONLY for the review/editing export
  // (`review: true`). The default is ISSUED output, which suppresses them (G13).
  review?: boolean;
}

export function emitSpecsIntact(ir: SectionIR, ctx: ModeContext, opts: EmitInput): string {
  const liveRids = new Set(opts.references.map((r) => r.rid));
  const liveUsids = new Set(opts.register.map((r) => r.usid));

  // G1 fail-closed: every reference/submittal id in the IR must be validated.
  for (const { paragraph } of eachParagraph(ir)) {
    for (const rid of paragraph.references ?? [])
      if (!liveRids.has(rid))
        throw new Error(`G1 violation: <REF> id ${rid} is not a validated D1 row`);
    for (const usid of paragraph.submittals ?? [])
      if (!liveUsids.has(usid))
        throw new Error(`G1 violation: <SUB> id ${usid} is not a validated D1 row`);
  }

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<SEC number="${esc(ir.section)}" title="${esc(ir.title)}" agency="${esc(
      ctx.agency ?? 'OTHER',
    )}" delivery="${esc(ctx.delivery ?? 'DBB')}">`,
  );

  if (opts.references.length) {
    lines.push('  <RIDS>');
    for (const r of opts.references) {
      lines.push(
        `    <REF rid="${esc(r.rid)}"><ORG>${esc(r.org)}</ORG>` +
          `<RID>${esc(r.designation)}</RID>` +
          `<DATE>${esc(r.editionDate)}</DATE>` +
          `<RTL>${esc(r.title)}</RTL></REF>`,
      );
    }
    lines.push('  </RIDS>');
  }

  if (opts.register.length) {
    lines.push('  <SUBMITTALS>');
    for (const row of opts.register) {
      const cls = row.classification ? ` classification="${esc(row.classification)}"` : '';
      lines.push(
        `    <SUB sd="${esc(row.sdCode ?? '')}" usid="${esc(row.usid)}"${cls}>${esc(row.item)}</SUB>`,
      );
    }
    lines.push('  </SUBMITTALS>');
  }

  for (const part of ir.parts) {
    lines.push(`  <PART number="${part.part}" title="${esc(part.title)}">`);
    for (const article of part.articles) {
      lines.push(`    <ART id="${esc(article.id)}" title="${esc(article.title)}">`);
      for (const p of article.paragraphs) {
        const attrs = [
          `id="${esc(p.id)}"`,
          p.mandatory ? 'mandatory="true"' : '',
          p.locked ? 'locked="true"' : '',
        ]
          .filter(Boolean)
          .join(' ');
        lines.push(`      <PARA ${attrs}>${esc(resolveParagraphText(p))}</PARA>`);
        // Notes to the Designer: review/editing export only. Issued output
        // suppresses them — G13 final-output hygiene.
        if (opts.review) {
          for (const s of p.selections ?? [])
            if (s.note) lines.push(`      <NTE selection="${esc(s.id)}">${esc(s.note)}</NTE>`);
          for (const note of p.designerNotes ?? [])
            lines.push(`      <NTE paragraph="${esc(p.id)}">${esc(note)}</NTE>`);
        }
      }
      lines.push('    </ART>');
    }
    lines.push('  </PART>');
  }

  lines.push('</SEC>');
  const xml = lines.join('\n');
  if (!opts.review) assertIssuedClean(xml, `issued section ${ir.section}`);
  return xml;
}

// G13 — final-output hygiene. The ISSUED manual must carry no unresolved editor
// markup: no `[ … ]` brackets / `[_____]` fills, no "NOTE TO DESIGNER", no
// `*****` SpecsIntact note fences. `assertIssuedClean` throws so any leak into
// issued output fails closed.
const ISSUED_MARKUP: { re: RegExp; what: string }[] = [
  { re: /\[[^\]]*\]/, what: 'unresolved bracket/fill' },
  { re: /NOTE TO DESIGNER/i, what: 'note to designer' },
  { re: /\*{5}/, what: 'SpecsIntact note fence (*****)' },
];
export function findIssuedMarkup(text: string): { what: string; sample: string } | null {
  for (const { re, what } of ISSUED_MARKUP) {
    const m = text.match(re);
    if (m) return { what, sample: m[0].slice(0, 60) };
  }
  return null;
}
export function assertIssuedClean(text: string, label = 'issued output'): void {
  const hit = findIssuedMarkup(text);
  if (hit) throw new Error(`final-output hygiene (G13): ${label} contains ${hit.what}: "${hit.sample}"`);
}

// G13 over a WHOLE section's issued surface: paragraph prose AND the titles the
// assembler emits verbatim (section / part / article). A per-paragraph scan
// alone misses bracketed titles, which are issued but carry no Selection.
export function assertSectionIssuedClean(ir: SectionIR, label = `issued ${ir.section}`): void {
  assertIssuedClean(ir.title, `${label} (section title)`);
  for (const part of ir.parts) {
    assertIssuedClean(part.title, `${label} PART ${part.part} title`);
    for (const article of part.articles) {
      assertIssuedClean(article.title, `${label} article ${article.id} title`);
      for (const paragraph of article.paragraphs)
        assertIssuedClean(resolveParagraphText(paragraph), `${label} ${paragraph.id}`);
    }
  }
}
