import { describe, it, expect } from 'vitest';
import { secToSectionIR } from '../src/corpus/sec-to-ir';
import { extractPublishedContent } from '../src/corpus/ufc-cim';
import { handleAdminCorpusRoutes } from '../src/corpus/admin';
import { assertSectionIssuedClean } from '../src/shared/specsintact';
import { makeTestDb } from './sqlite-d1';
import type { Env } from '../src/env';

const SEC = `<SEC><SCN>07 92 00</SCN><STL>JOINT SEALANTS</STL>
<PRT><TTL>PART 1 GENERAL</TTL>
<SPT><TTL>SUMMARY</TTL>
<TXT>Provide [silicone] sealant for exterior joints.</TXT>
</SPT></PRT></SEC>`;

describe('sec-to-ir (SEC master → SectionIR)', () => {
  it('parses section number, title, parts, and turns a bracket into a selection', () => {
    const { ir } = secToSectionIR(SEC, '07 92 00');
    expect(ir.section).toBe('07 92 00');
    expect(ir.title.toLowerCase()).toContain('joint sealants');
    expect(ir.parts.length).toBeGreaterThan(0);
    const selections = ir.parts.flatMap((p) => p.articles.flatMap((a) => a.paragraphs.flatMap((pp) => pp.selections ?? [])));
    expect(selections.length).toBeGreaterThan(0);
    // The {{id}} placeholder must be inline so the issued-hygiene check sees a
    // resolvable decision, not a raw bracket.
    const para = ir.parts[0].articles[0].paragraphs[0];
    expect(para.text).toMatch(/\{\{/);
  });
});

describe('ufc-cim extractor (G14 — no licensed CSI classification ids)', () => {
  it('extracts clauses + edition but NEVER masterFormatId/uniFormatId', () => {
    const cim = {
      criterion: { number: 'UFC 4-510-01', versionNumber: 'Change 5', masterFormatId: '09 90 00', uniFormatId: 'C2010' },
      sections: [
        { number: '2-1', title: 'Finishes', text: 'Interior finishes shall comply.', masterFormatId: '09 90 00' },
      ],
    };
    const out = extractPublishedContent(cim);
    expect(out.clauses.length).toBeGreaterThan(0);
    expect(out.edition).toBe('Change 5');
    // The serialized result must not carry the licensed CSI ids anywhere.
    const blob = JSON.stringify(out);
    expect(blob).not.toMatch(/masterFormatId/i);
    expect(blob).not.toMatch(/uniFormatId/i);
    expect(blob).not.toContain('C2010');
  });
});

describe('admin corpus auth (blueprint §2.4)', () => {
  it('401s when no secret is configured and dev-login is off', async () => {
    const { env } = makeTestDb();
    const e = { ...env, ALLOW_DEV_LOGIN: undefined } as unknown as Env;
    const res = await handleAdminCorpusRoutes(
      new Request('https://x/admin/corpus/staleness'),
      e,
      new URL('https://x/admin/corpus/staleness'),
    );
    expect(res?.status).toBe(401);
  });

  it('allows local dev (ALLOW_DEV_LOGIN=true) and honors a shared secret', async () => {
    const { env } = makeTestDb();
    const dev = { ...env, ALLOW_DEV_LOGIN: 'true' } as unknown as Env;
    const ok = await handleAdminCorpusRoutes(
      new Request('https://x/admin/corpus/staleness'),
      dev,
      new URL('https://x/admin/corpus/staleness'),
    );
    expect(ok?.status).toBe(200);

    const secret = { ...env, ALLOW_DEV_LOGIN: undefined, ADMIN_SECRET: 's3cret' } as unknown as Env;
    const denied = await handleAdminCorpusRoutes(
      new Request('https://x/admin/corpus/staleness'),
      secret,
      new URL('https://x/admin/corpus/staleness'),
    );
    expect(denied?.status).toBe(401);
    const allowed = await handleAdminCorpusRoutes(
      new Request('https://x/admin/corpus/staleness', { headers: { 'x-admin-secret': 's3cret' } }),
      secret,
      new URL('https://x/admin/corpus/staleness'),
    );
    expect(allowed?.status).toBe(200);
  });
});

describe('sec-to-ir output is issued-clean after inert flattening (G13)', () => {
  it('a section with only inert brackets carries no unresolved markup in titles', () => {
    const sec = `<SEC><SCN>09 90 00</SCN><STL>PAINTS AND COATING[S]</STL>
<PRT><TTL>PART 1 GENERAL</TTL><SPT><TTL>SUMMARY</TTL>
<TXT>Paint wall[s] and ceiling[s].</TXT></SPT></PRT></SEC>`;
    const { ir } = secToSectionIR(sec, '09 90 00');
    // Title [s] is inert -> flattened to "COATINGS"; no bracket should remain in titles.
    expect(ir.title).not.toMatch(/\[/);
  });
});
