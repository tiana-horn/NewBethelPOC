// Drafter. Loads the real, ingested UFGS SEC master for the requested section and
// emits the Section IR — VERBATIM. The model does not author, rephrase, or "adapt"
// specification prose (G13): drafting is tailoring, not generation. The government
// master text is the source; bracket/fill/tailoring resolution happens
// deterministically downstream in the Resolver, recorded with a resolve-or-default
// `basis`. This makes "everything you read is the government's own UFGS text, not
// written by a model" a code fact.

import type { Env } from '../env';
import { div0133SubmittalProcedures } from '../corpus/div01-013300';
import { loadRealUfgsSection } from '../corpus/ufgs-store';
import { eachParagraph } from '../shared/section-ir';
import type { ModeContext, SectionIR } from '../shared/types';
import type { DraftInput, DraftOutput } from './contracts';

export async function run(env: Env, ctx: ModeContext, input: DraftInput): Promise<DraftOutput> {
  const provenance: string[] = [];
  let ir: SectionIR;

  // One mode (UFGS). Every technical section drafts from REAL, ingested UFGS
  // corpus (scripts/etl-ufgs-corpus.ts converts the whole master). Div 01 general
  // requirements use the built-in template.
  const targetSection = input.section ?? '09 90 00';
  if (targetSection === '01 33 00') {
    ir = div0133SubmittalProcedures();
    provenance.push('Div 01 Submittal Procedures (built-in general-requirements template)');
  } else {
    const real = await loadRealUfgsSection(env, targetSection);
    if (real) {
      ir = real;
      provenance.push(`real UFGS corpus: section='${targetSection}' (ingested via scripts/etl-ufgs-corpus.ts — not illustrative, G12)`);
    } else {
      // The outline only proposes `draft` for a section with real corpus already
      // ingested. If an uningested section is requested, NEVER fall back to
      // illustrative content — return an honestly-empty section (visible, not
      // silently substituted) rather than a fabricated draft (G12).
      ir = { section: targetSection, title: `${targetSection} — no real corpus ingested`, tagProfile: ctx.tagProfile, parts: [] };
      provenance.push(`WARNING: no real UFGS corpus ingested for section '${targetSection}' — nothing drafted (G12)`);
    }
  }
  ir.tagProfile = ctx.tagProfile;

  for (const { paragraph } of eachParagraph(ir))
    if (paragraph.sourceRef) provenance.push(`${paragraph.id} <- ${paragraph.sourceRef}`);
  provenance.push(
    `retrieval: namespace='${ctx.retrievalNamespace}' intent='${input.params.designIntent.slice(0, 80)}'`,
  );
  if (ctx.masterId)
    provenance.push(`master: id='${ctx.masterId}' owner='${ctx.masterOwner ?? 'system'}' (${ctx.masterOwner === 'system' || !ctx.masterOwner ? 'built-in' : 'firm-uploaded'})`);

  // The model NEVER authors specification prose. The Drafter loads the government
  // SEC master verbatim; project-data resolution of the brackets/fills/tailoring is
  // the Resolver's job (deterministic, recorded with a resolve-or-default `basis`).
  provenance.push('drafting: verbatim SEC master (no model-authored prose — G13); selections resolved downstream');

  return { ir, provenance };
}
