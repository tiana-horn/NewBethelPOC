# Data model reference

Verified directly against [`../db/schema.sql`](../db/schema.sql) (28 tables,
`CREATE TABLE IF NOT EXISTS` only — non-destructive) and the accessor
functions in `../src/db/*.ts`. "Introduced by" cites the CHANGE-0x doc named
in the table's own schema comment — for history/rationale only; verify
current behavior against the code, not the doc. See
[`../README.md`](../README.md) for the current-state summary and
[`DOC-AUDIT-FINDINGS.md`](./DOC-AUDIT-FINDINGS.md) for where this schema
disagrees with what a doc claims.

## Authoritative lookup ("validate, don't generate" backbone)

### `ref_list`
Controlled reference-publication list, `list_id`-scoped (`UMRL` is the only
list actually queried under the single live UFGS mode; `COMMERCIAL`/`GSA`/
`MD_DGS` values are vestigial from removed modes B/C).
| Column | Type | Notes |
|---|---|---|
| `rid` | TEXT PK | |
| `list_id` | TEXT | default `'UMRL'` |
| `org`, `designation`, `edition_date`, `title` | TEXT | |
| `active` | INTEGER | default 1 |
| `source_edition`, `verified_at`, `stale` | TEXT/TEXT/INTEGER | G11 staleness triad |

Read by `src/db/d1.ts loadReferenceMap`/`lookupReference`. Introduced by
CHANGE-01 §1.3/§5.3; G11 columns by CHANGE-04 §9.1.

### `sub_list`
Controlled submittal list, `list_id`-scoped; `sd_code` nullable (was for
Mode C agencies with no SD-code scheme — those modes are gone, so this
nullability is now effectively unused, all live rows are `list_id='UMRL'`
with a real SD code).
| Column | Type |
|---|---|
| `usid` PK, `list_id`, `section`, `sd_code`, `item`, `default_class`, `notes`, `source_edition`, `verified_at`, `stale` | TEXT/TEXT/.../INTEGER |

Read by `loadSubmittalMap`/`lookupSubmittal` (`src/db/d1.ts`).

### `product_library`
Basis-of-design product grounding (G4). `pid` PK, `manufacturer`,
`product_name`, `category`, `cut_sheet_r2`, `attributes`. **Dormant on the
live UFGS path** — no UFGS drafting path ever sets `paragraph.productCategory`,
so `loadProductMap` is called but resolves nothing in practice. Exercised by
`test/golden.test.ts` and `test/perf-bench.test.ts` directly, not by any
real run today.

### `criteria`
Real UFC/GSA-P100/agency criteria clauses (G7). `cid` PK, `profile`
(`'ufc'|'gsa-p100'|'md-dgs'`), `document`, `edition`, `clause`, `text`,
`perf_level`, `verified_at`, `stale`. Only `profile='ufc'` is populated by
the live ETL (`scripts/etl-ufc-criteria.ts`); `gsa-p100`/`md-dgs` rows are
illustrative leftovers from removed modes, still read by one built-in Div 01
fixture (`src/corpus/div01-013300.ts` cites `cid-p100-finishes` — removing
it would break every manual's Div 01 draft with a spurious
`criteria-not-found`).

### `locked_docs`
Unalterable Division 00 front-end documents (G2). `ldid` PK, `profile`,
`title`, `r2_key`, `alterable` (0 = A/E may not touch it). Read by
`listLockedDocs(db, 'ufc')` in `src/manual/endpoints.ts` to seed Division 00.

## Tenancy / users / projects

### `organization` — **dead table**
`org_id` PK, `name`. Seeded with exactly one demo row
(`org-demo`) by `db/seed.sql`. **Zero SELECT/JOIN call sites anywhere in
`src/`** — `project.org_id` is a free-text column, never validated against
this table, never enforced as a foreign key (SQLite doesn't enforce FKs
without `PRAGMA foreign_keys=ON`, which is set nowhere in this codebase).
See `DOC-AUDIT-FINDINGS.md`.

### `app_user`
`email` PK, `name`, `created_at`. The real user directory — every signed-in
person gets a row via `upsertUser` (`src/db/projects.ts`), referenced by
`manual_assignment.user_id` and `manual_section_assignee.user_id`.

### `project`
The wizard's lifecycle record. `project_id` PK, `org_id` (unvalidated free
string — see `organization` above), `user_email` (owner), `name`, `mode`
(comment says `'UFGS'|'COMMERCIAL'|'PUBLIC_SECTOR'` but `src/index.ts`
hardcodes every new project to `'UFGS'` — the other two values can only
exist on pre-CHANGE-05 legacy rows), `public_profile`, `agency`, `section`,
`master_id`, `selections_json`, `status`, `params_json`, `delivery_kind`
(`'single-section'|'project-manual'`), `manual_status`, `created_at`.
Central accessor file: `src/db/projects.ts`.

### `project_input`
Raw uploaded files. `id` PK autoincrement, `project_id`, `kind`, `filename`,
`r2_key`, `sha256`, `parse_status`. Written by `POST /project/:id/inputs`,
read by `/parse` and Gate 0's required-inputs check.

### `extracted_project_data`
The normalized intake model, one row per project. `project_id` PK,
`data_json` (the full `ExtractedProjectData`), `confirmed` (Gate 0 gate —
the pipeline cannot run until this flips to 1).

### `master_library`
The corpus a run drafts from. `master_id` PK, `owner` (`'system'` built-in
or an org id for firm-uploaded), `name`, `mode`, `namespace` (Vectorize
namespace), `r2_prefix`, `status` (`'processing'|'ready'`), `created_at`.

## Comparison (permanently quarantined, G-CMP-1)

### `comparison`, `comparison_score`, `comparison_section`
Post-approval scoring of an uploaded in-house spec against the AI output.
`comparison.reference_r2_key` lives under a `projects/:id/comparison/
reference/` R2 prefix that no embedding/retrieval/generation path ever
reads (`src/compare/score.ts`, `src/manual/compare-manual.ts` are the only
readers, and only for scoring/display). `comparison_score.section = NULL`
marks a manual-scope rollup row (vs. a per-section score). `comparison_section`
holds the whole-manual segmentation/alignment (`matched|reference-only|
ours-only`). Accessors: `src/db/projects.ts` (comparison/comparison_score),
`src/db/manual.ts` (comparison_section).

## Single-section run record

### `submittal_register` — **write-only table**
`id` PK autoincrement, `project_id`, `section`, `sd_code`, `item`,
`classification`, `usid`, `status`. **Only `src/db/d1.ts` (`replaceRegister`,
called from `workflow.ts`'s validate step) writes to it — DELETE then
INSERT on every run.** Grep confirms no `SELECT ... FROM submittal_register`
exists anywhere in `src/`. The submittal register the app actually
displays/exports (per-section cards, the CSV artifact, the manual's master
register) is built from the **in-memory** `SectionRunResult.register`
(`SubmittalRegisterRow[]`, held in `ManualDO`/`SessionDO` state and
persisted into `traceability`, not this table). This table is a write-only
audit sink with no read path. See `DOC-AUDIT-FINDINGS.md`.

### `traceability`
Every resolved decision → its source (G6). `id` PK autoincrement,
`project_id`, `section`, `element`, `decision`, `source_type`, `source_ref`,
`confidence`, `basis` (`'project-data'|'ufc-criteria'|'ufgs-default'`,
CHANGE-06 G13), `confidence_tier`, `justification` (CHANGE-08 §7,
human-verifiable reasoning distinct from `source_ref`), `created_at`. Unique
index `(project_id, section, element, decision, source_type, source_ref)`
makes repeated Workflow-step retries idempotent (`INSERT OR IGNORE`). The
**only real read-and-display path** for submittal/reference/resolution data
in the traceability CSV artifact and the per-section resolution cards.
Accessors: `src/db/d1.ts appendTraces/getTraces/countTraces/clearTraces`.

### `seal_package`
The approved-for-seal record. `spid` PK, `project_id`, `section` (NULL for
`scope='manual'`), `scope` (`'section'|'manual'`), `sections_json`,
`pdf_r2_key`/`docx_r2_key`/`zip_r2_key`, `content_hash` (SHA-256 of the
frozen PDF), `frozen_at`, `attested_by`/`attested_at`/`license_no`/
`license_exp`, `status` (`'frozen'|'approved_for_seal'|'superseded'`).
Written independently by both `workflow.ts` (single-section) and
`manual-workflow.ts` (book) — see the README's *Architecture* section on
why these are two call sites, not one.

### `review_evidence`
The responsible-control record — one row per gate decision. `id` PK
autoincrement, `project_id`, `section`, `spid` (nullable — gates 1–4 predate
any freeze), `gate`, `element`, `action`
(`accept|reject|edit|clear-flag|confirm|...`), `before_val`, `after_val`,
`user_id`, `at`. Unique index makes a re-submitted identical decision
idempotent.

### `build_manifest`
`spid` PK, `corpus_version`, `model_config_json`, `prompt_version`,
`criteria_editions_json`, `guardrail_results_json`. The D1 mirror of the
`MANIFEST.json` written into the approved-for-seal ZIP.

## Project Manual (CHANGE-03)

### `manual_section`
The outline / TOC source of truth. `id` PK, `project_id`, `section`,
`title`, `division` (derived `'00'..'49'`), `order_index`, `role`
(`'front-end'|'div01'|'technical'`), `drafting_mode`
(`'draft'|'include'|'outline'`), `master_id`, `locked_doc_id`, `run_id`,
`status`. Accessor: `src/db/manual.ts replaceOutline/getOutline`.

### `manual_coordination_flag`
Cross-section flags, distinct from per-section validation flags. `id` PK
autoincrement, `project_id`, `kind` (`ref-edition-conflict|scope-gap|
scope-overlap|submittal-mismatch|div01-vs-gc|toc-integrity|
seal-coverage-gap` — the last one added by CHANGE-09, **not yet reflected in
this table's own schema comment**, see `DOC-AUDIT-FINDINGS.md`), `detail`,
`sections` (JSON array), `severity`, `status`.

### `manual_assembly`
The assembled book. `project_id` PK, `toc_json`, `docx_r2_key`,
`pdf_r2_key`, `content_hash`, `assembled_at`.

### `manual_cover_meta` (CHANGE-09)
Manual-level, **display-only** DoD title-page metadata — the generation
pipeline never reads it; the Assembler's cover template reads it at
assemble time only. `project_id` PK, `project_title`,
`installation_location`, `solicitation_no` (also the future addenda
correlator), `preparing_firm`, `design_district`, `dod_component`,
`issue_date`, `updated_at`, `updated_by`. Accessor:
`src/db/manual.ts getCoverMeta/upsertCoverMeta`.

## Corpus provenance (CHANGE-04)

### `ufgs_corpus_section`
The queryable answer to "is this section draftable?" `section` PK (e.g.
`'09 90 00'`, or a real `.00 NN`-tailored designation), `title`, `r2_key`,
`vectorize_ns`, `source_edition`, `ingested_at`, `embedded` (1 once the
title+scope is in the `ufgs` Vectorize namespace). 683 rows committed via
`db/generated/seed-sec-catalog.sql`; full body text depends on
`npm run etl:ufgs-corpus` having been run against the gitignored source.

### `corpus_source`
The provenance ledger — every ingested artifact traces here (G12). `source_id`
PK, `kind` (`UFGS-MASTER|UMRL|UMSL|UFC`), `identifier`, `edition`,
`ingested_at`, `checked_at`, `latest_known_edition`, `stale`, `r2_key`,
`criterion_id` (UFC UUID, captured at ingest so the staleness Cron needs no
seed map). Live-verified: the deployed Worker's `/admin/corpus/staleness`
returns real, dated rows for at least the UFC kind.

### `mandatory_div01_section` (CHANGE-09)
The mandatory Division 01 checklist — required reference data, seeded from
`db/seed-div01.sql` (11 rows), reseeded every CD deploy. `section` PK,
`title`, `sort_order`. Read by `src/db/corpus.ts
getMandatoryDiv01Sections`, consumed by `src/manual/outline.ts` to
force-include these regardless of intake features.

## People / roles (CHANGE-08)

### `manual_role`
Assignable roles — Tier 1 (sealing, `is_sealing_role=1`) or Tier 2
(production). `role_id` PK, `label`, `is_sealing_role`, `tier`,
`default_division_scope` (JSON array, nullable), `sort_order`. **The
table's own schema comment says "Seeded as DATA (db/seed.sql)" — this is
inaccurate; it is actually seeded from the separate `db/seed-roles.sql`**
(verified: `db/seed.sql` contains no `INSERT INTO manual_role`). See
`DOC-AUDIT-FINDINGS.md`.

### `manual_assignment`
The load-bearing many-to-many join: project × person × role. `id` PK,
`project_id`, `user_id`, `role_id`, `division_scope` (JSON array, NULL →
role default), `assigned_at`, `assigned_by`. Unique on
`(project_id, user_id, role_id)` — prevents duplicate rows, does NOT prevent
multi-role or multi-holder. Read by `src/manual/assembler.ts
resolveSealRoster` (CHANGE-09) to drive per-discipline seal pages.

### `manual_section_assignee`
Section-level assignment, many-to-many, keyed by `(project_id, section)`
rather than `manual_section.id` so it survives an outline reseed. `id` PK,
`project_id`, `section`, `user_id`, `assigned_at`. Drives "Assigned to me"
and Needs-Attention scoping (`src/manual/overview.ts`).

---

## Foreign keys are not enforced

SQLite requires `PRAGMA foreign_keys = ON` per connection to enforce
declared FKs, and nothing in this codebase sets it — every "FK" comment in
`schema.sql` (e.g. `-- FK organization`, `-- FK locked_docs`, `-- FK
app_user(email)`) is documentation only, not a database-enforced
constraint. Orphaned rows (e.g. a `manual_assignment.user_id` with no
`app_user` row, though `upsertAssignment` guards this in practice by
calling `upsertUser` first) are structurally possible.

## Seed files

| File | Contents | Destructive? | Reseed cadence |
|---|---|---|---|
| `db/schema.sql` | All 28 `CREATE TABLE IF NOT EXISTS` | No | Every deploy |
| `db/seed.sql` | Illustrative UMRL/UMSL/criteria/locked_docs/organization/master_library, with intentional G1-flag gaps | Yes (DELETEs project-scoped rows first) | Manual only |
| `db/generated/seed-umrl-umsl.sql` | Real parsed UMRL/UMSL (supersedes `seed.sql`'s UMRL rows) | Yes | Manual (`db:seed:real`) |
| `db/generated/seed-sec-catalog.sql` | 683-row SEC catalog | No (`INSERT OR REPLACE`) | Every deploy |
| `db/seed-roles.sql` | `manual_role` (required reference data) | No | Every deploy |
| `db/seed-div01.sql` | `mandatory_div01_section` (required reference data) | No | Every deploy |
| `db/schema-reset.sql` | DROP + recreate, for picking up a column change locally | Yes | Local only, never `--remote` |
