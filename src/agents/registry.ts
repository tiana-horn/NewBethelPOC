// AgentRegistry — the single dispatch seam for the six sub-agents. Its shape
// deliberately mirrors Worker-to-Worker service-binding RPC (§2.5): each entry
// is `run(env, ctx, input)`. In production each agent is its own Worker and this
// registry is replaced by service bindings (env.DRAFTER.run(ctx, input), ...);
// nothing else in the pipeline changes.

import * as coordinator from './coordinator';
import * as compliance from './compliance';
import * as drafter from './drafter';
import * as embeddings from './embeddings';
import * as resolver from './resolver';
import * as validator from './validator';

export const agents = {
  drafter: drafter.run,
  resolver: resolver.run,
  validator: validator.run,
  coordinator: coordinator.run,
  compliance: compliance.run,
  embeddings: embeddings.run,
} as const;
