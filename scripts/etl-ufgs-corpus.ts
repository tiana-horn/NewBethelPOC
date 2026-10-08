// Working-prototype expansion (Part 6.3, generalized) — bulk-ingest the ENTIRE
// real UFGS `.SEC` master (685 sections) as real, drafted corpus. Unlike the
// original Part 6.3 ("ingest what a given project's outline asks for"), the
// user's direction here is: any project's real intake should draft from real
// corpus with no rebuild per project — so the whole master goes in as a system
// asset, once, and the outline algorithm (already data-driven) flips whatever
// a project's classification resolves to from `outline` to `draft` for free.
//
// Run: node scripts/etl-ufgs-corpus.ts [--base http://localhost:PORT]
// Requires a running `wrangler dev` (the .SEC -> SectionIR conversion + R2/D1
// writes happen INSIDE the Worker via POST /admin/corpus/ufgs-bulk, so R2/D1
// bindings are used correctly — this script only reads files and POSTs them).

import { readdirSync, readFileSync } from 'node:fs';

const DIR = 'documents/UFGS_M';
const BASE = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'http://localhost:8787';
const BATCH_SIZE = 15;

async function main() {
  const files = readdirSync(DIR).filter((f) => f.toUpperCase().endsWith('.SEC'));
  console.log(`Found ${files.length} real UFGS .SEC files in ${DIR}`);

  let ingested = 0;
  let failed = 0;
  const failures: string[] = [];

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const payload = {
      files: batch.map((filename) => ({ filename, xml: readFileSync(`${DIR}/${filename}`, 'latin1') })),
    };
    const res = await fetch(`${BASE}/admin/corpus/ufgs-bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`Batch ${i}-${i + batch.length} failed: HTTP ${res.status}`);
      failed += batch.length;
      continue;
    }
    const data = (await res.json()) as { ingested: number; failed: number; results: { filename: string; ok: boolean; error?: string }[] };
    ingested += data.ingested;
    failed += data.failed;
    for (const r of data.results) if (!r.ok) failures.push(`${r.filename}: ${r.error}`);
    console.log(`[${Math.min(i + BATCH_SIZE, files.length)}/${files.length}] ingested=${ingested} failed=${failed}`);
  }

  console.log(`\nDone. Ingested ${ingested}, failed ${failed}.`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures.slice(0, 30)) console.log(`  ${f}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
