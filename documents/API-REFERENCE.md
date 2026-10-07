# API reference

Verified against the actual router code, not any CHANGE-0x doc's endpoint
list. Router entry points: `src/index.ts` (top-level dispatch + `/session`
+ `/project` non-manual routes), `src/manual/endpoints.ts`
(`/project/:id/manual/*`), `src/manual/people-endpoints.ts` (people/roles/
assignments/overview, mounted inside the manual router + `/manuals/saved`
at top level), `src/auth.ts` (`/auth/*`), `src/corpus/admin.ts`
(`/admin/corpus/*`).

All responses are JSON (`content-type: application/json`) except artifact
downloads, which stream the raw bytes with a `content-disposition` header.
CORS is wide open (`access-control-allow-origin: *`) on every route.

## Auth model quick reference

- **No auth required**: `/auth/*`, `/admin/corpus/*` (verified: no auth
  check anywhere in `corpus/admin.ts`, live-confirmed on the deployed
  Worker), `/api/seed-r2`, `/session/*`.
- **Auth required (401 without a session cookie)**: `/project*`,
  `/masters*`, `/projects`, `/manuals*` — enforced once in `src/index.ts`
  before any of those sub-routers run.
- **Per-project authorization** (403 if the caller isn't the owner or an
  assignee): every `/project/:id/*` and `/project/:id/manual/*` route,
  enforced by `src/authz.ts canAccessProject` + (CHANGE-08)
  `src/db/people.ts isUserAssigned`.

---

## `/auth/*` (`src/auth.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/auth/config` | none | `{ googleConfigured, clientId, devLoginAvailable }` |
| GET | `/auth/me` | none | `{ user: {email,name} \| null }` from the session cookie |
| POST | `/auth/logout` | none | clears the session cookie + KV entry |
| GET | `/auth/google/start` | none | 302 to Google OAuth (400 if not configured) |
| GET | `/auth/google/callback` | none | exchanges `code`, creates a session, 302 to `/` |
| POST | `/auth/session` | none, but **403 unless `ALLOW_DEV_LOGIN=true` AND Google unconfigured** | `{email,name}` → dev session (local only) |

## `/session/*` — single-section demo (`src/index.ts`)

No authentication on any of these.

| Method | Path | Purpose |
|---|---|---|
| POST | `/session` | create a session (mode pinned `UFGS`) → `{ sessionId, projectId, mode, section }` |
| POST | `/session/:id/inputs` | set params/schedule/drawings (defaults to `src/fixtures.ts` if omitted) |
| POST | `/session/:id/start` | create the `SpecWorkflow` instance (409 if already running) |
| GET | `/session/:id/state` | poll stage / pending gate |
| GET | `/session/:id/bundle` | the accumulated IR/flags/traces/etc. |
| POST | `/session/:id/stop` \| `/reset` | halt / clear |
| POST | `/session/:id/gate/:gateId` | `gate1`..`gate5` decision (409 if a blocking gate rejects it) |
| GET | `/session/:id/artifact/:kind` | download an artifact (see *Artifact kinds* below) |

## `/project*` and `/masters*` — wizard (`src/index.ts handleProjectRoutes`)

Auth required at the top-level check; per-project authz on every
`/project/:id/*` route below.

| Method | Path | Purpose |
|---|---|---|
| GET | `/masters` | list masters (`system` + caller's own) |
| POST | `/masters` | upload + ingest a firm master (multipart `file`) |
| POST | `/project` | create a project `{ name?, orgId?, agency? }` → mode pinned `UFGS` |
| GET | `/projects` | list projects for the caller's org/user |
| POST | `/project/:id/inputs` | upload raw intake files (multipart, one field per kind) |
| POST | `/project/:id/parse` | parse stored inputs → `ExtractedProjectData` (unconfirmed) |
| GET | `/project/:id/extracted` | the extracted data + confirmation status |
| POST | `/project/:id/extracted/confirm` | **Gate 0** — blocks if a required input kind never parsed |
| GET | `/project/:id/required-inputs` | the required-inputs manifest for this project's mode |
| POST | `/project/:id/selections` | step-3 choices (master, style pack, units, delivery) — mode/publicProfile are immutable after creation (409 if changed) |
| POST | `/project/:id/run` | start the single-section `SpecWorkflow` (409 if Gate 0 unconfirmed or already running) |
| POST | `/project/:id/stop` \| `/reset` \| `/restart` | run control |
| GET | `/project/:id/state` \| `/bundle` | run state / bundle |
| POST | `/project/:id/gate/:gateId` | `gate1`..`gate5` |
| GET | `/project/:id/artifact/:kind` | download |
| POST | `/project/:id/comparison` | upload a reference spec for scoring (only after approval; quarantined) |
| GET | `/project/:id/comparison` | latest comparison result |

## `/manuals/saved` (top level, `src/index.ts` → `people-endpoints.ts`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/manuals/saved` | every manual the caller created or is assigned to (CHANGE-08) |

## `/project/:id/manual/*` — Project Manual (`src/manual/endpoints.ts`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/outline` | current confirmed outline (empty if unconfirmed) |
| GET | `/outline/proposed` | computed candidate outline (SEC-catalog match + mandatory Div 01) |
| POST | `/outline` | **Gate M0** — confirm the outline (409 on duplicate section numbers) |
| GET \| POST | `/cover-meta` | manual-level DoD cover metadata (CHANGE-09, display-only) |
| POST | `/run` | start `ManualWorkflow` (body: `{ email? }` for the ready-notification) |
| POST | `/stop` \| `/reset` \| `/restart` | run control |
| GET | `/state` | live status / pending gate / per-section status |
| GET | `/coordination` | cross-section flags + per-section status |
| GET | `/section/:sec` | one section's drafted IR + flags + references + register + traces |
| POST | `/section/:sec/resolve` | per-section resolution (re-enterable review workspace, CHANGE-08 §6) |
| GET | `/decisions` | book-scope aggregated open decisions (feeds Gate M-DECIDE) |
| POST | `/gate/:gateId` | `M-DECIDE` \| `M-COORD` \| `gate5` |
| GET | `/artifact/:kind` | `docx`\|`pdf`\|`seal-package` (binary) or `toc`\|`references`\|`submittal-register`\|`coordination`\|`compliance` (JSON) |
| POST | `/comparison` | whole-manual quarantined compare upload |
| GET | `/comparison` | latest whole-manual comparison |
| POST | `/comparison/align` | nudge a comparison alignment row |

### People / roles / assignments (`src/manual/people-endpoints.ts`, mounted under the same `/project/:id/manual/*` prefix)

| Method | Path | Purpose |
|---|---|---|
| GET | `/overview` | the rebuilt Project Manual page derive: tiles, filter, 10-per-page pagination, division grouping, Needs-Attention (CHANGE-08 §3/§4) |
| GET | `/roles` | assignable roles (`manual_role`) |
| GET | `/users` | the app-user directory (for the assign picker) |
| GET | `/assignments` | current role assignments on this manual |
| POST | `/assignments` | assign a person to a role `{ userId, roleId, divisionScope? }` |
| POST | `/assignments/scope` | change one assignment's division scope |
| POST | `/assignments/remove` | remove an assignment |
| GET | `/section-assignees` | current per-section assignees |
| POST | `/section-assignees` | assign a person to a section |
| POST | `/section-assignees/remove` | unassign |

## `/admin/corpus/*` — corpus ETL (`src/corpus/admin.ts`) — **no auth**

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/corpus/staleness` | all `corpus_source` rows + which are stale |
| POST | `/admin/corpus/staleness/sweep` | manually trigger the staleness sweep (normally Cron-driven) |
| POST | `/admin/corpus/:sourceId/reverify` | re-check one source against its live edition |
| POST | `/admin/corpus/ufgs-section` | ingest one `.SEC` file |
| POST | `/admin/corpus/ufgs-bulk` | bulk-ingest `.SEC` files (used by `scripts/etl-ufgs-corpus.ts`) |
| POST | `/admin/corpus/umrl` | load parsed UMRL rows |
| POST | `/admin/corpus/umsl` | load parsed UMSL rows |
| POST | `/admin/corpus/criteria` | load agency-manual criteria rows |
| POST | `/admin/corpus/ufc-criteria` | load real UFC criteria (from `scripts/etl-ufc-criteria.ts`) |

## Misc

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/seed-r2` | none | seed corpora/style-pack placeholders into R2 |
| * | anything else | — | falls through to the static SPA (`env.ASSETS.fetch`) |

## Artifact kinds

Single-section (`/session` and `/project` non-manual): `section-ir`,
`specsintact-xml`, `docx`, `pdf`, `submittal-register-csv`, `references-csv`,
`resolution-log`, `criteria-matrix`, `division01-report`,
`coordination-flags`, `compliance-report`, `traceability-csv`,
`seal-package` — gated by the mode profile's `artifactSet`
(`src/mode/profiles.ts`).

Manual (`/project/:id/manual/artifact/:kind`): `docx`, `pdf`,
`seal-package` (binary, streamed from R2), `toc`, `references`,
`submittal-register`, `coordination`, `compliance` (JSON projections of the
live bundle).
