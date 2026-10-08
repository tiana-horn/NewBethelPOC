// CHANGE-04 Part 6 — parser for UFGS SpecsIntact section files (`.SEC`). These
// are the REAL, structured source of the per-section controlled lists: the
// REFERENCES article is the section's slice of the UMRL (§6.1), the SUBMITTALS
// article is its slice of the UMSL (§6.2), and the body text is the UFGS corpus
// (§6.3). Unlike the aggregate UMRL/UMSL PDFs (which are form/CID-font encoded
// and not cleanly text-extractable), the `.SEC` XML is deterministic to parse.
//
// No LLM, no invention — every row traces to a tag in the source file, and the
// edition is read from the file header (G7: editions are data, never model recall).

export interface SecHeader {
  section: string;   // '09 90 00'
  edition: string;   // 'February 2021' (verbatim from the header)
  preparingActivity?: string;
}
export interface SecReference {
  org: string;
  designation: string;
  editionDate: string;
  title: string;
}
export interface SecSubmittal {
  sdCode: string;        // 'SD-03'
  item: string;
  classification: string; // 'G' | 'S' | '' (reviewer/approval code)
}

function stripTags(s: string): string {
  return s
    .replace(/<TAI\b[^>]*>[\s\S]*?<\/TAI>/gi, '') // tailoring option spans
    .replace(/\[_+\]/g, '')                        // [_____] designer fill-ins
    .replace(/<[^>]+>/g, '')                        // any remaining tag
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_x, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ')
    .trim();
}

// Header: "UFGS-09 90 00 (February 2021)". Preparing Activity: <PRA>NAVFAC</PRA>.
export function parseSecHeader(xml: string): SecHeader | null {
  const m = xml.match(/UFGS-([0-9][0-9 ]+?[0-9])\s*\(([^)]+)\)/);
  if (!m) return null;
  const pra = xml.match(/<PRA>\s*([^<]+?)\s*<\/PRA>/);
  return { section: m[1].replace(/\s+/g, ' ').trim(), edition: m[2].trim(), preparingActivity: pra ? pra[1].trim() : undefined };
}

// REFERENCES: <REF><ORG>..</ORG>..<RID>designation</RID><RTL>(edition) title</RTL>..</REF>
export function parseSecReferences(xml: string): SecReference[] {
  const out: SecReference[] = [];
  for (const ref of xml.matchAll(/<REF>([\s\S]*?)<\/REF>/g)) {
    const block = ref[1];
    const orgM = block.match(/<ORG>([\s\S]*?)<\/ORG>/);
    const org = orgM ? stripTags(orgM[1]) : '';
    for (const pair of block.matchAll(/<RID>([\s\S]*?)<\/RID>\s*<RTL>([\s\S]*?)<\/RTL>/g)) {
      const designation = stripTags(pair[1]);
      const rtl = stripTags(pair[2]);
      // Leading parenthetical is the edition; the remainder is the title.
      const em = rtl.match(/^\(([^)]*)\)\s*(.*)$/);
      out.push({ org, designation, editionDate: em ? em[1].trim() : '', title: em ? em[2].trim() : rtl });
    }
  }
  return out;
}

// SUBMITTALS: scoped to the SUBMITTALS subpart. SD groups are introduced by
// <LST><SUB>SD-03 Product Data</SUB></LST>; items follow as <ITM><SUB>item</SUB>;
// <SUB>G…</SUB></ITM>. Walk in document order, carrying the current SD code.
export function parseSecSubmittals(xml: string): SecSubmittal[] {
  const start = xml.search(/<TTL>\s*SUBMITTALS\s*<\/TTL>/i);
  if (start < 0) return [];
  // Bound to the next subpart title (or end of file).
  const after = xml.slice(start + 1);
  const nextTtl = after.search(/<TTL>(?!\s*SUBMITTALS)/i);
  const region = nextTtl > 0 ? after.slice(0, nextTtl) : after;

  const out: SecSubmittal[] = [];
  let sd = '';
  // Tokenize LST (group headers) and ITM (items) in order.
  const tokRe = /<LST>([\s\S]*?)<\/LST>|<ITM>([\s\S]*?)<\/ITM>/g;
  let m: RegExpExecArray | null;
  while ((m = tokRe.exec(region))) {
    if (m[1] !== undefined) {
      const t = stripTags(m[1]);
      const sm = t.match(/\b(SD-\d{2})\b\s*(.*)$/);
      if (sm) sd = sm[1];
      continue;
    }
    if (!sd) continue;
    const subs = [...m[2].matchAll(/<SUB>([\s\S]*?)<\/SUB>/g)].map((x) => stripTags(x[1])).filter(Boolean);
    if (subs.length === 0) continue;
    const item = subs[0];
    // A trailing 'G' / 'S' (optionally with a reviewer code) is the classification.
    const cls = subs.slice(1).find((s) => /^[GS]\b/.test(s)) ?? '';
    out.push({ sdCode: sd, item, classification: cls.replace(/[,;].*$/, '').trim() });
  }
  return out;
}

// Body corpus text — tags stripped, for embedding into the `ufgs` namespace.
export function secToPlainText(xml: string): string {
  return xml
    .replace(/<MTA\b[^>]*\/>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
