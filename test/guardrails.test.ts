import { describe, it, expect } from 'vitest';
import {
  ALL_GUARDRAILS,
  assembleGuardrails,
  evaluateGuardrails,
  anyGuardrailFailed,
  type GuardrailInput,
} from '../src/shared/guardrails';
import type { GuardrailResult, ValidationFlag } from '../src/shared/types';

const resolverClean: GuardrailResult[] = [
  { id: 'G2', status: 'pass', evidence: 'locked spans unchanged' },
  { id: 'G3', status: 'pass', evidence: 'exclusive' },
];

function sectionRun(overrides: Partial<GuardrailInput> = {}): GuardrailInput {
  return {
    scope: 'section',
    resolverGuardrails: resolverClean,
    validationFlags: [],
    traceCount: 5,
    issuedHygieneClean: true,
    pdfRender: 'container',
    pdfVerified: true,
    ...overrides,
  };
}

describe('unified guardrail harness', () => {
  it('evaluates EVERY guardrail in the set for a clean section run', () => {
    const map = evaluateGuardrails(sectionRun());
    for (const id of ALL_GUARDRAILS) {
      expect(map[id], `guardrail ${id} must be present`).toBeDefined();
      expect(map[id].evidence.length).toBeGreaterThan(0);
    }
    expect(anyGuardrailFailed(map)).toBe(false);
  });

  it('marks manual-only guardrails n/a (never absent) on a section run', () => {
    const map = evaluateGuardrails(sectionRun());
    expect(map['G9'].status).toBe('n/a');
    expect(map['G15'].status).toBe('n/a');
    expect(map['G-MAN'].status).toBe('n/a');
  });

  it('THROWS if any guardrail result is missing (the core invariant)', () => {
    const partial: GuardrailResult[] = ALL_GUARDRAILS.slice(0, -1).map((id) => ({
      id,
      status: 'pass',
      evidence: 'x',
    }));
    expect(() => assembleGuardrails(partial)).toThrow(/missing guardrail result/);
  });

  it('THROWS on a duplicate guardrail result', () => {
    const dup: GuardrailResult[] = [
      ...ALL_GUARDRAILS.map((id) => ({ id, status: 'pass' as const, evidence: 'x' })),
      { id: 'G1', status: 'pass', evidence: 'again' },
    ];
    expect(() => assembleGuardrails(dup)).toThrow(/duplicate guardrail/);
  });

  it('fails G1 on an open reference-not-found flag', () => {
    const flag: ValidationFlag = {
      id: 'f1',
      kind: 'reference-not-found',
      requested: 'ASTM D3960',
      detail: 'not in UMRL',
      resolved: false,
    };
    const map = evaluateGuardrails(sectionRun({ validationFlags: [flag] }));
    expect(map['G1'].status).toBe('fail');
    expect(anyGuardrailFailed(map)).toBe(true);
  });

  it('a resolved flag does not fail G1', () => {
    const flag: ValidationFlag = {
      id: 'f1',
      kind: 'reference-not-found',
      requested: 'ASTM D3960',
      detail: 'resolved by reviewer',
      resolved: true,
    };
    const map = evaluateGuardrails(sectionRun({ validationFlags: [flag] }));
    expect(map['G1'].status).toBe('pass');
  });

  it('fails G16 for a worker-fallback PDF, passes for container+verified', () => {
    const bad = evaluateGuardrails(sectionRun({ pdfRender: 'worker-fallback', pdfVerified: false }));
    expect(bad['G16'].status).toBe('fail');
    const good = evaluateGuardrails(sectionRun());
    expect(good['G16'].status).toBe('pass');
  });

  it('G16/G13 are n/a before freeze (not silently pass)', () => {
    const map = evaluateGuardrails(
      sectionRun({ pdfRender: undefined, pdfVerified: undefined, issuedHygieneClean: undefined }),
    );
    expect(map['G16'].status).toBe('n/a');
    expect(map['G13'].status).toBe('n/a');
  });

  it('manual run: fails G9 on an open ref-edition conflict and G-MAN on a seal gap', () => {
    const map = evaluateGuardrails({
      scope: 'manual',
      resolverGuardrails: resolverClean,
      validationFlags: [],
      traceCount: 20,
      openInBookSelections: 0,
      issuedHygieneClean: true,
      pdfRender: 'container',
      pdfVerified: true,
      manualCoordinationFlags: [
        { kind: 'ref-edition-conflict', detail: 'ASTM D16 2020 vs 2017', sections: ['09 90 00', '09 91 00'], severity: 'high', status: 'open' },
        { kind: 'seal-coverage-gap', detail: 'Division 26 unsealed', sections: ['26 05 00'], severity: 'high', status: 'open' },
      ],
    });
    expect(map['G9'].status).toBe('fail');
    expect(map['G-MAN'].status).toBe('fail');
  });

  it('manual run: fails G15 when open in-book selections remain', () => {
    const map = evaluateGuardrails({
      scope: 'manual',
      resolverGuardrails: resolverClean,
      validationFlags: [],
      traceCount: 20,
      openInBookSelections: 3,
      issuedHygieneClean: true,
    });
    expect(map['G15'].status).toBe('fail');
  });
});
