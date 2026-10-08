// Text extraction for intake (CHANGE-02 §2). DOCX (unzip word/document.xml),
// PDF (content-stream text operators; FlateDecode inflated), and plain text.
// A PDF that yields negligible text is treated as SCANNED/RASTER and rejected by
// the caller — this system does NOT OCR (§7 honest boundary).

import { inflateZlib, unzipText } from '../shared/inflate';

export function extractDocxText(bytes: Uint8Array): string {
  const xml = unzipText(bytes, 'word/document.xml');
  if (!xml) return '';
  // Paragraph breaks -> newlines; text runs -> their content; tabs -> space.
  return xml
    .replace(/<w:tab[^>]*\/>/g, ' ')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (_m, t) => t)
    .replace(/<[^>]+>/g, '')
    // &amp; must decode LAST or `&amp;lt;` double-decodes to `<`.
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Naive PDF text extraction: pull the ( ... ) strings emitted by Tj/TJ across all
// content streams (inflating FlateDecode streams first). Sufficient to tell a
// text PDF from a scanned one and to index sheet titles / notes; NOT a faithful
// layout extraction.
export function extractPdfText(bytes: Uint8Array): string {
  const latin1 = new TextDecoder('latin1');
  const raw = latin1.decode(bytes);
  const chunks: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  let sawStream = false;
  while ((m = streamRe.exec(raw))) {
    sawStream = true;
    const streamBytes = Uint8Array.from(m[1], (c) => c.charCodeAt(0) & 0xff);
    let content = '';
    try {
      content = latin1.decode(inflateZlib(streamBytes));
    } catch {
      content = m[1]; // not deflated (or not zlib) — try as-is
    }
    chunks.push(extractStreamText(content));
  }
  if (!sawStream) chunks.push(extractStreamText(raw));
  return chunks.join('\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function extractStreamText(content: string): string {
  const out: string[] = [];
  // ( literal ) Tj   and   [ (a) -10 (b) ] TJ
  const re = /\(((?:\\.|[^\\()])*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const s = m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\t/g, ' ')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
    if (s.trim()) out.push(s);
  }
  return out.join(' ');
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
