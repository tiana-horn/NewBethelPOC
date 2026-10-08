// UFGS bracket classifier (CHANGE-07 follow-up). The `.SEC` master uses square
// brackets for TWO very different purposes, and telling them apart is what keeps
// the issued output clean (G13) without drowning the reviewer in non-decisions:
//
//   1. DECISIONS the designer must make — an optional span `[gypsum board]` or a
//      designer fill `[_____]`. These become real `Selection`s that the Resolver
//      resolves (or defaults, or flags) downstream.
//   2. INERT editorial fragments that are part of the sentence's grammar, NOT a
//      choice: an optional plural `wall[s]`, a conjunction `concrete [and] steel`,
//      or bracketed punctuation `[,]`. Treating these as decisions produced bogus
//      "resolve this" cards and, when left unresolved, leaked literal `[and]`/`[s]`
//      into the issued text (a G13 hygiene failure). They must be FLATTENED into
//      the prose (brackets dropped, inner kept), never surfaced as a decision.
//
// The classifier is also NESTED-aware: it consumes brackets innermost-first so a
// span like `[wall[s]]` resolves its inner `[s]` (inert -> "walls") before the
// outer `[walls]` is classified — no leftover unmatched `[`/`]` can survive into
// issued output. This is why the freeze-path G13 check can stay a hard fail: a
// leftover bracket now means a genuine unresolved decision, not a plural marker.

import type { Selection } from './types';

export type BracketClass = 'fill' | 'inert' | 'option';

// Conjunctions the UFGS master brackets as an editorial include (`[and]`, `[or]`,
// `[and/or]`). Optional plural/agreement suffixes (`wall[s]`, `box[es]`,
// `[ies]`). Bracketed punctuation (`[,]`, `[;]`, `[/]`). None are a designer
// choice — they are the sentence's own grammar and are flattened in.
const INERT_WORD = new Set(['and', 'or', 'and/or', 'nor']);
const INERT_SUFFIX = /^(?:s|es|ies|'s)$/i;
const INERT_PUNCT = /^[\s.,;:/&()-]*$/; // also matches an empty `[]`

// Classify one bracket's INNER text (already stripped of its `[` `]`). Callers
// pass the raw inner; classification trims internally so `[ _____ ]` and `[ s ]`
// are handled the same as their tight forms.
export function classifyBracket(inner: string): BracketClass {
  const t = inner.trim();
  if (/^_+$/.test(t)) return 'fill'; // [_____] designer fill-in
  if (INERT_PUNCT.test(t)) return 'inert'; // [] / [,] / [/]
  const low = t.toLowerCase();
  if (INERT_SUFFIX.test(low)) return 'inert'; // [s] [es] [ies]
  if (INERT_WORD.has(low)) return 'inert'; // [and] [or] [and/or]
  return 'option';
}

// What an inert bracket collapses to: its inner text, brackets removed (so
// `wall[s]` -> `walls`, `concrete [and] steel` -> `concrete and steel`). Empty
// `[]` collapses to nothing.
function flattenInert(inner: string): string {
  return inner.trim();
}

const INNERMOST = /\[([^[\]]*)\]/g; // a bracket containing no nested bracket

// Paragraph pass. Two phases:
//   1. Flatten inert grammar everywhere, innermost-first, so `[s]`/`[and]`/`[,]`
//      never become — or hide inside — a decision.
//   2. Turn each OUTERMOST remaining span into ONE `Selection`, with its `{{id}}`
//      placeholder left inline in the prose. A genuinely nested span like
//      `[, including [_____]]` is a SINGLE include/omit decision whose option text
//      carries the inner markup verbatim — the two-level IR (Article > Paragraph)
//      has no room for a sub-selection, and one decision matches how the reviewer
//      reads it. Nothing nested is orphaned: every `Selection.id` appears in the
//      returned prose (unlike an innermost-first scheme, which would bury the inner
//      placeholder inside the outer option string). If the reviewer includes such a
//      span and it still shows inner markup, the freeze-path G13 scan catches it.
// `selId(n)` mints the id for the n-th (0-based) span, matching the caller's
// existing `${id}-b${n+1}` convention.
export function extractBracketSelections(
  input: string,
  selId: (n: number) => string,
): { text: string; selections: Selection[] } {
  const flattened = flattenInertBrackets(input); // phase 1
  const selections: Selection[] = [];
  let out = '';
  for (let i = 0; i < flattened.length; ) {
    if (flattened[i] !== '[') {
      out += flattened[i++];
      continue;
    }
    // Find the matching close for this outermost `[`, tracking nested depth.
    let depth = 0;
    let j = i;
    for (; j < flattened.length; j++) {
      if (flattened[j] === '[') depth++;
      else if (flattened[j] === ']' && --depth === 0) break;
    }
    if (j >= flattened.length) {
      // Unmatched `[` — leave it literal so the hygiene scan surfaces it.
      out += flattened[i++];
      continue;
    }
    const inner = flattened.slice(i + 1, j).trim();
    const id = selId(selections.length);
    if (/^_+$/.test(inner)) selections.push({ id, kind: 'fill', value: null });
    else selections.push({ id, kind: 'option', options: [inner], resolved: null });
    out += `{{${id}}}`;
    i = j + 1;
  }
  return { text: out, selections };
}

// Title / plain-string pass: flatten INERT brackets only (a title can't carry a
// `Selection`), innermost-first, and LEAVE genuine option/fill brackets in place
// so the issued-output hygiene scan (G13) catches them as an unresolved decision
// instead of shipping them silently. Used for article/part/section titles, which
// the general paragraph walk never runs through `extractBracketSelections`.
export function flattenInertBrackets(input: string): string {
  let text = input;
  for (let guard = 0; guard < 1000; guard++) {
    let changed = false;
    text = text.replace(INNERMOST, (m, raw: string) => {
      if (classifyBracket(raw) !== 'inert') return m; // keep option/fill for the scan
      changed = true;
      return flattenInert(raw);
    });
    if (!changed) break;
  }
  return text;
}
