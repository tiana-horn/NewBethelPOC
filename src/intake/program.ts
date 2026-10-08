// Project program / basis-of-design extraction (CHANGE-02 §2). The program
// arrives as PDF/DOCX/text; we extract it into EPDProgram. With USE_AI=true this
// is a JSON-Schema-constrained LLM pass GROUNDED in the file (never free recall);
// with USE_AI=false a deterministic regex pass keeps the demo reproducible. The
// result is shown to the user at Gate 0 and can be corrected — an LLM misread is
// caught before the pipeline drafts.

import { aiEnabled, runModel } from '../shared/ai';
import type { Env } from '../env';
import type { EPDProgram, ModeContext } from '../shared/types';

export async function extractProgram(env: Env, ctx: ModeContext, text: string): Promise<EPDProgram> {
  const deterministic = extractProgramDeterministic(text);
  if (!aiEnabled(env) || !text.trim()) return deterministic;

  const schema = {
    type: 'object',
    properties: {
      buildingType: { type: 'string' },
      areaSqFt: { type: 'number' },
      location: { type: 'string' },
      codesApplicable: { type: 'array', items: { type: 'string' } },
      deliveryMethod: { type: 'string', enum: ['DBB', 'DB'] },
      sustainabilityTargets: { type: 'array', items: { type: 'string' } },
      designIntent: { type: 'string' },
    },
    required: ['buildingType', 'designIntent'],
  };
  const system =
    'You extract a construction project program into JSON. Use ONLY facts present in the text; ' +
    'leave a field empty if the text does not state it. Do not invent codes, areas, or targets.';
  try {
    const out = (await runModel(env, 'drafter', ctx, {
      system,
      prompt: `Project program document:\n\n${text.slice(0, 8000)}`,
      schema,
      maxTokens: 800,
    })) as Partial<EPDProgram>;
    // Merge: prefer model fields, fall back to deterministic where empty.
    return {
      buildingType: out.buildingType || deterministic.buildingType,
      areaSqFt: out.areaSqFt ?? deterministic.areaSqFt,
      location: out.location || deterministic.location,
      codesApplicable: out.codesApplicable?.length ? out.codesApplicable : deterministic.codesApplicable,
      deliveryMethod: out.deliveryMethod || deterministic.deliveryMethod,
      sustainabilityTargets: out.sustainabilityTargets?.length
        ? out.sustainabilityTargets
        : deterministic.sustainabilityTargets,
      designIntent: out.designIntent || deterministic.designIntent,
    };
  } catch {
    return deterministic; // fail-safe: the deterministic read
  }
}

export function extractProgramDeterministic(text: string): EPDProgram {
  const t = text.replace(/\s+/g, ' ').trim();
  const lower = t.toLowerCase();

  const deliveryMethod: EPDProgram['deliveryMethod'] = /\bdesign[-\s]?build\b|\bdb\b/.test(lower)
    ? 'DB'
    : /\bdesign[-\s]?bid[-\s]?build\b|\bdbb\b/.test(lower)
      ? 'DBB'
      : undefined;

  const sustainabilityTargets: string[] = [];
  const voc = t.match(/voc[^.\n]*?(\d{1,4})\s*g\/?l/i);
  if (voc) sustainabilityTargets.push(`VOC <= ${voc[1]} g/L`);
  else if (/low[-\s]?voc/i.test(t)) sustainabilityTargets.push('Low-VOC required');
  for (const kw of ['LEED', 'WELL', 'Energy Star']) if (new RegExp(kw, 'i').test(t)) sustainabilityTargets.push(kw);

  const area = t.match(/([\d][\d,]*)\s*(?:sf|sq\.?\s*ft|square\s+feet)/i);
  const codesApplicable = [...t.matchAll(/\b(IBC|IRC|IECC|IEBC|NFPA\s?\d+|ADA|ABAAS)\b/gi)].map((m) => m[1].toUpperCase());

  const buildingType =
    [
      ['administrative office', /administrative office|office building|administrative building/i],
      ['school', /school|classroom|educational/i],
      ['healthcare', /hospital|clinic|healthcare|medical/i],
      ['laboratory', /laborator|\blab\b/i],
      ['warehouse', /warehouse|storage facility/i],
    ].find(([, re]) => (re as RegExp).test(t))?.[0] as string | undefined;

  // Design intent: the first substantive sentence(s), capped.
  const designIntent = t.slice(0, 300);

  return {
    buildingType,
    areaSqFt: area ? Number(area[1].replace(/,/g, '')) : undefined,
    location: undefined,
    codesApplicable: [...new Set(codesApplicable)],
    deliveryMethod,
    sustainabilityTargets,
    designIntent,
  };
}

// Pull a numeric VOC limit (g/L) from sustainability targets, if present.
export function vocLimitFromProgram(program: EPDProgram): number | undefined {
  for (const s of program.sustainabilityTargets ?? []) {
    const m = s.match(/(\d{1,4})\s*g\/?l/i);
    if (m) return Number(m[1]);
  }
  return undefined;
}
