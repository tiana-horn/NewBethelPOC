// SCAFFOLD (M1). Minimal Worker so bindings validate (`wrangler deploy
// --dry-run`). The real router, pipeline, and agents arrive in later
// milestones per REBUILD-BLUEPRINT.md §11. The class exports below back the
// durable_objects / workflows bindings declared in wrangler.jsonc.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { DurableObject } from 'cloudflare:workers';
import { Container } from '@cloudflare/containers';

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
  USE_AI: string;
  AI_GATEWAY_ID: string;
  GOOGLE_REDIRECT_URI: string;
  MAIL_FROM: string;
  APP_URL: string;
}

/** Live manual run state + HITL gate decisions. SQLite-backed. */
export class ManualDO extends DurableObject<Env> {
  async fetch(_req: Request): Promise<Response> {
    return new Response('ManualDO scaffold', { status: 501 });
  }
}

/** LibreOffice headless render container — invoked only at freeze. */
export class RenderContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '2m';
}

/** The one pipeline: Outline → fan-out section runs → coordinate → aggregate
 *  → assemble → freeze, with waitForEvent HITL gates. */
export class ManualWorkflow extends WorkflowEntrypoint<Env> {
  async run(_event: WorkflowEvent<unknown>, _step: WorkflowStep): Promise<void> {
    // Implemented in M9.
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, useAi: env.USE_AI === 'true' });
    }
    // Everything else falls through to the static SPA.
    return env.ASSETS.fetch(req);
  },

  async scheduled(_event: ScheduledController, _env: Env): Promise<void> {
    // Quarterly corpus staleness sweep lands in M8.
  },
};
