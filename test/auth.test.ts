import { describe, it, expect } from 'vitest';
import { canAccessProject } from '../src/authz';
import { handleAuthRoutes } from '../src/auth';
import { makeTestDb } from './sqlite-d1';
import type { ProjectRow } from '../src/db/projects';
import type { Env } from '../src/env';

const proj = (userEmail: string | null): ProjectRow => ({
  projectId: 'p1', orgId: 'org-demo', userEmail, name: 'P', agency: 'ARMY',
  section: null, masterId: null, selectionsJson: null, status: 'intake',
});

describe('canAccessProject (authz choke point)', () => {
  it('shares an unowned (anonymous/demo) project with anyone', () => {
    expect(canAccessProject(proj(null), null)).toBe(true);
    expect(canAccessProject(proj(null), { email: 'a@x', name: 'A' })).toBe(true);
  });
  it('restricts an owned project to its owner', () => {
    expect(canAccessProject(proj('owner@x'), { email: 'owner@x', name: 'O' })).toBe(true);
    expect(canAccessProject(proj('owner@x'), { email: 'other@x', name: 'X' })).toBe(false);
    expect(canAccessProject(proj('owner@x'), null)).toBe(false);
  });
});

describe('/auth/config dev-login gating', () => {
  it('offers dev login only when Google is unconfigured AND ALLOW_DEV_LOGIN=true', async () => {
    const { env } = makeTestDb();
    const dev = { ...env, ALLOW_DEV_LOGIN: 'true' } as unknown as Env;
    const res = await handleAuthRoutes(new Request('https://x/auth/config'), dev, new URL('https://x/auth/config'));
    const body = await res!.json() as any;
    expect(body.googleConfigured).toBe(false);
    expect(body.devLoginAvailable).toBe(true);
  });

  it('disables dev login once Google is configured', async () => {
    const { env } = makeTestDb();
    const prod = { ...env, ALLOW_DEV_LOGIN: 'true', GOOGLE_CLIENT_ID: 'real-client-id.apps.googleusercontent.com' } as unknown as Env;
    const res = await handleAuthRoutes(new Request('https://x/auth/config'), prod, new URL('https://x/auth/config'));
    const body = await res!.json() as any;
    expect(body.googleConfigured).toBe(true);
    expect(body.devLoginAvailable).toBe(false);
  });

  it('refuses POST /auth/session when Google is configured (no dev bypass in prod)', async () => {
    const { env } = makeTestDb();
    const prod = { ...env, GOOGLE_CLIENT_ID: 'real-client-id.apps.googleusercontent.com' } as unknown as Env;
    const res = await handleAuthRoutes(
      new Request('https://x/auth/session', { method: 'POST', body: JSON.stringify({ email: 'a@x', name: 'A' }) }),
      prod,
      new URL('https://x/auth/session'),
    );
    expect(res!.status).toBe(403); // dev-login bypass refused in prod
  });
});
