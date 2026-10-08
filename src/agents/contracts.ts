// Agent I/O contracts. Each agent exposes a single entrypoint
//   run(env, ctx: ModeContext, input): Promise<Output>
// mirroring the spec's stateless RPC entrypoint (§8). In production each agent
// is its own Worker behind a service binding; here they are colocated modules
// sharing these exact contracts, dispatched through agents/registry.ts. The
// only change to split them out is replacing the registry with env.<AGENT>.run.

import type { Env } from '../env';
import type {
  CoordinationFlag,
  CriteriaMatrixRow,
  DrawingRow,
  ExtractedProjectData,
  FinishScheduleRow,
  GuardrailResult,
  ModeContext,
  ProjectParams,
  ReferencesList,
  ResolutionLog,
  SectionIR,
  SubmittalRegister,
  TraceRow,
  ValidationFlag,
} from '../shared/types';

export interface DraftInput {
  params: ProjectParams;
  schedule: FinishScheduleRow[];
  // CHANGE-03: which MasterFormat section to draft. Undefined in the single-
  // section path -> the Drafter uses the mode's default section (byte-for-byte
  // unchanged). A manual fan-out passes the target section so one project can
  // draft Division 01 + technical sections. This is data, not a mode branch.
  section?: string;
}
export interface DraftOutput {
  ir: SectionIR;
  provenance: string[]; // retrieval provenance carried into traceability
}

export interface ResolveInput {
  ir: SectionIR;
  params: ProjectParams;
  schedule: FinishScheduleRow[];
  // CHANGE-06 — the full extracted project data (spaces / finishes / materials /
  // IFC+COBie features / program) so the Resolver can match a selection against
  // the project's own features, not just the finish schedule. Optional + additive:
  // absent (offline / not extracted) -> the general resolver degrades to schedule.
  extracted?: ExtractedProjectData;
}
export interface ResolveOutput {
  ir: SectionIR;
  resolutionLog: ResolutionLog;
  traces: TraceRow[];
  exclusivityViolations: string[]; // G3
  lockedViolations: string[]; // G2 (empty unless a locked span changed)
  guardrails: GuardrailResult[]; // G2 + G3 as first-class results (evidence carried to the manifest)
}

export interface ValidateInput {
  ir: SectionIR;
  projectId: string;
}
export interface ValidateOutput {
  ir: SectionIR; // references/submittals now hold validated D1 ids only (G1)
  referencesList: ReferencesList;
  register: SubmittalRegister;
  criteriaMatrix: CriteriaMatrixRow[]; // Mode C: requirement → elected level → clause (G7)
  flags: ValidationFlag[];
  traces: TraceRow[];
}

export interface CoordinateInput {
  ir: SectionIR;
  schedule: FinishScheduleRow[];
  drawings: DrawingRow[];
}
export interface CoordinateOutput {
  flags: CoordinationFlag[];
}

export interface ComplianceInput {
  ir: SectionIR;
  referencesList?: ReferencesList;
  register?: SubmittalRegister;
  validationFlags: ValidationFlag[];
  coordinationFlags: CoordinationFlag[];
  traceCount: number;
  // Authoritative G2/G3 determinations from the Resolver (single source of
  // truth). Default to no violations when omitted (e.g. isolated unit tests).
  lockedSpanViolations?: string[];
  exclusivityViolations?: string[];
}
export interface ComplianceOutput {
  report: import('../shared/types').ComplianceReport;
}

export interface EmbedInput {
  texts: string[];
}
export interface EmbedOutput {
  vectors: number[][];
}

export type AgentRun<I, O> = (env: Env, ctx: ModeContext, input: I) => Promise<O>;
