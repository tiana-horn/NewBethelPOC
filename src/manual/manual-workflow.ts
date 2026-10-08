// ManualWorkflow — the parent Workflow over child section runs (CHANGE-03 §4.1).
// It fans out each `draft` section through the EXISTING per-section pipeline
// (runSection, agents unchanged) as its own durable step, runs the manual-scope
// Coordinator + aggregation + Compliance, parks at Gate M-COORD, assembles the
// book, parks at Gate 5 (Approve for Seal), then freezes the whole manual into an
// approved-for-seal package. Partial failure per section never aborts the book.
// No new agent; manual scope lives only here + the DO + the manual-scope passes +
// the Assembler + the compare layer.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { aggregateReferences, aggregateRegister, manualCompliance } from './aggregate';
import { assembleManual, sealCoverageFlags, type AssembleBody, type AssembleInput, type SealAssignment } from './assembler';
import { coordinateManual } from './coordinator-manual';
import { freezeManual, sealBlockedReason } from './freeze';
import { runSection } from './orchestrator';
import type { ManualDO, ManualGate } from './manual-do';
import {
  getCoverMeta,
  getManualEvidence,
  replaceCoordinationFlags,
  setManualStatus,
  setSectionStatus,
  writeAssembly,
} from '../db/manual';
import { appendTraces, criteriaEditions, writeBuildManifest, writeSealPackage } from '../db/d1';
import { getCorpusVersion } from '../db/corpus';
import { getProjectOwner } from '../db/projects';
import { listAssignments } from '../db/people';
import { evaluateGuardrails } from '../shared/guardrails';
import { resolveStylePack, type StylePack } from '../shared/stylepacks';
import { sha256Hex } from '../shared/seal';
import { sendManualReadyEmail } from '../shared/email';
import type { CertificationBlock } from '../shared/docx';
import type { EPDDrawingIndex, GuardrailResult, ManualCoverMeta, ModeContext } from '../shared/types';

// CHANGE-09 Stage 1 — the project's Tier 1 (is_sealing_role=1) assignments, for
// per-discipline seal pages. Read fresh at each use (cheap D1 query) rather than
// bootstrapped into the DO, so an assignment made mid-run is picked up.
async function getSealAssignments(env: Env, projectId: string): Promise<SealAssignment[]> {
  const rows = await listAssignments(env.DB, projectId);
  return rows
    .filter((r) => r.isSealingRole)
    .map((r) => ({ userId: r.userId, userName: r.userName, roleLabel: r.roleLabel, divisionScope: r.divisionScope }));
}

interface Params {
  projectId: string;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class ManualWorkflow extends WorkflowEntrypoint<Env, Params> {
  private stub(id: string): DurableObjectStub<ManualDO> {
    return this.env.MANUAL.get(this.env.MANUAL.idFromName(id)) as unknown as DurableObjectStub<ManualDO>;
  }

  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<void> {
    const { projectId } = event.payload;
    const stub = this.stub(projectId);

    try {
      const boot = await step.do('manual-boot', async () => {
        // The RPC stub types the result with `& Disposable`, which isn't
        // Serializable; cast to the DO method's own (plain) return type.
        const b = await stub.getBootstrap();
        return b as unknown as Awaited<ReturnType<ManualDO['getBootstrap']>>;
      });
      const { ctx, inputs, outline, includes, projectName } = boot;

      // NOTE: the ingest-time "link UFC criteria into the R2 IR" pre-step was
      // REMOVED (CHANGE-06 follow-up). The Resolver now consults the whole loaded
      // UFC corpus directly at resolution time (option-aware match), so there is
      // ONE link mechanism, not a coarse pre-link stacked behind the resolver's
      // match. Explicit/manual linkage is still available via
      // POST /admin/corpus/ufc-criteria { link }.

      // FAN-OUT — each drafted section is its own child run (partial failure OK).
      for (const s of outline.filter((o) => o.draftingMode === 'draft')) {
        await step.do(`section-${s.section}`, async () => {
          const res = await runSection(this.env, ctx, projectId, s.section, inputs);
          await appendTraces(this.env.DB, projectId, s.section, res.traces);
          await stub.setSectionResult(res);
          await setSectionStatus(this.env.DB, projectId, s.section, res.status, `run-${projectId}-${s.section.replace(/\s/g, '')}`);
        });
      }
      await step.do('mark-nondraft', async () => {
        for (const s of outline)
          if (s.draftingMode !== 'draft')
            await setSectionStatus(this.env.DB, projectId, s.section, s.draftingMode === 'include' ? 'complete' : 'pending');
      });

      // GATE M-DECIDE (CHANGE-06 §5, C1) — resolve every open in-book selection
      // BEFORE cross-section coordination reasons over them. Only OPEN the gate when
      // there are decisions to make; with none, there's nothing to resolve, so skip
      // it rather than block the run on an empty gate.
      const openDecisions = await step.do('manual-count-decisions', async () => (await stub.getOpenDecisions()).length);
      if (openDecisions > 0) {
        await manualGate(step, stub, 'M-DECIDE', 'deciding');
      }

      // COORDINATE (manual scope) — cross-section checks + G9, plus (CHANGE-09
      // Stage 1) seal-coverage-gap: any division with no sealing assignment.
      await step.do('manual-coordinate', async () => {
        const results = await stub.getResults();
        const extracted = {
          finishes: inputs.schedule.map((r) => ({ finish: r.finish, substrate: r.substrate })),
          materials: [] as { category: string }[],
        };
        const flags = coordinateManual({ outline, results, extracted, drawings: inputs.drawings });
        const sealAssignments = await getSealAssignments(this.env, projectId);
        flags.push(...sealCoverageFlags(outline, sealAssignments));
        await stub.saveCoordination(flags);
        await replaceCoordinationFlags(this.env.DB, projectId, flags);
      });

      // AGGREGATE — master references (dedup) + register + manual compliance.
      await step.do('manual-aggregate', async () => {
        const bundle = await stub.getBundle();
        const references = aggregateReferences(bundle.results);
        const register = aggregateRegister(bundle.results);
        const compliance = manualCompliance({
          outline,
          results: bundle.results,
          coordinationFlags: bundle.coordinationFlags,
          excluded: bundle.excluded,
        });
        await stub.saveAggregate({ references, register, compliance });
        await setManualStatus(this.env.DB, projectId, 'coordinating');
      });

      // GATE M-COORD — triage cross-section flags + bulk-clear per-section flags.
      await manualGate(step, stub, 'M-COORD', 'coordinating');

      // ASSEMBLE (preview) — the bound DOCX + List of Sections.
      await step.do('manual-assemble', async () => {
        const bundle = await stub.getBundle();
        const pack = await resolveStylePack(this.env, ctx.stylePackId);
        const sealAssignments = await getSealAssignments(this.env, projectId);
        const coverMeta = await getCoverMeta(this.env.DB, projectId);
        const input = buildAssembleInput(bundle, pack, projectName, undefined, sealAssignments, coverMeta ?? undefined, inputs.drawingsIndex);
        const { docx, toc } = assembleManual(input);
        // Preview DOCX to R2 (a full-manual DOCX base64 would exceed the 2 MB DO
        // storage cap); the DO keeps only the key. Overwritten by the frozen
        // artifacts at freeze.
        const previewKey = `manuals/${projectId}/preview/project-manual.docx`;
        await r2put(this.env, previewKey, docx, DOCX_MIME);
        await stub.saveAssembly({ docxKey: previewKey }, toc);
        await writeAssembly(this.env.DB, { projectId, toc, docxKey: previewKey, pdfKey: null, contentHash: null, assembledAt: new Date().toISOString() });
        await setManualStatus(this.env.DB, projectId, 'assembled');
      });

      // GATE 5 — Approve for Seal over the assembled manual.
      await manualGate(step, stub, 'gate5', 'assembled');

      // FREEZE — one DOCX -> one PDF -> one SHA-256 -> approved-for-seal package.
      await step.do('manual-freeze', async () => {
        const bundle = await stub.getBundle();
        const attestation = await stub.getAttestation();
        const pack = await resolveStylePack(this.env, ctx.stylePackId);
        const cert: CertificationBlock | undefined = attestation
          ? {
              entityName: projectName || 'Bethel (MD MBE/DBE/SBE A/E/CM)',
              date: new Date().toISOString().slice(0, 10),
              printedName: attestation.name,
              licenseNo: attestation.licenseNo,
              licenseExp: attestation.licenseExp,
              statement: attestation.statement,
            }
          : undefined;
        const sealAssignments = await getSealAssignments(this.env, projectId);
        const coverMeta = await getCoverMeta(this.env.DB, projectId);
        const input = buildAssembleInput(bundle, pack, projectName, cert, sealAssignments, coverMeta ?? undefined, inputs.drawingsIndex);

        const sectionHashes: Record<string, string> = {};
        for (const r of bundle.results)
          if (r.docxBase64) sectionHashes[r.section] = 'sha256:' + (await sha256Hex(unb64(r.docxBase64)));

        const editions = await criteriaEditions(this.env.DB, ctx.complianceProfile);
        const corpusVersion = await getCorpusVersion(this.env.DB); // C6.1 — real UFGS-Master edition, not a literal
        const guardrailResults = bookGuardrails(bundle.results);
        const evidence = await getManualEvidence(this.env.DB, projectId);

        const frozen = await freezeManual({
          env: this.env,
          assemble: input,
          sections: bundle.outline.map((s) => ({ section: s.section, title: s.title ?? '', division: s.division ?? '', orderIndex: s.orderIndex, role: s.role as any, draftingMode: s.draftingMode as any, lockedDocId: s.lockedDocId ?? undefined })),
          sectionHashes,
          masterReferences: bundle.masterReferences,
          masterRegister: bundle.masterRegister,
          compliance: bundle.compliance ?? { profile: 'manual', summary: '', checks: [], traceabilityRows: 0 },
          evidence,
          mode: ctx.mode,
          stylePackId: ctx.stylePackId,
          modelConfig: ctx.modelBindings,
          criteriaEditions: editions,
          corpusVersion,
          guardrailResults,
        });

        const base = `manuals/${projectId}/${frozen.hash8}`;
        await r2put(this.env, `${base}/project-manual.pdf`, frozen.pdf, 'application/pdf');
        await r2put(this.env, `${base}/project-manual.docx`, frozen.docx, DOCX_MIME);
        await r2put(this.env, `${base}/approved-for-seal-${frozen.hash8}.zip`, frozen.zip, 'application/zip');

        await stub.saveAssembly(
          { docxKey: `${base}/project-manual.docx`, pdfKey: `${base}/project-manual.pdf`, zipKey: `${base}/approved-for-seal-${frozen.hash8}.zip`, contentHash: frozen.contentHash, hash8: frozen.hash8, pdfPages: frozen.pdfPages, manifest: frozen.manifest, assembledAt: frozen.frozenAt },
          frozen.toc,
        );
        await writeAssembly(this.env.DB, { projectId, toc: frozen.toc, docxKey: `${base}/project-manual.docx`, pdfKey: `${base}/project-manual.pdf`, contentHash: frozen.contentHash, assembledAt: frozen.frozenAt });
        // CHANGE-06 §6 (C2 / G16) — a sealed PDF must be container-rendered AND
        // pagination-verified. A worker-fallback (or unverified) PDF is preview
        // only and can NEVER reach approved_for_seal. The frozen preview artifacts
        // are still written (status 'frozen'); the seal is refused with a message.
        const blocked = sealBlockedReason(frozen.manifest, !!attestation);
        const spid = `sp-manual-${projectId}-${frozen.hash8}`;
        await writeSealPackage(this.env.DB, {
          spid, projectId, section: '', // NULL for manual scope
          pdfKey: `${base}/project-manual.pdf`, docxKey: `${base}/project-manual.docx`, zipKey: `${base}/approved-for-seal-${frozen.hash8}.zip`,
          contentHash: frozen.contentHash, frozenAt: frozen.frozenAt,
          attestedBy: attestation?.name ?? null, attestedAt: attestation?.at ?? null,
          licenseNo: attestation?.licenseNo ?? null, licenseExp: attestation?.licenseExp ?? null,
          status: attestation && !blocked ? 'approved_for_seal' : 'frozen',
          scope: 'manual', sectionsJson: JSON.stringify(frozen.manifest.sections),
        });
        await writeBuildManifest(this.env.DB, spid, {
          contentHash: frozen.contentHash, frozenAt: frozen.frozenAt, attestedBy: frozen.manifest.attestedBy,
          mode: ctx.mode, stylePackId: ctx.stylePackId,
          corpusVersion: frozen.manifest.corpusVersion, criteriaEditions: editions, modelConfig: ctx.modelBindings,
          promptVersion: 'v1', guardrailResults: guardrailResults as any,
        });
        // G16 — refuse to advance to 'approved' on a non-seal-grade PDF. The
        // preview + 'frozen' seal-package row remain; the reviewer must bind the
        // render container and re-approve. This throw surfaces the message and
        // skips markDone (the manual is not silently sealed on a flat PDF).
        if (blocked) {
          await setManualStatus(this.env.DB, projectId, 'assembled');
          throw new Error(blocked);
        }
        await setManualStatus(this.env.DB, projectId, 'approved');

        // Rev A — notify the owner that the Project Manual finished rendering.
        const owner = await getProjectOwner(this.env.DB, projectId);
        if (owner)
          await sendManualReadyEmail(this.env, {
            to: owner.email, name: owner.name, projectName: projectName || projectId, projectId,
            contentHash: frozen.contentHash, pageCount: frozen.pdfPages, appUrl: this.env.APP_URL,
          });
      });

      await stub.markDone();
    } catch (err) {
      await stub.setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}

// Book-level G2/G3 (pass iff no section failed) + unioned validation flags + total
// traces -> the exhaustive G1..G8 map for the manual MANIFEST.
function bookGuardrails(results: { validationFlags: any[]; guardrails: GuardrailResult[]; traces: any[] }[]): Record<string, GuardrailResult> {
  const g2fail = results.some((r) => r.guardrails.some((g) => g.id === 'G2' && g.status === 'fail'));
  const g3fail = results.some((r) => r.guardrails.some((g) => g.id === 'G3' && g.status === 'fail'));
  const resolverGuardrails: GuardrailResult[] = [
    { id: 'G2', status: g2fail ? 'fail' : 'pass', evidence: g2fail ? 'A locked span changed in at least one section.' : 'All locked spans byte-identical across every section.' },
    { id: 'G3', status: g3fail ? 'fail' : 'pass', evidence: g3fail ? 'A requirement was resolved by multiple mechanisms in at least one section.' : 'Each requirement resolved by exactly one mechanism across the book.' },
  ];
  const validationFlags = results.flatMap((r) => r.validationFlags);
  const traceCount = results.reduce((n, r) => n + r.traces.length, 0);
  // Manual scope. By the time the manifest is built (assemble/freeze), the
  // blocking gates (M-DECIDE/M-COORD) have already cleared every open in-book
  // selection and cross-section flag (G5), so those evaluate clean here; G13/G16
  // are enforced inline at freeze (freeze.ts sealBlockedReason).
  return evaluateGuardrails({
    scope: 'manual',
    resolverGuardrails,
    validationFlags,
    traceCount,
    manualCoordinationFlags: [],
    openInBookSelections: 0,
  });
}

function buildAssembleInput(
  bundle: Awaited<ReturnType<ManualDO['getBundle']>>,
  pack: StylePack,
  projectName: string,
  cert: CertificationBlock | undefined,
  sealAssignments?: SealAssignment[],
  coverMeta?: ManualCoverMeta,
  drawingsIndex?: EPDDrawingIndex[],
): AssembleInput {
  const bodies: Record<string, AssembleBody> = {};
  for (const r of bundle.results) {
    // Held-out / errored sections carry no body -> the Assembler renders reserved.
    if (r.status === 'error' || bundle.excluded.includes(r.section) || !r.ir) continue;
    bodies[r.section] = { ir: r.ir, references: r.referencesList?.references ?? [], register: r.register?.rows ?? [] };
  }
  const includes: Record<string, { title: string; text: string }> = {};
  for (const s of bundle.outline)
    if (s.draftingMode === 'include') includes[s.section] = { title: s.title ?? '', text: `${s.title ?? 'Agency front-end document'} — included unaltered by the A/E; may not be modified (G2).` };

  return {
    projectName: projectName || 'Project Manual',
    issueDate: new Date().toISOString().slice(0, 10),
    pack,
    outline: bundle.outline,
    bodies,
    includes,
    certification: cert,
    dividers: true,
    sealAssignments,
    coverMeta,
    drawingsIndex,
  };
}

async function r2put(env: Env, key: string, body: Uint8Array, contentType: string): Promise<void> {
  try {
    await env.R2?.put(key, body, { httpMetadata: { contentType } });
  } catch {
    /* R2 optional — artifacts also live in the DO */
  }
}

// Both DO writes wrapped in step.do so Workflow replay doesn't re-open cleared gates.
async function manualGate(step: WorkflowStep, stub: DurableObjectStub<ManualDO>, gate: ManualGate, manualStatus: string): Promise<void> {
  await step.do(`open-${gate}`, async () => {
    await stub.openGate(gate, manualStatus);
  });
  await step.waitForEvent<any>(`await-${gate}`, { type: gate, timeout: '72 hours' });
  await step.do(`close-${gate}`, async () => {
    const nextStage = gate === 'M-DECIDE' ? 'coordinating' : gate === 'M-COORD' ? 'assembling' : 'freezing';
    await stub.setStage(nextStage, 'running', manualStatus);
  });
}
