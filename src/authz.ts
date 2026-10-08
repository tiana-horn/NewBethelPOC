// Authorization (CHANGE-07 §1.2) — the single choke point for project-scoped
// routes. Authentication (src/auth.ts) answers "who are you"; this answers "may you
// touch THIS project". It is applied ONCE at /project/:id and /project/:id/manual
// dispatch so no individual route can forget it (the class of IDOR the audit found).

import type { ProjectRow } from './db/projects';
import type { User } from './auth';

// A project OWNED by a signed-in user (user_email set) is owner-only. A project with
// no owner (anonymous/demo-org) is intentionally shared — anyone may reach it — but
// an owned project is NEVER exposed to a different user or to an anonymous caller.
export function canAccessProject(proj: ProjectRow, user: User | null): boolean {
  if (!proj.userEmail) return true; // anonymous/demo-org project — shared
  return proj.userEmail === user?.email; // owned — owner only
}
