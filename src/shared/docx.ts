// PageFormat DOCX rendering (CHANGE-01 §3.2) — Section IR + Style Pack -> a
// valid .docx with named styles, Word AUTO-numbering (numbering.xml, scheme
// from the pack), per-section page-number restart, header/footer field codes,
// locked-span visual distinction, Note-to-Designer suppression, END OF SECTION,
// and the Part-5 certification block (placeholders only — G8).
//
// Pagination fidelity is NOT verifiable in a Worker (only Word/LibreOffice lays
// out pages) — that is the render container's job (§3.4). This produces the
// markup; the container produces the PDF of record.

import { eachParagraph, resolveParagraphText } from './section-ir';
import type { StylePack } from './stylepacks';
import { zip } from './zip';
import type { Paragraph, ReferenceRow, SectionIR, SubmittalRegisterRow } from './types';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export interface CertificationBlock {
  entityName: string;
  date: string;
  printedName: string;
  licenseNo: string;
  licenseExp: string;
  statement: string;
}

export interface DocxInput {
  references?: ReferenceRow[];
  register?: SubmittalRegisterRow[];
  certification?: CertificationBlock; // Part 5 — rendered into the DOCX, applied to nothing
}

// ---- low-level run/paragraph builders ----
function run(text: string, o: { b?: boolean; i?: boolean; color?: string; sz?: number } = {}): string {
  const rpr: string[] = [];
  if (o.b) rpr.push('<w:b/>');
  if (o.i) rpr.push('<w:i/>');
  if (o.sz) rpr.push(`<w:sz w:val="${o.sz}"/>`);
  if (o.color) rpr.push(`<w:color w:val="${o.color}"/>`);
  const rPr = rpr.length ? `<w:rPr>${rpr.join('')}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}
function pageField(): string {
  return `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
}

// A numbered paragraph bound to the auto-numbering (ilvl) — no literal number.
function numbered(style: string, ilvl: number, runs: string, extraPpr = ''): string {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr>${extraPpr}</w:pPr>${runs}</w:p>`;
}
export function styled(style: string, runs: string, extraPpr = ''): string {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${extraPpr}</w:pPr>${runs}</w:p>`;
}
export { run as docxRun, pageField as docxPageField };

// paragraph "letter" depth: '1.1.A' -> level 2 (lettered); deeper -> +1 each.
function paraIlvl(id: string): number {
  const segs = id.split('.').filter(Boolean);
  return Math.min(Math.max(segs.length - 1, 2), 5); // articles are ilvl1; paras >= ilvl2
}

// The section's body paragraphs (title -> parts -> END OF SECTION -> optional
// certification), WITHOUT the document wrapper or the trailing sectPr. Shared by
// the single-section renderer and the manual Assembler so both stitch identical
// section content (CHANGE-03 §5 — the Assembler reuses the render engine).
export function sectionBodyXml(ir: SectionIR, pack: StylePack, opts: DocxInput = {}): string {
  const body: string[] = [];
  body.push(styled('SpecTitle', run(`SECTION ${ir.section}`, { b: true, sz: 28 })));
  body.push(styled('SpecTitle', run(ir.title.toUpperCase(), { b: true, sz: 24 })));

  // Reference/submittal lists are section-global; emit them once, under the
  // FIRST requesting paragraph, without dropping any other paragraph.
  let refsEmitted = false;
  let regEmitted = false;
  for (const part of ir.parts) {
    body.push(numbered('SpecPart', 0, run(` - ${part.title}`, { b: true }), '<w:keepNext/>'));
    for (const article of part.articles) {
      body.push(numbered('SpecArticle', 1, run(`  ${article.title}`, { b: true }), '<w:keepNext/>'));

      for (const p of article.paragraphs) {
        body.push(paragraphXml(p, pack));
        if (!refsEmitted && p.refRequests?.length && opts.references?.length) {
          for (const r of opts.references) body.push(referenceLine(pack, r));
          refsEmitted = true;
        }
        if (!regEmitted && p.subRequests?.length && opts.register?.length) {
          for (const s of opts.register) body.push(submittalLine(s));
          regEmitted = true;
        }
      }
    }
  }
  body.push(styled('SpecEndSection', run(pack.endOfSectionMarker, { b: true })));
  if (opts.certification) body.push(...certificationXml(opts.certification, pack));
  return body.join('');
}

export function renderDocx(ir: SectionIR, pack: StylePack, opts: DocxInput = {}): Uint8Array {
  const bodyXml = sectionBodyXml(ir, pack, opts);
  const sectPr = sectionProperties(ir, pack);
  const body: string[] = [bodyXml];
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document ${W} ${R}><w:body>${body.join('')}${sectPr}</w:body></w:document>`;

  return zip([
    { name: '[Content_Types].xml', content: contentTypes() },
    { name: '_rels/.rels', content: rootRels() },
    { name: 'word/document.xml', content: documentXml },
    { name: 'word/_rels/document.xml.rels', content: documentRels() },
    { name: 'word/styles.xml', content: buildStylesXml(pack) },
    { name: 'word/numbering.xml', content: buildNumberingXml(pack) },
    { name: 'word/header1.xml', content: headerXml(ir) },
    { name: 'word/footer1.xml', content: footerXml(ir) },
  ]);
}

function paragraphXml(p: Paragraph, pack: StylePack): string {
  const text = resolveParagraphText(p); // notes suppressed (never appended); selections as text
  const ilvl = paraIlvl(p.id);
  if (p.locked) {
    // Locked / mandatory / unalterable — visually distinct: shading + left bar +
    // a bold marker run so the reviewer sees what the AI could not touch.
    const marker = run('[LOCKED — NOT EDITABLE]  ', { b: true, color: '7A5C00' });
    const shd = '<w:shd w:val="clear" w:fill="EDE7D6"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="6" w:color="7A5C00"/></w:pBdr>';
    return numbered('SpecLocked', ilvl, marker + run(text), shd);
  }
  return numbered('SpecPara', ilvl, run(text));
}

function referenceLine(pack: StylePack, r: ReferenceRow): string {
  const txt =
    pack.referencedPubsLayout === 'ufgs-dated'
      ? `${r.org}  ${r.designation}  (${r.editionDate})  ${r.title}` // UFGS dated ORG/desig/date/title
      : `${r.designation} (${r.editionDate}) — ${r.title}`;
  return styled('SpecRef', run(txt));
}
function submittalLine(s: SubmittalRegisterRow): string {
  const code = s.sdCode ? `${s.sdCode}  ` : '';
  const cls = s.classification ? `  [${s.classification}]` : '';
  return styled('SpecRef', run(`${code}${s.item}${cls}`));
}

export function certificationXml(c: CertificationBlock, pack: StylePack): string[] {
  const md = pack.jurisdiction === 'MD';
  const out: string[] = [];
  out.push(styled('SpecCertHead', run(md ? 'CERTIFICATION (Maryland — COMAR titleblock)' : 'CERTIFICATION', { b: true })));
  out.push(styled('SpecCert', run(c.entityName, { b: true })));
  out.push(styled('SpecCert', run(c.statement)));
  out.push(styled('SpecCert', run(`Printed name: ${c.printedName}`)));
  out.push(styled('SpecCert', run(`License No.: ${c.licenseNo}     Expiration: ${c.licenseExp}`)));
  out.push(styled('SpecCert', run(`Date: ${c.date}`)));
  // Placeholders — the system applies NOTHING (G8).
  out.push(styled('SpecCert', run('[ SEAL PLACEHOLDER — affixed by the licensed architect through their own process ]', { i: true, color: '888888' })));
  out.push(styled('SpecCert', run('[ SIGNATURE PLACEHOLDER — not applied by this system ]', { i: true, color: '888888' })));
  return out;
}

// per-section: page-number restart at 1 + section-scoped header/footer.
function sectionProperties(ir: SectionIR, pack: StylePack): string {
  const m = pack.marginTwips;
  return (
    `<w:sectPr>` +
    `<w:headerReference w:type="default" r:id="rIdHdr"/>` +
    `<w:footerReference w:type="default" r:id="rIdFtr"/>` +
    `<w:pgNumType w:start="1"/>` + // per-section page numbering (09 91 00-1, -2, ...)
    `<w:pgSz w:w="12240" w:h="15840"/>` +
    `<w:pgMar w:top="${m.top}" w:right="${m.right}" w:bottom="${m.bottom}" w:left="${m.left}" w:header="720" w:footer="720" w:gutter="0"/>` +
    `</w:sectPr>`
  );
}

function headerXml(ir: SectionIR): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W} ${R}><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${run(`${ir.section}  ${ir.title}`, { sz: 18, color: '666666' })}</w:p></w:hdr>`;
}
function footerXml(ir: SectionIR): string {
  // Section-scoped "09 91 00-<PAGE>" (UFGS/ENG-4025 convention: section number,
  // dash, page number — no surrounding spaces, CHANGE-09 §6).
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W} ${R}><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run(`${ir.section}-`, { sz: 18 })}${pageField()}</w:p></w:ftr>`;
}

// ---- styles.xml — named paragraph styles (never direct formatting) ----
export function buildStylesXml(pack: StylePack): string {
  const body = pack.bodyFont;
  const head = pack.headingFont;
  const style = (id: string, name: string, opts: { ind?: number; before?: number; after?: number; font?: string; sz?: number; b?: boolean; keepNext?: boolean; jc?: string }) => {
    const ppr: string[] = [];
    if (opts.keepNext) ppr.push('<w:keepNext/><w:keepLines/>');
    if (opts.ind != null) ppr.push(`<w:ind w:left="${opts.ind}" w:hanging="360"/>`);
    ppr.push(`<w:spacing w:before="${opts.before ?? 0}" w:after="${opts.after ?? 120}"/>`);
    if (opts.jc) ppr.push(`<w:jc w:val="${opts.jc}"/>`);
    const rpr: string[] = [`<w:rFonts w:ascii="${opts.font ?? body}" w:hAnsi="${opts.font ?? body}"/>`, `<w:sz w:val="${opts.sz ?? 22}"/>`];
    if (opts.b) rpr.push('<w:b/>');
    return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:pPr>${ppr.join('')}</w:pPr><w:rPr>${rpr.join('')}</w:rPr></w:style>`;
  };
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${body}" w:hAnsi="${body}"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>` +
    style('SpecTitle', 'Spec Title', { font: head, sz: 28, b: true, jc: 'center', after: 80 }) +
    style('SpecPart', 'Spec Part', { font: head, sz: 24, b: true, before: 240, keepNext: true }) +
    style('SpecArticle', 'Spec Article', { font: head, sz: 22, b: true, before: 160, keepNext: true }) +
    style('SpecPara', 'Spec Paragraph', { ind: 720, after: 120 }) +
    style('SpecLocked', 'Spec Locked', { ind: 720, after: 120 }) +
    style('SpecRef', 'Spec Reference', { ind: 720, after: 40 }) +
    style('SpecEndSection', 'Spec End Of Section', { b: true, jc: 'center', before: 240 }) +
    style('SpecCertHead', 'Spec Cert Head', { font: head, b: true, before: 240 }) +
    style('SpecCert', 'Spec Cert', { after: 40 }) +
    `</w:styles>`
  );
}

// ---- numbering.xml — Word AUTO-numbering; scheme from the pack ----
export function buildNumberingXml(pack: StylePack): string {
  const lvl = (i: number, fmt: string, text: string, ind: number) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${ind}" w:hanging="360"/></w:pPr></w:lvl>`;
  let levels: string;
  if (pack.numberingScheme === 'ufgs-decimal') {
    // 1.1 / 1.1.1 / 1.1.1.1 — nested decimal (UFGS / SpecsIntact).
    levels =
      lvl(0, 'decimal', 'PART %1', 0) +
      lvl(1, 'decimal', '%1.%2', 360) +
      lvl(2, 'decimal', '%1.%2.%3', 720) +
      lvl(3, 'decimal', '%1.%2.%3.%4', 1080) +
      lvl(4, 'decimal', '%1.%2.%3.%4.%5', 1440) +
      lvl(5, 'decimal', '%1.%2.%3.%4.%5.%6', 1800);
  } else {
    // CSI PageFormat: 1.1 / A. / 1. / a. / (1) / (a).
    levels =
      lvl(0, 'decimal', 'PART %1', 0) +
      lvl(1, 'decimal', '%1.%2', 360) +
      lvl(2, 'upperLetter', '%3.', 720) +
      lvl(3, 'decimal', '%4.', 1080) +
      lvl(4, 'lowerLetter', '%5.', 1440) +
      lvl(5, 'decimal', '(%6)', 1800);
  }
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}>` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>${levels}</w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
    `</w:numbering>`
  );
}

function contentTypes(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
    `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` +
    `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>` +
    `</Types>`
  );
}
function rootRels(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`
  );
}
function documentRels(): string {
  const rel = (id: string, type: string, target: string) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rel('rIdSty', 'styles', 'styles.xml') +
    rel('rIdNum', 'numbering', 'numbering.xml') +
    rel('rIdHdr', 'header', 'header1.xml') +
    rel('rIdFtr', 'footer', 'footer1.xml') +
    `</Relationships>`
  );
}
