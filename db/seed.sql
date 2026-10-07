-- ============================================================================
-- ILLUSTRATIVE seed data for the OFFLINE DEMO (USE_AI=false).
--
--   *** NOT AUTHORITATIVE. Designations, editions, criteria clauses, and
--       front-end document bodies below are PLACEHOLDERS and MUST be replaced
--       with verified sources before any non-demo use (G1/G7). ***
--
-- The deliberately-omitted reference (ASTM D3960) and submittal (SD-06) are
-- absent so guardrail G1 (validate, don't generate) can fire on them.
--
-- `npm run db:seed:real` (db/generated/seed-umrl-umsl.sql) SUPERSEDES the
-- UMRL/UMSL rows below with the real parsed lists, so the G1 omission only holds
-- when this file is applied WITHOUT db:seed:real (i.e. `npm run db:seed` alone).
-- This file DELETEs only non-authoritative lookup rows + the built-in master —
-- it NEVER touches project data.
-- ============================================================================

DELETE FROM ref_list;
DELETE FROM sub_list;
DELETE FROM product_library;
DELETE FROM criteria;
DELETE FROM locked_docs;

-- === UMRL — Painting family (illustrative) ===================================
INSERT INTO ref_list (rid, list_id, org, designation, edition_date, title, active) VALUES
  ('rid-astm-d16',   'UMRL', 'ASTM',      'ASTM D16',   '2020', 'Standard Terminology for Paint, Related Coatings, Materials, and Applications', 1),
  ('rid-astm-d4258', 'UMRL', 'ASTM',      'ASTM D4258', '2017', 'Standard Practice for Surface Cleaning Concrete for Coating', 1),
  ('rid-mpi-43',     'UMRL', 'MPI',       'MPI 43',     '2021', 'Interior Latex, Eggshell (Gloss Level 3)', 1),
  ('rid-mpi-54',     'UMRL', 'MPI',       'MPI 54',     '2021', 'Interior Latex, Semi-Gloss (Gloss Level 5)', 1),
  ('rid-sspc-sp1',   'UMRL', 'SSPC-AMPP', 'SSPC-SP 1',  '2015', 'Solvent Cleaning', 1),
  ('rid-sspc-sp3',   'UMRL', 'SSPC-AMPP', 'SSPC-SP 3',  '2018', 'Power Tool Cleaning', 1);
--  ASTM D3960 INTENTIONALLY OMITTED (G1).

-- === UMSL submittals (SD-coded) for 09 90 00 (illustrative) ==================
INSERT INTO sub_list (usid, list_id, section, sd_code, item, default_class, notes) VALUES
  ('usid-sd03-coating', 'UMRL', '09 90 00', 'SD-03', 'Coating Products',           'G', 'Manufacturer product data.'),
  ('usid-sd04-samples', 'UMRL', '09 90 00', 'SD-04', 'Samples',                    'G', 'Two samples per color and sheen.'),
  ('usid-sd07-voc',     'UMRL', '09 90 00', 'SD-07', 'VOC Compliance Certificate', 'S', 'Certificate meeting the VOC limit.');
--  SD-06 Adhesion Test Reports INTENTIONALLY OMITTED (G1).

-- === Criteria clauses (G7 — editions are DATA, never model recall) ===========
-- NOTE: cid-p100-finishes is referenced by the built-in Division 01 fixture
-- (src/corpus/div01-013300.ts); keep it or that draft raises a spurious
-- criteria-not-found. All rows here are ILLUSTRATIVE placeholders.
INSERT INTO criteria (cid, profile, document, edition, clause, text, perf_level) VALUES
  ('cid-p100-finishes', 'ufc', 'UFC (illustrative)', '2024 (ILLUSTRATIVE)', '3.7 Interior Finishes',
     'Interior finishes and coatings performance (illustrative placeholder).', NULL),
  ('cid-p100-voc',      'ufc', 'UFC (illustrative)', '2024 (ILLUSTRATIVE)', '3.7.2 VOC Limits',
     'Baseline: comply with applicable code VOC limits (illustrative placeholder).', NULL),
  ('cid-ufc-fmt',       'ufc', 'UFC 1-300-02', '2023 (ILLUSTRATIVE)', 'Format',
     'Unified Facilities Guide Specifications formatting per UFC 1-300-02.', NULL);

-- === Unalterable Division 00 front-end documents (UFC) — G2 ==================
-- Bodies are ILLUSTRATIVE placeholders in R2 (written by seed-r2) pending the
-- verified federal documents. alterable=0 (A/E may not touch them).
INSERT INTO locked_docs (ldid, profile, title, r2_key, alterable) VALUES
  ('ld-ufc-solicit', 'ufc', 'Solicitation, Offer and Award (SF 1442) and Instructions to Offerors', 'corpus/public/UFC/00-solicitation.txt', 0),
  ('ld-ufc-far',     'ufc', 'Federal Acquisition Regulation (FAR) Contract Clauses', 'corpus/public/UFC/00-far-clauses.txt', 0),
  ('ld-ufc-dfars',   'ufc', 'Defense FAR Supplement (DFARS) Contract Clauses', 'corpus/public/UFC/00-dfars-clauses.txt', 0),
  ('ld-ufc-wage',    'ufc', 'Davis-Bacon Wage Determination (Construction)', 'corpus/public/UFC/00-wage-determination.txt', 0);

-- === Built-in master library (owner = 'system') ==============================
-- Firm-uploaded masters are inserted at runtime by POST /masters (owner = <org>).
DELETE FROM master_library;
INSERT INTO master_library (master_id, owner, name, mode, namespace, r2_prefix, status) VALUES
  ('master-ufgs', 'system', 'UFGS Master', 'UFGS', 'ufgs', 'corpus/ufgs/', 'ready');

-- The assignable roles (manual_role) and mandatory Division 01 checklist
-- (mandatory_div01_section) are REQUIRED reference data in their own idempotent
-- files (db/seed-roles.sql, db/seed-div01.sql), reseeded every deploy without the
-- project-data DELETEs above.
