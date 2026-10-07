-- ============================================================================
-- CHANGE-09 Stage 3 — the mandatory Division 01 checklist (REQUIRED reference
-- data, not illustrative).
--
-- Kept in its OWN file (separate from db/seed.sql, which DELETEs project-scoped
-- rows) so it can be reseeded on every deploy the way db/seed-roles.sql is —
-- WITHOUT wiping project data. Idempotent via INSERT OR REPLACE. Loaded locally
-- by `npm run db:seed:div01` (chained into `db:reset`) and remotely by CD.
--
-- Every UFGS building-project outline force-includes these Division 01 General
-- Requirements sections REGARDLESS of intake features (they are required by
-- rule, not implied by building features — CHANGE-09 §3). Each is resolved
-- against `ufgs_corpus_section` at outline time: drafted where a real SEC file
-- is ingested, else honestly reserved (outline/G-MAN) — never invented.
-- Section numbers + titles are the real UFGS master numbering (bare tri-service
-- form; an ingested `.00 NN` agency-tailored variant is preferred automatically
-- by the agency-suffix resolver, CHANGE-09 §2, when one exists instead).
-- ============================================================================
INSERT OR REPLACE INTO mandatory_div01_section (section, title, sort_order) VALUES
  ('01 11 00', 'Summary of Work',                     1),
  ('01 20 00', 'Price and Payment Procedures',         2),
  ('01 30 00', 'Administrative Requirements',          3),
  ('01 32 00', 'Construction Progress Documentation',  4),
  ('01 33 00', 'Submittal Procedures',                 5),
  ('01 45 00', 'Quality Control',                      6),
  ('01 50 00', 'Temporary Facilities and Controls',    7),
  ('01 57 19', 'Temporary Environmental Controls',     8),
  ('01 60 00', 'Product Requirements',                 9),
  ('01 70 00', 'Execution and Closeout Requirements', 10),
  ('01 78 00', 'Closeout Submittals',                 11);
