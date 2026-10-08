// Authentication (Rev A) — Google sign-in with a dev/placeholder fallback.
// Credentials (GOOGLE_CLIENT_ID/SECRET, GOOGLE_REDIRECT_URI) are PLACEHOLDERS;
// wire real secrets before production. When Google is not configured, POST
// /auth/session accepts an email + name so the app is usable now and projects can
// still be attributed to a signed-in user. Sessions live in KV keyed by an opaque
// cookie; the user record lives in D1 (app_user).

import type { Env } from './env';
import { upsertUser } from './db/projects';

export interface User {
  email: string;
  name: string;
}

const COOKIE = 'sp_session';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

// Secure: the deployed Worker is HTTPS-only, so the session cookie is never emitted
// over plaintext there (CHANGE-07 §1.3). But `Secure` cookies are dropped by the
// browser over `http://localhost` (`wrangler dev`), which would silently log the
// developer out and 403 every owner-scoped project. So gate `Secure` on the actual
// request scheme: hardened in production, functional in local dev.
function isSecureReq(url: URL): boolean {
  return url.protocol === 'https:';
}
function cookieHeader(id: string, secure: boolean): string {
  // SameSite=Lax + HttpOnly retained in all environments.
  return `${COOKIE}=${id}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${SESSION_TTL}`;
}

// The OAuth callback URL. In local dev (http://localhost) ALWAYS round-trip back to
// THIS origin, ignoring a configured production `GOOGLE_REDIRECT_URI` — otherwise
// signing in locally bounces the developer to the production site. In production
// (HTTPS) the configured URI wins, falling back to the request origin.
function googleRedirectUri(env: Env, url: URL): string {
  if (!isSecureReq(url)) return `${url.origin}/auth/google/callback`;
  return env.GOOGLE_REDIRECT_URI || `${url.origin}/auth/google/callback`;
}

// Dev/placeholder email login is a startup convenience — it must be UNREACHABLE in
// production. It is permitted only when real OAuth is NOT configured AND an explicit
// .dev.vars flag opts in. A deployed env (Google configured, or the flag unset) 403s.
function devLoginAllowed(env: Env, googleConfigured: boolean): boolean {
  return !googleConfigured && String(env.ALLOW_DEV_LOGIN).toLowerCase() === 'true';
}
function readCookie(req: Request): string | null {
  const raw = req.headers.get('cookie') ?? '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

async function createSession(env: Env, user: User): Promise<string> {
  const id = crypto.randomUUID();
  await upsertUser(env.DB, user.email, user.name);
  await env.KV.put(`session:${id}`, JSON.stringify(user), { expirationTtl: SESSION_TTL });
  return id;
}

export async function getUser(env: Env, req: Request): Promise<User | null> {
  const id = readCookie(req);
  if (!id) return null;
  const raw = await env.KV.get(`session:${id}`);
  return raw ? (JSON.parse(raw) as User) : null;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...headers },
  });

export async function handleAuthRoutes(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const googleConfigured = !!(env.GOOGLE_CLIENT_ID && !env.GOOGLE_CLIENT_ID.startsWith('PLACEHOLDER'));

  if (path === '/auth/config' && req.method === 'GET') {
    return json({
      googleConfigured,
      clientId: googleConfigured ? env.GOOGLE_CLIENT_ID : null,
      devLoginAvailable: devLoginAllowed(env, googleConfigured),
    });
  }

  if (path === '/auth/me' && req.method === 'GET') {
    const user = await getUser(env, req);
    return json({ user });
  }

  if (path === '/auth/logout' && req.method === 'POST') {
    const id = readCookie(req);
    if (id) await env.KV.delete(`session:${id}`);
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly;${isSecureReq(url) ? ' Secure;' : ''} Max-Age=0` });
  }

  // Real Google flow (only when configured).
  if (path === '/auth/google/start' && req.method === 'GET') {
    if (!googleConfigured) return json({ error: 'google-not-configured', useDevLogin: true }, 400);
    const redirect = googleRedirectUri(env, url);
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!);
    authUrl.searchParams.set('redirect_uri', redirect);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('access_type', 'offline');
    return Response.redirect(authUrl.toString(), 302);
  }

  if (path === '/auth/google/callback' && req.method === 'GET') {
    if (!googleConfigured) return json({ error: 'google-not-configured' }, 400);
    const code = url.searchParams.get('code');
    if (!code) return json({ error: 'missing code' }, 400);
    try {
      const redirect = googleRedirectUri(env, url);
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID!,
          client_secret: env.GOOGLE_CLIENT_SECRET || '',
          redirect_uri: redirect,
          grant_type: 'authorization_code',
        }),
      });
      const tok = (await tokenRes.json()) as { access_token?: string };
      if (!tok.access_token) return json({ error: 'token exchange failed' }, 400);
      const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { authorization: `Bearer ${tok.access_token}` },
      });
      const info = (await infoRes.json()) as { email?: string; name?: string };
      if (!info.email) return json({ error: 'no email from Google' }, 400);
      const sid = await createSession(env, { email: info.email, name: info.name || info.email });
      return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': cookieHeader(sid, isSecureReq(url)) } });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // Dev / placeholder session — the "credentials provided later" path. Accepts an
  // email + name and signs the user in. This is the same session mechanism Google
  // uses; only the identity source differs.
  if (path === '/auth/session' && req.method === 'POST') {
    // CHANGE-07 §1.1 — hard gate: this route is an auth bypass if reachable in prod.
    if (!devLoginAllowed(env, googleConfigured))
      return json({ error: 'dev login is disabled in this environment; use Google sign-in' }, 403);
    const body = (await req.json().catch(() => ({}))) as { email?: string; name?: string };
    const email = (body.email || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'valid email required' }, 400);
    const name = (body.name || email.split('@')[0]).trim();
    const sid = await createSession(env, { email, name });
    return json({ ok: true, user: { email, name } }, 200, { 'set-cookie': cookieHeader(sid, isSecureReq(url)) });
  }

  return null;
}
