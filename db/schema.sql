-- ============================================================================
-- D1 schema — the authoritative-lookup store ("validate, don't generate"
-- backbone: G1/G4/G7). Clean rebuild per REBUILD-BLUEPRINT.md §5.
--
-- 26 tables. Deliberately DROPPED vs. the prior POC (blueprint §2.2):
--   * `organization`       — never read anywhere; project.org_id is free text.
--   * `submittal_register` — write-only, never SELECTed; the live register is
--                            the in-memory run result persisted into traceability.
--
-- NON-DESTRUCTIVE: this file only CREATEs (IF NOT EXISTS) and never DROPs, so it
-- is safe to apply to remote/production on every deploy. The DROP-then-recreate
-- path (to pick up a column change locally) lives in LOCAL-ONLY db/schema-reset.sql
-- (`npm run db:schema:reset`, or `npm run db:reset` which chains reset -> schema
-- -> seed). Applying this file alone will NOT alter an existing table's columns;
-- when a definition changes, run the reset (local) or an explicit ALTER (remote).
-- ============================================================================

-- === Controlled reference list (UMRL) ========================================
CREATE TABLE IF NOT EXISTS ref_list (
  rid           TEXT PRIMARY KEY,
  list_id       TEXT NOT NULL DEFAULT 'UMRL',
  org           TEXT NOT NULL,
  designation   TEXT NOT NULL,
  edition_date  TEXT NOT NULL,
  title         TEXT NOT NULL,
  active        INTEGER DEFAULT 1,
  -- G11 staleness triad — the edition each row was LOADED at, when it was last
  -- verified against the live source, and whether that edition has gone stale.
  source_edition TEXT,
  verified_at    TEXT,
  stale          INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ref_list ON ref_list (list_id, org, designation);

-- === Controlled submittal list (UMSL) ========================================
CREATE TABLE IF NOT EXISTS sub_list (
  usid          TEXT PRIMARY KEY,
  list_id       TEXT NOT NULL DEFAULT 'UMSL',
  section       TEXT NOT NULL,
  sd_code       TEXT,                           -- 'SD-01'..'SD-11'
  item          TEXT NOT NULL,
  default_class TEXT,
  notes         TEXT,
  source_edition TEXT,
  verified_at    TEXT,
  stale          INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sub_list ON sub_list (list_id, section, item);

-- === Product library — basis-of-design grounding (G4). Dormant on the live
-- UFGS path (no UFGS path sets productCategory) but the code path + tests are
-- real; kept so G4 stays exercised. ==========================================
CREATE TABLE IF NOT EXISTS product_library (
  pid           TEXT PRIMARY KEY,
  manufacturer  TEXT NOT NULL,
  product_name  TEXT NOT NULL,
  category      TEXT NOT NULL,
  cut_sheet_r2  TEXT,
  attributes    TEXT
);
CREATE INDEX IF NOT EXISTS idx_product_category ON product_library (category);

-- === Criteria clauses (UFC) — G7. Editions VERIFIED at build time, never from
-- model memory. Only profile='ufc' is populated by the live ETL. ==============
CREATE TABLE IF NOT EXISTS criteria (
  cid        TEXT PRIMARY KEY,
  profile    TEXT NOT NULL,   -- 'ufc'
  document   TEXT NOT NULL,
  edition    TEXT NOT NULL,
  clause     TEXT NOT NULL,
  text       TEXT NOT NULL,
  perf_level TEXT,
  verified_at TEXT,
  stale       INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_criteria ON criteria (profile, clause);

-- === Unalterable Division 00 front-end documents — G2 ========================
CREATE TABLE IF NOT EXISTS locked_docs (
  ldid      TEXT PRIMARY KEY,
  profile   TEXT NOT NULL,
  title     TEXT NOT NULL,
  r2_key    TEXT,
  alterable INTEGER DEFAULT 0  -- 0 = may NOT be altered by the A/E
);

-- === Users — Google (or dev) sign-in; projects/assignments attribute here =====
CREATE TABLE IF NOT EXISTS app_user (
  email      TEXT PRIMARY KEY,
  name       TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- === Projects — the wizard's lifecycle record ================================
-- Mode is always UFGS (the only live mode); there is no mode column that lies.
CREATE TABLE IF NOT EXISTS project (
  project_id     TEXT PRIMARY KEY,
  org_id         TEXT,                -- free-text label only (no organization table)
  user_email     TEXT,                -- the signed-in owner (NULL = anonymous/shared demo)
  name           TEXT,
  agency         TEXT,                -- 'ARMY'|'NAVY'|'AIRFORCE'|'OTHER' (the one tailoring axis)
  section        TEXT,                -- the section to produce (single-section delivery)
  master_id      TEXT,                -- selected master (FK master_library)
  selections_json TEXT,               -- step-3 choices (stylepack/units/delivery)
  status         TEXT DEFAULT 'intake', -- 'intake'|'ready'|'running'|'rendered'|'approved'
  params_json    TEXT,                -- program/codes/sustainability (pipeline intake)
  delivery_kind  TEXT DEFAULT 'single-section', -- 'single-section' | 'project-manual'
  manual_status  TEXT,                -- 'outline'|'running'|'coordinating'|'assembled'|'approved'|'superseded'
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_user ON project (user_email);

-- === Raw intake uploads ======================================================
CREATE TABLE IF NOT EXISTS project_input (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT,
  kind         TEXT,                  -- 'finish-schedule'|'bim-ifc'|'drawings'|'program'|'standards'|'ref-spec'
  filename     TEXT,
  r2_key       TEXT,
  sha256       TEXT,
  parse_status TEXT DEFAULT 'pending' -- 'pending'|'parsed'|'rejected'
);
CREATE INDEX IF NOT EXISTS idx_project_input ON project_input (project_id);

-- === The normalized intake model, user-confirmed at Gate 0 ===================
CREATE TABLE IF NOT EXISTS extracted_project_data (
  project_id TEXT PRIMARY KEY,
  data_json  TEXT,
  confirmed  INTEGER DEFAULT 0        -- Gate 0: pipeline cannot run until confirmed = 1
);

-- === Master library — the corpus a run drafts from ===========================
CREATE TABLE IF NOT EXISTS master_library (
  master_id  TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,           -- 'system' (built-in) | <org id> (firm-uploaded)
  name       TEXT,
  mode       TEXT,
  namespace  TEXT NOT NULL,           -- Vectorize namespace: 'ufgs' | 'master:<owner>:<id>'
  r2_prefix  TEXT,
  status     TEXT DEFAULT 'ready',    -- 'processing'|'ready'
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_master_owner ON master_library (owner, mode);

-- === Comparison (permanently QUARANTINED, G-CMP-1) ===========================
-- The uploaded in-house spec is scoring/display only — never embedded,
-- retrieved, or placed in any agent prompt.
CREATE TABLE IF NOT EXISTS comparison (
  cmp_id            TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  reference_r2_key  TEXT NOT NULL,    -- QUARANTINED path; never embedded
  reference_sha256  TEXT,
  corpus_provenance TEXT,
  scope             TEXT DEFAULT 'section', -- 'section' | 'manual'
  status            TEXT              -- 'uploaded'|'scored'|'error'
);
CREATE INDEX IF NOT EXISTS idx_comparison_project ON comparison (project_id);
CREATE TABLE IF NOT EXISTS comparison_score (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  cmp_id           TEXT,
  section          TEXT,              -- NULL = manual-scope rollup row
  dimension        TEXT,
  ai_value         TEXT,
  ref_value        TEXT,
  verdict          TEXT,              -- 'match'|'ai-stronger'|'ref-stronger'|'divergent'
  divergence_class TEXT,              -- 'genuine-miss'|'defensible-choice'|'n/a'
  traceability_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_comparison_score ON comparison_score (cmp_id);
CREATE TABLE IF NOT EXISTS comparison_section (
  id                      TEXT PRIMARY KEY,
  cmp_id                  TEXT NOT NULL,
  ref_section             TEXT,
  ref_segment_r2_key      TEXT NOT NULL, -- QUARANTINED segment path; never embedded
  matched_project_section TEXT,
  alignment               TEXT,       -- 'matched' | 'reference-only' | 'ours-only'
  alignment_confidence    REAL,
  title                   TEXT
);
CREATE INDEX IF NOT EXISTS idx_comparison_section ON comparison_section (cmp_id);

-- === Traceability (every resolved decision -> its source) — G6 ===============
-- The real read-and-display source for submittal/reference/resolution data.
CREATE TABLE IF NOT EXISTS traceability (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT,
  section       TEXT,
  element       TEXT,
  decision      TEXT,
  source_type   TEXT,
  source_ref    TEXT,
  confidence    REAL,
  -- which authority resolved this: 'project-data' | 'ufc-criteria' | 'ufgs-default' (G13)
  basis         TEXT,
  -- labeled confidence tier ('high'|'medium-ufgs-default'|'low-no-ufc') — the
  -- honest category; `confidence` (REAL) is only a coarse ordering heuristic.
  confidence_tier TEXT,
  -- the human-verifiable justification: names the literal extracted value that
  -- drove the decision and why it implies `decision` (distinct from source_ref).
  justification TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trace_project ON traceability (project_id, section);
-- Idempotency for at-least-once Workflow step retries (INSERT OR IGNORE).
CREATE UNIQUE INDEX IF NOT EXISTS ux_trace
  ON traceability (project_id, section, element, decision, source_type, source_ref);

-- ============================================================================
-- Approved-for-seal — never a real seal, never a signing key (G8).
-- One write path (the unified pipeline), not two.
-- ============================================================================
CREATE TABLE IF NOT EXISTS seal_package (
  spid         TEXT PRIMARY KEY,
  project_id   TEXT, section TEXT,      -- section NULLABLE for scope='manual'
  scope        TEXT DEFAULT 'section',  -- 'section' | 'manual'
  sections_json TEXT,
  pdf_r2_key   TEXT, docx_r2_key TEXT, zip_r2_key TEXT,
  content_hash TEXT NOT NULL,          -- SHA-256 of the frozen PDF
  frozen_at    TEXT NOT NULL,
  attested_by  TEXT, attested_at TEXT,
  license_no   TEXT, license_exp TEXT,
  status       TEXT NOT NULL           -- 'frozen' | 'approved_for_seal' | 'superseded'
);

CREATE TABLE IF NOT EXISTS review_evidence (   -- the responsible-control record
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT, section TEXT,
  spid        TEXT,                     -- NULLABLE: gates 1-4 run BEFORE any freeze
  gate        TEXT,
  element     TEXT,
  action      TEXT,                     -- 'accept'|'reject'|'edit'|'clear-flag'|'confirm'|...
  before_val  TEXT, after_val TEXT,
  user_id     TEXT, at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evidence ON review_evidence (project_id, section);
CREATE UNIQUE INDEX IF NOT EXISTS ux_evidence
  ON review_evidence (project_id, section, gate, element, action, user_id, at);

CREATE TABLE IF NOT EXISTS build_manifest (
  spid                   TEXT PRIMARY KEY,
  corpus_version         TEXT, model_config_json TEXT,
  prompt_version         TEXT, criteria_editions_json TEXT,
  guardrail_results_json TEXT
);

-- ============================================================================
-- Project Manual — assembly + whole-manual compare. Manual scope is
-- orchestration/data, never a per-section agent branch.
-- ============================================================================
CREATE TABLE IF NOT EXISTS manual_section (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  section       TEXT NOT NULL,
  title         TEXT,
  division      TEXT,                   -- derived '00'..'49'
  order_index   INTEGER NOT NULL,
  role          TEXT NOT NULL,          -- 'front-end' | 'div01' | 'technical'
  drafting_mode TEXT NOT NULL,          -- 'draft' | 'include' | 'outline'
  master_id     TEXT,
  locked_doc_id TEXT,                   -- FK locked_docs (role='front-end')
  run_id        TEXT,
  status        TEXT DEFAULT 'pending'  -- 'pending'|'drafted'|'validated'|'coordinated'|'complete'|'error'
);
CREATE INDEX IF NOT EXISTS idx_manual_section ON manual_section (project_id, order_index);

CREATE TABLE IF NOT EXISTS manual_coordination_flag (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  kind       TEXT,                       -- 'ref-edition-conflict'|'scope-gap'|'scope-overlap'|
                                         -- 'submittal-mismatch'|'div01-vs-gc'|'toc-integrity'|
                                         -- 'seal-coverage-gap'
  detail     TEXT,
  sections   TEXT,                       -- JSON array of involved section numbers
  severity   TEXT,
  status     TEXT DEFAULT 'open'         -- 'open'|'resolved'
);
CREATE INDEX IF NOT EXISTS idx_manual_coord ON manual_coordination_flag (project_id);

CREATE TABLE IF NOT EXISTS manual_assembly (
  project_id   TEXT PRIMARY KEY,
  toc_json     TEXT,                     -- ordered [{ section, title, pageCount }]
  docx_r2_key  TEXT,
  pdf_r2_key   TEXT,
  content_hash TEXT,                     -- SHA-256 of frozen manual PDF
  assembled_at TEXT
);

-- Manual-level DoD cover/title-page metadata. DISPLAY-ONLY: nothing in the
-- generation pipeline reads this; the Assembler's cover template reads it at
-- assemble time. A manual generated before these are filled is still valid —
-- the cover renders honest labeled blanks until then (G13).
CREATE TABLE IF NOT EXISTS manual_cover_meta (
  project_id            TEXT PRIMARY KEY,
  project_title         TEXT,
  installation_location TEXT,
  solicitation_no       TEXT,            -- also the addenda correlator (future work)
  preparing_firm        TEXT,
  design_district       TEXT,
  dod_component         TEXT,
  issue_date            TEXT,
  updated_at            TEXT,
  updated_by            TEXT
);

-- ============================================================================
-- Corpus presence + provenance/staleness ledger. Both are controlled lists
-- (G11/G12): a run's outline sizing and citations resolve ONLY through these
-- tables — never model inference.
-- ============================================================================
CREATE TABLE IF NOT EXISTS ufgs_corpus_section (
  section        TEXT PRIMARY KEY,        -- '09 90 00' (or a '.00 NN' agency variant)
  title          TEXT,
  r2_key         TEXT NOT NULL,           -- source UFGS section file
  vectorize_ns   TEXT NOT NULL,           -- 'ufgs'
  source_edition TEXT NOT NULL,           -- UFGS Master quarter, e.g. '2026-Q2'
  ingested_at    TEXT NOT NULL,
  embedded       INTEGER DEFAULT 0        -- 1 once title+PART 1 scope is in the `ufgs` namespace
);

-- G12: every ref_list/sub_list/criteria/UFGS row must trace to a row here.
CREATE TABLE IF NOT EXISTS corpus_source (
  source_id            TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,      -- 'UFGS-MASTER'|'UMRL'|'UMSL'|'UFC'
  identifier           TEXT NOT NULL,
  edition              TEXT NOT NULL,
  ingested_at          TEXT NOT NULL,
  checked_at           TEXT,
  latest_known_edition TEXT,
  stale                INTEGER DEFAULT 0,
  r2_key               TEXT,
  criterion_id         TEXT                -- UFC criterion UUID captured at ingest (staleness Cron)
);
CREATE INDEX IF NOT EXISTS idx_corpus_source_kind ON corpus_source (kind, identifier);

-- ============================================================================
-- People, roles, and assignments (multi-user Project Manual). MANY-TO-MANY
-- joins so multi-role / multi-assignee / multi-division never force a migration.
-- ============================================================================
-- Assignable roles, seeded as DATA (db/seed-roles.sql). Tier 1 = sealing
-- (discipline seal covers a division scope); Tier 2 = production.
CREATE TABLE IF NOT EXISTS manual_role (
  role_id                TEXT PRIMARY KEY,
  label                  TEXT NOT NULL,
  is_sealing_role        INTEGER NOT NULL DEFAULT 0,   -- 1 = Tier 1 sealing role
  tier                   INTEGER NOT NULL,             -- 1 (sealing) | 2 (production)
  default_division_scope TEXT,                         -- JSON array of '03','22',... (nullable)
  sort_order             INTEGER
);

-- project × person × role. Unique only on the exact triple (prevents duplicate
-- rows, NOT multi-role/multi-holder). Drives per-discipline seal pages.
CREATE TABLE IF NOT EXISTS manual_assignment (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,                        -- FK app_user(email)
  role_id        TEXT NOT NULL,
  division_scope TEXT,                                 -- JSON array; NULL -> role default
  assigned_at    TEXT,
  assigned_by    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_manual_assignment ON manual_assignment (project_id, user_id, role_id);
CREATE INDEX IF NOT EXISTS idx_manual_assignment_project ON manual_assignment (project_id);
CREATE INDEX IF NOT EXISTS idx_manual_assignment_user ON manual_assignment (user_id);

-- Section-level assignment. Keyed by (project_id, section) so it survives an
-- outline replace/reseed. Drives "Assigned to me" / Needs-Attention scoping.
CREATE TABLE IF NOT EXISTS manual_section_assignee (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  section     TEXT NOT NULL,
  user_id     TEXT NOT NULL,                           -- FK app_user(email)
  assigned_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_manual_section_assignee ON manual_section_assignee (project_id, section, user_id);
CREATE INDEX IF NOT EXISTS idx_manual_section_assignee_project ON manual_section_assignee (project_id);
CREATE INDEX IF NOT EXISTS idx_manual_section_assignee_user ON manual_section_assignee (user_id);

-- ============================================================================
-- The mandatory Division 01 checklist (REQUIRED reference data). Every UFGS
-- building-project outline force-includes these regardless of intake features —
-- resolved to a real ufgs_corpus_section where ingested (draft), else
-- reserved/outline (honest, G-MAN). Seeded as DATA (db/seed-div01.sql).
-- ============================================================================
CREATE TABLE IF NOT EXISTS mandatory_div01_section (
  section    TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  sort_order INTEGER
);
