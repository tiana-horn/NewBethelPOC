// Shared seal/output helpers. NEVER a professional seal or signature; NEVER
// holds a signing key (G8). The system freezes an immutable, hashed PDF of record
// and packages the review evidence that makes a licensed architect's seal
// defensible — then stops.
//
// NOTE vs. the prior POC: the single-section `assembleSealPackage`/`PackageParts`
// ZIP packager is gone (blueprint §2.1 — one pipeline). The Project Manual's
// freeze path (src/manual/freeze.ts) owns the one seal-package assembly. The
// helpers below (hashing, fallback-PDF text flattening, disclosure/compliance
// markdown) are shared and used by that path.

import { textToPdf } from './pdf';
import { resolveParagraphText } from './section-ir';
import type {
  Mode,
  ReferenceRow,
  SectionIR,
  SubmittalRegisterRow,
} from './types';
import type { CertificationBlock } from './docx';

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Flatten the resolved section (plus references, register, certification) to text
// lines for the fallback PDF-of-record.
export function sectionLines(
  ir: SectionIR,
  opts: { references?: ReferenceRow[]; register?: SubmittalRegisterRow[]; certification?: CertificationBlock; endMarker?: string },
): string[] {
  const out: string[] = [`SECTION ${ir.section}`, ir.title.toUpperCase(), ''];
  let refsEmitted = false;
  let regEmitted = false;
  for (const part of ir.parts) {
    out.push(`PART ${part.part} - ${part.title}`);
    for (const a of part.articles) {
      out.push(`  ${a.id}  ${a.title}`);
      for (const p of a.paragraphs) {
        out.push(`    ${p.locked ? '[LOCKED] ' : ''}${p.id}  ${resolveParagraphText(p)}`);
        if (!refsEmitted && p.refRequests?.length && opts.references?.length) {
          for (const r of opts.references) out.push(`    ${r.org}  ${r.designation} (${r.editionDate})  ${r.title}`);
          refsEmitted = true;
        }
        if (!regEmitted && p.subRequests?.length && opts.register?.length) {
          for (const s of opts.register) out.push(`      ${s.sdCode ? s.sdCode + '  ' : ''}${s.item}${s.classification ? '  [' + s.classification + ']' : ''}`);
          regEmitted = true;
        }
      }
    }
    out.push('');
  }
  out.push(opts.endMarker ?? 'END OF SECTION', '');
  if (opts.certification) {
    const c = opts.certification;
    out.push('CERTIFICATION', c.entityName, c.statement, `Printed name: ${c.printedName}`, `License No.: ${c.licenseNo}   Expiration: ${c.licenseExp}`, `Date: ${c.date}`);
    out.push('[ SEAL PLACEHOLDER ]  [ SIGNATURE PLACEHOLDER ]  (applied by the licensed architect, not this system)');
  }
  return out;
}

export function renderFallbackPdf(ir: SectionIR, opts: Parameters<typeof sectionLines>[1]): Uint8Array {
  return textToPdf(sectionLines(ir, opts), `${ir.section} ${ir.title}`);
}

export function disclosureMd(_mode: Mode): string {
  return [
    '# DISCLOSURE — what this system did NOT do',
    '',
    'This package was produced by an AI-assisted specifications tool.',
    '',
    '- **No professional seal or signature has been applied.** The enclosed PDF carries a seal *placeholder* and a signature *placeholder* only.',
    '- **The system holds no signing key** and performs no cryptographic signing on any licensee’s behalf.',
    '- **Sealing remains the personal act of a licensed architect** exercising responsible control and substantive review, through their own process (Bluebeam / Adobe / wet ink).',
    '- The enclosed review evidence, traceability, and guardrail results exist to **support** — not replace — that professional judgment.',
    '- **Digital signatures are permitted, not required**, and acceptance is at the discretion of local officials; rules vary by state.',
    '- Format fidelity: output renders to UFGS conventions (UFC 1-300-02).',
    '',
    '_Not legal advice. Confirm current requirements and agency acceptance rules before any real seal is applied._',
  ].join('\n');
}

export function complianceMd(report: { profile: string; summary: string; checks: { requirement: string; status: string; detail: string }[] }): string {
  const rows = report.checks.map((c) => `- ${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '—'} **${c.requirement}** — ${c.detail}`);
  return [`# Compliance — ${report.profile.toUpperCase()}`, '', report.summary, '', ...rows].join('\n');
}
