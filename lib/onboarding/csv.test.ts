/**
 * CSV parser tests.
 *
 * A school's file comes from Excel, Google Sheets, or an export from whatever
 * they used before. These tests use the shapes those files actually take —
 * quoting, CRLF, BOM, ragged rows, a delimiter that is not a comma — because a
 * parser that only handles a hand-typed toy file silently corrupts real data,
 * and quiet corruption in a school's roll is what gets billed later.
 */
import { describe, expect, it } from 'vitest';
import { CsvParseError, detectDelimiter, parseCsv } from './csv';

describe('detectDelimiter', () => {
  it('finds a comma', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });

  it('finds a semicolon — common in exports from European and legacy systems', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
  });

  it('finds a tab — a spreadsheet copied and pasted', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('ignores delimiters inside quoted values', () => {
    // The header holds one real comma and two inside a quoted name.
    expect(detectDelimiter('"Eze, Ada";"Okonkwo, Ngozi";class')).toBe(';');
  });

  it('falls back to a comma for a single-column file', () => {
    expect(detectDelimiter('name\nAda\nNgozi')).toBe(',');
  });
});

describe('parseCsv — quoting', () => {
  it('keeps a comma inside a quoted field', () => {
    const parsed = parseCsv('first,last\n"Ada, Ngozi",Eze');
    expect(parsed.rows[0]!.cells).toEqual(['Ada, Ngozi', 'Eze']);
  });

  it('unescapes a doubled quote', () => {
    const parsed = parseCsv('first,last\n"Ada ""Ngozi""",Eze');
    expect(parsed.rows[0]!.cells).toEqual(['Ada "Ngozi"', 'Eze']);
  });

  it('keeps a newline inside a quoted field as part of the value', () => {
    const parsed = parseCsv('first,address\nAda,"12 Broad Street\nLagos"');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.cells[1]).toBe('12 Broad Street\nLagos');
  });

  it('still reports the NEXT row on its true source line after a quoted newline', () => {
    const parsed = parseCsv('first,last\n"Ada\nNgozi",Eze\nMusa,Danjuma');
    expect(parsed.rows[0]!.line).toBe(2);
    // The second row is physically on line 5 because row 1 spanned lines 2 and 3.
    expect(parsed.rows[1]!.line).toBe(4);
    expect(parsed.rows[1]!.cells).toEqual(['Musa', 'Danjuma']);
  });

  it('does not lose the row when a quote is never closed', () => {
    const parsed = parseCsv('first,last\n"Ada,Eze');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.cells[0]).toBe('Ada,Eze');
  });

  it('treats a mid-word quote as literal text, not as an opening quote', () => {
    const parsed = parseCsv('first,last\nAd"a,Eze');
    expect(parsed.rows[0]!.cells).toEqual(['Ad"a', 'Eze']);
  });
});

describe('parseCsv — real-world file shapes', () => {
  it('strips a UTF-8 BOM, which Excel writes on CSV export', () => {
    const parsed = parseCsv('\uFEFFfirst,last\nAda,Eze');
    // Without the strip, the first header becomes "\uFEFFfirst" and the column
    // silently fails to match.
    expect(parsed.headers).toEqual(['first', 'last']);
  });

  it('handles CRLF line endings', () => {
    const parsed = parseCsv('first,last\r\nAda,Eze\r\nMusa,Danjuma\r\n');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[1]!.cells).toEqual(['Musa', 'Danjuma']);
  });

  it('handles old-style CR-only line endings', () => {
    const parsed = parseCsv('first,last\rAda,Eze\rMusa,Danjuma');
    expect(parsed.rows).toHaveLength(2);
  });

  it('trims padding whitespace a bursar leaves on headers and cells', () => {
    const parsed = parseCsv('  First Name , Last  Name \n  Ada , Eze ');
    expect(parsed.headers).toEqual(['First Name', 'Last  Name']);
    expect(parsed.rows[0]!.cells).toEqual(['Ada', 'Eze']);
  });

  it('keeps interior whitespace inside a name', () => {
    const parsed = parseCsv('name\nAda  Ngozi Eze');
    expect(parsed.rows[0]!.cells[0]).toBe('Ada  Ngozi Eze');
  });

  it('drops trailing blank lines but KEEPS a blank line in the middle', () => {
    const parsed = parseCsv('first,last\nAda,Eze\n\nMusa,Danjuma\n\n\n');
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[1]!.blank).toBe(true);
    expect(parsed.rows[1]!.line).toBe(3);
  });

  it('counts the physical lines in the file', () => {
    expect(parseCsv('first,last\nAda,Eze\nMusa,Danjuma').totalLines).toBe(3);
  });

  it('flags a ragged row rather than shifting its values', () => {
    const parsed = parseCsv('first,last,class\nAda,Eze\nMusa,Danjuma,SS1');
    expect(parsed.rows[0]!.ragged).toBe(true);
    expect(parsed.rows[1]!.ragged).toBe(false);
  });

  it('flags a row with too MANY values as ragged too', () => {
    const parsed = parseCsv('first,last\nAda,Eze,extra');
    expect(parsed.rows[0]!.ragged).toBe(true);
    expect(parsed.rows[0]!.cells).toHaveLength(3);
  });

  it('handles a single-column file', () => {
    const parsed = parseCsv('name\nAda\nMusa');
    expect(parsed.headers).toEqual(['name']);
    expect(parsed.rows.map((r) => r.cells[0])).toEqual(['Ada', 'Musa']);
  });

  it('returns a header-only file with no rows', () => {
    const parsed = parseCsv('first,last\n');
    expect(parsed.rows).toHaveLength(0);
  });
});

describe('parseCsv — refusals', () => {
  it('refuses an empty file', () => {
    expect(() => parseCsv('')).toThrow(CsvParseError);
    expect(() => parseCsv('   \n  ')).toThrow(CsvParseError);
  });

  it('names the problem when there is no header', () => {
    expect(() => parseCsv('')).toThrow(/empty/i);
  });
});
