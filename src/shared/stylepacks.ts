// Style Packs — layout as data, bound to the Mode Context. One `csi-baseline`
// foundation (CSI PageFormat conventions, Word auto-numbering); `ufgs` carries
// the REAL overrides derived from the UFGS corpus + UFC 1-300-02 — the pack every
// live run uses. `md-dgs` overrides only the certification-block jurisdiction.
// (The prior POC's empty `commercial-house`/`gsa` stubs are dropped — blueprint
// §2.2.) Resolved as csi-baseline deep-merged with <pack>/overrides.json in R2;
// self-seeds from these compiled defaults.

import type { Env } from '../env';

export interface StylePack {
  id: string;
  numberingScheme: 'csi' | 'ufgs-decimal';
  bodyFont: string;
  headingFont: string;
  marginTwips: { top: number; right: number; bottom: number; left: number };
  endOfSectionMarker: string;
  suppressNotes: boolean; // Notes to the Designer never print in the issued document
  referencedPubsLayout: 'csi' | 'ufgs-dated';
  changeBars: boolean;
  jurisdiction: 'MD' | 'generic'; // certification-block template (per-jurisdiction)
}

// THE FOUNDATION — CSI PageFormat conventions.
export const CSI_BASELINE: StylePack = {
  id: 'csi-baseline',
  numberingScheme: 'csi', // 1.1 / A. / 1. / a.
  bodyFont: 'Times New Roman',
  headingFont: 'Arial',
  marginTwips: { top: 1440, right: 1440, bottom: 1440, left: 1440 }, // 1"
  endOfSectionMarker: 'END OF SECTION',
  suppressNotes: true,
  referencedPubsLayout: 'csi',
  changeBars: false,
  jurisdiction: 'generic',
};

// Per-pack overrides deep-merged onto csi-baseline.
export const PACK_OVERRIDES: Record<string, Partial<StylePack>> = {
  ufgs: {
    // REAL overrides derived from UFGS corpus + UFC 1-300-02 (NOT model recall).
    numberingScheme: 'ufgs-decimal', // 1.1 / 1.1.1 / ... nested decimal
    referencedPubsLayout: 'ufgs-dated', // ORG / designation / date / title
    suppressNotes: true,
  },
  'md-dgs': { jurisdiction: 'MD' }, // Maryland certification-block template
};

function merge(base: StylePack, ov: Partial<StylePack>, id: string): StylePack {
  return { ...base, ...ov, id, marginTwips: { ...base.marginTwips, ...(ov.marginTwips ?? {}) } };
}

// Resolve a pack: R2 override JSON if present, else compiled default. Self-seeds
// R2 so "format lives in R2" holds while the demo is zero-config.
export async function resolveStylePack(env: Env, stylePackId: string): Promise<StylePack> {
  const key = `stylepacks/${stylePackId}/overrides.json`;
  let overrides: Partial<StylePack> = PACK_OVERRIDES[stylePackId] ?? {};
  try {
    const obj = await env.R2?.get(key);
    if (obj) overrides = JSON.parse(await obj.text());
  } catch {
    /* fall back to compiled overrides */
  }
  return merge(CSI_BASELINE, overrides, stylePackId);
}
