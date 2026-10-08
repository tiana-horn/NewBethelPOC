// Worker entrypoint — class exports back the durable_objects / workflows /
// containers bindings in wrangler.jsonc, and the fetch/scheduled handlers. The
// full HTTP router is wired in M12; for now fetch serves health + the static SPA
// and scheduled() runs the quarterly corpus staleness sweep (G11).

export type { Env } from './env';
import type { Env } from './env';
import { sweepCorpusStaleness } from './corpus/staleness-cron';

// The real pipeline classes (one pipeline — no SpecWorkflow/SessionDO).
export { ManualDO } from './manual/manual-do';
export { ManualWorkflow } from './manual/manual-workflow';
export { RenderContainer } from './render-container';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, useAi: env.USE_AI === 'true' });
    }
    // Everything else falls through to the static SPA until the router lands (M12).
    return env.ASSETS.fetch(req);
  },

  // Quarterly corpus staleness sweep — flags newer editions for human
  // re-verification; never auto-adopts (G11).
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await sweepCorpusStaleness(env);
  },
};
