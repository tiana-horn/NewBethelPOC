# Guardrail reference

Every guardrail ID actually referenced in code or tests, verified by
`grep -rohE "G(1[0-9]|[1-9])\b" src/ test/` plus `G-MAN`/`G-CMP-1`. Two
enforcement mechanisms coexist in this codebase — see the note below the
table before trusting either "G1–G8" or "G9+" claims at face value.

## Two different enforcement mechanisms

**G1–G8** go through `src/shared/guardrails.ts`'s `assembleGuardrails()`,
which **throws** if any of the 8 is missing from the evaluated-results list
passed to it. This is a real exhaustiveness guarantee: a guardrail in this
set cannot silently be recorded "pass" without code that actually computed
its status. Both `workflow.ts` and `manual-workflow.ts` call
`evaluateGuardrails()` (which wraps `assembleGuardrails`) before writing a
manifest.

**G9, G11–G16, G-MAN, G-CMP-1** are real, code-enforced checks (grep
confirms each has an actual blocking/flagging code path, not just a
comment), but each lives at its own point of use — there is no shared file
that asserts "all of these were evaluated this run." A missing check in
this group would not throw; it would just not block anything. This is a
real architectural distinction, not a naming inconsistency — worth knowing
before assuming G9+ have the same hard guarantee as G1–G8.

**G10 is retired.** It named the OmniClass→MasterFormat crosswalk (licensed
CSI IP), reverted in CHANGE-05. It appears only in two comments explaining
its own removal (`src/corpus/sec-to-ir.ts`, `src/db/corpus.ts`) and is
enforced by nothing live.

---

## G1 — Validate, don't generate (references & submittals)
**Prevents**: a fabricated reference designation, edition, or submittal
classification reaching issued output.
**Enforced**: `src/agents/validator.ts` resolves every `refRequest`/
`subRequest` against `ref_list`/`sub_list` (D1) or emits a `ValidationFlag`
— never a literal. `src/shared/specsintact.ts` independently fails closed
if any `<REF>`/`<SUB>` id in the emitted XML wasn't D1-validated.
**Evaluated by**: `src/shared/guardrails.ts flagGuardrails` (open
`reference-not-found`/`submittal-not-found` flags → fail).
**Tested**: `test/guardrails.test.ts`, `test/golden.test.ts`.

## G2 — Locked/mandatory spans preserved verbatim
**Prevents**: the Resolver silently editing unalterable text (e.g. General
Conditions, mandatory UFC 1-300-02 language).
**Enforced**: `src/agents/resolver.ts` + `src/shared/section-ir.ts
lockedSpansUnchanged`; both `workflow.ts` and `manual-workflow.ts` throw
immediately on a non-empty violation list (before persisting).
**Evaluated by**: `lockedSpanGuardrail` in `shared/guardrails.ts`.
**Tested**: `test/guardrails.test.ts`, `test/resolver-brackets.test.ts`.

## G3 — Tailoring or brackets, never both
**Prevents**: the same requirement being resolved by two mechanisms at once
(a silent double-resolution that could disagree with itself).
**Enforced**: `src/agents/resolver.ts checkExclusivity`.
**Evaluated by**: `exclusivityGuardrail`.
**Tested**: `test/guardrails.test.ts`.

## G4 — Product grounding
**Prevents**: a basis-of-design product being invented rather than pulled
from `product_library`.
**Enforced**: `src/agents/resolver.ts` grounds from `product_library` only;
`validator.ts` flags `product-unverifiable`. **Dormant on the live UFGS
path** — no current UFGS drafting path sets `paragraph.productCategory`, so
this guardrail always evaluates "pass (nothing to check)" in practice today.
The code and its dedicated tests are real, just not exercised by a live
UFGS run.
**Evaluated by**: `flagGuardrails`.
**Tested**: `test/golden.test.ts`, `test/perf-bench.test.ts`.

## G5 — Blocking HITL on unresolved items
**Prevents**: a run reaching Freeze with an unresolved blocking gate.
**Enforced**: `session-do.ts`/`manual-do.ts` refuse gate3/gate5 (and
M-DECIDE/M-COORD) admission until cleared; this is asserted as a
**structural** invariant (`structuralGuardrails()` in `shared/guardrails.ts`
returns a hardcoded `pass` with evidence text, not derived from per-run
data — the actual enforcement is the gate-rejection code path itself, which
`decisions.test.ts`/`manual.test.ts` exercise indirectly).
**Tested**: exercised across `manual.test.ts`, `guardrail-assembly.test.ts`.

## G6 — Provenance on every decision
**Prevents**: an unrecorded, unauditable decision.
**Enforced**: every agent returns `TraceRow[]`; `src/db/d1.ts appendTraces`
persists to `traceability` (idempotent via a unique index).
**Evaluated by**: `traceGuardrail` (pass iff `traceCount > 0`).
**Tested**: `test/guardrail-assembly.test.ts`.

## G7 — Criteria clauses/editions from data
**Prevents**: a criteria edition coming from model recall instead of the
`criteria` table.
**Enforced**: `validator.ts` + `db/d1.ts` resolve `criteria` rows only.
**Evaluated by**: `flagGuardrails` (open `criteria-not-found` → fail).
**Tested**: `test/golden.test.ts`, `test/ufc-criteria.test.ts`.

## G8 — No signing key, no applied seal
**Prevents**: the system ever holding key material or claiming to apply a
real seal/signature.
**Enforced**: `workflow.ts`/`manual/freeze.ts` render placeholder text only
("SEAL PLACEHOLDER"/"SIGNATURE PLACEHOLDER"); no key-handling code exists
anywhere in `src/` (verified: `grep -rE 'privateKey|pkcs|\.p12|importKey'
src/` finds nothing outside test assertions that it's absent).
**Evaluated by**: `structuralGuardrails()` (hardcoded `pass`).
**Tested**: `test/seal-disciplines.test.ts` explicitly asserts the absence
of key-material strings.

## G9 — Cross-section reference-edition consistency (manual scope)
**Prevents**: two sections in the same book citing the same standard at two
different editions without it being surfaced.
**Enforced**: `src/manual/coordinator-manual.ts` — emits a
`ref-edition-conflict` `ManualCoordinationFlag`, triaged at Gate M-COORD.
**Tested**: `test/manual.test.ts` ("G9 — flags a standard cited at two
editions across sections").

## G11 — Corpus staleness: flag, never auto-adopt
**Prevents**: a newer published edition silently replacing an ingested one.
**Enforced**: `src/corpus/staleness-cron.ts markStale` (Cron-driven,
quarterly) and `src/corpus/admin.ts` reverify — both only ever set a
`stale` flag, never overwrite `edition`.
**Tested**: `test/staleness-cron.test.ts`.

## G12 — Every authoritative row traces to a real ingest
**Prevents**: a fabricated corpus section being drafted from.
**Enforced**: `src/db/corpus.ts corpus_source` provenance ledger;
`src/agents/drafter.ts` returns an honestly-empty IR (never fabricated
content) for a section with no `ufgs_corpus_section` row.
**Tested**: `test/sec-to-ir.test.ts`, `test/manual.test.ts`.

## G13 — Final-output hygiene / resolve-or-default, never invent
**Prevents**: unresolved bracket markup or a "Note to Designer" leaking into
issued text; a resolution being made up rather than resolved or defaulted.
**Enforced**: `src/shared/specsintact.ts assertSectionIssuedClean`, called
from both `workflow.ts`'s `seal` step and `manual/freeze.ts` before
packaging — the one hygiene check both pipelines actually share.
**Tested**: `test/hygiene.test.ts`.

## G14 — No licensed CSI classification IDs
**Prevents**: `masterFormatId`/`uniFormatId` (licensed CSI IP, returned by
the WBDG CIM API) from ever being ingested or persisted.
**Enforced**: `src/corpus/ufc-cim.ts` — the extractor builds objects that
never name those fields, by construction.
**Tested**: `test/ufc-criteria.test.ts`.

## G15 — M-DECIDE gate refuses an open in-book selection
**Prevents**: the book proceeding past M-DECIDE with an unresolved
selection.
**Enforced**: `src/manual/manual-do.ts applyGate('M-DECIDE', …)`, composed
from `src/manual/aggregate.ts`'s pure helpers (`collectOpenDecisions`,
`applySelectionResolution`, `ufgsDefaultFor`).
**Tested**: the pure helpers are directly tested in `test/decisions.test.ts`
(every unresolved selection surfaced; a fill with no default stays open,
never fabricated; a fully-resolved book has zero open decisions). **The
gate-blocking path itself (`applyGate`) has no dedicated integration test**
— it composes tested primitives but isn't independently exercised
end-to-end in the suite.

## G16 — Seal-grade PDF requires container render + pagination verification
**Prevents**: a `worker-fallback` (unverified pagination) PDF from ever
reaching `approved_for_seal` status.
**Enforced**: **twice, independently** — `workflow.ts`'s `seal` step
(single-section) and `manual/freeze.ts sealBlockedReason` (manual). Both
check the same condition (`pdfRender === 'container' && pdfVerified`) but
are two separate code paths, consistent with the two-pipeline architecture
documented in `PIPELINE-REFERENCE.md`.
**Tested**: `test/seal-gate.test.ts`.

## G-MAN — Honest manual scope
**Prevents**: an outline-only/reserved section being presented as drafted;
a division silently omitted or silently sealed.
**Enforced**: throughout `src/manual/{outline,assembler,aggregate}.ts` —
the mandatory Division 01 checklist is always present regardless of intake
features; Division 00 renders a labeled government-furnished placeholder
rather than nothing; an uncovered division raises `seal-coverage-gap`
rather than being silently sealed or silently dropped.
**Tested**: `test/manual.test.ts`, `test/mandatory-div01.test.ts`,
`test/seal-disciplines.test.ts`.

## G-CMP-1 — Comparison upload permanently quarantined
**Prevents**: an uploaded reference spec (for scoring against the AI
output) ever being embedded, retrieved, or placed in a generation prompt.
**Enforced**: stored under a dedicated R2 prefix
(`projects/:id/comparison/reference/`), read only by `src/compare/score.ts`
and `src/manual/compare-manual.ts` — both scoring-only code paths, never
called from any draft/resolve/validate step.
**Tested**: `test/comparison.test.ts`.
