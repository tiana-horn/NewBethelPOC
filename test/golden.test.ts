import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, type TestDb } from './sqlite-d1';
import { agents } from '../src/agents/registry';
import { resetUfcIndexCache } from '../src/agents/resolver';
import { evaluateGuardrails } from '../src/shared/guardrails';
import { ufgsPainting } from '../src/corpus/ufgs-09-90-00';
import { DEFAULT_PARAMS, DEFAULT_SCHEDULE, DEFAULT_DRAWINGS } from '../src/fixtures';
import { allSelections, isSelectionResolved } from '../src/shared/section-ir';
import type { ModeContext } from '../src/shared/types';

const ctx: ModeContext = {
  mode: 'UFGS',
  retrievalNamespace: 'ufgs',
  rulesetId: 'ufgs-brackets-tailoring-v1',
  tagProfile: 'specsintact',
  referenceListId: 'UMRL',
  stylePackId: 'ufgs',
  complianceProfile: 'ufc',
  artifactSet: [],
  modelBindings: {
    drafter: 'x', resolver: 'x', validator: 'x', coordinator: 'x', compliance: 'x', embeddings: 'x',
  },
  agency: 'ARMY',
  delivery: 'DBB',
  constructionAgent: 'USACE',
};

let t: TestDb;
beforeEach(() => {
  resetUfcIndexCache();
  t = makeTestDb();
  // UMRL — 6 rows; ASTM D3960 deliberately omitted (G1 demonstration).
  t.raw.exec(`
    INSERT INTO ref_list (rid, list_id, org, designation, edition_date, title, active) VALUES
      ('rid-astm-d16','UMRL','ASTM','ASTM D16','2020','Terminology for Paint',1),
      ('rid-astm-d4258','UMRL','ASTM','ASTM D4258','2017','Surface Cleaning Concrete',1),
      ('rid-mpi-43','UMRL','MPI','MPI 43','2021','Interior Latex, Eggshell',1),
      ('rid-mpi-54','UMRL','MPI','MPI 54','2021','Interior Latex, Semi-Gloss',1),
      ('rid-sspc-sp1','UMRL','SSPC-AMPP','SSPC-SP 1','2015','Solvent Cleaning',1),
      ('rid-sspc-sp3','UMRL','SSPC-AMPP','SSPC-SP 3','2018','Power Tool Cleaning',1);
    INSERT INTO sub_list (usid, list_id, section, sd_code, item, default_class, notes) VALUES
      ('usid-sd03','UMRL','09 90 00','SD-03','Coating Products','G',NULL),
      ('usid-sd04','UMRL','09 90 00','SD-04','Samples','G',NULL),
      ('usid-sd07','UMRL','09 90 00','SD-07','VOC Compliance Certificate','S',NULL);
    INSERT INTO criteria (cid, profile, document, edition, clause, text) VALUES
      ('cid-ufc-fmt','ufc','UFC 1-300-02','2023','Format','UFGS formatting.');
  `);
  // SD-06 Adhesion Test Reports deliberately omitted from UMSL (G1 demonstration).
});

describe('golden pipeline: draft → resolve → validate (USE_AI=false, deterministic)', () => {
  it('resolves every bracket/fill from project data or the UFGS default (G2/G3 clean)', async () => {
    const ir = ufgsPainting();
    const resolved = await agents.resolver(t.env, ctx, { ir, params: DEFAULT_PARAMS, schedule: DEFAULT_SCHEDULE });

    expect(resolved.lockedViolations).toEqual([]); // G2
    expect(resolved.exclusivityViolations).toEqual([]); // G3
    const g2 = resolved.guardrails.find((g) => g.id === 'G2');
    const g3 = resolved.guardrails.find((g) => g.id === 'G3');
    expect(g2?.status).toBe('pass');
    expect(g3?.status).toBe('pass');

    // Every selection resolved (project data / UFGS default) — nothing invented.
    const open = allSelections(resolved.ir).filter(({ selection }) => !isSelectionResolved(selection));
    expect(open).toEqual([]);
    expect(resolved.traces.length).toBeGreaterThan(0);
  });

  it('validates references/submittals against D1 and FLAGS the intentional omissions (G1)', async () => {
    const ir = ufgsPainting();
    const resolved = await agents.resolver(t.env, ctx, { ir, params: DEFAULT_PARAMS, schedule: DEFAULT_SCHEDULE });
    const v = await agents.validator(t.env, ctx, { ir: resolved.ir, projectId: 'p1' });

    expect(v.referencesList.references.map((r) => r.rid)).toContain('rid-astm-d16');
    expect(v.referencesList.references.length).toBe(6);
    // ASTM D3960 is not in UMRL -> flagged, never invented.
    expect(v.flags.some((f) => f.kind === 'reference-not-found' && /D3960/.test(f.requested))).toBe(true);
    // SD-06 is not in UMSL -> flagged.
    expect(v.flags.some((f) => f.kind === 'submittal-not-found' && /Adhesion/.test(f.requested))).toBe(true);
    // Validated submittals in the register.
    expect(v.register.rows.map((r) => r.usid).sort()).toEqual(['usid-sd03', 'usid-sd04', 'usid-sd07']);
    // Criteria edition came from data (G7).
    expect(v.criteriaMatrix.some((c) => c.document === 'UFC 1-300-02' && c.edition === '2023')).toBe(true);
    // A G submittal got a defaulted approving authority (USACE) with ufgs-default basis.
    const sd03 = v.register.rows.find((r) => r.usid === 'usid-sd03');
    expect(sd03?.approvingAuthority).toMatch(/USACE/);
    expect(sd03?.approvingAuthorityBasis).toBe('ufgs-default');
  });

  it('coordinator flags the planted spec-vs-drawing conflict in Room 112', async () => {
    const ir = ufgsPainting();
    const c = await agents.coordinator(t.env, ctx, { ir, schedule: DEFAULT_SCHEDULE, drawings: DEFAULT_DRAWINGS });
    expect(c.flags.some((f) => f.type === 'spec-vs-drawing-conflict' && /112/.test(f.location))).toBe(true);
  });

  it('the unified harness: open G1 flags FAIL the run; resolving them passes it', async () => {
    const ir = ufgsPainting();
    const resolved = await agents.resolver(t.env, ctx, { ir, params: DEFAULT_PARAMS, schedule: DEFAULT_SCHEDULE });
    const v = await agents.validator(t.env, ctx, { ir: resolved.ir, projectId: 'p1' });

    const failing = evaluateGuardrails({
      scope: 'section',
      resolverGuardrails: resolved.guardrails,
      validationFlags: v.flags,
      traceCount: resolved.traces.length + v.traces.length,
    });
    expect(failing['G1'].status).toBe('fail'); // D3960 + SD-06 unresolved

    const cleared = v.flags.map((f) => ({ ...f, resolved: true }));
    const passing = evaluateGuardrails({
      scope: 'section',
      resolverGuardrails: resolved.guardrails,
      validationFlags: cleared,
      traceCount: resolved.traces.length + v.traces.length,
    });
    expect(passing['G1'].status).toBe('pass');
  });
});

describe('drafter (G12 honesty)', () => {
  it('returns an honestly-empty IR for an un-ingested section (never fabricates)', async () => {
    const out = await agents.drafter(t.env, ctx, { params: DEFAULT_PARAMS, schedule: DEFAULT_SCHEDULE, section: '07 92 00' });
    expect(out.ir.parts).toEqual([]);
    expect(out.provenance.some((p) => /no real UFGS corpus/i.test(p))).toBe(true);
  });

  it('drafts a section from ingested R2 corpus when present', async () => {
    const ir = ufgsPainting();
    t.raw.exec(`INSERT INTO ufgs_corpus_section (section, title, r2_key, vectorize_ns, source_edition, ingested_at) VALUES ('09 90 00','Paints and Coatings','corpus/ufgs/09-90-00.json','ufgs','2026-Q2',datetime('now'))`);
    t.putR2('corpus/ufgs/09-90-00.json', JSON.stringify(ir));
    const out = await agents.drafter(t.env, ctx, { params: DEFAULT_PARAMS, schedule: DEFAULT_SCHEDULE, section: '09 90 00' });
    expect(out.ir.section).toBe('09 90 00');
    expect(out.ir.parts.length).toBeGreaterThan(0);
  });
});
