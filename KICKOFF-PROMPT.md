# Kickoff prompt for the new repo

Paste everything below the line into Claude Code, opened in the new, empty repo,
after you've copied in `REBUILD-BLUEPRINT.md` and the carried-over files (§14).

---

You are building a project from scratch in this repo. The complete, authoritative
spec is `REBUILD-BLUEPRINT.md` in the repo root — read it in full before writing
any code. It is a clean rearchitecture of a prior proof-of-concept; build the
system it describes, not whatever a prior codebase did.

**Product in one line:** an AI construction-specifications writer for UFGS (U.S.
DoD) Project Manuals, on Cloudflare. It drafts from the real ingested UFGS master
verbatim, resolves brackets deterministically against project data + real UFC
criteria, and assembles a sealable Project Manual. The non-negotiable promise:
nothing issued is invented — every reference, submittal, and criterion traces to
a real ingested row or is flagged for a human. Keep that true at every step.

**Before you start:**
1. Read `REBUILD-BLUEPRINT.md` end to end. Pay special attention to §2
   (rearchitecture decisions — these are the deltas from the old POC and are
   already decided; do not reintroduce the dead code or the two-pipeline split)
   and §7 (the full guardrail contract).
2. Skim the four reference docs carried over into `documents/` (`DATA-MODEL.md`,
   `API-REFERENCE.md`, `PIPELINE-REFERENCE.md`, `GUARDRAILS-REFERENCE.md`). Treat
   them as detailed appendices to the blueprint, BUT apply the §2 deletions as
   you port from them — the blueprint wins wherever they disagree.
3. Confirm which carried-over source files are present (blueprint §14): the
   committed `db/generated/seed-sec-catalog.sql`, and the gitignored source data
   needed for ETL (`documents/UFGS_M/*.SEC`, `scripts/ufc-uuids.json`, the sample
   IFC/COBie intake). Tell me what's missing before relying on it.

**How to work:**
- Follow the build order in blueprint §11 (bottom-up: scaffold → schema+seeds →
  shared core → D1 accessors → agents → mode context → intake → corpus → the
  unified pipeline → render container → auth → router → frontend → CI). Each
  layer must be testable before the next.
- Default to `USE_AI=false` locally — the system must be fully functional and
  deterministic offline. `.dev.vars` sets `USE_AI=false` and
  `ALLOW_DEV_LOGIN=true`.
- Keep `npm run typecheck`, `npm test`, and `wrangler deploy --dry-run` green at
  every milestone. Don't move to the next layer with any of them red.
- Write tests as you go (blueprint §12). Every guardrail in §7 gets at least one
  test, and the unified guardrail harness must throw if any applicable guardrail
  was never evaluated.
- This is a Cloudflare project. Use the `cloudflare`, `wrangler`, and
  `durable-objects` skills when configuring bindings, writing the Worker/Workflow/
  DO code, and running wrangler. Load them before guessing at syntax.
- Commit at each milestone with a clear message.

**Start now by:** reading the blueprint, then proposing a short plan — the first
3–4 milestones you'll tackle, the table list for `db/schema.sql` (should be ~24
tables, with the old repo's `organization` and `submittal_register` omitted per
§2.2/§5), and anything in the blueprint you need me to clarify before you write
code. Don't write code until I confirm the plan.
