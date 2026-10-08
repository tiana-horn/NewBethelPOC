import { describe, it, expect } from 'vitest';
import { coordinateManual } from '../src/manual/coordinator-manual';
import { aggregateReferences } from '../src/manual/aggregate';
import { sealCoverageFlags } from '../src/manual/assembler';
import { selectAgencyVariant, divisionOf, orderSections } from '../src/manual/division';
import type { SectionRunResult } from '../src/manual/orchestrator';
import type { ManualSectionRef, ReferenceRow } from '../src/shared/types';

function result(section: string, refs: ReferenceRow[]): SectionRunResult {
  return {
    section,
    status: 'complete',
    referencesList: { references: refs, flagged: [] },
    validationFlags: [],
    coordinationFlags: [],
    traces: [],
    guardrails: [],
  };
}
const ref = (designation: string, editionDate: string): ReferenceRow => ({
  rid: `rid-${designation}-${editionDate}`, org: 'ASTM', designation, editionDate, title: designation, validated: true,
});

const outlineRow = (section: string): any => ({
  id: section, section, title: section, division: divisionOf(section),
  orderIndex: 0, role: 'technical', draftingMode: 'draft',
});

describe('manual-scope coordination', () => {
  it('G9 — flags a standard cited at two different editions across sections', () => {
    const flags = coordinateManual({
      outline: [outlineRow('09 90 00'), outlineRow('09 91 00')],
      results: [
        result('09 90 00', [ref('ASTM D16', '2020')]),
        result('09 91 00', [ref('ASTM D16', '2017')]),
      ],
      extracted: null,
      drawings: [],
    });
    const g9 = flags.find((f) => f.kind === 'ref-edition-conflict');
    expect(g9).toBeDefined();
    expect(g9!.sections.sort()).toEqual(['09 90 00', '09 91 00']);
  });

  it('does not flag when the same standard is cited at one edition', () => {
    const flags = coordinateManual({
      outline: [outlineRow('09 90 00'), outlineRow('09 91 00')],
      results: [result('09 90 00', [ref('ASTM D16', '2020')]), result('09 91 00', [ref('ASTM D16', '2020')])],
      extracted: null,
      drawings: [],
    });
    expect(flags.some((f) => f.kind === 'ref-edition-conflict')).toBe(false);
  });
});

describe('G-MAN — seal coverage', () => {
  it('flags a division with no sealing assignment covering it', () => {
    const outline = [outlineRow('09 90 00'), outlineRow('26 05 00')];
    const flags = sealCoverageFlags(outline, [
      { userId: 'u1', userName: 'A. Architect', roleLabel: 'Architect of Record', divisionScope: ['09'] },
    ]);
    const gap = flags.find((f) => f.kind === 'seal-coverage-gap');
    expect(gap).toBeDefined();
    expect(gap!.sections).toContain('26 05 00'); // Division 26 uncovered
  });

  it('no gap when every division is covered', () => {
    const outline = [outlineRow('09 90 00')];
    const flags = sealCoverageFlags(outline, [
      { userId: 'u1', userName: 'A', roleLabel: 'AOR', divisionScope: ['09'] },
    ]);
    expect(flags.length).toBe(0);
  });
});

describe('aggregation + ordering + agency variants', () => {
  it('aggregateReferences dedups a standard cited by multiple sections', () => {
    const refs = aggregateReferences([
      result('09 90 00', [ref('ASTM D16', '2020')]),
      result('09 91 00', [ref('ASTM D16', '2020')]),
    ]);
    expect(refs.filter((r) => r.designation === 'ASTM D16').length).toBe(1);
  });

  it('orderSections sorts by MasterFormat number', () => {
    const o = orderSections([
      { section: '09 90 00' } as ManualSectionRef,
      { section: '01 33 00' } as ManualSectionRef,
      { section: '03 30 00' } as ManualSectionRef,
    ]);
    expect(o.map((s) => s.section)).toEqual(['01 33 00', '03 30 00', '09 90 00']);
  });

  it('selectAgencyVariant collapses a numbering slot to the agency-tailored file', () => {
    const candidates = [
      { section: '01 33 00' },
      { section: '01 33 00.00 10' }, // Army-tailored variant
      { section: '01 33 00.00 20' }, // Navy-tailored variant
    ];
    const army = selectAgencyVariant(candidates, 'ARMY').map((c) => c.section);
    // Exactly one 01 33 00 slot survives, and it isn't both variants.
    expect(army.filter((s) => s.startsWith('01 33 00')).length).toBe(1);
  });
});
