// Manual fan-out — the Orchestrator's job, NOT a new agent (CHANGE-03 §4.1).
// `runSection` is literally "the existing per-section pipeline, invoked N times":
// it drives Draft -> Resolve -> Validate -> Coordinate -> Compliance -> Emit by
// calling the SAME six agents through the registry with their UNCHANGED contracts
// (run(ctx: ModeContext, input)). No agent reads ManualContext or `scope`; the
// only manual-aware input is the optional target `section` passed to the Drafter.
//
// Partial failure is expected and handled (§4.1): one section erroring returns a
// result with status='error' and never throws, so the book still coordinates and
// assembles the rest with the failure flagged.

import { agents } from '../agents/registry';
import type { Env } from '../env';
import { getExtracted } from '../db/projects';
import { renderDocx } from '../shared/docx';
import { resolveStylePack } from '../shared/stylepacks';
import type {
  CoordinationFlag,
  CriteriaMatrixRow,
  DrawingRow,
  FinishScheduleRow,
  GuardrailResult,
  ManualSectionStatus,
  ModeContext,
  ProjectParams,
  ReferencesList,
  SectionIR,
  SubmittalRegister,
  TraceRow,
  ValidationFlag,
} from '../shared/types';

export interface SectionRunResult {
  section: string;
  status: ManualSectionStatus;
  error?: string;
  ir?: SectionIR;
  referencesList?: ReferencesList;
  register?: SubmittalRegister;
  criteriaMatrix?: CriteriaMatrixRow[];
  validationFlags: ValidationFlag[];
  coordinationFlags: CoordinationFlag[];
  compliance?: import('../shared/types').ComplianceReport;
  traces: TraceRow[];
  guardrails: GuardrailResult[];
  docxBase64?: string;
}

export interface SectionInputs {
  params: ProjectParams;
  schedule: FinishScheduleRow[];
  drawings: DrawingRow[];
}

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};

// Run one drafted section through the full per-section pipeline. Never throws:
// any failure (incl. a G2/G3 halt) returns status='error' so the book run
// survives (partial-failure requirement, §4.1). `projectId` partitions the
// section's traceability rows in D1 (the caller persists `traces`).
export async function runSection(
  env: Env,
  ctx: ModeContext,
  projectId: string,
  section: string,
  inputs: SectionInputs,
): Promise<SectionRunResult> {
  const traces: TraceRow[] = [];
  try {
    // 2. DRAFT — the target section is the only manual-aware input.
    const draft = await agents.drafter(env, ctx, { params: inputs.params, schedule: inputs.schedule, section });
    let ir = draft.ir;

    // 3. RESOLVE — G2 (locked spans) + G3 (selection-mechanism exclusivity) are
    // BLOCKING per section; a violation marks the section errored (it cannot
    // enter assembly), exactly as the single-section pipeline halts. The Resolver
    // also matches selections against the project's extracted features + UFC
    // criteria (G13); extracted is best-effort (absent -> schedule-only vocab).
    const extracted = await getExtracted(env.DB, projectId).catch(() => null);
    const resolved = await agents.resolver(env, ctx, { ir, params: inputs.params, schedule: inputs.schedule, extracted: extracted?.data });
    if (resolved.lockedViolations.length)
      return errored(section, `G2 locked-span violation (${resolved.lockedViolations.join(', ')})`, traces);
    if (resolved.exclusivityViolations.length)
      return errored(section, `G3 exclusivity violation (${resolved.exclusivityViolations.join(', ')})`, traces);
    ir = resolved.ir;
    traces.push(...resolved.traces);

    // 4. VALIDATE — references/submittals/products/criteria vs D1 (G1/G4/G7).
    const validated = await agents.validator(env, ctx, { ir, projectId });
    ir = validated.ir;
    traces.push(...validated.traces);

    // 5. COORDINATE (per-section; manual-scope cross-checks run separately).
    const coord = await agents.coordinator(env, ctx, { ir, schedule: inputs.schedule, drawings: inputs.drawings });

    // 6. COMPLIANCE.
    const compliance = await agents.compliance(env, ctx, {
      ir,
      referencesList: validated.referencesList,
      register: validated.register,
      validationFlags: validated.flags,
      coordinationFlags: coord.flags,
      traceCount: traces.length,
      lockedSpanViolations: resolved.lockedViolations,
      exclusivityViolations: resolved.exclusivityViolations,
    });

    // 7. EMIT — the per-section DOCX the Assembler stitches into the book.
    const pack = await resolveStylePack(env, ctx.stylePackId);
    const docx = renderDocx(ir, pack, { references: validated.referencesList.references, register: validated.register.rows });

    // A section with unresolved G1/G4 flags is `validated`, not `complete`: it
    // may not enter assembly until the flags are cleared (blocking, §4.1).
    const openFlags = validated.flags.filter((f) => !f.resolved);
    const status: ManualSectionStatus = openFlags.length ? 'validated' : 'complete';

    return {
      section,
      status,
      ir,
      referencesList: validated.referencesList,
      register: validated.register,
      criteriaMatrix: validated.criteriaMatrix,
      validationFlags: validated.flags,
      coordinationFlags: coord.flags,
      compliance: compliance.report,
      traces,
      guardrails: resolved.guardrails,
      docxBase64: b64(docx),
    };
  } catch (err) {
    return errored(section, err instanceof Error ? err.message : String(err), traces);
  }
}

function errored(section: string, error: string, traces: TraceRow[]): SectionRunResult {
  return { section, status: 'error', error, validationFlags: [], coordinationFlags: [], traces, guardrails: [] };
}
