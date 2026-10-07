-- ============================================================================
-- CHANGE-08 — assignable roles (REQUIRED reference data, not illustrative).
--
-- Kept in its OWN file (separate from db/seed.sql, which DELETEs project-scoped
-- rows) so it can be reseeded on every deploy the way db/generated/seed-sec-catalog
-- .sql is — WITHOUT wiping project data. Idempotent via INSERT OR REPLACE, so a
-- redeploy is safe and picks up any label/scope edits. Loaded locally by
-- `npm run db:seed:roles` (chained into `db:reset`) and remotely by CD.
--
-- Tier 1 = sealing roles (an EOR/AOR whose discipline seal covers a MasterFormat
-- division scope, is_sealing_role=1). Tier 2 = production roles. The
-- default_division_scope (JSON array of division strings) is the DEFAULT for a new
-- assignment's own overridable scope — it is copied onto the manual_assignment row.
-- ============================================================================
INSERT OR REPLACE INTO manual_role (role_id, label, is_sealing_role, tier, default_division_scope, sort_order) VALUES
  ('architect_of_record',      'Architect of Record',            1, 1, '["01","06","07","08","09","10","12","14"]', 1),
  ('structural_eor',           'Structural Engineer of Record',  1, 1, '["03","04","05","31"]',                     2),
  ('mechanical_eor',           'Mechanical Engineer of Record',  1, 1, '["22","23"]',                               3),
  ('electrical_eor',           'Electrical Engineer of Record',  1, 1, '["26","27","28"]',                          4),
  ('civil_eor',                'Civil Engineer of Record',       1, 1, '["02","31","32","33"]',                     5),
  ('fire_protection_engineer', 'Fire Protection Engineer',       1, 1, '["21","28"]',                               6),
  ('plumbing_engineer',        'Plumbing Engineer',              1, 1, '["22"]',                                    7),
  ('project_manager',          'Project Manager',                0, 2, NULL,                                        8),
  ('specification_writer',     'Specification Writer',           0, 2, NULL,                                        9),
  ('qc_reviewer',              'QA/QC Reviewer',                 0, 2, NULL,                                        10),
  ('discipline_designer',      'Discipline Designer/Drafter',    0, 2, NULL,                                        11);
