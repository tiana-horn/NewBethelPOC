// Master ingest (CHANGE-02 §3). A firm uploads their in-house master; we store
// the source in R2, chunk it, and embed the chunks into a MASTER-SCOPED Vectorize
// namespace `master:<owner>:<masterId>`. The selected master's namespace becomes
// the run's retrievalNamespace, so the AI drafts from whichever master is chosen.
// Validate-don't-generate (G1/G4/G7) is unaffected — it always keys off D1.
//
// With USE_AI/Vectorize live this performs real embedding; offline it stores the
// chunks and marks the master ready (the deterministic drafter uses the mode's
// structural corpus, with this master bound as retrieval source + provenance).

import { agents } from '../agents/registry';
import type { Env } from '../env';
import { buildModeContext } from '../mode/mode-context';
import { detectFileType } from '../intake/filetype';
import { extractDocxText } from '../intake/text';
import type { Mode } from '../shared/types';

export function masterNamespace(owner: string, masterId: string): string {
  return `master:${owner}:${masterId}`;
}

export interface IngestArgs {
  masterId: string;
  owner: string; // an org_id (firm-uploaded masters are never 'system')
  mode?: Mode;
  filename: string;
  bytes: Uint8Array;
}

export interface IngestResult {
  namespace: string;
  r2Prefix: string;
  chunks: number;
  embedded: boolean;
}

export async function ingestMaster(env: Env, args: IngestArgs): Promise<IngestResult> {
  const namespace = masterNamespace(args.owner, args.masterId);
  const r2Prefix = `masters/${args.owner}/${args.masterId}/`;

  // Store the source verbatim.
  await env.R2?.put(`${r2Prefix}source-${args.filename}`, args.bytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });

  const text = masterText(args.filename, args.bytes);
  const chunks = chunkText(text);
  await env.R2?.put(`${r2Prefix}chunks.json`, JSON.stringify(chunks), {
    httpMetadata: { contentType: 'application/json' },
  });

  // Embed into the master-scoped namespace when AI + Vectorize are available.
  let embedded = false;
  try {
    const ctx = await buildModeContext(env, args.mode ?? 'UFGS', {});
    const { vectors } = await agents.embeddings(env, ctx, { texts: chunks });
    const vindex = env.VECTORIZE as
      | { upsert(v: { id: string; values: number[]; namespace?: string; metadata?: Record<string, unknown> }[]): Promise<unknown> }
      | undefined;
    if (vindex && vectors.length === chunks.length && vectors.length > 0) {
      await vindex.upsert(
        vectors.map((values, i) => ({
          id: `${args.masterId}:${i}`,
          values,
          namespace,
          metadata: { masterId: args.masterId, owner: args.owner, chunk: i },
        })),
      );
      embedded = true;
    }
  } catch {
    /* embedding is best-effort; the master is still selectable + bound */
  }

  return { namespace, r2Prefix, chunks: chunks.length, embedded };
}

function masterText(filename: string, bytes: Uint8Array): string {
  const det = detectFileType(filename, bytes);
  if (det.type === 'docx') return extractDocxText(bytes);
  // txt / SpecsIntact XML / other text — decode and (for XML) strip tags.
  const raw = new TextDecoder().decode(bytes);
  return det.type === 'xml' ? raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : raw;
}

// Paragraph-ish chunking bounded to ~800 chars — enough granularity for
// house-language retrieval without a heavyweight splitter.
function chunkText(text: string, max = 800): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > max) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > max) {
      chunks.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.length ? chunks : [text.slice(0, max)].filter(Boolean);
}
