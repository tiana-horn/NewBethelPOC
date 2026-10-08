// File-type detection for intake (CHANGE-02 §2/§7). Determines how each upload
// is parsed, and REJECTS — with a clear message, never silently — the formats
// the spec deliberately does not ingest: native Revit/AutoCAD (require IFC /
// schedule exports) and scanned/raster PDFs (no OCR). Detection is by magic
// bytes first, extension second, so a mislabeled file is still caught.

export type FileType = 'csv' | 'xlsx' | 'ifc' | 'pdf' | 'docx' | 'txt' | 'xml';

export interface Detected {
  type?: FileType;
  rejected?: boolean;
  reason?: string;
}

const ext = (name: string) => (name.split('.').pop() ?? '').toLowerCase();
const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);
const asciiHead = (b: Uint8Array, n = 512) =>
  new TextDecoder('latin1').decode(b.subarray(0, Math.min(n, b.length)));

export function detectFileType(filename: string, bytes: Uint8Array): Detected {
  const e = ext(filename);

  // --- Hard rejections (proprietary CAD/BIM native formats) ---
  // Revit: magic is the OLE compound-file header 'D0 CF 11 E0'. AutoCAD DWG:
  // ASCII 'AC10xx' at offset 0. Reject by extension too — never parse these.
  if (e === 'rvt' || e === 'rfa' || startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0]))
    return {
      rejected: true,
      reason:
        'Native Revit files (.rvt) are proprietary and are not ingested. Export IFC (File → Export → IFC) or export the room/finish schedule to CSV/XLSX.',
    };
  if (e === 'dwg' || e === 'dxf' || /^AC10\d\d/.test(asciiHead(bytes, 8)))
    return {
      rejected: true,
      reason:
        'Native AutoCAD files (.dwg/.dxf) are not ingested. Export IFC or a text/CSV schedule instead.',
    };

  const head = asciiHead(bytes);

  // --- PDF: distinguish text-extractable from scanned/raster (rejected) ---
  if (e === 'pdf' || startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return { type: 'pdf' }; // scanned-vs-text decision is made after text extraction
  }

  // --- ZIP container: DOCX vs XLSX (both are OOXML zips) ---
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || e === 'docx' || e === 'xlsx') {
    if (e === 'xlsx') return { type: 'xlsx' };
    if (e === 'docx') return { type: 'docx' };
    // Unknown zip: peek at the OOXML content-types part.
    const txt = asciiHead(bytes, 4096);
    if (txt.includes('spreadsheetml')) return { type: 'xlsx' };
    if (txt.includes('wordprocessingml')) return { type: 'docx' };
    return { rejected: true, reason: 'Unrecognized ZIP/office container.' };
  }

  // --- IFC (STEP text, ISO-10303-21) — text-based, parsed directly ---
  if (e === 'ifc' || head.startsWith('ISO-10303-21')) return { type: 'ifc' };

  if (e === 'csv') return { type: 'csv' };
  if (e === 'xml' || head.trimStart().startsWith('<?xml') || head.trimStart().startsWith('<'))
    return { type: 'xml' };
  if (e === 'txt' || e === 'md') return { type: 'txt' };

  // Fall back to text if it looks like text; otherwise reject.
  const printable = countPrintable(bytes.subarray(0, 512));
  if (printable > 0.85) return { type: 'txt' };
  return {
    rejected: true,
    reason: `Unsupported or binary file type "${e || 'unknown'}". Provide CSV/XLSX schedules, IFC, or text-extractable PDF/DOCX.`,
  };
}

function countPrintable(b: Uint8Array): number {
  if (b.length === 0) return 1;
  let ok = 0;
  for (const c of b) if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) ok++;
  return ok / b.length;
}
