// Build the ModeContext (§2.2 + CHANGE-01) — created once per session from the
// mode selection and threaded through every agent call. Profiles live in KV; we
// self-seed from compiled defaults on first use. Mode C keys the profile by
// `PUBLIC_SECTOR:<publicProfile>`. This is the ONLY place mode selection is
// interpreted.

import type { Env } from '../env';
import type { AgentName, Mode, ModeContext } from '../shared/types';
import { DEFAULT_MODEL_CONFIG, DEFAULT_PROFILES, type ModeProfile } from './profiles';

const KV_PROFILE = (key: string) => `mode_profile:${key}`;
const KV_MODEL_CONFIG = 'model_config';

export interface ModeSelections {
  agency?: ModeContext['agency'];
  delivery?: ModeContext['delivery'];
  // CHANGE-02 — step-3 wizard selections that further shape the context.
  stylePackId?: string; // overrides the mode default style pack
  units?: 'imperial' | 'dual';
  // Selected master (CHANGE-02 §3): its Vectorize namespace becomes the run's
  // retrievalNamespace, and its owner is recorded as corpus provenance.
  masterId?: string;
  masterOwner?: string;
  masterNamespace?: string;
}

async function loadProfile(env: Env, key: string): Promise<ModeProfile> {
  const def = DEFAULT_PROFILES[key];
  if (!def) throw new Error(`no mode profile for '${key}'`);
  const raw = await env.KV.get(KV_PROFILE(key));
  if (raw) {
    // Backfill any keys the cached KV profile is missing from the compiled
    // default. A profile seeded before a new field was added (e.g. stylePackId)
    // would otherwise return that field as `undefined` forever — which surfaced
    // as "Style Pack: undefined" on the manual cover. KV edits still win for keys
    // it does define; the compiled default only fills the gaps.
    return { ...def, ...(JSON.parse(raw) as Partial<ModeProfile>) } as ModeProfile;
  }
  await env.KV.put(KV_PROFILE(key), JSON.stringify(def)); // write-through seed
  return def;
}

async function loadModelConfig(env: Env): Promise<Record<AgentName, string>> {
  const raw = await env.KV.get(KV_MODEL_CONFIG);
  if (raw) return JSON.parse(raw) as Record<AgentName, string>;
  await env.KV.put(KV_MODEL_CONFIG, JSON.stringify(DEFAULT_MODEL_CONFIG));
  return DEFAULT_MODEL_CONFIG;
}

export async function buildModeContext(
  env: Env,
  _mode: Mode = 'UFGS',
  selections: ModeSelections = {},
): Promise<ModeContext> {
  const profile = await loadProfile(env, 'UFGS');
  const base = await loadModelConfig(env); // global model_config

  // Per-mode model routing comes from the COMPILED profile (source of truth,
  // immune to a stale KV profile); the global model_config is the base.
  const overrides = DEFAULT_PROFILES.UFGS?.modelOverrides ?? {};
  const { modelOverrides: _omit, ...profileFields } = profile;
  const ctx: ModeContext = { ...profileFields, modelBindings: { ...base, ...overrides } };

  // CHANGE-05 §2 — the agency axis is all that still varies.
  ctx.agency = selections.agency ?? 'ARMY';
  ctx.delivery = selections.delivery ?? 'DBB';
  ctx.constructionAgent =
    ctx.agency === 'NAVY' ? 'NAVFAC' : ctx.agency === 'AIRFORCE' ? 'AFCEC' : 'USACE';

  // CHANGE-02 — bind the selected master + step-3 overrides. The master's
  // namespace drives retrieval; switching masters changes the source. Validate-
  // don't-generate (G1/G4/G7) is unaffected — it always keys off D1. The built-in
  // namespace is retained as `baseRetrievalNamespace` so a firm-uploaded master
  // still resolves a structural corpus without any agent branching on mode.
  ctx.baseRetrievalNamespace = ctx.retrievalNamespace;
  if (selections.stylePackId) ctx.stylePackId = selections.stylePackId;
  if (selections.units) ctx.units = selections.units;
  if (selections.masterId) ctx.masterId = selections.masterId;
  if (selections.masterOwner) ctx.masterOwner = selections.masterOwner;
  if (selections.masterNamespace) ctx.retrievalNamespace = selections.masterNamespace;

  return ctx;
}
