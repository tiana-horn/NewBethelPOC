// Embeddings agent. Produces vectors for Vectorize indexing/query (§8). When
// USE_AI=false there is no embedding model available, so it returns empty
// vectors and the Drafter falls back to the local corpus — the demo never
// depends on live inference. When USE_AI=true it embeds via the pinned model
// through AI Gateway.

import type { Env } from '../env';
import { aiEnabled } from '../shared/ai';
import type { ModeContext } from '../shared/types';
import type { EmbedInput, EmbedOutput } from './contracts';

export async function run(env: Env, ctx: ModeContext, input: EmbedInput): Promise<EmbedOutput> {
  if (!aiEnabled(env) || input.texts.length === 0) return { vectors: [] };
  const model = ctx.modelBindings.embeddings;
  const res: any = await (env.AI as any).run(
    model,
    { text: input.texts },
    { gateway: { id: env.AI_GATEWAY_ID } },
  );
  const vectors: number[][] = res?.data ?? [];
  return { vectors };
}
