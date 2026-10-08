// CHANGE-06 §2.2 (C6.2) — the staleness sweep the corpus provenance ledger was
// always designed for. Walks `corpus_source` and, for each source we can check
// against a live free-government source, asks "is there a newer edition?". If so
// it calls the EXISTING markStale (flag-only). It NEVER adopts an edition (G11):
// human re-verification via reverifyCorpusSource remains the sole clear path.
//
// Only UFC sources are live-checkable today (via the WBDG CIM version history,
// Part 1.1). UMRL/UMSL/UFGS-MASTER have their own out-of-band cadence and are
// skipped here — honestly reported, never silently "checked". The sweep tolerates
// the CIM API being unreachable: it logs and skips, and never throws out of the
// scheduled handler (a crashed cron would silently stop all future sweeps).

import { listCorpusSources, markStale, type CorpusSourceRow } from '../db/corpus';
import { fetchUfcVersionHistory, isUuid, UFC_CRITERION_SEED, type UfcVersionSummary } from './ufc-cim';
import type { Env } from '../env';

export interface SweepDeps {
  // Injected for testing; defaults hit the real CIM API.
  fetchVersions?: (criterionId: string) => Promise<UfcVersionSummary[]>;
  // designation -> criterionId (UUID). Defaults to the committed out-of-band seed.
  criterionSeed?: Record<string, string>;
  log?: (msg: string) => void;
}

export interface SweepReport {
  checked: number; // sources we could actually check against a live source
  flagged: number; // sources newly marked stale
  skipped: number; // sources with no live check available / no id known
  errors: number; // live checks that failed (CIM unreachable, etc.)
  details: { sourceId: string; kind: string; identifier: string; outcome: string }[];
}

// The "latest" edition from a version history: the max by ISO datePublished, else
// the max versionNumber string, else the last entry. Returns null if the history
// carries no usable edition label (nothing to compare — G7: never invent one).
export function latestEdition(versions: UfcVersionSummary[]): string | null {
  const dated = versions.filter((v) => v.datePublished);
  if (dated.length) {
    dated.sort((a, b) => (a.datePublished! < b.datePublished! ? -1 : 1));
    const top = dated[dated.length - 1];
    return top.versionNumber?.trim() || top.datePublished!.trim();
  }
  const numbered = versions.filter((v) => v.versionNumber);
  if (numbered.length) {
    numbered.sort((a, b) => (a.versionNumber! < b.versionNumber! ? -1 : 1));
    return numbered[numbered.length - 1].versionNumber!.trim();
  }
  return null;
}

// Flag-only decision: a source is stale if the live latest edition is present and
// differs from the recorded edition. We never RANK-adopt — any difference routes
// to a human (markStale), because comparing free-text edition labels ('Change 4'
// vs '2023-05-01') can't be done safely enough to auto-adopt (G11).
export function isNewerEdition(current: string, latest: string | null): boolean {
  if (!latest) return false;
  return latest.trim() !== (current ?? '').trim();
}

export async function sweepCorpusStaleness(env: Env, deps: SweepDeps = {}): Promise<SweepReport> {
  const log = deps.log ?? ((m: string) => console.log(`[staleness-cron] ${m}`));
  const seed = deps.criterionSeed ?? UFC_CRITERION_SEED;
  const fetchVersions =
    deps.fetchVersions ?? ((criterionId: string) => fetchUfcVersionHistory(criterionId));

  const report: SweepReport = { checked: 0, flagged: 0, skipped: 0, errors: 0, details: [] };
  let sources: CorpusSourceRow[];
  try {
    sources = await listCorpusSources(env.DB);
  } catch (err) {
    log(`could not list corpus_source: ${err instanceof Error ? err.message : String(err)}`);
    return report;
  }

  for (const src of sources) {
    // Only UFC sources are live-checkable via CIM today.
    if (src.kind !== 'UFC') {
      report.skipped++;
      report.details.push({ sourceId: src.sourceId, kind: src.kind, identifier: src.identifier, outcome: 'skipped (no live check for this kind)' });
      continue;
    }
    // Prefer the criterionId captured at ingest (corpus_source.criterion_id, C6.2);
    // fall back to the committed seed map only as a manual override.
    const criterionId = src.criterionId ?? seed[src.identifier];
    if (!criterionId || !isUuid(criterionId)) {
      report.skipped++;
      report.details.push({ sourceId: src.sourceId, kind: src.kind, identifier: src.identifier, outcome: 'skipped (no criterionId captured at ingest or in seed)' });
      continue;
    }
    try {
      const versions = await fetchVersions(criterionId);
      report.checked++;
      const latest = latestEdition(versions);
      if (isNewerEdition(src.edition, latest)) {
        await markStale(env.DB, src.sourceId, latest!); // flag ONLY — never adopts (G11)
        report.flagged++;
        report.details.push({ sourceId: src.sourceId, kind: src.kind, identifier: src.identifier, outcome: `flagged stale: recorded "${src.edition}" vs live "${latest}"` });
      } else {
        report.details.push({ sourceId: src.sourceId, kind: src.kind, identifier: src.identifier, outcome: 'current' });
      }
    } catch (err) {
      // Tolerate CIM unreachable — log + skip, never crash the schedule.
      report.errors++;
      report.details.push({ sourceId: src.sourceId, kind: src.kind, identifier: src.identifier, outcome: `error: ${err instanceof Error ? err.message : String(err)}` });
      log(`check failed for ${src.identifier}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`sweep done: checked=${report.checked} flagged=${report.flagged} skipped=${report.skipped} errors=${report.errors}`);
  return report;
}
