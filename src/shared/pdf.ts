// Minimal, dependency-free PDF-of-record generator (text, Helvetica, paginated).
//
// This is the IN-WORKER FALLBACK for the freeze step when the LibreOffice render
// container (§3.4) is not deployed. It is NOT pagination-verified — only Word /
// LibreOffice lays out real pages — but it produces a valid, frozen, hashable
// PDF so the approved-for-seal flow (Part 5) is exercised end to end. Swap in the
// container's PDF for true format fidelity.

const enc = new TextEncoder();

function wrap(line: string, width = 95): string[] {
  if (line.length <= width) return [line];
  const words = line.split(' ');
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) {
      if (cur) out.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

function escPdf(s: string): string {
  // Latin-1 only; drop non-encodable chars to keep the content stream valid.
  return s.replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '');
}

export function textToPdf(lines: string[], _title = 'Document'): Uint8Array {
  const pageH = 792;
  const top = 720;
  const bottom = 72;
  const leading = 13;
  const linesPerPage = Math.floor((top - bottom) / leading);

  const wrapped: string[] = [];
  for (const l of lines) for (const w of wrap(l)) wrapped.push(w);

  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += linesPerPage) pages.push(wrapped.slice(i, i + linesPerPage));
  if (pages.length === 0) pages.push(['']);

  // Object layout: 1 Catalog, 2 Pages, 3 Font, then per page: content + page.
  const objects: string[] = [];
  const pageObjNums: number[] = [];
  let nextObj = 4;
  const contentObjs: { num: number; body: string }[] = [];

  for (const pageLines of pages) {
    const contentNum = nextObj++;
    const pageNum = nextObj++;
    pageObjNums.push(pageNum);
    let stream = `BT /F1 10 Tf ${72} ${top} Td ${leading} TL`;
    for (const l of pageLines) stream += ` (${escPdf(l)}) Tj T*`;
    stream += ' ET';
    contentObjs.push({ num: contentNum, body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream` });
    objects[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${pageH}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
  }
  for (const c of contentObjs) objects[c.num] = c.body;

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count ${pageObjNums.length} /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  const total = nextObj - 1;
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i <= total; i++) {
    offsets[i] = body.length;
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = body.length;
  body += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return enc.encode(body);
}
