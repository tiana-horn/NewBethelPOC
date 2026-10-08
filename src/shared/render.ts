// PDF-of-record rendering with pagination verification (CHANGE-01 §3.4). Uses
// the LibreOffice render container when the RENDER binding is present (real page
// layout -> verifiable pagination), else the in-Worker fallback. This module
// only *calls* the container via its binding — it does NOT import
// @cloudflare/containers, so the main Worker bundle stays container-free.

import type { Env } from '../env';
import { renderFallbackPdf, type sectionLines } from './seal';
import type { SectionIR } from './types';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function countPdfPages(pdf: Uint8Array): number {
  const s = new TextDecoder('latin1').decode(pdf);
  const m = s.match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 1;
}

export async function renderPdfViaContainer(
  env: Env,
  docx: Uint8Array,
): Promise<{ pdf: Uint8Array; pageCount: number }> {
  const ns = env.RENDER as any;
  if (!ns) throw new Error('no RENDER container binding');
  const stub = ns.getByName('render'); // one named LibreOffice instance
  const res: Response = await stub.fetch('http://render/render', {
    method: 'POST',
    headers: { 'content-type': DOCX_MIME },
    body: docx,
  });
  if (!res.ok) throw new Error(`container render failed: ${res.status}`);
  const pdf = new Uint8Array(await res.arrayBuffer());
  const pageCount = parseInt(res.headers.get('x-page-count') || '', 10) || countPdfPages(pdf);
  return { pdf, pageCount };
}

export interface PdfResult {
  pdf: Uint8Array;
  pageCount: number;
  path: 'container' | 'worker-fallback';
  verified: boolean; // pagination verified against a real office render
}

// Render the frozen PDF of record. Prefers the container (verifiable pagination);
// falls back to the in-Worker generator (valid PDF, not pagination-verified).
export async function renderPdfOfRecord(
  env: Env,
  docx: Uint8Array,
  ir: SectionIR,
  opts: Parameters<typeof sectionLines>[1],
): Promise<PdfResult> {
  if (env.RENDER) {
    try {
      const { pdf, pageCount } = await renderPdfViaContainer(env, docx);
      // Pagination verification: a real render must produce >= 1 laid-out page.
      // (Section-page numbering + heading-orphan checks build on this signal.)
      if (pageCount < 1 || pdf.length < 100) throw new Error('pagination check failed');
      return { pdf, pageCount, path: 'container', verified: true };
    } catch {
      /* fall through to the in-Worker fallback */
    }
  }
  const pdf = renderFallbackPdf(ir, opts);
  return { pdf, pageCount: countPdfPages(pdf), path: 'worker-fallback', verified: false };
}
