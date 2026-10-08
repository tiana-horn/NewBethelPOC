// Load a REAL, ingested UFGS SectionIR by section number. This is what makes the
// Drafter general: any section the outline resolves to drafts from whatever has
// actually been ingested (scripts/etl-ufgs-corpus.ts), not a hardcoded per-section
// fixture. `ufgs_corpus_section.r2_key` is the source of truth for where the
// converted IR JSON lives (written by POST /admin/corpus/ufgs-bulk).

import type { Env } from '../env';
import type { SectionIR } from '../shared/types';

// The ONE canonical section-number -> R2 key mapping. Every non-alphanumeric run
// (spaces AND the dot in extended numbers like "01 31 23.13 20") collapses to a
// single dash. Both the ingest and the loader use this so they can never disagree.
export function ufgsCorpusR2Key(section: string): string {
  return `corpus/ufgs/${section.replace(/[^0-9A-Za-z]+/g, '-')}.json`;
}

export async function loadRealUfgsSection(env: Env, section: string): Promise<SectionIR | null> {
  if (!env.R2) return null;
  const row = await env.DB.prepare(`SELECT r2_key as r2Key FROM ufgs_corpus_section WHERE section = ?1`)
    .bind(section)
    .first<{ r2Key: string }>();
  // Try the stored key first, then the canonical section->key — robust to any
  // normalization drift between the catalog and the R2 objects.
  const candidates = [row?.r2Key, ufgsCorpusR2Key(section)].filter((k): k is string => !!k);
  const tried = new Set<string>();
  for (const key of candidates) {
    if (tried.has(key)) continue;
    tried.add(key);
    const obj = await env.R2.get(key);
    if (!obj) continue;
    try {
      return JSON.parse(await obj.text()) as SectionIR;
    } catch {
      return null;
    }
  }
  return null;
}
