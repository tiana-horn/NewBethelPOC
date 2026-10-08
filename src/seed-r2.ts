// R2 seeding (CHANGE-01 §4.1) — writes the data the architecture assumes lives
// in R2 but v1 never wrote: the mode corpora (/corpus/...), product cut sheets
// (/cutsheets/...), and the Style Packs (/stylepacks/...). Generated from the
// compiled code so R2 mirrors the single source of truth. Invoked via
// POST /api/seed-r2. Illustrative placeholders — labeled as such.

import { ufgsPainting } from './corpus/ufgs-09-90-00';
import type { Env } from './env';
import { buildModeContext } from './mode/mode-context';
import { buildNumberingXml, buildStylesXml } from './shared/docx';
import { textToPdf } from './shared/pdf';
import { emitSpecsIntact } from './shared/specsintact';
import { CSI_BASELINE, PACK_OVERRIDES, resolveStylePack } from './shared/stylepacks';

const GC_MD =
  'DGS GENERAL CONDITIONS FOR CONSTRUCTION CONTRACTS (ILLUSTRATIVE PLACEHOLDER — REPLACE WITH THE VERIFIED DOCUMENT).\n' +
  'These General Conditions are issued by the Maryland Department of General Services and may not be altered by the ' +
  'Architect/Engineer. Supplemental conditions require prior written DGS approval.';
const CORE_GSA =
  'PBS CORE BUILDING STANDARDS MEMORANDUM (ILLUSTRATIVE PLACEHOLDER — REPLACE WITH THE VERIFIED DOCUMENT).\n' +
  'Establishes the mandatory laws, regulations, and codes for the project; may not be altered by the A/E. ABAAS accessibility is mandatory on GSA projects.';

// CHANGE-06 §7 (C7) — UFC-profile Division 00 front-end bodies. Free, federal
// front-end documents a DoD/UFGS project manual reproduces UNALTERED (G2). These
// are ILLUSTRATIVE placeholders, clearly labeled — exactly like the md-dgs/gsa
// bodies — pending the verified documents. Keys match the locked_docs r2_key seed.
const UFC_FRONT_END: { key: string; body: string }[] = [
  {
    key: 'corpus/public/UFC/00-solicitation.txt',
    body:
      'SOLICITATION, OFFER AND AWARD — SF 1442 + INSTRUCTIONS TO OFFERORS (ILLUSTRATIVE PLACEHOLDER — REPLACE WITH THE VERIFIED DOCUMENT).\n' +
      'The federal solicitation and instructions to offerors are issued by the Contracting Officer and are included unaltered by the A/E (G2).',
  },
  {
    key: 'corpus/public/UFC/00-far-clauses.txt',
    body:
      'FEDERAL ACQUISITION REGULATION (FAR) CONTRACT CLAUSES (ILLUSTRATIVE PLACEHOLDER — REPLACE WITH THE VERIFIED DOCUMENT).\n' +
      'FAR clauses incorporated by reference and in full text; mandatory federal contract terms, not alterable by the A/E.',
  },
  {
    key: 'corpus/public/UFC/00-dfars-clauses.txt',
    body:
      'DEFENSE FAR SUPPLEMENT (DFARS) CONTRACT CLAUSES (ILLUSTRATIVE PLACEHOLDER — REPLACE WITH THE VERIFIED DOCUMENT).\n' +
      'DoD supplemental contract clauses; mandatory, not alterable by the A/E.',
  },
  {
    key: 'corpus/public/UFC/00-wage-determination.txt',
    body:
      'DAVIS-BACON WAGE DETERMINATION — CONSTRUCTION (ILLUSTRATIVE PLACEHOLDER — REPLACE WITH THE VERIFIED DOCUMENT).\n' +
      'The applicable Department of Labor wage determination for the project locality; included unaltered (G2).',
  },
];

export async function seedR2(env: Env): Promise<string[]> {
  if (!env.R2) throw new Error('R2 binding not available');
  const keys: string[] = [];
  const put = async (key: string, body: string | Uint8Array, contentType: string) => {
    await env.R2!.put(key, body, { httpMetadata: { contentType } });
    keys.push(key);
  };

  // ---- Corpus (CHANGE-05 §2 — UFGS only; Modes B/C corpora removed) ----
  const ufgsCtx = await buildModeContext(env, 'UFGS', { agency: 'ARMY', delivery: 'DBB' });
  // The seeded corpus XML is the pre-resolution MASTER (unresolved brackets), so
  // it is a review/editing artifact — not subject to issued-output hygiene.
  await put('corpus/ufgs/09 90 00.xml', emitSpecsIntact(ufgsPainting(), ufgsCtx, { references: [], register: [], review: true }), 'application/xml');

  // ---- Public front-end documents (Division 00, included unaltered — G2) ----
  // Illustrative placeholders (labeled), keyed to the locked_docs r2_key seed.
  await put('corpus/public/MD_DGS/general-conditions.txt', GC_MD, 'text/plain');
  await put('corpus/public/GSA/core-standards.txt', CORE_GSA, 'text/plain');
  for (const d of UFC_FRONT_END) await put(d.key, d.body, 'text/plain'); // CHANGE-06 §7 (C7)

  // ---- Style Packs (format as data) ----
  // csi-baseline: the foundation.
  await put('stylepacks/csi-baseline/meta.json', JSON.stringify(CSI_BASELINE, null, 2), 'application/json');
  await put('stylepacks/csi-baseline/overrides.json', JSON.stringify({}, null, 2), 'application/json');
  await put('stylepacks/csi-baseline/styles.xml', buildStylesXml(CSI_BASELINE), 'application/xml');
  await put('stylepacks/csi-baseline/numbering.xml', buildNumberingXml(CSI_BASELINE), 'application/xml');
  await put('stylepacks/csi-baseline/sectpr.json', JSON.stringify({ pgSz: { w: 12240, h: 15840 }, pgMar: CSI_BASELINE.marginTwips, pgNumRestart: true }, null, 2), 'application/json');

  // ufgs (real overrides) + inheritance stubs.
  for (const id of ['ufgs', 'commercial-house', 'md-dgs', 'gsa']) {
    const pack = await resolveStylePack(env, id);
    await put(`stylepacks/${id}/overrides.json`, JSON.stringify(PACK_OVERRIDES[id] ?? {}, null, 2), 'application/json');
    await put(`stylepacks/${id}/meta.json`, JSON.stringify(pack, null, 2), 'application/json');
    await put(`stylepacks/${id}/styles.xml`, buildStylesXml(pack), 'application/xml');
    await put(`stylepacks/${id}/numbering.xml`, buildNumberingXml(pack), 'application/xml');
  }

  return keys;
}
