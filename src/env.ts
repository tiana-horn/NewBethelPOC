// The Worker environment — every binding declared in wrangler.jsonc, plus the
// config vars. Imported by the shared core, the agents, and the router.

export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  DB: D1Database;
  R2: R2Bucket;
  KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  MANUAL: DurableObjectNamespace;
  RENDER: DurableObjectNamespace;
  MANUAL_WORKFLOW: Workflow;

  // Config (non-sensitive — vars). Sensitive values are Cloudflare secrets.
  USE_AI: string; // 'true' | 'false'
  AI_GATEWAY_ID: string;
  GOOGLE_REDIRECT_URI: string;
  MAIL_FROM: string;
  APP_URL: string;

  // Local-only / secrets (optional at type level; absent in prod vars).
  ALLOW_DEV_LOGIN?: string; // '.dev.vars' only — dev login bypass
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  ADMIN_SECRET?: string; // shared secret guarding /admin/* (blueprint §2.4)
}
