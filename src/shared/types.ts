// ============================================================================
// Shared domain types — the contracts every agent and the orchestrator share.
// Single home for the Mode seam and the Section IR / structured-output schemas.
// One live mode (UFGS); `Mode` stays a named type so the ModeContext seam reads
// cleanly. Clean rebuild per REBUILD-BLUEPRINT.md.
// ============================================================================

export type Mode = 'UFGS';

export type AgentName =
  | 'drafter'
  | 'resolver'
  | 'validator'
  | 'coordinator'
  | 'compliance'
  | 'embeddings';

export type ArtifactKind =
  | 'section-ir'
  | 'docx'
  | 'pdf'
  | 'specsintact-xml'
  | 'submittal-register-csv'
  | 'references-csv'
  | 'resolution-log'
  | 'coordination-flags'
  | 'compliance-report'
  | 'traceability-csv'
  | 'criteria-matrix'
  | 'division01-report'
  | 'seal-package';

export type SpecifyingMethod = 'prescriptive' | 'proprietary' | 'performance';

// ---- The Mode Context object: created once per section run, threaded through
// every agent call. The ONLY place mode selection is interpreted. ----
export interface ModeContext {
  mode: Mode;
  retrievalNamespace: string; // Vectorize namespace ('ufgs' | 'master:<owner>:<id>')
  rulesetId: string; // which editing ruleset the Resolver loads
  tagProfile: TagProfile; // emitter/serializer profile
  referenceListId: string; // 'UMRL'
  stylePackId: string; // layout pack — 'ufgs'
  artifactSet: ArtifactKind[]; // which artifacts to generate
  complianceProfile: string; // 'ufc'
  modelBindings: Record<AgentName, string>; // pinned Workers AI model IDs per agent

  // Agency axis — the one axis that still varies.
  agency?: 'ARMY' | 'NAVY' | 'AIRFORCE' | 'OTHER';
  delivery?: 'DBB' | 'DB';
  constructionAgent?: 'USACE' | 'NAVFAC' | 'AFCEC' | 'OTHER';
  lockedFrontEndDocs?: string[]; // locked_docs ldids

  // The master the AI drafts from (built-in or firm-uploaded) + units.
  baseRetrievalNamespace?: string;
  masterId?: string;
  masterOwner?: string; // 'system' (built-in) | <org id> — corpus provenance
  units?: 'imperial' | 'dual';
}

export type TagProfile = 'specsintact' | 'plain';

// ============================================================================
// Section IR — a selection is any resolvable axis: option / fill (brackets).
// ============================================================================

export type SelectionKind = 'option' | 'fill';

export interface Selection {
  id: string;
  kind: SelectionKind;
  note?: string; // "Note to the Designer" / editing note
  requirementId?: string; // key for G3 selection-mechanism exclusivity
  options?: string[]; // kind === 'option'
  resolved?: string[] | null; // chosen subset (null until resolved)
  value?: string | null; // kind === 'fill' — resolved value (null until resolved)
}

export interface ReferenceRequest {
  org: string;
  designation: string;
}

export interface SubmittalRequest {
  sdCode?: string; // 'SD-01'..'SD-11'
  item: string;
  classification?: string; // 'G' | 'S' | reviewer code | undefined
}

export interface Paragraph {
  id: string;
  text: string;
  sourceRef?: string; // provenance from retrieval
  locked: boolean; // immutable (G2 — any span with locked:true)
  mandatory: boolean; // "shall"/"must" span

  selections?: Selection[];

  // References/submittals — pre-validation *requests* vs post-validation IDs.
  refRequests?: ReferenceRequest[];
  references?: string[]; // resolved rids into D1 (G1: never free text)
  subRequests?: SubmittalRequest[];
  submittals?: string[]; // resolved usids into D1 (G1: never free text)

  criteriaRef?: string; // cid into `criteria` (UFC) — G7
  products?: string[]; // pids into product_library ONLY — G4

  // REVIEW-ONLY orphan Notes to the Designer (no bracket to attach to). Surfaced
  // in the review UI + resolution log; NEVER emitted into issued output (G13).
  designerNotes?: string[];

  // G4 basis-of-design (dormant on the live UFGS path, but real + tested).
  specifyingMethod?: SpecifyingMethod;
  productCategory?: string; // category to ground against product_library
  basisOfDesignPid?: string; // chosen product_library pid (G4)

  // Governed by a tailoring/selection axis, not a selection widget.
  tailoring?: {
    requirementId: string;
    axis: 'agency' | 'delivery';
    includeWhen: { agency?: ModeContext['agency']; delivery?: ModeContext['delivery'] };
  };

  // This paragraph reproduces an unalterable Division 00 front-end doc (G2).
  lockedDocId?: string; // ldid into locked_docs
}

export interface Article {
  id: string;
  title: string;
  paragraphs: Paragraph[];
}

export interface Part {
  part: 1 | 2 | 3;
  title: string;
  articles: Article[];
}

// Tailoring resolution (for G3 auditing).
export interface TailoringDecision {
  requirementId: string;
  axis: string;
  chosen: string;
  effect: 'include' | 'omit';
  target: string;
}

export interface SectionIR {
  section: string;
  title: string;
  tagProfile: TagProfile;
  parts: Part[];
  tailoring?: TailoringDecision[];
}

// ============================================================================
// Structured agent outputs
// ============================================================================

// Which authority resolved a selection (G13): 'project-data' = the project's own
// schedule/criteria/features; 'ufc-criteria' = a linked UFC clause; 'ufgs-default'
// = the documented UFGS default (first-listed option). Never invented.
export type ResolutionBasis = 'project-data' | 'ufc-criteria' | 'ufgs-default';

// A LABELED confidence tier — the honest categorical read. NOT a probability.
export type ResolutionConfidenceTier = 'high' | 'medium-ufgs-default' | 'low-no-ufc';

export interface ResolutionLogEntry {
  selectionId: string;
  chosen: string[] | string;
  sourceType: string;
  sourceRef: string;
  justification: string;
  confidence: number; // heuristic ordering only — read `confidenceTier`
  confidenceTier?: ResolutionConfidenceTier;
  basis?: ResolutionBasis;
}
export interface ResolutionLog {
  entries: ResolutionLogEntry[];
}

export interface SubmittalRegisterRow {
  sdCode?: string;
  classification: string; // 'G' | 'S' | ''
  usid: string;
  item: string;
  paragraphId?: string;
  // Approving-authority code for a G submittal: named by the SEC source, else
  // defaulted from the construction agent per UFGS 01 33 00 (G13).
  approvingAuthority?: string;
  approvingAuthorityBasis?: ResolutionBasis;
}
export interface SubmittalRegister {
  rows: SubmittalRegisterRow[];
}

export interface ReferenceRow {
  rid: string;
  org: string;
  designation: string;
  editionDate: string;
  title: string;
  validated: boolean;
}
export interface FlaggedReference {
  requestedDesignation: string;
  reason: string;
}
export interface ReferencesList {
  references: ReferenceRow[];
  flagged: FlaggedReference[];
}

// Validation flags (G1 references/submittals, G4 products, G7 criteria).
export type ValidationFlagKind =
  | 'reference-not-found'
  | 'submittal-not-found'
  | 'product-unverifiable'
  | 'criteria-not-found';

export interface ValidationFlag {
  id: string;
  kind: ValidationFlagKind;
  requested: string;
  detail: string;
  paragraphId?: string;
  resolved: boolean;
  resolution?: string;
}

export interface CoordinationFlag {
  id: string;
  type: string;
  location: string;
  detail: string;
  severity: 'low' | 'medium' | 'high';
  resolved: boolean;
}

export interface ComplianceCheck {
  id: string;
  requirement: string;
  status: 'pass' | 'fail' | 'na';
  detail: string;
}
export interface ComplianceReport {
  profile: string;
  checks: ComplianceCheck[];
  traceabilityRows: number;
  summary: string;
}

export interface TraceRow {
  element: string;
  decision: string;
  sourceType: string;
  sourceRef: string;
  confidence: number; // heuristic ordering only — read `confidenceTier`
  confidenceTier?: ResolutionConfidenceTier;
  basis?: ResolutionBasis; // G13
  // The human-verifiable justification: names the literal value that drove the
  // decision and why it implies it (distinct from sourceRef, the pointer).
  justification?: string;
}

// ---- Guardrail results as first-class data (blueprint §2.3/§7) ----
// The UNIFIED set: every guardrail applicable to a run is EVALUATED (pass/fail)
// or explicitly 'n/a' (with evidence) — never silently absent. The harness
// (shared/guardrails.ts) throws if any id below is missing from a run's results.
// G10 is retired (reverted OmniClass crosswalk) and deliberately not a member.
export type GuardrailId =
  | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9'
  | 'G11' | 'G12' | 'G13' | 'G14' | 'G15' | 'G16'
  | 'G-MAN' | 'G-CMP-1';
export interface GuardrailResult {
  id: GuardrailId;
  status: 'pass' | 'fail' | 'n/a'; // 'n/a' = not applicable to this run, but still evaluated
  evidence: string; // why this status — recorded in the seal manifest
}

export interface CriteriaMatrixRow {
  requirement: string;
  electedLevel: string;
  clause: string;
  document: string;
  edition: string;
}

// ============================================================================
// Approved-for-seal — never a real seal, never a signing key (G8).
// ============================================================================
export interface ReviewEvidenceRow {
  gate: string;
  element: string;
  action: 'accept' | 'reject' | 'edit' | 'clear-flag' | 'confirm' | 'acknowledge' | 'attest';
  beforeVal?: string;
  afterVal?: string;
  userId: string;
  at: string;
}

export interface BuildManifest {
  contentHash: string;
  frozenAt: string;
  attestedBy: { userId: string; name: string; licenseNo: string; licenseExp: string } | null;
  mode: Mode;
  stylePackId: string;
  corpusVersion: string;
  criteriaEditions: Record<string, string>;
  modelConfig: Record<string, string>;
  promptVersion: string;
  guardrailResults: Record<GuardrailId, GuardrailResult>;
  pdfRender?: 'container' | 'worker-fallback'; // how the frozen PDF was produced
  pdfPages?: number; // pages in the frozen PDF (pagination signal)
}

// ============================================================================
// Project intake + pipeline/session state
// ============================================================================

export interface ProjectParams {
  name?: string;
  designIntent: string;
  vocLimitGL?: number;
  substratesInScope?: string[];
  agency?: ModeContext['agency'];
  delivery?: ModeContext['delivery'];
  defaultSpecifyingMethod?: SpecifyingMethod;
}

export interface FinishScheduleRow {
  room: string;
  substrate: string;
  finish: string;
  sheen: string;
}
export interface DrawingRow {
  room: string;
  shownFinish: string;
}

// ---- The normalized intake model (one model, many parsers) ----
export interface EPDSpace {
  id: string;
  name?: string;
  occupancy?: string;
}
export interface EPDFinish {
  spaceRef: string;
  substrate: string;
  finish: string;
  sheen?: string;
  location?: string;
}
export interface EPDMaterial {
  category: string;
  descriptor?: string;
  attributes?: Record<string, unknown>;
}
// Building-element features for SEC-catalog selection, read off IFC entity types
// + Revit type names, aggregated by type. `keyword` is the lexical noun the SEC
// matcher compares against a section's title + PART 1 scope.
export interface EPDElement {
  ifcType: string; // 'IfcDoor' | 'IfcCovering' | ...
  keyword: string; // 'door' | 'window' | 'wall' | 'ceiling' | 'flooring' | ...
  count: number;
  typeNames?: string[];
}
export interface EPDProgram {
  buildingType?: string;
  areaSqFt?: number;
  location?: string;
  codesApplicable?: string[];
  deliveryMethod?: 'DBB' | 'DB';
  sustainabilityTargets?: string[];
  designIntent?: string;
}
export interface EPDDrawingIndex {
  sheet: string;
  title?: string;
  r2Key?: string;
}
export interface EPDProvenance {
  field: string;
  source: string; // 'csv' | 'xlsx' | 'ifc' | 'pdf' | 'docx' | 'llm' | 'default'
  confidence: number;
}
export interface ExtractedProjectData {
  projectId: string;
  spaces: EPDSpace[];
  finishes: EPDFinish[];
  materials: EPDMaterial[];
  elements: EPDElement[];
  program: EPDProgram;
  drawingsIndex: EPDDrawingIndex[];
  generalNotes: string[];
  drawings: DrawingRow[];
  provenance: EPDProvenance[];
}

// ---- Master library ----
export type MasterOwner = 'system' | string; // 'system' (built-in) | <org id>
export interface MasterLibraryRow {
  masterId: string;
  owner: MasterOwner;
  name: string;
  mode?: Mode;
  namespace: string;
  status: 'processing' | 'ready';
}

// ---- Comparison — scoring only, permanently quarantined (G-CMP-1) ----
export type CompareVerdict = 'match' | 'ai-stronger' | 'ref-stronger' | 'divergent';
export type DivergenceClass = 'genuine-miss' | 'defensible-choice' | 'n/a';
export interface ComparisonScoreRow {
  dimension: string;
  aiValue: string;
  refValue: string;
  verdict: CompareVerdict;
  divergenceClass: DivergenceClass;
  traceabilityRef: string;
}
export interface ComparisonReport {
  cmpId: string;
  projectId: string;
  corpusProvenance: MasterOwner;
  status: 'uploaded' | 'scored' | 'error';
  scores: ComparisonScoreRow[];
}

// ============================================================================
// Project Manual assembly + whole-manual compare. Manual scope is
// orchestration/data; no per-section agent reads it.
// ============================================================================
export type DeliveryKind = 'single-section' | 'project-manual';
export type ManualScope = 'section' | 'manual';
export type SectionRole = 'front-end' | 'div01' | 'technical';
export type DraftingMode = 'draft' | 'include' | 'outline';
export type ManualStatus =
  | 'outline'
  | 'running'
  | 'coordinating'
  | 'assembled'
  | 'approved'
  | 'superseded';

export interface ManualSectionRef {
  section: string;
  title: string;
  division: string; // '00'..'49' (derived)
  orderIndex: number;
  role: SectionRole;
  draftingMode: DraftingMode;
  masterId?: string;
  lockedDocId?: string;
  runId?: string;
}

export interface ManualContext {
  projectId: string;
  scope: ManualScope; // agents never read this
  sections: ManualSectionRef[];
  frontEndDocIds: string[];
  assembly: {
    coverTemplateId: string;
    tocStyle: 'list-of-sections';
    dividers: boolean;
    sealPageScope: 'manual' | 'per-discipline';
  };
}

export type ManualSectionStatus =
  | 'pending'
  | 'drafted'
  | 'validated'
  | 'coordinated'
  | 'complete'
  | 'error';

export type ManualCoordinationKind =
  | 'ref-edition-conflict'
  | 'scope-gap'
  | 'scope-overlap'
  | 'submittal-mismatch'
  | 'div01-vs-gc'
  | 'toc-integrity'
  // a division present in the outline has no sealing assignment whose scope
  // covers it — never silently emit an unsealed division (G8/G-MAN).
  | 'seal-coverage-gap';
export interface ManualCoordinationFlag {
  id?: number;
  kind: ManualCoordinationKind;
  detail: string;
  sections: string[];
  severity: 'low' | 'medium' | 'high';
  status: 'open' | 'resolved';
}

export interface ManualCoverMeta {
  projectTitle?: string;
  installationLocation?: string;
  solicitationNo?: string;
  preparingFirm?: string;
  designDistrict?: string;
  dodComponent?: string;
  issueDate?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface TocRow {
  section: string;
  title: string;
  role: SectionRole;
  draftingMode: DraftingMode;
  pageCount: number;
}

export type ManualAlignment = 'matched' | 'reference-only' | 'ours-only';
export interface ComparisonSectionRow {
  id: string;
  refSection: string | null;
  refSegmentR2Key: string; // QUARANTINED segment path; never embedded
  matchedProjectSection: string | null;
  alignment: ManualAlignment;
  alignmentConfidence: number;
  title?: string;
}

export type Stage =
  | 'intake'
  | 'draft'
  | 'resolve'
  | 'validate'
  | 'coordinate'
  | 'compliance'
  | 'emit'
  | 'done';

// Per-section HITL gates + the manual-scope gates (blueprint §4).
export type GateId =
  | 'gate1' | 'gate2' | 'gate3' | 'gate4' | 'gate5'
  | 'M0' | 'M-DECIDE' | 'M-COORD';

export interface GatePrompt {
  gateId: GateId;
  stage: Stage;
  title: string;
  blocking: boolean;
  payload: any;
}

export type SessionStatus = 'created' | 'running' | 'awaiting-gate' | 'done' | 'error';

export interface ProgressEvent {
  stage: string;
  message: string;
  count?: number;
  total?: number;
  at: string; // ISO timestamp
}

export interface SessionState {
  sessionId: string;
  projectId: string;
  mode: Mode;
  stage: Stage;
  status: SessionStatus;
  pendingGate?: GatePrompt | null;
  artifacts: ArtifactKind[];
  contentHash?: string | null;
  error?: string | null;
  progress?: ProgressEvent[];
  updatedAt: string;
}

export interface GateDecision {
  gateId: GateId;
  [key: string]: unknown;
}
