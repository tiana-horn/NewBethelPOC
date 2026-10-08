// CHANGE-06 §1 (C5) — fetch real UFC technical criteria from the WBDG CIM public
// API and load them into `criteria` (+ corpus_source), optionally linking them
// onto the already-ingested UFGS Section IRs. The actual CIM fetch + D1/R2 writes
// happen INSIDE the Worker (POST /admin/corpus/ufc-criteria) so bindings are used
// correctly; this script only passes the version identifiers and prints results.
//
// Discovery caveat (see memory wbdg-cim-api): CIM has NO public list/search route,
// so a criterion/version UUID must be obtained out-of-band. Pass it explicitly.
//
// SINGLE:  node scripts/etl-ufc-criteria.ts --version <versionId-uuid> [--link "09 90 00,08 11 13"] [--base http://localhost:8787]
//    or:   node scripts/etl-ufc-criteria.ts --designation "UFC 4-510-01"   (only if seeded in UFC_VERSION_SEED)
// BATCH:   node scripts/etl-ufc-criteria.ts --file scripts/ufc-uuids.json  [--base ...]
//          The file is a JSON array; only `versionId` is required per entry:
//          [ { "versionId": "…", "designation": "UFC 4-510-01",
//              "criterionId": "…", "link": ["09 90 00","08 11 13"] }, … ]

import { readFileSync } from 'node:fs';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BASE = arg('--base') ?? 'http://localhost:8787';

interface UfcEntry {
  versionId?: string;
  designation?: string;
  criterionId?: string; // not used by ingest (only the staleness Cron) — carried for readability
  link?: string[] | string;
}

// POST one entry to the Worker; returns true on success, false on any failure
// (a 422 = edition-unconfirmed / G7: the rows were deliberately NOT loaded).
async function ingestOne(entry: UfcEntry): Promise<boolean> {
  const sections = Array.isArray(entry.link)
    ? entry.link
    : typeof entry.link === 'string'
      ? entry.link.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
  const payload: Record<string, unknown> = {};
  if (entry.versionId) payload.versionId = entry.versionId;
  if (entry.designation) payload.designation = entry.designation;
  if (sections && sections.length) {
    payload.link = true;
    payload.sections = sections;
  }
  const label = entry.designation ?? entry.versionId ?? '(unknown)';
  const res = await fetch(`${BASE}/admin/corpus/ufc-criteria`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const tag = res.status === 422 ? 'SKIPPED (G7: edition unconfirmed — not loaded)' : `HTTP ${res.status}`;
    console.error(`✗ ${label}: ${tag}\n${JSON.stringify(data, null, 2)}`);
    return false;
  }
  console.log(`✓ ${label}: ${JSON.stringify(data)}`);
  return true;
}

async function main() {
  const file = arg('--file');
  if (file) {
    let entries: UfcEntry[];
    try {
      entries = JSON.parse(readFileSync(file, 'utf8')) as UfcEntry[];
    } catch (err) {
      console.error(`Could not read/parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      console.error(`${file} must be a non-empty JSON array of { versionId, … } entries.`);
      process.exit(2);
    }
    const missing = entries.filter((e) => !e.versionId && !e.designation);
    if (missing.length) {
      console.error(`${missing.length} ent/entries have neither versionId nor designation.`);
      process.exit(2);
    }
    let ok = 0;
    for (const e of entries) {
      // Sequential + a small pause — the spec says "batch politely (rate-limited)".
      if (await ingestOne(e)) ok++;
      await new Promise((r) => setTimeout(r, 400));
    }
    console.log(`\nDone. ${ok}/${entries.length} loaded (${entries.length - ok} skipped/failed).`);
    process.exit(ok === entries.length ? 0 : 3);
  }

  // Single-entry mode.
  const versionId = arg('--version');
  const designation = arg('--designation');
  if (!versionId && !designation) {
    console.error('Provide --file <json>, or --version <uuid>, or --designation "UFC X-YYY-ZZ".');
    process.exit(2);
  }
  const ok = await ingestOne({ versionId, designation, link: arg('--link') });
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
