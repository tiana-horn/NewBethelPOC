import { describe, it, expect } from 'vitest';
import { makeTestDb } from './sqlite-d1';
import { buildModeContext } from '../src/mode/mode-context';

describe('buildModeContext', () => {
  it('always builds the UFGS profile and derives the construction agent from agency', async () => {
    const { env } = makeTestDb();
    const army = await buildModeContext(env, 'UFGS', { agency: 'ARMY' });
    expect(army.mode).toBe('UFGS');
    expect(army.referenceListId).toBe('UMRL');
    expect(army.stylePackId).toBe('ufgs');
    expect(army.complianceProfile).toBe('ufc');
    expect(army.constructionAgent).toBe('USACE');
    expect(army.modelBindings.drafter).toBeTruthy();

    const navy = await buildModeContext(env, 'UFGS', { agency: 'NAVY' });
    expect(navy.constructionAgent).toBe('NAVFAC');
    const af = await buildModeContext(env, 'UFGS', { agency: 'AIRFORCE' });
    expect(af.constructionAgent).toBe('AFCEC');
  });

  it('binds a selected master namespace + style pack override', async () => {
    const { env } = makeTestDb();
    const ctx = await buildModeContext(env, 'UFGS', {
      masterId: 'm1', masterOwner: 'org-x', masterNamespace: 'master:org-x:m1', stylePackId: 'md-dgs',
    });
    expect(ctx.retrievalNamespace).toBe('master:org-x:m1');
    expect(ctx.baseRetrievalNamespace).toBe('ufgs');
    expect(ctx.stylePackId).toBe('md-dgs');
  });
});
