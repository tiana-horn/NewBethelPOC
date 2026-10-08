// CHANGE-06 Part 3 (C4) — the embedding recall pass for section selection. At
// ufgs-bulk ingest we embed each section's TITLE + PART 1 SCOPE into a new `ufgs`
// namespace in the existing VECTORIZE index; at match time we query it and BLEND
// an embedding-recall score into the lexical matcher's confidence.
//
// The lexical pass (sec-match.ts) stays PRIMARY and standalone — Vectorize has no
// local emulation, so offline/local runs use lexical only. This embedding pass is
// a remote-only ENHANCEMENT gated on aiEnabled + a bound VECTORIZE. Every entry
// point degrades to "no recall" on any failure or missing binding; it never
// throws into the selection path (tripwire: selection must never REQUIRE Vectorize).
//
// Embedding is a ranking/recall aid over the FREE SEC catalog — nothing it
// produces is emitted as spec text (G1/G7 unaffected).

import { agents } from '../agents/registry';
import { aiEnabled } from '../shared/ai';
import type { Env } from '../env';
import type { ModeContext } from '../shared/types';
import type { SecCandidate, SecCatalogEntry } from './sec-match';

export const UFGS_NAMESPACE = 'ufgs';

// Loose structural types for the Vectorize binding (no local emulation / types).
interface VectorizeUpsert {
  upsert(v: { id: string; values: number[]; namespace?: string; metadata?: Record<string, unknown> }[]): Promise<unknown>;
}
interface VectorizeQuery {
  query(
    values: number[],
    opts: { topK?: number; namespace?: string; returnMetadata?: boolean | 'all' | 'indexed' },
  ): Promise<{ matches?: { id: string; score: number; metadata?: Record<string, unknown> }[] }>;
}

export function sectionEmbedText(title: string, scopeText?: string): string {
  return `${title}\n${scopeText ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 2000);
}

// Ingest-side: embed one section into the `ufgs` namespace. Best-effort; returns
// whether the vector was actually written (so the caller can set `embedded`).
export async function embedUfgsSection(
  env: Env,
  ctx: ModeContext,
  args: { section: string; title: string; scopeText?: string },
): Promise<boolean> {
  if (!aiEnabled(env)) return false;
  const vindex = env.VECTORIZE as unknown as VectorizeUpsert | undefined;
  if (!vindex?.upsert) return false;
  try {
    const { vectors } = await agents.embeddings(env, ctx, { texts: [sectionEmbedText(args.title, args.scopeText)] });
    if (!vectors.length || !vectors[0]?.length) return false;
    await vindex.upsert([
      { id: `ufgs:${args.section}`, values: vectors[0], namespace: UFGS_NAMESPACE, metadata: { section: args.section, title: args.title } },
    ]);
    return true;
  } catch {
    return false; // remote-only enhancement; ingest still succeeds without it
  }
}

// Match-side: query the `ufgs` namespace with the project's feature text and
// return section -> recall score (0..1 cosine). Empty on any failure / offline.
export async function embeddingRecall(
  env: Env,
  ctx: ModeContext,
  queryText: string,
  topK = 40,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!aiEnabled(env) || !queryText.trim()) return out;
  const vindex = env.VECTORIZE as unknown as VectorizeQuery | undefined;
  if (!vindex?.query) return out;
  try {
    const { vectors } = await agents.embeddings(env, ctx, { texts: [queryText.slice(0, 2000)] });
    if (!vectors.length || !vectors[0]?.length) return out;
    const res = await vindex.query(vectors[0], { topK, namespace: UFGS_NAMESPACE, returnMetadata: true });
    for (const m of res.matches ?? []) {
      const section = (m.metadata?.section as string) ?? String(m.id).replace(/^ufgs:/, '');
      if (section) out.set(section, Math.max(0, Math.min(1, m.score)));
    }
  } catch {
    /* degrade to lexical-only */
  }
  return out;
}

export interface BlendOptions {
  recallWeight: number; // how much recall can lift a lexical candidate's confidence
  recallOnlyMin: number; // min recall score for a recall-ONLY section to become a candidate
  recallOnlyWeight: number; // confidence assigned to a recall-only candidate = weight * score
  maxCandidates: number;
}
export const DEFAULT_BLEND_OPTIONS: BlendOptions = {
  recallWeight: 0.5,
  recallOnlyMin: 0.72,
  recallOnlyWeight: 0.6,
  maxCandidates: 60,
};

// Pure blend: recall can only RAISE a lexical candidate's confidence (never lower
// it — lexical is the floor), and sufficiently-strong recall-only sections are
// added as new candidates. If `recall` is empty (offline / no namespace), the
// lexical list is returned byte-for-byte unchanged.
export function blendCandidates(
  lexical: SecCandidate[],
  recall: Map<string, number>,
  catalog: SecCatalogEntry[],
  options: Partial<BlendOptions> = {},
): SecCandidate[] {
  if (recall.size === 0) return lexical;
  const opt = { ...DEFAULT_BLEND_OPTIONS, ...options };
  const byTitle = new Map(catalog.map((c) => [c.section, c] as const));
  const seen = new Set<string>();

  const blended: SecCandidate[] = lexical.map((c) => {
    seen.add(c.section);
    const r = recall.get(c.section) ?? 0;
    if (r <= 0) return c;
    // Monotonic lift toward 1, proportional to remaining headroom.
    const confidence = Math.min(1, c.confidence + opt.recallWeight * r * (1 - c.confidence));
    return {
      ...c,
      confidence: Math.round(confidence * 1000) / 1000,
      matchBasis: `${c.matchBasis}; +embedding(${r.toFixed(2)})`,
    };
  });

  // Recall-only sections the lexical pass ranked below threshold (the recall win).
  for (const [section, score] of recall) {
    if (seen.has(section) || score < opt.recallOnlyMin) continue;
    const entry = byTitle.get(section);
    blended.push({
      section,
      title: entry?.title ?? section,
      secFileRef: entry?.r2Key,
      matchBasis: `embedding-recall(${score.toFixed(2)})`,
      confidence: Math.round(opt.recallOnlyWeight * score * 1000) / 1000,
    });
  }

  blended.sort((a, b) => b.confidence - a.confidence);
  return blended.slice(0, opt.maxCandidates);
}
