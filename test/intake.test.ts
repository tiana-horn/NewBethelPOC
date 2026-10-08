import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeTestDb } from './sqlite-d1';
import { normalizeInputs } from '../src/intake/normalize';
import { toPipelineInputs } from '../src/intake/pipeline-inputs';
import type { ModeContext } from '../src/shared/types';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => new Uint8Array(readFileSync(join(here, '..', 'fixtures', n)));

const ctx = { mode: 'UFGS', retrievalNamespace: 'ufgs', referenceListId: 'UMRL' } as unknown as ModeContext;

describe('intake normalization (many parsers, one model)', () => {
  it('parses a finish-schedule CSV into spaces + finishes with provenance', async () => {
    const { env } = makeTestDb();
    const res = await normalizeInputs(env, ctx, 'p1', [
      { kind: 'finish-schedule', filename: 'finish-schedule.csv', bytes: fixture('finish-schedule.csv') },
      { kind: 'drawings', filename: 'drawings.csv', bytes: fixture('drawings.csv') },
    ]);

    expect(res.perInput.every((p) => p.parseStatus === 'parsed')).toBe(true);
    expect(res.data.finishes.length).toBe(3);
    expect(res.data.finishes.map((f) => f.substrate)).toContain('gypsum board');
    expect(res.data.spaces.length).toBeGreaterThan(0);
    // The drawings CSV carries the planted Room 112 "wall covering" conflict.
    expect(res.data.drawings.find((d) => d.room === '112')?.shownFinish).toMatch(/wall covering/i);
    expect(res.data.provenance.some((p) => p.field === 'finishes')).toBe(true);
  });

  it('maps ExtractedProjectData onto the pipeline inputs the agents consume', async () => {
    const { env } = makeTestDb();
    const res = await normalizeInputs(env, ctx, 'p1', [
      { kind: 'finish-schedule', filename: 'finish-schedule.csv', bytes: fixture('finish-schedule.csv') },
    ]);
    const inputs = toPipelineInputs(res.data, { agency: 'ARMY' });
    expect(inputs.schedule.length).toBe(3);
    expect(inputs.schedule[0]).toHaveProperty('substrate');
    expect(inputs.params.substratesInScope).toContain('gypsum board');
    expect(inputs.params.agency).toBe('ARMY');
  });
});
