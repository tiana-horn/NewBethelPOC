// LLM access, always through AI Gateway. Two modes:
//   USE_AI=false (local/test default, and a valid prod mode) -> aiEnabled() is
//     false; agents use deterministic drafting/matching so runs are reproducible
//     with no inference cost or account auth.
//   USE_AI=true -> runModel() calls Workers AI via AI Gateway, using the model id
//     pinned per-agent in the KV mode profile (ctx.modelBindings).
//
// The guardrails (validate-don't-generate, locked spans, D1 lookups) are
// deterministic code and do NOT depend on the model. The model only drafts prose
// hints and matching *suggestions*; authority always comes from D1.

import type { Env } from '../env';
import type { AgentName, ModeContext } from './types';

export function aiEnabled(env: Env): boolean {
  return String(env.USE_AI).toLowerCase() === 'true';
}

export interface RunModelArgs {
  system?: string;
  prompt: string;
  schema?: Record<string, unknown>; // JSON-Schema-constrained structured output
  maxTokens?: number;
}

// Returns parsed JSON when a schema is given, else raw text. Throws if AI is
// disabled — callers must gate on aiEnabled() and provide a deterministic path.
export async function runModel(
  env: Env,
  agent: AgentName,
  ctx: ModeContext,
  args: RunModelArgs,
): Promise<unknown> {
  if (!aiEnabled(env)) throw new Error('runModel called while USE_AI=false');
  const model = ctx.modelBindings[agent];
  if (!model) throw new Error(`no model pinned for agent '${agent}'`);

  const messages = [
    ...(args.system ? [{ role: 'system', content: args.system }] : []),
    { role: 'user', content: args.prompt },
  ];

  const input: Record<string, unknown> = { messages, max_tokens: args.maxTokens ?? 2048 };
  if (args.schema) {
    input.response_format = { type: 'json_schema', json_schema: args.schema };
  }

  // AI Gateway: caching, rate limiting, retries, observability. Session affinity
  // enables prefix caching across the agent pipeline.
  const res: any = await (env.AI as any).run(model, input, {
    gateway: { id: env.AI_GATEWAY_ID, skipCache: false },
  });

  const text: string = res?.response ?? res?.result?.response ?? '';
  if (!args.schema) return text;
  try {
    return typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error('model did not return schema-valid JSON');
  }
}
