// Minimal, dependency-free CSV. Handles quoted fields, embedded commas/quotes,
// CRLF/LF, and skips blank lines. Sufficient for finish schedules and the CSV
// artifacts we emit. (Full BIM/IFC intake is out of scope for the POC — §11.)

export function parseCsv(text: string): Record<string, string>[] {
  const rows = splitRows(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length === 1 && cells[0].trim() === '') continue; // blank line
    const rec: Record<string, string> = {};
    header.forEach((key, j) => {
      rec[key] = (cells[j] ?? '').trim();
    });
    out.push(rec);
  }
  return out;
}

function splitRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // CRLF: swallow the \r and let the following \n terminate the row. Lone \r
      // (classic-Mac line endings) is itself a row terminator — otherwise the
      // whole file collapses into a single row.
      if (text[i + 1] === '\n') continue;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  // last field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// `rows` is intentionally loose (readonly any[]): interface types (TraceRow,
// SubmittalRegisterRow, ...) lack index signatures, so a stricter type would
// reject every call site. This is a serializer boundary, not domain logic.
export function toCsv(rows: readonly any[], columns?: string[]): string {
  if (rows.length === 0) return columns ? columns.join(',') + '\n' : '';
  const cols = columns ?? Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
  return lines.join('\n') + '\n';
}
