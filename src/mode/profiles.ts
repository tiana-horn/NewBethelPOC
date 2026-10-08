// Mode Profiles (§2.2, §4.4 + CHANGE-01 §4.1) — the templates ModeContext is
// built from. These live in KV keyed by mode (Mode C additionally by profile).
// Editing a profile here or in KV is the ONLY place mode selection is
// interpreted — everything downstream just reads ModeContext. Mode C is a pure
// data recombination: no new agent, no `if (mode === 'PUBLIC_SECTOR')` outside
// this loading path.

import type { AgentName, ArtifactKind, ModeContext } from '../shared/types';

// Per-mode agent-model overrides layered onto the global model_config (data).
export type ModeProfile = Pick<
  ModeContext,
  | 'mode'
  | 'retrievalNamespace'
  | 'rulesetId'
  | 'tagProfile'
  | 'referenceListId'
  | 'stylePackId'
  | 'artifactSet'
  | 'complianceProfile'
> & { modelOverrides?: Partial<Record<AgentName, string>> };

// *** VERIFY AGAINST THE LIVE CATALOG (`wrangler ai models`) AND RE-PIN. ***
export const DEFAULT_MODEL_CONFIG: Record<AgentName, string> = {
  drafter: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', // long context; large sections
  resolver: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  validator: '@cf/meta/llama-3.1-8b-instruct-fast',
  coordinator: '@cf/meta/llama-3.1-8b-instruct-fast',
  compliance: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  embeddings: '@cf/baai/bge-base-en-v1.5',
};

// A fast, small model for latency-sensitive drafting. The guardrail rejects any
// token-unsafe rewrite regardless of model (and falls back to the master text),
// so trading the 70B for the 8B here costs no correctness — only latency.
const FAST_DRAFTER = '@cf/meta/llama-3.1-8b-instruct-fast';

// DOCX + PDF + seal-package export in every mode (§3.5, §5).
const SHARED_ARTIFACTS: ArtifactKind[] = [
  'section-ir',
  'docx',
  'pdf',
  'coordination-flags',
  'compliance-report',
  'traceability-csv',
  'seal-package',
];

// CHANGE-05 §2 — one mode (UFGS). Modes B/C profiles removed.
export const DEFAULT_PROFILES: Record<string, ModeProfile> = {
  UFGS: {
    mode: 'UFGS',
    retrievalNamespace: 'ufgs',
    rulesetId: 'ufgs-brackets-tailoring-v1',
    tagProfile: 'specsintact',
    referenceListId: 'UMRL',
    stylePackId: 'ufgs',
    complianceProfile: 'ufc',
    artifactSet: [
      ...SHARED_ARTIFACTS,
      'specsintact-xml',
      'submittal-register-csv',
      'references-csv',
      'resolution-log',
    ],
    // The UFGS section is large, so route its Drafter to the fast model to keep
    // AI-assisted drafting responsive.
    modelOverrides: { drafter: FAST_DRAFTER },
  },
};
