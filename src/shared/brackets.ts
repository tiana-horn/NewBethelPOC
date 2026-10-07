// Text-seam repair at the emit boundary. When a selection resolves to '' (an
// omitted option) or an included list item carries its own commas, the rendered
// sentence can have doubled/stray commas, a space before punctuation, or a
// collapsed double space. `repairSeams` normalizes those seams so the issued
// sentence reads grammatically. Conservative + idempotent: clean text passes
// through unchanged. It only touches whitespace/punctuation seams — never words.

export function repairSeams(text: string): string {
  let t = text;
  // Space(s) before a comma/semicolon/period/colon -> none.
  t = t.replace(/\s+([,;:.])/g, '$1');
  // Doubled punctuation from an omitted item, e.g. "a, , b" or "a,, b" -> "a, b".
  t = t.replace(/([,;])\s*(?:[,;]\s*)+/g, '$1 ');
  // A list that starts/ends with a stray separator: " , b" -> "b"; "a , " -> "a".
  t = t.replace(/(\(|\[|^)\s*,\s*/g, '$1');
  t = t.replace(/\s*,\s*(\)|\]|$)/g, '$1');
  // Collapse runs of spaces/tabs (not newlines) to one.
  t = t.replace(/[ \t]{2,}/g, ' ');
  // Space before a closing bracket / after an opening one.
  t = t.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  return t;
}
