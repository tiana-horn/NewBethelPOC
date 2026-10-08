// The Assembler (CHANGE-03 §5) — a PURE function of the confirmed outline +
// per-section artifacts. No LLM, no keys, no state; it belongs in the emit/render
// layer, not an agent. It merges sections with SECTION BREAKS that preserve EACH
// section's sectPr (per-section page-number restart + section-scoped header/
// footer) — a naive body concat collapses the restarts (the failure mode
// CHANGE-01 warned about). It reuses the render engine (sectionBodyXml + styles +
// numbering) rather than re-rendering per section.
//
// Structure of the bound book:
//   cover -> List of Sections (TOC) -> [ front-end include | Div 01 | technical |
//   outline placeholder ]* -> seal-and-signature page
// Each block is its own Word section; the seal page is emitted INTO the DOCX so
// the freeze captures it (never stamped onto the PDF afterward).

import {
  buildNumberingXml,
  buildStylesXml,
  certificationXml,
  docxPageField,
  docxRun as run,
  esc,
  sectionBodyXml,
  styled,
  type CertificationBlock,
} from '../shared/docx';
import { compareSections } from './division';
import type { StylePack } from '../shared/stylepacks';
import { zip } from '../shared/zip';
import type { ManualSectionRow } from '../db/manual';
import type { EPDDrawingIndex, ManualCoordinationFlag, ManualCoverMeta, ReferenceRow, SectionIR, SubmittalRegisterRow, TocRow } from '../shared/types';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface AssembleBody {
  ir: SectionIR;
  references: ReferenceRow[];
  register: SubmittalRegisterRow[];
}

// CHANGE-09 Stage 1 — one manual_assignment row with is_sealing_role=1 (a Tier 1
// EOR/AOR). `divisionScope` here is already resolved to the assignment's own
// scope OR the role's default_division_scope (db/people.ts listAssignments does
// that fallback) — the Assembler never re-derives a default.
export interface SealAssignment {
  userId: string;
  userName: string;
  roleLabel: string;
  divisionScope: string[] | null;
}

export interface AssembleInput {
  projectName: string;
  issueDate: string;
  // On-screen chrome only (e.g. the Project Manual page mode chip) — CHANGE-09
  // Stage 5 removes "mode/profile" from the PRINTED cover (an internal concept
  // that must never appear on an issued title page); this field is no longer
  // read by coverBody, kept optional for any other on-screen caller.
  modeLabel?: string;
  pack: StylePack;
  outline: ManualSectionRow[];
  bodies: Record<string, AssembleBody>; // draft sections that produced a body
  includes: Record<string, { title: string; text: string }>; // front-end (Div 00) docs
  certification?: CertificationBlock;
  dividers: boolean;
  pageCounts?: Record<string, number>; // real per-section counts from the pagination pass
  // CHANGE-09 Stage 1 — the project's sealing-role assignments (manual_assignment
  // joined to manual_role, is_sealing_role=1). Undefined/empty falls back to the
  // pre-CHANGE-08 division heuristic (disciplinesInOutline) so a manual with no
  // assignments yet still gets honest placeholder seal pages.
  sealAssignments?: SealAssignment[];
  // CHANGE-09 Stage 5 — manual-level DoD title-page metadata (manual_cover_meta).
  // Display-only; an unset field renders an honest labeled blank on the cover.
  coverMeta?: ManualCoverMeta;
  // CHANGE-09 Stage 6 — the intake's drawings index (ExtractedProjectData.
  // drawingsIndex), for the front-matter List of Drawings. Undefined/empty
  // renders a truthful "no drawings issued" note rather than omitting the slot.
  drawingsIndex?: EPDDrawingIndex[];
}

export interface AssembleResult {
  docx: Uint8Array;
  toc: TocRow[];
}

// One assembled Word "section" — its body content + the per-section header/footer.
interface Block {
  key: string; // stable id -> header/footer part names
  bodyXml: string;
  headerText: string;
  footerLabel: string | null; // null = no section-number footer (cover/TOC use roman/none)
}

// Estimate a section's page count from its rendered paragraph volume, so the List
// of Sections carries real, non-trivial counts even without the container. The
// two-pass render overrides these with verified counts when a PDF is produced.
function estimatePageCount(bodyXml: string): number {
  const paras = (bodyXml.match(/<w:p[ >]/g) ?? []).length;
  return Math.max(1, Math.ceil(paras / 22));
}

// A labeled "reserved — not included in this issue" page so the TOC stays honest
// (G-MAN: an outline-only / errored section is NEVER presented as drafted).
// CHANGE-09 Stage 3 — a reserved Division 00 entry gets its OWN honest reason: it
// is government/contracting-furnished (the DoD reality that the A/E book often
// begins at Division 01), not a missing corpus — a Div 01+ reserved section keeps
// the original "corpus not available" wording.
function placeholderBody(section: string, title: string, role: ManualSectionRow['role']): string {
  const isFrontEnd = role === 'front-end';
  const reason = isFrontEnd
    ? 'GOVERNMENT/CONTRACTING-FURNISHED — NOT ISSUED BY THE A/E'
    : 'SECTION RESERVED — NOT INCLUDED IN THIS ISSUE';
  const detail = isFrontEnd
    ? 'This Division 00 procurement/contracting form is furnished by the government contracting office, not the A/E, and was not configured for this profile in this demonstration. It is listed for completeness only — the A/E\'s book properly begins at Division 01 in that case.'
    : 'This section is listed in the Table of Contents for completeness. No specification body is issued for it in this Project Manual (corpus not available for this demonstration scope).';
  return (
    styled('SpecTitle', run(`SECTION ${section}`, { b: true, sz: 28 })) +
    styled('SpecTitle', run(title.toUpperCase(), { b: true, sz: 24 })) +
    styled('SpecPara', run(reason, { b: true, color: '888888' })) +
    styled('SpecPara', run(detail, { i: true, color: '888888' }))
  );
}

function includeBody(section: string, title: string, text: string): string {
  // Front-end docs are inserted UNALTERED and rendered as locked (G2): shading +
  // left bar + a bold marker so the reviewer sees what the A/E may not touch.
  const marker = run('[LOCKED — AGENCY FRONT-END DOCUMENT, NOT EDITABLE]  ', { b: true, color: '7A5C00' });
  const shd = '<w:shd w:val="clear" w:fill="EDE7D6"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="6" w:color="7A5C00"/></w:pBdr>';
  return (
    styled('SpecTitle', run(`SECTION ${section}`, { b: true, sz: 28 })) +
    styled('SpecTitle', run(title.toUpperCase(), { b: true, sz: 24 })) +
    `<w:p><w:pPr><w:pStyle w:val="SpecLocked"/>${shd}</w:pPr>${marker}${run(text)}</w:p>`
  );
}

// CHANGE-09 Stage 5 — a real DoD title-page field. An unset value renders an
// honest labeled blank (G13 default styling), never invented; "mode/profile" —
// an internal concept — never appears on the printed cover (it may remain
// on-screen chrome elsewhere, e.g. the Project Manual page's mode chip).
function coverField(label: string, value: string | undefined): string {
  const v = value?.trim();
  return styled('SpecCert', v ? run(`${label}: ${v}`) : run(`${label}: [_____]`, { color: '9A7B2F' }));
}

function coverBody(input: AssembleInput): string {
  const m = input.coverMeta ?? {};
  const title = m.projectTitle?.trim() || input.projectName;
  return (
    styled('SpecTitle', run('PROJECT MANUAL', { b: true, sz: 40 })) +
    styled('SpecTitle', run(title, { b: true, sz: 30 })) +
    coverField('Installation / Location', m.installationLocation) +
    coverField('Solicitation / Contract No.', m.solicitationNo) +
    coverField('Preparing A/E Firm / Activity', m.preparingFirm) +
    coverField('Design District / Command', m.designDistrict) +
    coverField('DoD Component', m.dodComponent) +
    styled('SpecCert', run(`Issued: ${m.issueDate?.trim() || input.issueDate}`)) +
    styled('SpecCert', run('The complete bound specification. Drafts only — a licensed architect-of-record must review and seal.', { i: true, color: '666666' }))
  );
}

function tocBody(toc: TocRow[]): string {
  const rows = toc
    .map((t) => {
      const tag =
        t.draftingMode === 'include' ? '  (front-end, included)' : t.draftingMode === 'outline' ? '  (reserved)' : '';
      return styled('SpecRef', run(`${t.section}   ${t.title}${tag}` + `   ·   ${t.pageCount} p.`));
    })
    .join('');
  return (
    styled('SpecTitle', run('TABLE OF CONTENTS — LIST OF SECTIONS', { b: true, sz: 26 })) +
    styled('SpecCert', run('Page counts are per section; sections repaginate independently and are reissued individually.', { i: true, color: '666666' })) +
    rows
  );
}

// CHANGE-09 Stage 6 — List of Drawings front matter. Renders the intake's
// drawingsIndex when present; otherwise a truthful "no drawings issued" note —
// the front-matter slot is never silently omitted (G-MAN).
function listOfDrawingsBody(drawingsIndex: EPDDrawingIndex[] | undefined): string {
  const head = styled('SpecTitle', run('LIST OF DRAWINGS', { b: true, sz: 26 }));
  if (!drawingsIndex || drawingsIndex.length === 0) {
    return (
      head +
      styled('SpecCert', run('No drawings issued with this manual.', { i: true, color: '666666' }))
    );
  }
  const rows = drawingsIndex
    .map((d) => styled('SpecRef', run(`${d.sheet}${d.title ? '   ' + d.title : ''}`)))
    .join('');
  return head + rows;
}

// Build the ordered blocks + the TOC rows. Page counts come from `pageCounts`
// (verified pass) or the estimate.
function buildBlocks(input: AssembleInput): { blocks: Block[]; toc: TocRow[] } {
  const blocks: Block[] = [];
  const toc: TocRow[] = [];
  const divisionLabel = new Set<string>();

  for (const s of input.outline) {
    // Optional division divider (once per division).
    if (input.dividers && !divisionLabel.has(s.division)) {
      divisionLabel.add(s.division);
      blocks.push({
        key: `div-${s.division}`,
        bodyXml: styled('SpecPart', run(`DIVISION ${s.division}`, { b: true, sz: 30 })),
        headerText: `Division ${s.division}`,
        footerLabel: null,
      });
    }

    const body = input.bodies[s.section];
    const hasBody = !!body;
    let bodyXml: string;
    let effectiveMode: TocRow['draftingMode'] = s.draftingMode;
    if (s.draftingMode === 'include') {
      const inc = input.includes[s.section];
      bodyXml = includeBody(s.section, s.title ?? '', inc?.text ?? `Agency front-end document "${s.title}", included unaltered.`);
    } else if (s.draftingMode === 'draft' && hasBody) {
      bodyXml = sectionBodyXml(body!.ir, input.pack, { references: body!.references, register: body!.register });
    } else {
      // outline-only, OR a draft that produced no body (errored) -> reserved.
      bodyXml = placeholderBody(s.section, s.title ?? '', s.role);
      effectiveMode = 'outline';
    }

    const pageCount = input.pageCounts?.[s.section] ?? estimatePageCount(bodyXml);
    toc.push({ section: s.section, title: s.title ?? '', role: s.role, draftingMode: effectiveMode, pageCount });
    blocks.push({
      key: `sec-${s.section.replace(/\s/g, '')}`,
      bodyXml,
      headerText: `${s.section}  ${s.title ?? ''}`,
      footerLabel: s.section,
    });
  }
  return { blocks, toc };
}

export function assembleManual(input: AssembleInput): AssembleResult {
  const { blocks, toc } = buildBlocks(input);

  // Cover + TOC precede the section blocks; the per-discipline seal pages close
  // the book (CHANGE-06 §8 — architect of record + one page per engineering
  // discipline present; G8 placeholders only).
  const cover: Block = { key: 'cover', bodyXml: coverBody(input), headerText: input.projectName, footerLabel: null };
  const tocBlock: Block = { key: 'toc', bodyXml: tocBody(toc), headerText: 'Table of Contents', footerLabel: null };
  const drawingsBlock: Block = { key: 'drawings', bodyXml: listOfDrawingsBody(input.drawingsIndex), headerText: 'List of Drawings', footerLabel: null };
  const ordered: Block[] = [cover, tocBlock, drawingsBlock, ...blocks, ...sealBlocks(input)];

  // Assemble document.xml: each non-final section ends with a paragraph carrying
  // its sectPr (the section break); the final section's sectPr is a body child.
  const parts: string[] = [];
  ordered.forEach((blk, i) => {
    parts.push(blk.bodyXml);
    const sectPr = sectPrFor(blk, input.pack);
    if (i < ordered.length - 1) {
      // The sectPr describing THIS section lives in a trailing empty paragraph.
      parts.push(`<w:p><w:pPr>${sectPr}</w:pPr></w:p>`);
    } else {
      parts.push(sectPr); // final section: body-level sectPr
    }
  });

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document ${W} ${R}><w:body>${parts.join('')}</w:body></w:document>`;

  // Package: styles + numbering (reused) + a header/footer part per section.
  const files = [
    { name: '[Content_Types].xml', content: contentTypes(ordered) },
    { name: '_rels/.rels', content: rootRels() },
    { name: 'word/document.xml', content: documentXml },
    { name: 'word/_rels/document.xml.rels', content: documentRels(ordered) },
    { name: 'word/styles.xml', content: buildStylesXml(input.pack) },
    { name: 'word/numbering.xml', content: buildNumberingXml(input.pack) },
  ];
  for (const blk of ordered) {
    files.push({ name: `word/header-${blk.key}.xml`, content: headerXml(blk.headerText) });
    files.push({ name: `word/footer-${blk.key}.xml`, content: footerXml(blk.footerLabel) });
  }
  return { docx: zip(files), toc };
}

// Per-section properties: header/footer references to THIS section's parts +
// page-number restart at 1 (so the book paginates per section, not continuously).
function sectPrFor(blk: Block, pack: StylePack): string {
  const m = pack.marginTwips;
  return (
    `<w:sectPr>` +
    `<w:headerReference w:type="default" r:id="rIdHdr-${blk.key}"/>` +
    `<w:footerReference w:type="default" r:id="rIdFtr-${blk.key}"/>` +
    `<w:pgNumType w:start="1"/>` +
    `<w:pgSz w:w="12240" w:h="15840"/>` +
    `<w:pgMar w:top="${m.top}" w:right="${m.right}" w:bottom="${m.bottom}" w:left="${m.left}" w:header="720" w:footer="720" w:gutter="0"/>` +
    `</w:sectPr>`
  );
}

// One resolved seal page: the discipline/role, the assigned person (if any, real
// assignment path only), the sections it covers, and the attestation (only the
// Architect-of-Record page(s) ever carry it).
export interface SealPage {
  key: string;
  discipline: string;
  userName?: string;
  sections: { section: string; title: string }[];
  cert?: CertificationBlock;
}

function sealBody(page: SealPage, pack: StylePack): string {
  const head = styled('SpecCertHead', run(`SEAL AND SIGNATURE PAGE — ${page.discipline.toUpperCase()}`, { b: true }));
  const who = page.userName ? styled('SpecCert', run(page.userName, { b: true })) : '';
  const scope = page.sections.length
    ? styled('SpecCert', run(`Sections in scope: ${page.sections.map((s) => s.section).join(', ')}`, { i: true, color: '666666' }))
    : '';
  // G8 holds for every discipline: placeholders only — no key, no applied seal.
  // The attestation block (if present) is the architect-of-record's; the other
  // disciplines/sealers get placeholder pages keyed to their divisions.
  if (!page.cert) {
    return (
      head + who + scope +
      styled('SpecCert', run(`[ SEAL PLACEHOLDER — affixed by the licensed ${page.discipline} through their own process ]`, { i: true, color: '888888' })) +
      styled('SpecCert', run('[ SIGNATURE PLACEHOLDER — not applied by this system ]', { i: true, color: '888888' }))
    );
  }
  return head + who + scope + certificationXml(page.cert, pack).join('');
}

// CHANGE-06 §8 (C8, stretch) — map a CSI division to the discipline that seals it.
// Architect of Record seals general + architectural divisions; engineers seal
// theirs. This is a Style-Pack-template concern (which placeholder pages to emit),
// not a rebuild; G8 still holds (placeholders only).
function disciplineForDivision(division: string): string {
  const n = parseInt((division || '').slice(0, 2), 10);
  if (!Number.isFinite(n)) return 'Architect of Record';
  if (n <= 14) return 'Architect of Record'; // 00–01 general/front-end, 02–14 architectural
  if (n >= 21 && n <= 25) return 'Mechanical Engineer of Record'; // fire suppression/plumbing/HVAC/automation
  if (n >= 26 && n <= 28) return 'Electrical Engineer of Record'; // electrical/comms/electronic safety
  if (n >= 31 && n <= 35) return 'Civil Engineer of Record'; // earthwork/exterior/utilities/waterways
  if (n >= 40 && n <= 48) return 'Process/Utilities Engineer of Record'; // process + utility divisions
  return 'Engineer of Record';
}

// The distinct disciplines present in the book, Architect of Record always first
// (the book always carries Division 00/01 general front-end).
export function disciplinesInOutline(outline: AssembleInput['outline']): string[] {
  const present = new Set<string>();
  for (const s of outline) present.add(disciplineForDivision(s.division));
  present.add('Architect of Record');
  const rest = [...present].filter((d) => d !== 'Architect of Record').sort();
  return ['Architect of Record', ...rest];
}

// CHANGE-09 Stage 1 — resolve the real seal roster from the project's Tier 1
// (is_sealing_role=1) manual_assignment rows (CHANGE-08 §5). One page PER
// ASSIGNMENT (not per discipline), scoped to the divisions that assignment's
// `division_scope` shares with divisions actually present in this outline (a
// scope naming a division absent from this book gets no page — nothing here for
// that sealer to seal). Multiple sealers — even two holding the same role, or two
// whose scopes both cover a division — each get their own page (§ ground rule).
// Division 00 is government/contracting-furnished and is never in scope for an
// A/E seal. Falls back to the pre-CHANGE-08 disciplinesInOutline heuristic when
// no sealing assignments exist yet (honest placeholders, no coverage-gap check —
// there is no real assignment data to check coverage against).
export function resolveSealRoster(
  outline: AssembleInput['outline'],
  sealAssignments: SealAssignment[] | undefined,
  cert: CertificationBlock | undefined,
): { pages: SealPage[]; gapDivisions: string[] } {
  const divisionsPresent = [...new Set(outline.map((s) => s.division))].filter((d) => d !== '00');
  const sectionsByDivision = new Map<string, { section: string; title: string }[]>();
  for (const s of outline) {
    if (s.division === '00') continue;
    const arr = sectionsByDivision.get(s.division) ?? [];
    arr.push({ section: s.section, title: s.title ?? '' });
    sectionsByDivision.set(s.division, arr);
  }

  if (!sealAssignments || sealAssignments.length === 0) {
    const disciplines = disciplinesInOutline(outline);
    const pages: SealPage[] = disciplines.map((discipline, i) => ({
      key: i === 0 ? 'seal' : `seal-${i}`,
      discipline,
      sections: outline
        .filter((s) => s.division !== '00' && disciplineForDivision(s.division) === discipline)
        .map((s) => ({ section: s.section, title: s.title ?? '' })),
      cert: i === 0 ? cert : undefined,
    }));
    return { pages, gapDivisions: [] };
  }

  const pages: SealPage[] = [];
  const covered = new Set<string>();
  let hasAor = false;
  sealAssignments.forEach((a, i) => {
    const scope = (a.divisionScope ?? []).filter((d) => divisionsPresent.includes(d));
    if (scope.length === 0) return; // nothing in THIS book for this sealer to seal
    scope.forEach((d) => covered.add(d));
    const isAor = /architect of record/i.test(a.roleLabel);
    if (isAor) hasAor = true;
    pages.push({
      key: `seal-${i}`,
      discipline: a.roleLabel,
      userName: a.userName,
      sections: scope.flatMap((d) => sectionsByDivision.get(d) ?? []).sort((x, y) => compareSections(x.section, y.section)),
      cert: isAor ? cert : undefined,
    });
  });
  // The book always carries an Architect-of-Record attestation location, even
  // when no one is yet assigned that role — an honest placeholder (G8), not a
  // silently dropped attestation.
  if (!hasAor) pages.unshift({ key: 'seal-aor', discipline: 'Architect of Record', sections: [], cert });

  const gapDivisions = divisionsPresent.filter((d) => !covered.has(d));
  return { pages, gapDivisions };
}

// CHANGE-09 Stage 1 — one `seal-coverage-gap` coordination flag per division with
// no sealing assignment covering it. Only computed against REAL assignment data
// (no assignments at all -> no flags; that book is using the heuristic fallback,
// which has no assignment roster to be incomplete against).
export function sealCoverageFlags(
  outline: AssembleInput['outline'],
  sealAssignments: SealAssignment[] | undefined,
): ManualCoordinationFlag[] {
  if (!sealAssignments || sealAssignments.length === 0) return [];
  const { gapDivisions } = resolveSealRoster(outline, sealAssignments, undefined);
  if (!gapDivisions.length) return [];
  const sectionsByDivision = new Map<string, string[]>();
  for (const s of outline) {
    if (!gapDivisions.includes(s.division)) continue;
    const arr = sectionsByDivision.get(s.division) ?? [];
    arr.push(s.section);
    sectionsByDivision.set(s.division, arr);
  }
  return gapDivisions.map((d) => ({
    kind: 'seal-coverage-gap',
    detail: `Division ${d} has no sealing assignment covering it. Assign a sealing role (Architect/Engineer of Record) with this division in its scope before the book is sealed.`,
    sections: (sectionsByDivision.get(d) ?? []).sort(compareSections),
    severity: 'high',
    status: 'open',
  }));
}

function sealBlocks(input: AssembleInput): Block[] {
  const { pages } = resolveSealRoster(input.outline, input.sealAssignments, input.certification);
  return pages.map((p) => ({
    key: p.key,
    bodyXml: sealBody(p, input.pack),
    headerText: 'Seal and Signature',
    footerLabel: null,
  }));
}

function headerXml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W} ${R}><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${run(text, { sz: 18, color: '666666' })}</w:p></w:hdr>`;
}
function footerXml(label: string | null): string {
  // "09 91 00-<PAGE>" (UFGS/ENG-4025 convention: section number, dash, page
  // number — no surrounding spaces, CHANGE-09 §6).
  const p = label
    ? `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run(`${label}-`, { sz: 18 })}${docxPageField()}</w:p>`
    : `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${docxPageField()}</w:p>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W} ${R}>${p}</w:ftr>`;
}

function contentTypes(blocks: Block[]): string {
  const hdrFtr = blocks
    .flatMap((b) => [
      `<Override PartName="/word/header-${b.key}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`,
      `<Override PartName="/word/footer-${b.key}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`,
    ])
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
    hdrFtr +
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
function documentRels(blocks: Block[]): string {
  const rel = (id: string, type: string, target: string) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const hf = blocks
    .flatMap((b) => [
      rel(`rIdHdr-${b.key}`, 'header', `header-${b.key}.xml`),
      rel(`rIdFtr-${b.key}`, 'footer', `footer-${b.key}.xml`),
    ])
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rel('rIdSty', 'styles', 'styles.xml') +
    rel('rIdNum', 'numbering', 'numbering.xml') +
    hf +
    `</Relationships>`
  );
}

// Pagination verification at MANUAL scope (§5): assert every section restarts
// numbering (each sectPr carries pgNumType start=1) and that the TOC resolves
// (every outline entry has a block + a page count). Returns problems (empty = ok).
export function verifyManualPagination(docxXml: string, toc: TocRow[]): string[] {
  const problems: string[] = [];
  const restarts = (docxXml.match(/<w:pgNumType w:start="1"\/>/g) ?? []).length;
  if (restarts < toc.length)
    problems.push(`expected >= ${toc.length} per-section page-number restarts, found ${restarts}`);
  for (const t of toc) if (t.pageCount < 1) problems.push(`section ${t.section} has no page count`);
  return problems;
}

export { DOCX_MIME as MANUAL_DOCX_MIME };
