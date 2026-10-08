// Compliance Reviewer (criteria keyed by ctx.complianceProfile). Single mode
// (UFGS) -> the UFC profile. The Mode B (house-qa) and Mode C (gsa-p100 / md-dgs)
// profiles + their MBE/DBE and seal-page checks were removed with those modes
// (CHANGE-05). Produces the compliance/traceability report as a byproduct (G6).

import type { Env } from '../env';
import { allSelections, eachParagraph, isSelectionResolved } from '../shared/section-ir';
import type { ComplianceCheck, ModeContext } from '../shared/types';
import type { ComplianceInput, ComplianceOutput } from './contracts';

export async function run(_env: Env, ctx: ModeContext, input: ComplianceInput): Promise<ComplianceOutput> {
  const checks: ComplianceCheck[] = [];
  const unresolved = (kind: string) =>
    input.validationFlags.filter((f) => f.kind === kind && !f.resolved).length;

  // Shared: provenance (G6).
  checks.push({
    id: 'trace',
    requirement: 'Every resolved decision writes a traceability row (G6).',
    status: input.traceCount > 0 ? 'pass' : 'fail',
    detail: `${input.traceCount} traceability rows recorded.`,
  });

  // Shared: no unresolved selection ([ ] / [_____] / perf-level) remains.
  const open = allSelections(input.ir).filter(({ selection }) => !isSelectionResolved(selection));
  checks.push({
    id: 'selections',
    requirement: 'All editor selections ([ ] / [_____] / performance level) are resolved.',
    status: open.length === 0 ? 'pass' : 'fail',
    detail: open.length === 0 ? 'No unresolved selections remain.' : `Unresolved: ${open.map((s) => s.selection.id).join(', ')}.`,
  });

  // Shared: locked spans present + preserved (G2). The "preserved verbatim"
  // determination comes from the Resolver's authoritative locked-span diff
  // (single source of truth) — NOT re-derived from the resolved IR, which cannot
  // detect a change on its own.
  const locked = [...eachParagraph(input.ir)].filter(({ paragraph }) => paragraph.locked);
  const lockedViolations = input.lockedSpanViolations ?? [];
  checks.push({
    id: 'locked',
    requirement: 'Locked spans (mandatory / unalterable agency documents) preserved verbatim (G2).',
    status: lockedViolations.length === 0 ? 'pass' : 'fail',
    detail:
      lockedViolations.length === 0
        ? `${locked.length} locked span(s) present and preserved.`
        : `Locked span(s) changed: ${lockedViolations.join(', ')}.`,
  });

  // G3: selection-mechanism exclusivity — the Resolver's authoritative result.
  const overlap = input.exclusivityViolations ?? [];
  checks.push({
    id: 'exclusivity',
    requirement: 'Each requirement is resolved by exactly one mechanism (G3).',
    status: overlap.length === 0 ? 'pass' : 'fail',
    detail: overlap.length === 0 ? 'No selection-mechanism overlap.' : `Overlap: ${overlap.join(', ')}.`,
  });

  // References (G1) — all modes with a reference list. Counted from the LIVE
  // validation flags (which gate 3 resolves), not the Validator's immutable
  // pre-triage `flagged` snapshot — otherwise a reviewer-cleared reference
  // would keep this check failing forever and Gate 5 could never admit.
  if (input.referencesList) {
    const flaggedRefs = unresolved('reference-not-found');
    checks.push({
      id: 'refs',
      requirement: 'References reach the artifact only from the controlled list by id (G1).',
      status: flaggedRefs === 0 ? 'pass' : 'fail',
      detail: flaggedRefs === 0
        ? `${input.referencesList.references.length} references validated.`
        : `${flaggedRefs} requested reference(s) unresolved — must be cleared, never invented.`,
    });
  }

  // G7 — criteria editions from data.
  checks.push({
    id: 'criteria',
    requirement: 'Criteria clauses and editions cited only from the criteria table (G7).',
    status: unresolved('criteria-not-found') === 0 ? 'pass' : 'fail',
    detail: unresolved('criteria-not-found') === 0 ? 'All criteria references resolved from data.' : `${unresolved('criteria-not-found')} criteria reference(s) unresolved.`,
  });

  // Single mode (UFGS) — always the UFC compliance profile. The house-qa /
  // gsa-p100 / md-dgs branches were removed with Modes B/C (CHANGE-05).
  ufcChecks(input, checks, unresolved);

  const fails = checks.filter((c) => c.status === 'fail').length;
  const summary =
    fails === 0
      ? `All ${checks.length} checks passed for the ${ctx.complianceProfile.toUpperCase()} profile.`
      : `${fails} of ${checks.length} checks failed for the ${ctx.complianceProfile.toUpperCase()} profile — resolve before Approve for Seal.`;

  return { report: { profile: ctx.complianceProfile, checks, traceabilityRows: input.traceCount, summary } };
}

function ufcChecks(input: ComplianceInput, checks: ComplianceCheck[], unresolved: (k: string) => number): void {
  checks.push({
    id: 'subs',
    requirement: 'Submittals reach the register only from UMSL by id (G1).',
    status: unresolved('submittal-not-found') === 0 ? 'pass' : 'fail',
    detail: unresolved('submittal-not-found') === 0
      ? `${input.register?.rows.length ?? 0} submittals validated against UMSL.`
      : `${unresolved('submittal-not-found')} requested submittal(s) unresolved.`,
  });
}

// (Mode B/C compliance checks removed — houseQaChecks / publicChecks /
//  substitutionCheck covered product grounding, perf-level election, MBE/DBE, the
//  seal-page requirement, and "or equal" substitution for the commercial + public
//  profiles. Those profiles no longer exist under single-mode UFGS, CHANGE-05.)
