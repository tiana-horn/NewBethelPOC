# Rebuild Blueprint — AI Specifications Writer

> **What this document is.** A self-contained, executable specification for
> rebuilding this project **from scratch in a new, empty repository**. A fresh
> Claude Code instance should be able to open the new repo with only this file
> and the carried-over source data (see §14) and build the whole system.
>
> **This is a clean rearchitecture, not a port.** It describes the system we
> *want*, with the known drift in the current repo already fixed. Where it says
> "the old repo does X, we will instead do Y," do Y. Do not reproduce X.
>
> **Non-negotiable product promise:** nothing the system issues is invented.
> Every reference, submittal classification, and criterion citation traces to a
> real ingested row or is flagged for a human — never guessed. The system
> produces an *approved-for-seal package*; a licensed architect-of-record
> applies the actual seal outside the system. Keep this true at every step.

---

## 1. What the product is

An AI construction-specifications writer for **UFGS (U.S. DoD) Project
Manuals**. A firm creates a project (for a DoD agency), uploads building intake
(IFC model, COBie workbook, finish-schedule CSV/XLSX, program PDF/DOCX),
confirms the machine-extracted project data, confirms a section outline, then
runs the whole book: every section is drafted from the **real, ingested UFGS
master**, its brackets/choices resolved against project data + real UFC
criteria, validated against controlled reference/submittal lists, coordinated
across sections, assembled into a bound Project Manual (cover + lists +
sections + per-discipline seal pages), and frozen to one hash-addressed,
content-immutable PDF of record.

The drafting engine **never authors spec prose**. It loads government UFGS
section text verbatim and performs *deterministic* bracket resolution on top of
it. The LLM is used only at the edges (intake extraction, retrieval recall) —
never to write a requirement, a citation, or an edition.

### Domain primer (read before building — these terms recur)

- **UFGS** — Unified Facilities Guide Specifications. The DoD master spec
  library, ~700 sections, published as SpecsIntact `.SEC` files. Public U.S.
  Government work (freely ingestible).
- **SpecsIntact `.SEC`** — an SGML/XML-ish format. A section has PARTs →
  paragraphs, `<REF>` reference tags, `<SUB>` submittal tags, tailoring
  options, and **brackets** `[ ... ]` marking editor choices/fills. See the
  carried-over `documents/specsintact-format-notes.md`.
- **Brackets** — `[option A][option B]` (pick one) or `[_____]` (fill-in). The
  Resolver's whole job is choosing/filling these from authoritative data.
- **UMRL / UMSL** — the Unified Master Reference List / Master Submittal List:
  controlled lists of valid reference publications and submittal items. The
  "validate, don't generate" backbone — a `<REF>`/`<SUB>` must resolve to a row
  here or be flagged.
- **UFC criteria** — Unified Facilities Criteria: technical clauses + editions,
  pulled from the WBDG CIM API. Authoritative source for resolving a bracket to
  a criterion-driven value.
- **Agency** — `ARMY | NAVY | AIRFORCE | OTHER`. The one real tailoring axis.
  Drives the UMRL subset, the construction agent (USACE/NAVFAC/AFCEC), which
  agency-tailored `.00 NN` SEC variant is selected, and a G-submittal's default
  approving authority.
- **Seal** — a licensed architect/engineer's stamp + signature on contract
  documents. The system produces placeholders only and **holds no signing key**.
- **CSI licensing boundary** — MasterFormat, SectionFormat, PageFormat,
  UniFormat, and OmniClass Table 22 are **licensed CSI intellectual property.**
  Never ingest or persist them. In particular, drop `masterFormatId` /
  `uniFormatId` at every data boundary. (CSI *conventions* expressed in our own
  Style Pack code are fine; CSI *content/IDs* are not.)

---

## 2. Rearchitecture decisions (what changes vs. the old repo)

The old repo accreted drift over nine change-sets. Build the target state
directly. These are the deltas — each is a decision already made:

### 2.1 ONE pipeline, not two
The old repo had two independent Workflow implementations (`SpecWorkflow`/
`SessionDO` for a single section, `ManualWorkflow`/`ManualDO` for the book) that
shared the six agents but **duplicated** orchestration, freeze, and seal-package
assembly. A CHANGE-07 doc claimed to unify them; that never happened.

**Build one pipeline.** A single-section run is just a **one-section manual**.
There is exactly one Workflow class (`ManualWorkflow`), one live-state Durable
Object (`ManualDO`), one freeze path, one seal-package assembler. The
single-section "demo" front door still exists in the UI, but it drives the same
backend with an outline of one technical section (no sign-in required path may
remain for the demo, see §10). Delete `SpecWorkflow`, `SessionDO`, and the
`shared/seal.ts assembleSealPackage` duplicate entirely.

### 2.2 Delete dead code — do not recreate it
- **`organization` table** — never read anywhere. Omit it. `project.org_id`
  stays a free-text column (or drop it; see §5).
- **`submittal_register` D1 table** — write-only, never selected. Omit it. The
  live submittal register is the in-memory `SectionRunResult.register`,
  persisted into `traceability`.
- **Modes B (Commercial) and C (Public Sector)** — collapsed out long ago. One
  mode: **UFGS**. No `mode` parameter that silently ignores its argument; no
  three-mode chooser in the UI. `buildModeContext()` loads the UFGS profile,
  full stop.
- **`commercial-house` / `gsa` Style Pack stubs** — empty override objects. Omit.
  Ship `csi-baseline` (foundation) + `ufgs` (the real, always-used pack) +
  optionally `md-dgs` (jurisdiction override only) if trivially cheap.
- **G10** — retired (named the reverted OmniClass crosswalk). Do not assign the
  number. Guardrail IDs are G1–G9, G11–G16, plus G-MAN and G-CMP-1.
- **Unwired IFC-extraction container** (`container-ifc/`) — the in-Worker
  STEP-text parser is the real path. Don't scaffold the second container.

### 2.3 One guardrail harness, covering everything
The old repo had a hard exhaustiveness check for **G1–G8 only**
(`assembleGuardrails` throws if one is missing), while G9/G11–G16 each lived at
their own point of use with no "all evaluated this run" assertion.

**Unify it.** Build one `evaluateGuardrails(run)` that asserts *every* guardrail
applicable to the run was evaluated (present with a pass/fail/n-a status +
evidence), and throws if any is missing — for the whole set, not a subset. A
guardrail that was never computed must never be silently recorded "pass." This
is the single most important invariant in the system; make it structural.

### 2.4 Authenticate the corpus admin surface
`/admin/corpus/*` was unauthenticated in the old repo (live-confirmed in prod —
anyone could trigger ETL/ingest). In the rebuild, **require auth** on all
`/admin/*` routes (a signed-in admin role, or at minimum a shared-secret header
checked server-side). Do not ship an open ingest surface.

### 2.5 Keep what genuinely worked
Carry forward unchanged in spirit: the six-agent contract
(`run(env, ctx, input)` through one registry), `ModeContext` construction, the
Style Pack layering, the `SectionIR` intermediate representation, the
provenance/traceability ledger, the two-pass paginated container render for
seal-grade PDFs, the quarterly staleness Cron, and the deterministic
`USE_AI=false` offline mode for reproducible local demos and tests.

---

## 3. Tech stack & cost posture

**Stay on Cloudflare.** It is already the lean/low-cost choice: Workers, D1, R2,
KV, Vectorize, Workers AI, Workflows, Durable Objects, Cron, and static Assets
all have generous free/low tiers, and the whole thing deploys as one Worker. Do
not re-platform.

| Concern | Primitive |
|---|---|
| API + router + static SPA host | Worker (`src/index.ts`) + Assets |
| Pipeline orchestration (durable, HITL gates) | **Workflow** (`ManualWorkflow`) |
| Live run state + gate decisions | **Durable Object** (`ManualDO`) |
| Seal-grade PDF (verifiable pagination) | **Container** (LibreOffice headless) |
| Authoritative lookup (lists/criteria/projects/traces) | **D1** |
| Corpus text + generated artifacts | **R2** |
| Profiles, model config, auth sessions | **KV** |
| Section retrieval recall (optional) | **Vectorize** |
| LLM inference (intake extraction, recall) | **Workers AI** via **AI Gateway** |
| Quarterly staleness sweep | **Cron** |
| Ready-notification email | Resend (HTTP), optional/no-op if unconfigured |

### Cost levers — bake these in from day one
- **USE_AI toggle.** `USE_AI=false` must give a fully functional, deterministic
  system (drafting is verbatim-from-corpus anyway; extraction falls back to
  deterministic parsing; embeddings return empty and callers degrade to
  lexical). This is the local/test default **and** a valid production mode —
  zero inference cost. Only flip `USE_AI=true` where LLM extraction adds value.
- **Container is the one real cost.** LibreOffice render containers bill for
  compute while running. Keep `max_instances` low (≤3), `instance_type: basic`,
  and invoke the container **only at freeze** (seal-grade PDF), never for
  preview. Preview PDFs use the in-Worker fallback renderer (which G16 refuses
  at seal — that's correct). A manual with no freeze never spins a container.
- **Vectorize is optional.** Everything works lexical-only. Treat embedding
  recall as an enhancement, never a dependency.
- **Pin a small, cheap Workers AI model** for intake extraction; keep prompts
  JSON-Schema-constrained and short. Cache nothing that would hold PII.

---

## 4. The pipeline (unified)

One Cloudflare Workflow, `step.do` per stage, `step.waitForEvent` for Human-In-
The-Loop gates. `ManualDO` holds live state (ModeContext, per-section status,
accumulated bundle, artifacts, gate decisions, attestation).

```
Outline        compute candidate outline: SEC-catalog lexical match (+ optional
               Vectorize recall) from intake features, ALWAYS plus the mandatory
               Division 01 checklist, plus Division 00 (from locked_docs or an
               honest government-furnished placeholder)
   └─ gate M0  confirm outline (BLOCKING for the book; 409 on dup section #s)

Fan-out        for each `draft`-mode outline entry, runSection():
               Draft → Resolve → Validate → Coordinate → Compliance
               (the SAME six agents; a section error sets status:'error' and the
                book still assembles the rest — partial failure tolerated)

Mark-nondraft  mark include/outline sections complete/pending (never shown as
               drafted — G-MAN)

Count-decisions count open in-book bracket selections
   └─ gate M-DECIDE  resolve EVERY open selection (BLOCKING; opens only if >0).
                     Per-section review workspace is re-enterable.

Coordinate     cross-section checks → ManualCoordinationFlags:
               ref-edition-conflict (G9), scope-gap, scope-overlap,
               submittal-mismatch, div01-vs-gc, toc-integrity, seal-coverage-gap

Aggregate      master references (dedup), master submittal register,
               manual-level compliance report

   └─ gate M-COORD  triage cross-section flags (BLOCKING)

Assemble       the bound book: cover (real DoD title-page fields) · List of
               Sections · List of Drawings · section bodies · ONE seal-and-
               signature page per sealing-role assignment, scoped to its
               divisions. Preview DOCX to R2.

   └─ gate 5   approve for seal (BLOCKING)

Freeze         assertSectionIssuedClean (G13) → two-pass paginated render
               (estimate → verify → re-render) via the Container → SHA-256 →
               ZIP with MANIFEST.json. sealBlockedReason enforces G16
               (container-rendered + pagination-verified, else refuse).
```

A single-section run = an outline of exactly one technical (`draft`-mode)
section fanned through the identical stages, then assembled/frozen as a
one-section book. No separate code path.

### The six agents (one contract, one registry)

All six are colocated modules dispatched through one registry
(`src/agents/registry.ts`), each `run(env, ctx: ModeContext, input) → output`.
The registry shape mirrors Worker-to-Worker service-binding RPC so they can
later be split into separate Workers without touching call sites. **Every agent
call goes through the registry — no pipeline imports an agent module directly.**

1. **Drafter** — `{ params, schedule, section? } → { ir: SectionIR,
   provenance }`. Loads the ingested UFGS SEC master **verbatim**. If a section
   has no `ufgs_corpus_section` row, returns an honestly-empty IR — never
   fabricates (G12).
2. **Resolver** — `{ ir, params, schedule, extracted? } → { ir, resolutionLog,
   traces, exclusivityViolations, lockedViolations, guardrails }`. Resolves
   every bracket/fill/tailoring selection in precedence **project data → UFC
   criteria → UFGS default**, recording the `basis`. Returns G2 (locked-span)
   and G3 (exclusivity) violations as first-class data; the pipeline treats a
   non-empty violation list as fatal and halts before persisting.
3. **Validator** — `{ ir, projectId } → { ir, referencesList, register,
   criteriaMatrix, flags, traces }`. Resolves every reference/submittal/
   criteria/product request against D1 or flags it — never invents (G1/G4/G7).
   For a G-classified submittal, resolves-or-defaults an `approvingAuthority`
   from `ctx.constructionAgent`, with a G13 trace.
4. **Coordinator** — `{ ir, schedule, drawings } → { flags }`. Deterministic
   cross-check of spec vs. finish schedule + drawings (e.g. a scheduled finish
   with no governing paragraph).
5. **Compliance** — `{ ir, referencesList?, register?, validationFlags,
   coordinationFlags, traceCount, lockedSpanViolations?, exclusivityViolations? }
   → { report }`. Keyed by `ctx.complianceProfile` (`'ufc'` is the only live
   profile). Produces the report consumed at Gate 5.
6. **Embeddings** — `{ texts } → { vectors }`. Returns empty vectors when
   `USE_AI=false`; callers degrade to the lexical/corpus path rather than
   failing.

---

## 5. Data model

Target: **27 tables** in `db/schema.sql`, `CREATE TABLE IF NOT EXISTS` only
(non-destructive). This drops the old repo's dead `organization` and write-only
`submittal_register`. Full column detail lives in the carried-over
`documents/DATA-MODEL.md` — but **apply the deletions in §2.2** when you port it.

**Authoritative lookup (validate-don't-generate backbone)**
- `ref_list` — controlled references (`list_id`='UMRL'; `rid` PK; org,
  designation, edition_date, title, active; + G11 staleness triad
  source_edition/verified_at/stale).
- `sub_list` — controlled submittals (`usid` PK; section, sd_code, item,
  default_class, notes; + staleness triad).
- `criteria` — UFC clauses + editions (`cid` PK; profile='ufc', document,
  edition, clause, text, perf_level, verified_at, stale).
- `locked_docs` — unalterable Div 00 front-end docs (`ldid` PK; title, r2_key,
  alterable).
- `product_library` — basis-of-design grounding (G4). Keep the table + code
  path (dormant on the UFGS path today, but real and tested).

**Project lifecycle**
- `app_user` (`email` PK) — the user directory.
- `project` (`project_id` PK; user_email owner, name, agency, section,
  master_id, selections_json, status, params_json, delivery_kind, manual_status,
  created_at). Mode is always UFGS — do not add a mode column that lies.
- `project_input` — raw uploads (project_id, kind, filename, r2_key, sha256,
  parse_status).
- `extracted_project_data` — normalized intake (`project_id` PK, data_json,
  `confirmed` — the Gate-0 gate; the pipeline cannot run until it flips to 1).
- `master_library` — the corpus a run drafts from (`master_id` PK; owner, name,
  namespace, r2_prefix, status).

**Run record**
- `traceability` — every resolved decision → its source (G6). Carries `basis`
  (project-data|ufc-criteria|ufgs-default) and `justification`. Unique index
  makes Workflow-step retries idempotent (INSERT OR IGNORE). **This is the real
  read-and-display source for submittal/reference/resolution data** — the CSV
  artifact and per-section cards read from here.
- `seal_package` — the approved-for-seal record (content_hash = SHA-256 of the
  frozen PDF; status frozen|approved_for_seal|superseded; attestation fields).
  One write path now (not two).
- `review_evidence` — one row per gate decision (responsible-control record).
- `build_manifest` — D1 mirror of the ZIP's MANIFEST.json.

**Project Manual**
- `manual_section` — outline/TOC source of truth (section, title, division,
  order_index, role front-end|div01|technical, drafting_mode draft|include|
  outline, master_id, locked_doc_id, run_id, status).
- `manual_coordination_flag` — cross-section flags (kind includes
  seal-coverage-gap).
- `manual_assembly` — the assembled book (toc_json, docx_r2_key, pdf_r2_key,
  content_hash).
- `manual_cover_meta` — display-only DoD title-page metadata (read only by the
  Assembler's cover template, never by generation).

**Corpus provenance**
- `ufgs_corpus_section` — "is this section draftable?" (section PK, title,
  r2_key, vectorize_ns, source_edition, ingested_at, embedded). ~683 rows from
  the committed SEC catalog seed.
- `corpus_source` — provenance ledger, every ingest traces here (G12). kind
  UFGS-MASTER|UMRL|UMSL|UFC; edition, ingested_at, checked_at,
  latest_known_edition, stale, r2_key, criterion_id.
- `mandatory_div01_section` — the mandatory Division 01 checklist (11 rows,
  required reference data).

**People / roles (multi-user manuals)**
- `manual_role` — assignable roles; Tier 1 (sealing, is_sealing_role=1) /
  Tier 2 (production); default_division_scope. Seed from `db/seed-roles.sql`.
- `manual_assignment` — project × person × role many-to-many (unique on
  (project_id, user_id, role_id)). Drives per-discipline seal pages.
- `manual_section_assignee` — section-level assignment many-to-many, keyed by
  (project_id, section) so it survives an outline reseed. Drives "assigned to
  me" / Needs-Attention.

**Comparison (permanently quarantined, G-CMP-1)**
- `comparison`, `comparison_score`, `comparison_section` — post-approval scoring
  of an uploaded in-house spec against our output. The reference upload lives
  under R2 `projects/:id/comparison/reference/` and is **never** embedded,
  retrieved, or placed in a generation prompt — only scoring code reads it.

> **Foreign keys:** SQLite doesn't enforce declared FKs without
> `PRAGMA foreign_keys=ON`, which we do not set. FK comments are documentation.
> Guard referential integrity in code (e.g. upsert the user before an
> assignment), as the old repo does.

### Seed files
- `db/schema.sql` — all `CREATE TABLE IF NOT EXISTS`. Non-destructive. Every deploy.
- `db/generated/seed-sec-catalog.sql` — the 683-row SEC catalog. **Committed**,
  `INSERT OR REPLACE`, reseeded every deploy. (Carry this file over verbatim.)
- `db/seed-roles.sql`, `db/seed-div01.sql` — required reference data, idempotent,
  reseeded every deploy.
- `db/generated/seed-umrl-umsl.sql` — real parsed UMRL/UMSL (regenerable from
  source; gitignored). Loaded by `db:seed:real`.
- `db/seed.sql` — illustrative data with intentional G1-flag gaps (for the
  offline demo). Destructive of project rows; manual only.
- `db/schema-reset.sql` — DROP + recreate, local only, never `--remote`.

---

## 6. HTTP API surface

All JSON except artifact downloads (raw bytes + content-disposition). Router
split: `src/index.ts` (top-level dispatch + project routes), `src/manual/
endpoints.ts` (`/project/:id/manual/*`), `src/manual/people-endpoints.ts`
(people/roles/assignments/overview + `/manuals/saved`), `src/auth.ts`
(`/auth/*`), `src/corpus/admin.ts` (`/admin/corpus/*`).

**Auth tiers (enforced in `src/index.ts` before sub-routers run):**
- No auth: `/auth/*`, `/api/seed-r2`, and the public single-section **demo**
  (see §10 for whether to keep an anonymous demo door).
- **`/admin/*` — now REQUIRES auth** (admin role or shared-secret header). This
  is the §2.4 fix.
- Auth required (401 without session): `/project*`, `/masters*`, `/projects`,
  `/manuals*`.
- Per-project authz (403 if not owner/assignee): every `/project/:id/*` route,
  via `canAccessProject` + `isUserAssigned`.

**Route groups** (full table in carried-over `documents/API-REFERENCE.md` —
drop the `/session/*` group if you fully collapse the demo into a one-section
manual; otherwise keep it as a thin alias over the unified pipeline):
- `/auth/*` — config, me, logout, google/{start,callback}, dev session
  (403 unless Google unconfigured AND `ALLOW_DEV_LOGIN=true`).
- `/masters`, `/project`, `/projects`, `/project/:id/{inputs,parse,extracted,
  extracted/confirm,required-inputs,selections,run,state,bundle,gate/:id,
  artifact/:kind,comparison}`.
- `/project/:id/manual/{outline,outline/proposed,cover-meta,run,stop,reset,
  restart,state,coordination,section/:sec,section/:sec/resolve,decisions,
  gate/:id,artifact/:kind,comparison,comparison/align}`.
- `/project/:id/manual/{overview,roles,users,assignments,assignments/scope,
  assignments/remove,section-assignees,section-assignees/remove}`.
- `/manuals/saved` (top level).
- `/admin/corpus/{staleness,staleness/sweep,:id/reverify,ufgs-section,
  ufgs-bulk,umrl,umsl,criteria,ufc-criteria}` — **auth required.**

**Artifact kinds** — single-section/section scope: section-ir, specsintact-xml,
docx, pdf, submittal-register-csv, references-csv, resolution-log,
criteria-matrix, division01-report, coordination-flags, compliance-report,
traceability-csv, seal-package. Manual scope: docx, pdf, seal-package (binary
from R2); toc, references, submittal-register, coordination, compliance (JSON).

---

## 7. Guardrails (the whole contract)

Build one `evaluateGuardrails(run)` with a single exhaustiveness assertion over
the **entire** set below (§2.3). Each returns `{ id, status: pass|fail|n/a,
evidence }`. A missing entry throws. Carry the detailed enforcement/test map
from `documents/GUARDRAILS-REFERENCE.md`.

| # | Guardrail | One-line |
|---|---|---|
| G1 | Validate, don't generate | refs/submittals resolve against D1 or flag; SpecsIntact emit fails closed on an unvalidated `<REF>/<SUB>` |
| G2 | Locked spans verbatim | resolver + `lockedSpansUnchanged`; halt on violation |
| G3 | Tailoring XOR brackets | `checkExclusivity`; halt on violation |
| G4 | Product grounding | basis-of-design from `product_library` only; flag unverifiable |
| G5 | Blocking HITL | gates 3/5, M-DECIDE, M-COORD refuse admission until cleared |
| G6 | Provenance everywhere | every agent returns traces → `traceability` |
| G7 | Criteria from data | editions from `criteria`, never model recall |
| G8 | No signing key / no applied seal | placeholders only; zero key material in `src/` |
| G9 | Cross-section ref-edition consistency | `ref-edition-conflict` flag |
| ~~G10~~ | *retired — do not assign* | — |
| G11 | Corpus staleness: flag, never auto-adopt | Cron `markStale`; reverify only flags |
| G12 | Every row traces to a real ingest | `corpus_source` ledger; empty-IR for un-ingested section |
| G13 | Output hygiene + resolve-or-default | `assertSectionIssuedClean` before packaging; no unresolved markup / "Note to Designer" leak |
| G14 | No licensed CSI classification IDs | drop `masterFormatId`/`uniFormatId` at the extractor |
| G15 | M-DECIDE refuses an open selection | `applyGate('M-DECIDE')` over pure helpers |
| G16 | Seal-grade PDF needs container + pagination verify | refuse worker-fallback PDF at seal |
| G-MAN | Honest manual scope | outline-only never shown as drafted; honest Div 00/01; seal-coverage-gap flagged |
| G-CMP-1 | Comparison upload quarantined | never embedded/retrieved/prompted |

---

## 8. Auth & authorization

- **Google OAuth** (`/auth/google/{start,callback}`) is the real path; sessions
  in KV keyed by an opaque HttpOnly/SameSite=Lax cookie (Secure only over HTTPS
  so local http dev works); user row in `app_user`.
- **Dev login** (`POST /auth/session`) is local-only: 403s unless Google is
  unconfigured AND `ALLOW_DEV_LOGIN=true` (a `.dev.vars`-only flag).
- Per-project access: a project with no owner (anonymous/demo) is shared; an
  owned project is owner-only OR reachable by anyone holding a
  `manual_assignment` / `manual_section_assignee` row on it.
- **New:** admin routes require auth (§2.4).

---

## 9. Corpus ETL & provenance

Scripts (Node, run against a local `wrangler dev` which does the actual
R2/D1 writes inside the Worker):
- `etl:sec-catalog` → `db/generated/seed-sec-catalog.sql` (section # + title,
  683 rows). Committed.
- `etl:ufgs-corpus` → `POST /admin/corpus/ufgs-bulk` → `sec-to-ir` → R2 + D1
  `ufgs_corpus_section`/`corpus_source`. Ingests `.SEC` body text. One-time /
  on source change.
- `etl:ufgs` → `db/generated/seed-umrl-umsl.sql` (real UMRL/UMSL).
- `etl:ufc-criteria` → `POST /admin/corpus/ufc-criteria` → D1 `criteria` +
  `corpus_source`. Pulls real UFC clauses/editions from the **WBDG CIM API**
  (`src/corpus/ufc-cim.ts`); criterion/version UUIDs are out-of-band in a
  committed `scripts/ufc-uuids.json` (the CIM has no public search route).
  **Drop `masterFormatId`/`uniFormatId` here (G14).**

Quarterly **Cron** (`0 8 1 2,5,8,11 *`) → `scheduled()` → walks `corpus_source`,
flags newer editions `stale` for human re-verification. Never auto-adopts (G11).

---

## 10. Frontend

A static SPA in `public/` (`index.html`, `app.js`, `styles.css`), served via
Cloudflare Assets with `not_found_handling: single-page-application` and
`run_worker_first` scoped to the API prefixes (critical — otherwise
`<a download>` artifact clicks get the SPA shell instead of the file; see the
carried-over `wrangler.jsonc` comment).

**Rearchitecture for the UI:** remove the vestigial three-mode chooser (there is
one mode). Decide the demo door: either keep a public, no-sign-in single-section
demo that drives the unified one-section-manual pipeline, or require sign-in
everywhere. Recommended: **keep the anonymous demo** (it's good for showing the
product) but implement it as a one-section manual on an unowned/shared project,
not a separate `SessionDO` pipeline.

Core screens: project wizard (create → upload intake → Gate 0 confirm extracted
data → selections), the Project Manual page (`/overview` derive: status tiles,
filter, pagination, division grouping, per-user Needs-Attention), the
per-section review workspace (bracket resolution for M-DECIDE), cross-section
flag triage (M-COORD), approve-for-seal, and artifact downloads. Consider
rebuilding `app.js` (currently a 2,400-line single file) as small modules — but
that's a quality choice, not a requirement.

---

## 11. Build order (how to sequence the rebuild)

A fresh agent should build bottom-up so each layer is testable before the next:

1. **Scaffold** — `wrangler.jsonc` (carry over, update IDs), `package.json`,
   `tsconfig.json`, `vitest.config.ts`, `.dev.vars.example`
   (`USE_AI=false`, `ALLOW_DEV_LOGIN=true`), `.gitignore`.
2. **Schema + seeds** — `db/schema.sql` (24 tables, §5), the three required
   seeds, and the committed SEC catalog. `npm run db:reset` must succeed.
3. **Shared core** — `types.ts`, `SectionIR` + `section-ir.ts`, `brackets.ts`,
   `specsintact.ts` (incl. `assertSectionIssuedClean`), `stylepacks.ts`,
   `guardrails.ts` (the unified harness, §2.3/§7), `ai.ts` (USE_AI gate).
4. **D1 accessors** — `db/*.ts` for every table group; `appendTraces` idempotent.
5. **The six agents** + the registry (§4).
6. **Mode context + profiles** (one UFGS profile).
7. **Intake** — filetype detect, IFC STEP-text parser, COBie/table/finish-
   schedule parsers, program extractor, normalize → `ExtractedProjectData`.
8. **Corpus** — `sec-parser`, `sec-to-ir`, `ufc-cim`, `corpus/admin.ts`
   (**auth'd**), `staleness-cron`, the ETL scripts.
9. **The unified pipeline** — `ManualWorkflow`, `ManualDO`, `orchestrator`
   (runSection), `outline`, `division`, `coordinator-manual`, `aggregate`,
   `assembler`, `freeze`, `overview`.
10. **Render container** — `container/` (LibreOffice headless + a tiny HTTP
    server), `RenderContainer` DO, wired in `wrangler.jsonc`. Invoked only at
    freeze.
11. **Auth + authz** — `auth.ts`, `authz.ts`, `people.ts`.
12. **Router** — `index.ts` + the endpoint modules; wire every route in §6.
13. **Frontend** — `public/*`.
14. **CI/CD** — `.github/workflows/deploy.yml`: verify (typecheck + test +
    `wrangler deploy --dry-run`) on every push/PR; deploy + secret sync + schema
    re-apply + reseed on push to the default branch.

Keep `npm run typecheck`, `npm test`, and `wrangler deploy --dry-run` green at
every milestone.

---

## 12. Testing strategy

Vitest, no Cloudflare account needed, all with `USE_AI=false`. Mirror the old
repo's coverage (it had ~260 tests across 34 files): a golden end-to-end draft/
resolve/validate test, a guardrail-assembly exhaustiveness test (now covering
the **whole** set), resolver bracket-resolution + locked-span + exclusivity
tests, manual assembly/seal-gating tests, output-hygiene (notes-to-designer),
the SEC matcher, UFC criteria + G14, staleness Cron, per-discipline sealing,
agency-suffix variant selection, the mandatory Div 01 checklist, submittal-
register approving-authority fill, cover metadata, section-format tells, and the
comparison quarantine. Every guardrail in §7 gets at least one test.

Add a test the old repo lacked: an **integration test for the M-DECIDE
gate-blocking path** (the old repo only tested its pure helpers).

---

## 13. Known limitations to preserve honestly (don't pretend to fix)

State these plainly in the new README; several are inherent to the domain:
- The tool drafts; a licensed architect-of-record must review and stamp. "Human-
  verified," not "cannot err."
- One tailoring axis (agency). No full tailoring matrix.
- Minimal, valid (not pixel-perfect) DOCX. Byte-for-byte SpecsIntact round-trip
  is blocked on the authoritative DTD/XSD (not public).
- No `<MET>/<ENG>` dual-unit engine.
- No addenda/revision model — a post-freeze edit supersedes the whole book (new
  content hash) rather than tracking a discrete addendum.
- Seal-grade PDF requires the render container; without it, freeze produces a
  valid-but-unverified PDF that G16 refuses at seal.
- UFC criterion/version UUID discovery is out-of-band (committed seed map).
- **Licensing:** UFGS/UFC/UMRL/UMSL are public U.S. Government works. CSI
  MasterFormat/SectionFormat/PageFormat/UniFormat/OmniClass are licensed — never
  ingested or persisted.

---

## 14. What to carry over from the old repo

Copy these into the new repo (they are inputs, not things to regenerate):
- **Reference docs** — `documents/DATA-MODEL.md`, `API-REFERENCE.md`,
  `PIPELINE-REFERENCE.md`, `GUARDRAILS-REFERENCE.md`, `specsintact-format-notes.md`.
  (Treat as detailed appendices to this blueprint; apply §2 deletions as you port.)
- **Committed seed** — `db/generated/seed-sec-catalog.sql` (683 sections).
- **Source data (gitignored, large/licensed)** — `documents/UFGS_M/*.SEC`,
  `scripts/ufc-uuids.json`, the sample IFC/COBie intake
  (`NBU_MedicalClinic_*.ifc`, `2013-03-28-Clinic-Handover-v13.xlsx`), the
  SpecsIntact format PDFs. Needed to run the ETL; keep out of git.
- **Container** — `container/Dockerfile` + `server.py` (LibreOffice render),
  if a working image already exists, reuse its registry digest.

Do **not** carry over: `src/session-do.ts`, `src/workflow.ts`,
`src/shared/seal.ts` (the single-section duplicate), `container-ifc/`, the
`organization`/`submittal_register` schema, the Mode B/C profiles, the
`commercial-house`/`gsa` style packs, or the `documents/spec-writer-poc-CHANGE-0x`
change-set docs (superseded by this blueprint + the four reference docs).

---

## Appendix — one-time Cloudflare setup

```bash
wrangler d1 create spec_writer          # paste database_id into wrangler.jsonc
wrangler kv namespace create KV         # paste id
wrangler r2 bucket create spec-writer-artifacts
wrangler vectorize create spec-writer --preset @cf/baai/bge-base-en-v1.5
wrangler ai gateway create spec-writer  # name must match AI_GATEWAY_ID var
wrangler d1 execute spec_writer --remote --file db/schema.sql
wrangler d1 execute spec_writer --remote --file db/generated/seed-sec-catalog.sql
wrangler deploy
```
