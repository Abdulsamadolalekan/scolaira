/**
 * CSV parsing for school data imports.
 *
 * WHY THIS IS HAND-WRITTEN
 *   A school's file does not come from a developer. It comes from Excel, Google
 *   Sheets, or an export from whatever system the school used before. Those
 *   files contain quoted fields, commas inside names and addresses, CRLF line
 *   endings, a UTF-8 BOM, blank rows at the end, and — because a bursar typed it
 *   — trailing spaces on every header. A naive `split(',')` corrupts all of it,
 *   and the corruption is silent: names shift a column and the import looks
 *   successful.
 *
 *   So this parser implements RFC 4180 properly: quoted fields, escaped quotes
 *   (`""`), delimiters and newlines INSIDE quotes, CRLF and LF, and a leading
 *   BOM. It is pure and has no dependencies, which means it is testable without
 *   a database and cannot drift into doing something the tests do not describe.
 *
 * WHAT IT DOES NOT DO
 *   It does not guess values, coerce types, or discard anything. It reports what
 *   it found — including ragged rows and the exact line each row came from — and
 *   leaves every interpretation to `student-import.ts`, which states its
 *   decisions explicitly.
 */

/** Delimiters a school's export realistically uses. */
const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const;

export type Delimiter = (typeof CANDIDATE_DELIMITERS)[number];

export interface ParsedCsv {
  /** Header cells, trimmed of surrounding whitespace and BOM. Blank ones stay blank. */
  headers: string[];
  /**
   * Data rows. Each row is an array aligned to `headers`; a short row is padded
   * with `''` and a long row keeps its extra cells, so nothing is lost — the
   * caller decides whether that is acceptable.
   */
  rows: CsvRow[];
  /** The delimiter actually used, so the caller can echo it back to the user. */
  delimiter: Delimiter;
  /** Total physical lines consumed, including blank ones and the header. */
  totalLines: number;
}

export interface CsvRow {
  /** 1-based line number in the SOURCE file, so an error can point at it. */
  line: number;
  cells: string[];
  /** True when every cell is empty/whitespace — counted, not imported. */
  blank: boolean;
  /** True when the cell count differs from the header count. */
  ragged: boolean;
}

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/**
 * Split one delimited row into cells, honouring quotes.
 *
 * Returns the cells; the caller tracks the line number because a quoted field
 * may legally contain newlines, so one "row" can span several physical lines.
 */
function splitRow(text: string, delimiter: string): { cells: string[]; consumed: number } {
  const cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  for (; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote inside a quoted field: "" → "
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      // A quote only opens a quoted field at the START of that field. Excel
      // writes `"Ada, Ngozi"`; it never writes `Ad"a`, so anything else is
      // treated as literal text rather than mangled.
      inQuotes = true;
      field = '';
      continue;
    }
    if (ch === delimiter) {
      cells.push(field);
      field = '';
      continue;
    }
    if (ch === '\r' || ch === '\n') break;
    field += ch;
  }
  // Close an unterminated quote rather than losing the row: an unbalanced quote
  // is a real file, and dropping the row would hide data from the school.
  cells.push(field);

  // Consume the line terminator so the caller can advance correctly.
  let consumed = i;
  if (text[i] === '\r' && text[i + 1] === '\n') consumed = i + 2;
  else if (text[i] === '\r' || text[i] === '\n') consumed = i + 1;

  return { cells, consumed };
}

/**
 * Choose the delimiter by counting candidate characters OUTSIDE quotes on the
 * first non-blank line. The delimiter that appears most often wins; a tie keeps
 * the earlier candidate, so `,` is preferred over `;`.
 *
 * A single-column file has no delimiter at all — that is legal (a list of names)
 * and falls back to `,`.
 */
export function detectDelimiter(text: string): Delimiter {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  let best: Delimiter = ',';
  let bestCount = 0;
  for (const candidate of CANDIDATE_DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i += 1) {
      const ch = firstLine[i]!;
      if (ch === '"') {
        if (inQuotes && firstLine[i + 1] === '"') i += 1;
        else inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && ch === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Parse a whole CSV document.
 *
 * A UTF-8 BOM is stripped, the delimiter is detected, and blank lines are
 * returned as blank rows rather than silently dropped — the import summary
 * tells the school how many were skipped, because "I uploaded 400 and it said
 * 397" must always be explainable.
 */
export function parseCsv(input: string, options: { delimiter?: Delimiter } = {}): ParsedCsv {
  if (typeof input !== 'string') throw new CsvParseError('CSV content must be a string.');
  // Excel writes a BOM for CSV exports; left in place it becomes part of the
  // first header name and the first column silently fails to match.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.trim() === '') throw new CsvParseError('The file is empty.');

  const delimiter = options.delimiter ?? detectDelimiter(text);

  let pos = 0;
  /** Line number where the row starting at `pos` begins. */
  let line = 1;
  let headers: string[] | null = null;
  const rows: CsvRow[] = [];
  const totalLines = text.split(/\r\n|\r|\n/).length;

  while (pos < text.length) {
    const { cells, consumed } = splitRow(text.slice(pos), delimiter);
    const rowLine = line;

    if (consumed === 0) {
      // No terminator left: this is the final row of the file.
      pos = text.length;
    } else {
      // A quoted field may legally contain newlines, so advance the line counter
      // by the number of physical lines this row actually occupied.
      line += (text.slice(pos, pos + consumed).match(/\n/g) ?? []).length;
      pos += consumed;
    }

    const trimmed = cells.map((c) => c.trim());
    if (!headers) {
      headers = trimmed;
      continue;
    }
    rows.push({
      line: rowLine,
      cells: trimmed,
      blank: trimmed.every((c) => c === ''),
      ragged: trimmed.length !== headers.length,
    });
  }

  if (!headers) throw new CsvParseError('The file has no header row.');

  // Drop TRAILING blank rows, which every text editor adds at EOF. Blank rows
  // anywhere else are kept and reported: an unexplained gap in the middle of a
  // 400-row file is something the school should see, and a row count that
  // silently differs from the file is worse than a warning.
  //
  // Only a row that is COMPLETELY empty is treated as EOF padding. A row written
  // with delimiters (`ada,,eze` with all-empty values, or a lone `,,`) is a
  // deliberate blank row a person left behind, so it is counted rather than
  // discarded — the school is told it was skipped instead of being left to
  // wonder why 400 rows became 399.
  const isEofPadding = (row: CsvRow) => row.cells.length <= 1;
  while (rows.length > 0 && rows[rows.length - 1]!.blank && isEofPadding(rows[rows.length - 1]!)) {
    rows.pop();
  }

  return { headers, rows, delimiter, totalLines: Math.max(totalLines, 1) };
}
