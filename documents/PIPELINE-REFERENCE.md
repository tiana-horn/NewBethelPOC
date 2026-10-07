# Pipeline / agent reference

Traced directly from `src/workflow.ts` (single-section) and
`src/manual/manual-workflow.ts` + `src/manual/orchestrator.ts` (Project
Manual) — not from a diagram. See [`../README.md`](../README.md)
*Architecture* for why these are two separate Workflow implementations that
share only the six agents below.

## The six agents (`src/agents/*`, dispatched via `src/agents/registry.ts`)

Every agent has the identical contract
(`src/agents/contracts.ts`): `run(env: Env, ctx: ModeContext, input) →
Promise<output>`. Both pipelines call these through the SAME registry
object (`agents.drafter`, `agents.resolver`, ...) — confirmed by grep, no
direct import of an agent module from either Workflow file.

### 1. Drafter (`src/agents/drafter.ts`)
**In**: `{ params, schedule, section? }`. **Out**: `{ ir: SectionIR,
provenance: string[] }`. Loads the real, ingested UFGS SEC master for the
requested section **verbatim** — never authors, rephrases, or "adapts"
prose (G13). If the section has no ingested corpus row
(`ufgs_corpus_section`), it returns an honestly-empty IR rather than
fabricating content (verified by `test/manual.test.ts`: "an un-ingested
UFGS section returns an honestly-empty IR"). `section` is undefined in the
single-section path (defaults to the mode's default section) and set
explicitly by the manual fan-out.

### 2. Resolver (`src/agents/resolver.ts`)
**In**: `{ ir, params, schedule, extracted? }`. **Out**: `{ ir,
resolutionLog, traces, exclusivityViolations, lockedViolations,
guardrails }`. Resolves every bracket/fill/tailoring selection in
precedence order: **project data → UFC criteria → UFGS default** (G13),
recording which authority resolved it (`basis`). Returns G2 (locked-span)
and G3 (exclusivity) violations as first-class data — both pipelines treat
a non-empty violation list as fatal and halt before persisting.

### 3. Validator (`src/agents/validator.ts`)
**In**: `{ ir, projectId }`. **Out**: `{ ir, referencesList, register,
criteriaMatrix, flags, traces }`. Resolves every reference/submittal/
criteria/product request against D1 (`ref_list`/`sub_list`/`criteria`/
`product_library`) or flags it — never invents a designation, date, or
classification (G1/G4/G7). CHANGE-09 addition: for a G-classified submittal,
resolves or defaults (from `ctx.constructionAgent`) an `approvingAuthority`,
with a G13-citing trace.

### 4. Coordinator (`src/agents/coordinator.ts`)
**In**: `{ ir, schedule, drawings }`. **Out**: `{ flags:
CoordinationFlag[] }`. Cross-checks the drafted spec against the finish
schedule and drawings (e.g. a scheduled finish with no governing
paragraph). Purely deterministic today; the file's own comment notes
`USE_AI=true` could add semantic cross-checking but doesn't yet.

### 5. Compliance (`src/agents/compliance.ts`)
**In**: `{ ir, referencesList?, register?, validationFlags,
coordinationFlags, traceCount, lockedSpanViolations?,
exclusivityViolations? }`. **Out**: `{ report: ComplianceReport }`. Keyed by
`ctx.complianceProfile` (only `'ufc'` is live — the Mode B/C `house-qa`/
`gsa-p100`/`md-dgs` profiles + their MBE/DBE and seal-page checks were
removed with those modes). Produces the compliance/traceability report
consumed at Gate 5 / the manual's Gate 5.

### 6. Embeddings (`src/agents/embeddings.ts`)
**In**: `{ texts: string[] }`. **Out**: `{ vectors: number[][] }`. Returns
empty vectors when `USE_AI=false` (the entire local demo path) — callers
(Drafter's retrieval, `src/manual/sec-embed.ts`'s recall blend) degrade to
the non-embedding corpus/lexical path rather than failing.

---

## Single-section pipeline (`SpecWorkflow`, `src/workflow.ts`)

One Cloudflare Workflow `run()`, `step.do`-per-stage, `step.waitForEvent`
gates:

| Step | What it does | Gate after |
|---|---|---|
| `intake` | bootstrap from `SessionDO`, clear old traces | — |
| `draft` | `agents.drafter` → save IR | **gate1** (confirm scope, non-blocking) |
| `resolve` | `agents.resolver`; halts the Workflow on any G2/G3 violation | **gate2** (accept/reject resolutions, non-blocking) |
| `validate` | `agents.validator`; persists `submittal_register` (write-only, see `DATA-MODEL.md`) + traces | **gate3** (clear flags — **BLOCKING**) |
| `coordinate` | `agents.coordinator` | **gate4** (triage, non-blocking) |
| `compliance` | `agents.compliance` | — |
| `emit` | renders working DOCX/PDF/CSV artifacts (`renderDocx`, `renderFallbackPdf`, `emitSpecsIntact`) to R2 + the DO | **gate5** (approve for seal — **BLOCKING**) |
| `seal` | `assertSectionIssuedClean` (G13) → render DOCX+PDF with the cert block → hash → `assembleSealPackage` (`shared/seal.ts`) → write `seal_package`/`build_manifest` | — |

Ends with `stub.markDone()`. G16 (seal-grade PDF) is enforced inline in the
`seal` step, independently of the manual pipeline's equivalent check.

## Project Manual pipeline (`ManualWorkflow`, `src/manual/manual-workflow.ts`)

| Step | What it does | Gate after |
|---|---|---|
| `manual-boot` | bootstrap from `ManualDO` | — |
| `section-<n>` (fan-out, one per `draft`-mode outline entry) | `src/manual/orchestrator.ts runSection` — draft→resolve→validate→coordinate→compliance for ONE section, via the same 6 agents; a section error never aborts the book (`status: 'error'`, book still assembles the rest) | — |
| `mark-nondraft` | mark `include`/`outline` sections complete/pending | — |
| `manual-count-decisions` | count open in-book selections | **M-DECIDE** (only opened if count > 0) |
| `manual-coordinate` | `src/manual/coordinator-manual.ts` cross-section checks + (CHANGE-09) `sealCoverageFlags` | — |
| `manual-aggregate` | `src/manual/aggregate.ts` — master references (dedup), master register, manual compliance report | — |
| (gate) | — | **M-COORD** (triage cross-section flags — **BLOCKING**) |
| `manual-assemble` | `src/manual/assembler.ts assembleManual` — cover, TOC, List of Drawings, section bodies, seal pages; preview DOCX to R2 | **gate5** (approve for seal — **BLOCKING**) |
| `manual-freeze` | `src/manual/freeze.ts freezeManual` — two-pass paginated render (estimate → verify → re-render), hash, ZIP with `MANIFEST.json`, `sealBlockedReason` (G16) | — |

Ends with `stub.markDone()`.

### Why "two pipelines, one set of agents"

`runSection` (manual) and the inline steps in `workflow.ts` (single-section)
both call `agents.drafter/resolver/validator/coordinator/compliance` with
identical contracts — that sharing is real and verified. What is **not**
shared: the Workflow orchestration class itself, the freeze/seal assembly
(`shared/seal.ts assembleSealPackage` vs. `manual/freeze.ts freezeManual`),
and the DOCX/PDF render call sites at emit time (though both ultimately call
the same low-level `src/shared/docx.ts` primitives). See
`DOC-AUDIT-FINDINGS.md` finding #1 for the CHANGE-07 doc that describes this
as unified when it isn't.

## Outline seeding (Project Manual only, `src/manual/outline.ts`)

Two entry points, both used depending on whether the SEC catalog + intake
features are usable:

- `computeOutlineFromCandidates` — the normal path: SEC-catalog lexical
  match (`src/manual/sec-match.ts`) blended with optional Vectorize
  embedding recall (`src/manual/sec-embed.ts`), plus the mandatory
  Division 01 checklist (always), plus Division 00 (from `locked_docs`, or
  an honest government-furnished placeholder if none configured).
- `computeModeAOutline` — the fallback when the SEC catalog is empty or no
  usable intake features exist: mandatory Division 01 checklist +
  Division 00 only, no technical sections. (Historically this collapsed to
  a single section before CHANGE-09 §3 — see `DOC-AUDIT-FINDINGS.md`.)

Agency-tailored `.00 NN` SEC variants are collapsed to the one matching the
project's agency by `src/manual/division.ts selectAgencyVariant` (CHANGE-09
§2), used by both entry points.
