-- ============================================================================
-- D1 schema RESET — DESTRUCTIVE. Drops every table so a subsequent
-- `db/schema.sql` re-run recreates them with current definitions (to pick up a
-- column change on an already-migrated local DB).
--
-- LOCAL DEV ONLY. `db/schema.sql` is intentionally NON-destructive so it is safe
-- on remote/production. NEVER run this with --remote. Chained by `npm run
-- db:reset` (reset -> schema -> seeds).
-- ============================================================================
DROP TABLE IF EXISTS ref_list;
DROP TABLE IF EXISTS sub_list;
DROP TABLE IF EXISTS product_library;
DROP TABLE IF EXISTS criteria;
DROP TABLE IF EXISTS locked_docs;
DROP TABLE IF EXISTS app_user;
DROP TABLE IF EXISTS project;
DROP TABLE IF EXISTS project_input;
DROP TABLE IF EXISTS extracted_project_data;
DROP TABLE IF EXISTS master_library;
DROP TABLE IF EXISTS comparison;
DROP TABLE IF EXISTS comparison_score;
DROP TABLE IF EXISTS comparison_section;
DROP TABLE IF EXISTS traceability;
DROP TABLE IF EXISTS seal_package;
DROP TABLE IF EXISTS review_evidence;
DROP TABLE IF EXISTS build_manifest;
DROP TABLE IF EXISTS manual_section;
DROP TABLE IF EXISTS manual_coordination_flag;
DROP TABLE IF EXISTS manual_assembly;
DROP TABLE IF EXISTS manual_cover_meta;
DROP TABLE IF EXISTS ufgs_corpus_section;
DROP TABLE IF EXISTS corpus_source;
DROP TABLE IF EXISTS manual_role;
DROP TABLE IF EXISTS manual_assignment;
DROP TABLE IF EXISTS manual_section_assignee;
DROP TABLE IF EXISTS mandatory_div01_section;
-- Legacy names from the prior POC (harmless if absent).
DROP TABLE IF EXISTS organization;
DROP TABLE IF EXISTS submittal_register;
DROP TABLE IF EXISTS ref_umrl;
DROP TABLE IF EXISTS sub_umsl;
