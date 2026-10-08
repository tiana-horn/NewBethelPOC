// Validator (data-driven). G1 / G4 / G7. Lookups are scoped by
// ctx.referenceListId (UMRL); the submittal lookup needs no SD code; criteriaRef
// links are validated against the `criteria` table (G7 — editions are data, never
// model recall). Authoritative values ALWAYS come from D1; an unresolved request
// becomes a FLAG, never an invented value.

import type { Env } from '../env';
import { loadCriteriaMap, loadProductMap, loadReferenceMap, loadSubmittalMap } from '../db/d1';
import { eachParagraph } from '../shared/section-ir';
import type {
  CriteriaMatrixRow,
  FlaggedReference,
  ModeContext,
  ReferenceRow,
  ResolutionBasis,
  SubmittalRegisterRow,
  TraceRow,
  ValidationFlag,
} from '../shared/types';
import type { ValidateInput, ValidateOutput } from './contracts';

// The real, standard approving-authority office for each construction agent,
// cited when a G-classified submittal has no office named directly in the SEC
// source (G13 default; never invented per-project data).
function defaultApprovingAuthority(ctx: ModeContext): string {
  switch (ctx.constructionAgent) {
    case 'USACE':
      return 'USACE Resident Engineer / Contracting Officer';
    case 'NAVFAC':
      return 'NAVFAC Resident Officer in Charge of Construction (ROICC)';
    case 'AFCEC':
      return 'AFCEC Contracting Officer';
    default:
      return 'Contracting Officer (Government)';
  }
}
// A classification the SEC source wrote as e.g. 'G(BDPTS)' already names the
// reviewing office — split it out rather than defaulting over it.
const CLASS_WITH_OFFICE = /^([GS])\s*\(([^)]+)\)\s*$/;

export async function run(env: Env, ctx: ModeContext, input: ValidateInput): Promise<ValidateOutput> {
  const ir = structuredClone(input.ir);
  const listId = ctx.referenceListId;
  const references: ReferenceRow[] = [];
  const flaggedRefs: FlaggedReference[] = [];
  const register: SubmittalRegisterRow[] = [];
  const criteriaMatrix: CriteriaMatrixRow[] = [];
  const flags: ValidationFlag[] = [];
  const traces: TraceRow[] = [];
  const seenRids = new Set<string>();
  const seenUsids = new Set<string>();
  const seenCids = new Set<string>();
  let flagN = 0;

  // Batch the four controlled-list lookups into one query each per run (kills the
  // N+1). O(1) exact-match lookups below; same resolve/flag semantics (G1/G4/G7).
  const cids: string[] = [];
  const pids: string[] = [];
  for (const { paragraph } of eachParagraph(ir)) {
    if (paragraph.criteriaRef) cids.push(paragraph.criteriaRef);
    if (paragraph.productCategory && paragraph.basisOfDesignPid) pids.push(paragraph.basisOfDesignPid);
  }
  const [refMap, subMap, criteriaMap, productMap] = await Promise.all([
    loadReferenceMap(env.DB, listId),
    loadSubmittalMap(env.DB, listId, ir.section),
    loadCriteriaMap(env.DB, cids),
    loadProductMap(env.DB, pids),
  ]);

  for (const { paragraph } of eachParagraph(ir)) {
    // ---- G1: references vs the controlled list (exact) ----
    if (paragraph.refRequests?.length) {
      const resolved: string[] = [];
      for (const rq of paragraph.refRequests) {
        const row = refMap.get(`${rq.org.trim()}|${rq.designation.trim()}`) ?? null;
        if (row) {
          resolved.push(row.rid);
          if (!seenRids.has(row.rid)) {
            seenRids.add(row.rid);
            references.push({
              rid: row.rid, org: row.org, designation: row.designation,
              editionDate: row.edition_date, title: row.title, validated: true,
            });
            traces.push({
              element: `reference:${row.designation}`,
              decision: `validated ${row.rid} (${row.edition_date})`,
              sourceType: 'REF-LIST', sourceRef: `${listId}:${row.rid}`, confidence: 1,
            });
          }
        } else {
          flaggedRefs.push({ requestedDesignation: rq.designation, reason: `not found in ${listId}` });
          flags.push({
            id: `vf-${++flagN}`, kind: 'reference-not-found', requested: `${rq.org} ${rq.designation}`,
            detail: `Reference ${rq.designation} is not in the controlled list ${listId}. Resolve manually; the system will not invent a designation or date.`,
            paragraphId: paragraph.id, resolved: false,
          });
        }
      }
      paragraph.references = resolved; // D1-backed ids only (G1)
    }

    // ---- G1: submittals vs the controlled list (exact; no SD code required) ----
    if (paragraph.subRequests?.length) {
      const resolved: string[] = [];
      for (const sq of paragraph.subRequests) {
        const row = subMap.get(sq.item.trim()) ?? null;
        if (row) {
          resolved.push(row.usid);
          const rawClass = sq.classification ?? row.default_class ?? '';
          // Split any embedded office code out of the classification (format fix)
          // and resolve/default the approving authority for a G row.
          const officeMatch = rawClass.match(CLASS_WITH_OFFICE);
          const classification = officeMatch ? officeMatch[1] : rawClass;
          let approvingAuthority: string | undefined;
          let approvingAuthorityBasis: ResolutionBasis | undefined;
          if (classification === 'G') {
            if (officeMatch) {
              approvingAuthority = officeMatch[2].trim();
              approvingAuthorityBasis = 'project-data';
            } else {
              approvingAuthority = defaultApprovingAuthority(ctx);
              approvingAuthorityBasis = 'ufgs-default';
            }
          }
          if (!seenUsids.has(row.usid)) {
            seenUsids.add(row.usid);
            register.push({ sdCode: row.sd_code ?? undefined, item: row.item, classification, usid: row.usid, paragraphId: paragraph.id, approvingAuthority, approvingAuthorityBasis });
            traces.push({
              element: `submittal:${row.item}`,
              decision: `validated ${row.usid} [${classification || '—'}]`,
              sourceType: 'REF-LIST', sourceRef: `${listId}:${row.usid}`, confidence: 1,
            });
            if (approvingAuthority) {
              traces.push({
                element: `submittal-authority:${row.item}`,
                decision: approvingAuthority,
                sourceType: approvingAuthorityBasis === 'project-data' ? 'REF-LIST' : 'UFGS-DEFAULT',
                sourceRef: approvingAuthorityBasis === 'project-data' ? `${listId}:${row.usid}` : 'UFGS 01 33 00 SUBMITTAL PROCEDURES',
                confidence: 1,
                basis: approvingAuthorityBasis,
                justification:
                  approvingAuthorityBasis === 'project-data'
                    ? `The SEC submittal classification for "${row.item}" names the reviewing office "${approvingAuthority}" directly.`
                    : `No reviewing office is named for "${row.item}"; defaulted to the ${ctx.constructionAgent ?? 'Government'} approving authority per UFGS 01 33 00 Submittal Procedures (G-classified submittals require Government approval).`,
              });
            }
          }
        } else {
          flags.push({
            id: `vf-${++flagN}`, kind: 'submittal-not-found',
            requested: `${sq.sdCode ? sq.sdCode + ' ' : ''}${sq.item}`,
            detail: `Submittal "${sq.item}" is not in the controlled list ${listId} for ${ir.section}. Resolve manually; the system will not invent a submittal item.`,
            paragraphId: paragraph.id, resolved: false,
          });
        }
      }
      paragraph.submittals = resolved;
    }

    // ---- G7: criteria citation only from the criteria table (with editions) ----
    if (paragraph.criteriaRef) {
      const c = criteriaMap.get(paragraph.criteriaRef.trim()) ?? null;
      if (c) {
        if (!seenCids.has(c.cid)) {
          seenCids.add(c.cid);
          criteriaMatrix.push({
            requirement: paragraph.text.replace(/\{\{[^}]+\}\}/g, '…').slice(0, 90),
            electedLevel: '—', // no performance-level selections under the single UFGS mode
            clause: c.clause, document: c.document, edition: c.edition,
          });
          traces.push({
            element: `criteria:${c.clause}`,
            decision: `${c.document} ${c.edition} — ${c.clause}`,
            sourceType: c.profile === 'ufc' ? 'UFC' : 'AGENCY-MANUAL',
            sourceRef: c.cid, confidence: 1,
          });
        }
      } else {
        flags.push({
          id: `vf-${++flagN}`, kind: 'criteria-not-found', requested: paragraph.criteriaRef,
          detail: `Criteria clause ${paragraph.criteriaRef} is not in the criteria table. Editions must come from data, not model memory (G7).`,
          paragraphId: paragraph.id, resolved: false,
        });
      }
    }

    // ---- G4: product grounding (dormant on the live UFGS path, but real) ----
    if (paragraph.productCategory) {
      if (paragraph.basisOfDesignPid) {
        const prod = productMap.get(paragraph.basisOfDesignPid.trim()) ?? null;
        if (prod) {
          traces.push({
            element: `product:${prod.category}`,
            decision: `grounded ${prod.pid} (${prod.manufacturer} ${prod.product_name})`,
            sourceType: 'product-library', sourceRef: prod.pid, confidence: 1,
          });
        } else {
          flags.push({
            id: `vf-${++flagN}`, kind: 'product-unverifiable', requested: paragraph.basisOfDesignPid,
            detail: `Basis-of-design pid ${paragraph.basisOfDesignPid} is not in product_library.`,
            paragraphId: paragraph.id, resolved: false,
          });
        }
      } else {
        flags.push({
          id: `vf-${++flagN}`, kind: 'product-unverifiable', requested: paragraph.productCategory,
          detail: `No product in product_library for category "${paragraph.productCategory}". Provide a verifiable basis-of-design; the system will not invent a manufacturer.`,
          paragraphId: paragraph.id, resolved: false,
        });
      }
    }
  }

  return {
    ir,
    referencesList: { references, flagged: flaggedRefs },
    register: { rows: register },
    criteriaMatrix,
    flags,
    traces,
  };
}
