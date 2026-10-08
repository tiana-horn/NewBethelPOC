// ManualDO — one Durable Object per Project Manual run. Holds the live manual
// scope: ManualContext, the per-section run results, cross-section coordination
// flags, aggregated Validator outputs, the manual-scope compliance report, the
// assembled book, the architect's attestation, and the frozen content hash. It is
// the manual analogue of SessionDO. NO agent reads it — manual scope lives here,
// in the ManualWorkflow, the manual-scope Coordinator/Compliance/aggregation
// passes, the Assembler, and the compare layer only (CHANGE-03 tripwire).

import { DurableObject } from 'cloudflare:workers';
import { isNotInitialized, NotInitialized } from '../shared/errors';
import type { Env } from '../env';
import {
  applySelectionResolution,
  collectOpenDecisions,
  manualCompliance,
  ufgsDefaultFor,
  type MasterRegisterGroup,
  type OpenDecision,
} from './aggregate';
import { eachParagraph, isSelectionResolved } from '../shared/section-ir';
import type { SectionRunResult } from './orchestrator';
import type { ManualSectionRow } from '../db/manual';
import type {
  ComplianceReport,
  DrawingRow,
  EPDDrawingIndex,
  FinishScheduleRow,
  ManualContext,
  ManualCoordinationFlag,
  ModeContext,
  ProjectParams,
  ReferenceRow,
  TocRow,
} from '../shared/types';

// CHANGE-06 Part 5 (C1) — one resolved decision recorded at M-DECIDE. The
// endpoint turns each into a traceability row (basis preserved for G13.2).
export interface DecidedDecision {
  section: string;
  paragraphId: string;
  selectionId: string;
  kind: string;
  chosen: string;
  basis: 'project-data' | 'ufgs-default';
}

export type ManualGate = 'M-DECIDE' | 'M-COORD' | 'gate5';
export type ManualRunStatus =
  | 'created'
  | 'running'
  | 'awaiting-gate'
  | 'assembling'
  | 'done'
  | 'error'
  | 'superseded';

interface Attestation {
  name: string;
  licenseNo: string;
  licenseExp: string;
  userId: string;
  statement: string;
  at: string;
}

interface Assembly {
  // R2 object keys for the rendered book artifacts (see manual-workflow freeze /
  // assemble steps). The bytes live in R2 — a full-manual DOCX/PDF/ZIP base64 is
  // several MB, past the 2 MB DO storage per key+value cap — so only these small
  // keys are persisted here; getArtifact streams the bytes from R2 by key.
  docxKey?: string;
  pdfKey?: string;
  zipKey?: string;
  contentHash?: string;
  hash8?: string;
  pdfPages?: number;
  manifest?: unknown;
  assembledAt?: string;
}

export interface ManualRunState {
  projectId: string;
  status: ManualRunStatus;
  manualStatus: string;
  stage: string;
  pendingGate: ManualGate | null;
  sections: {
    section: string;
    title: string;
    role: string;
    draftingMode: string;
    status: string;
    openFlags: number;
    error?: string;
  }[];
  coordinationOpen: number;
  contentHash: string | null;
  pdfPages: number | null;
  error: string | null;
  updatedAt: string;
}

interface Persisted {
  projectId: string;
  projectName: string;
  ctx: ModeContext;
  manualCtx: ManualContext;
  inputs: { params: ProjectParams; schedule: FinishScheduleRow[]; drawings: DrawingRow[]; drawingsIndex: EPDDrawingIndex[] };
  outline: ManualSectionRow[];
  includes: Record<string, { title: string; text: string }>;
  user: { email: string; name: string } | null;
  results: Record<string, SectionRunResult>;
  coordinationFlags: ManualCoordinationFlag[];
  masterReferences: ReferenceRow[];
  masterRegister: MasterRegisterGroup[];
  compliance?: ComplianceReport;
  toc: TocRow[];
  assembly: Assembly;
  attestation?: Attestation;
  excluded: string[]; // sections held out of assembly (reject path), rendered reserved
  workflowInstanceId?: string;
  state: { status: ManualRunStatus; manualStatus: string; stage: string; pendingGate: ManualGate | null; contentHash: string | null; pdfPages: number | null; error: string | null; updatedAt: string };
}

export class ManualDO extends DurableObject<Env> {
  private data!: Persisted;
  private loaded = false;

  // Guarantees a value or throws NotInitialized (see SessionDO.load for rationale).
  // Assigning unconditionally also clears stale in-memory state after reset().
  private async load(): Promise<Persisted> {
    if (!this.loaded) {
      this.data = (await this.ctx.storage.get<Persisted>('data')) as Persisted;
      if (this.data) {
        // Per-section results live under their own `result:<section>` keys, not
        // inside the 'data' value. A full-corpus manual's combined verbatim IR
        // bodies are several MB — far past the 2 MB SQLite per-value cap that a
        // single 'data' blob would hit (SQLITE_TOOBIG). Rehydrate them here so
        // callers still see one `results` map. (Falls back to any legacy
        // in-'data' results for DOs written before this split.)
        const stored = await this.ctx.storage.list<SectionRunResult>({ prefix: 'result:' });
        if (stored.size > 0) {
          this.data.results = {};
          for (const [, res] of stored) this.data.results[res.section] = res;
        } else if (!this.data.results) {
          this.data.results = {};
        }
      }
      this.loaded = true;
    }
    if (!this.data) throw new NotInitialized();
    return this.data;
  }
  private async save(): Promise<void> {
    this.data.state.updatedAt = new Date().toISOString();
    // Persist the container WITHOUT the large per-section results — those live
    // under their own keys (see setSectionResult) so no single stored value
    // approaches the 2 MB SQLite per-value limit. The in-memory map is left
    // intact for the accessors; only the persisted copy is emptied.
    const { results: _results, ...rest } = this.data;
    await this.ctx.storage.put('data', { ...rest, results: {} });
  }

  // The manual-scope compliance report DERIVED from current live state (pull, not
  // push): coordination-flag status, per-section results, and the reviewer's
  // held-out set — as they are NOW, not a snapshot taken at an earlier stage.
  // Every gate-admission check and the frozen artifact read through this so a
  // report can never lag behind the triage that resolved its inputs.
  private liveCompliance(): ComplianceReport {
    const results = this.data.outline
      .map((s) => this.data.results[s.section])
      .filter(Boolean) as SectionRunResult[];
    return manualCompliance({
      outline: this.data.outline,
      results,
      coordinationFlags: this.data.coordinationFlags,
      excluded: this.data.excluded,
    });
  }

  async init(args: {
    projectId: string;
    projectName: string;
    ctx: ModeContext;
    manualCtx: ManualContext;
    inputs: { params: ProjectParams; schedule: FinishScheduleRow[]; drawings: DrawingRow[]; drawingsIndex: EPDDrawingIndex[] };
    outline: ManualSectionRow[];
    includes: Record<string, { title: string; text: string }>;
    user: { email: string; name: string } | null;
  }): Promise<void> {
    this.data = {
      projectId: args.projectId,
      projectName: args.projectName,
      ctx: args.ctx,
      manualCtx: args.manualCtx,
      inputs: args.inputs,
      outline: args.outline,
      includes: args.includes,
      user: args.user,
      results: {},
      coordinationFlags: [],
      masterReferences: [],
      masterRegister: [],
      toc: [],
      assembly: {},
      excluded: [],
      state: { status: 'created', manualStatus: 'running', stage: 'fanout', pendingGate: null, contentHash: null, pdfPages: null, error: null, updatedAt: new Date().toISOString() },
    };
    this.loaded = true;
    await this.save();
  }

  async getBootstrap(): Promise<Pick<Persisted, 'projectId' | 'projectName' | 'ctx' | 'manualCtx' | 'inputs' | 'outline' | 'includes' | 'user'>> {
    await this.load();
    const { projectId, projectName, ctx, manualCtx, inputs, outline, includes, user } = this.data;
    return { projectId, projectName, ctx, manualCtx, inputs, outline, includes, user };
  }

  async setWorkflowInstance(id: string): Promise<void> {
    await this.load();
    this.data.workflowInstanceId = id;
    if (this.data.state.status === 'created') this.data.state.status = 'running';
    await this.save();
  }
  async getWorkflowInstance(): Promise<string | undefined> {
    await this.load();
    return this.data.workflowInstanceId;
  }

  async setStage(stage: string, status: ManualRunStatus = 'running', manualStatus?: string): Promise<void> {
    await this.load();
    this.data.state.stage = stage;
    this.data.state.status = status;
    if (manualStatus) this.data.state.manualStatus = manualStatus;
    this.data.state.pendingGate = null;
    await this.save();
  }

  async setSectionResult(result: SectionRunResult): Promise<void> {
    await this.load();
    this.data.results[result.section] = result;
    // Each section IR (verbatim UFGS master) is well under the 2 MB per-value
    // limit on its own; the whole-book sum is not. Store it under its own key.
    await this.ctx.storage.put(`result:${result.section}`, result);
    await this.save();
  }
  async getResults(): Promise<SectionRunResult[]> {
    await this.load();
    return this.data.outline.map((s) => this.data.results[s.section]).filter(Boolean) as SectionRunResult[];
  }

  async saveCoordination(flags: ManualCoordinationFlag[]): Promise<void> {
    await this.load();
    this.data.coordinationFlags = flags;
    await this.save();
  }
  async saveAggregate(args: { references: ReferenceRow[]; register: MasterRegisterGroup[]; compliance: ComplianceReport }): Promise<void> {
    await this.load();
    this.data.masterReferences = args.references;
    this.data.masterRegister = args.register;
    this.data.compliance = args.compliance;
    await this.save();
  }

  async openGate(gate: ManualGate, manualStatus: string): Promise<void> {
    await this.load();
    this.data.state.pendingGate = gate;
    this.data.state.status = 'awaiting-gate';
    this.data.state.manualStatus = manualStatus;
    await this.save();
  }

  // M-COORD triage + Gate 5 approve. Rev E: a gate BLOCKS while unresolved
  // rejections/failures exist. M-COORD requires the reviewer to triage every
  // cross-section flag (proceed clears them; excluded sections are held out and
  // rendered reserved — the honest "reject" path). Gate 5 refuses while any
  // manual-level compliance check fails or any coordination flag is still open.
  async applyGate(gate: ManualGate, decision: Record<string, unknown>): Promise<{ ok: boolean; error?: string; decided?: DecidedDecision[] }> {
    await this.load();
    // CHANGE-06 Part 5 (C1) — M-DECIDE: bulk-resolve / default every open
    // selection across the book. Explicit resolutions carry basis 'project-data';
    // "apply UFGS default to all remaining" records EACH as a G13.2 default
    // (never a blanket unrecorded action). Blocks (ok:false) while any selection
    // stays open (a fill with no value can't be defaulted — G-MAN).
    if (gate === 'M-DECIDE') {
      const resolutions = (decision.resolutions as { selectionId: string; value: string | string[] }[]) ?? [];
      const defaultRemaining = decision.defaultRemaining === true;
      const results = this.data.outline.map((s) => this.data.results[s.section]).filter(Boolean) as SectionRunResult[];
      const decided: DecidedDecision[] = [];
      const touched = new Set<string>();

      // Index every selection to its owning section + paragraph.
      const locate = (selectionId: string) => {
        for (const r of results) {
          if (!r.ir) continue;
          for (const { paragraph } of eachParagraph(r.ir))
            for (const s of paragraph.selections ?? [])
              if (s.id === selectionId) return { result: r, paragraphId: paragraph.id, selection: s };
        }
        return null;
      };

      for (const res of resolutions) {
        const hit = locate(res.selectionId);
        if (!hit) continue;
        const chosen = applySelectionResolution(hit.selection, res.value);
        if (chosen == null) continue;
        touched.add(hit.result.section);
        decided.push({ section: hit.result.section, paragraphId: hit.paragraphId, selectionId: res.selectionId, kind: hit.selection.kind, chosen, basis: 'project-data' });
      }

      if (defaultRemaining) {
        for (const r of results) {
          if (!r.ir) continue;
          for (const { paragraph } of eachParagraph(r.ir))
            for (const s of paragraph.selections ?? []) {
              if (isSelectionResolved(s)) continue;
              const def = ufgsDefaultFor(s);
              if (def == null) continue; // fill with no default stays open (honest)
              const chosen = applySelectionResolution(s, def);
              if (chosen == null) continue;
              touched.add(r.section);
              decided.push({ section: r.section, paragraphId: paragraph.id, selectionId: s.id, kind: s.kind, chosen, basis: 'ufgs-default' });
            }
        }
      }

      // Persist each mutated section result under its own result:* key so the
      // resolutions survive a DO eviction while the gate is open (up to 72h).
      for (const section of touched) {
        const r = this.data.results[section];
        if (r) await this.ctx.storage.put(`result:${section}`, r);
      }
      await this.save();

      const stillOpen = collectOpenDecisions(results);
      if (stillOpen.length)
        return { ok: false, error: `M-DECIDE is blocking: ${stillOpen.length} decision(s) still open (a designer fill needs an explicit value — it has no UFGS default).`, decided };
      return { ok: true, decided };
    }
    if (gate === 'M-COORD') {
      const excluded = (decision.excludeSections as string[]) ?? [];
      this.data.excluded = excluded;
      // Bulk-accept: clear per-section validation flags on INCLUDED sections and
      // resolve all cross-section flags. Excluded sections are held (reserved).
      for (const r of Object.values(this.data.results)) {
        if (excluded.includes(r.section)) {
          r.status = 'error';
          r.error = r.error ?? 'excluded at Gate M-COORD (held out of assembly; rendered reserved)';
          continue;
        }
        for (const f of r.validationFlags) if (!f.resolved) { f.resolved = true; f.resolution = 'accepted default at manual scope (Gate M-COORD bulk accept)'; }
      }
      for (const f of this.data.coordinationFlags) f.status = 'resolved';
      // Re-derive the compliance report from the state this triage just changed,
      // so downstream readers (assembly preview, Gate 5, frozen artifact) never
      // see the pre-triage snapshot (the former permanent Gate-5 deadlock).
      this.data.compliance = this.liveCompliance();
      await this.save();
      return { ok: true };
    }
    // gate5 — Approve for Seal over the assembled manual.
    if (decision.attest !== true) return { ok: false, error: 'attestation required to approve the manual for seal' };
    // Derive compliance from live state at admission time (pull, not push) and
    // persist it so the freeze captures the same report the gate evaluated.
    const compliance = this.liveCompliance();
    this.data.compliance = compliance;
    const failing = compliance.checks.filter((c) => c.status === 'fail');
    if (failing.length)
      return { ok: false, error: `Gate 5 is blocking: ${failing.length} manual-level check(s) still failing (${failing.map((c) => c.id).join(', ')}).` };
    const openCoord = this.data.coordinationFlags.filter((f) => f.status === 'open');
    if (openCoord.length)
      return { ok: false, error: `Gate 5 is blocking: ${openCoord.length} cross-section flag(s) still open. Triage Gate M-COORD first.` };
    this.data.attestation = {
      name: (decision.name as string) ?? 'Architect of Record',
      licenseNo: (decision.licenseNo as string) ?? '',
      licenseExp: (decision.licenseExp as string) ?? '',
      userId: (decision.userId as string) ?? 'demo-architect',
      statement: (decision.statement as string) ?? 'I have exercised responsible control over, and performed substantive review of, this Project Manual.',
      at: new Date().toISOString(),
    };
    await this.save();
    return { ok: true };
  }

  // CHANGE-08 §6 — per-section resolution (re-enterable). Applies reviewer
  // resolutions to ONE section's stored result IR, in place, so the user can jump
  // into any section's review workspace, resolve/adjust its selections, and return
  // — the workspace stays editable in a review/read-with-edit state (not locked
  // after the first pass). Persists the mutated result under its own result:* key
  // and returns the section's remaining-open count so the caller can gate on it.
  async resolveSection(section: string, resolutions: { selectionId: string; value: string | string[] }[]): Promise<{ ok: boolean; resolved: number; open: number; error?: string }> {
    await this.load();
    const r = this.data.results[section];
    if (!r?.ir) return { ok: false, resolved: 0, open: 0, error: `section ${section} has no drafted body to resolve` };
    let resolved = 0;
    const byId = new Map<string, (typeof resolutions)[number]>();
    for (const res of resolutions) byId.set(res.selectionId, res);
    for (const { paragraph } of eachParagraph(r.ir)) {
      for (const s of paragraph.selections ?? []) {
        const res = byId.get(s.id);
        if (!res) continue;
        const chosen = applySelectionResolution(s, res.value);
        if (chosen != null) resolved++;
      }
    }
    // Recompute this section's status from its live open-decision count so the
    // manual page's dots/pills reflect the reviewer's per-section resolution.
    const open = collectOpenDecisions([r]).length;
    if (open === 0 && r.status !== 'error' && r.status !== 'complete') r.status = 'coordinated';
    await this.ctx.storage.put(`result:${section}`, r);
    await this.save();
    return { ok: true, resolved, open };
  }

  // The selections in ONE section (resolved + open), for the per-section review
  // workspace. Read-only projection of the stored result.
  async getSectionDecisions(section: string): Promise<OpenDecision[]> {
    await this.load();
    const r = this.data.results[section];
    return r ? collectOpenDecisions([r]) : [];
  }

  // CHANGE-06 Part 5 (C1) — aggregated open decisions across the whole book,
  // derived from the DO-held per-section results (no new table).
  async getOpenDecisions(): Promise<OpenDecision[]> {
    await this.load();
    const results = this.data.outline.map((s) => this.data.results[s.section]).filter(Boolean) as SectionRunResult[];
    return collectOpenDecisions(results);
  }

  async getExcluded(): Promise<string[]> {
    await this.load();
    return this.data.excluded;
  }
  async getAttestation(): Promise<Attestation | undefined> {
    await this.load();
    return this.data.attestation;
  }

  async saveAssembly(a: Assembly, toc?: TocRow[]): Promise<void> {
    await this.load();
    // `a` carries only small R2 keys + metadata now (the rendered bytes are
    // written to R2 by the caller), so the whole thing fits well under the 2 MB
    // DO storage cap and can merge straight onto `data.assembly`.
    this.data.assembly = { ...this.data.assembly, ...a };
    if (toc) this.data.toc = toc;
    if (a.contentHash) this.data.state.contentHash = a.contentHash;
    if (a.pdfPages != null) this.data.state.pdfPages = a.pdfPages;
    await this.save();
  }

  async markDone(): Promise<void> {
    await this.load();
    this.data.state.status = 'done';
    this.data.state.stage = 'done';
    this.data.state.manualStatus = 'approved';
    this.data.state.pendingGate = null;
    await this.save();
  }
  async setError(msg: string): Promise<void> {
    await this.load();
    this.data.state.status = 'error';
    this.data.state.error = msg;
    await this.save();
  }
  // Rev B — stop / reset a running manual.
  async stop(): Promise<void> {
    try {
      await this.load();
    } catch (err) {
      if (isNotInitialized(err)) return; // nothing running
      throw err;
    }
    this.data.state.status = 'error';
    this.data.state.error = 'stopped by user';
    this.data.state.pendingGate = null;
    await this.save();
  }
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.loaded = false;
  }

  async getState(): Promise<ManualRunState> {
    // Polled before init() and after reset() — a not-yet-initialized manual is a
    // normal state, not an error. Return the neutral default so pollers get 200.
    try {
      await this.load();
    } catch (err) {
      if (isNotInitialized(err))
        return {
          projectId: '', status: 'created', manualStatus: 'outline', stage: 'outline', pendingGate: null,
          sections: [], coordinationOpen: 0, contentHash: null, pdfPages: null, error: null, updatedAt: new Date().toISOString(),
        };
      throw err;
    }
    const s = this.data.state;
    return {
      projectId: this.data.projectId,
      status: s.status,
      manualStatus: s.manualStatus,
      stage: s.stage,
      pendingGate: s.pendingGate,
      sections: this.data.outline.map((o) => {
        const r = this.data.results[o.section];
        return {
          section: o.section,
          title: o.title ?? '',
          role: o.role,
          draftingMode: o.draftingMode,
          status: r?.status ?? o.status ?? 'pending',
          openFlags: r ? r.validationFlags.filter((f) => !f.resolved).length : 0,
          error: r?.error,
        };
      }),
      coordinationOpen: this.data.coordinationFlags.filter((f) => f.status === 'open').length,
      contentHash: s.contentHash,
      pdfPages: s.pdfPages,
      error: s.error,
      updatedAt: s.updatedAt,
    };
  }

  // For the coordination view, assembly preview, artifacts, and whole-manual
  // compare (the approved per-section bodies). Read-only projection.
  async getBundle(): Promise<{
    projectId: string;
    projectName: string;
    ctx: ModeContext;
    outline: ManualSectionRow[];
    results: SectionRunResult[];
    coordinationFlags: ManualCoordinationFlag[];
    masterReferences: ReferenceRow[];
    masterRegister: MasterRegisterGroup[];
    compliance?: ComplianceReport;
    toc: TocRow[];
    excluded: string[];
    contentHash: string | null;
  }> {
    await this.load();
    return {
      projectId: this.data.projectId,
      projectName: this.data.projectName,
      ctx: this.data.ctx,
      outline: this.data.outline,
      results: this.data.outline.map((s) => this.data.results[s.section]).filter(Boolean) as SectionRunResult[],
      coordinationFlags: this.data.coordinationFlags,
      masterReferences: this.data.masterReferences,
      masterRegister: this.data.masterRegister,
      compliance: this.data.compliance,
      toc: this.data.toc,
      excluded: this.data.excluded,
      contentHash: this.data.state.contentHash,
    };
  }

  // Returns the R2 key (not the bytes) for a book artifact; the endpoint streams
  // the object from R2. Keeping the multi-MB bytes out of the DO avoids both the
  // 2 MB storage cap on the write side and any RPC-size concern on read.
  async getArtifact(kind: string): Promise<{ r2Key: string; contentType: string } | null> {
    await this.load();
    const a = this.data.assembly;
    if (kind === 'docx' && a.docxKey)
      return { r2Key: a.docxKey, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    if (kind === 'pdf' && a.pdfKey) return { r2Key: a.pdfKey, contentType: 'application/pdf' };
    if (kind === 'seal-package' && a.zipKey) return { r2Key: a.zipKey, contentType: 'application/zip' };
    return null;
  }
}
