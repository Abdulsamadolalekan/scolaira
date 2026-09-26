/**
 * H-9 · H9-5 — the evidence index must not rot.
 *
 * The index is checked against the real repository (every `PRESENT` row must resolve to a file that
 * exists and be dated), and the checker itself is checked against synthetic rows — including the case
 * that matters most, a `PRESENT` row whose artefact has disappeared, which must fail rather than be
 * dropped.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkEvidenceIndex, parseEvidenceIndex, type EvidenceRow } from './evidence-index';

const INDEX_PATH = resolve(process.cwd(), 'docs/readiness/H9_EVIDENCE_INDEX.md');

function row(overrides: Partial<EvidenceRow>): EvidenceRow {
  return {
    artefact: 'something',
    owner: 'Engineering',
    date: '2026-09-26',
    status: 'PRESENT',
    where: '`docs/OPERATIONS.md`',
    line: 1,
    ...overrides,
  };
}

describe('H9-5 evidence index', () => {
  const markdown = readFileSync(INDEX_PATH, 'utf8');
  const rows = parseEvidenceIndex(markdown);

  it('parses the repository index', () => {
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.some((r) => r.status === 'PRESENT')).toBe(true);
    expect(rows.some((r) => r.status === 'MISSING')).toBe(true);
  });

  it('every PRESENT row resolves to a real, dated artefact', () => {
    const result = checkEvidenceIndex(rows, { root: process.cwd() });
    expect(result.failures, result.failures.join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('is a real check: a PRESENT row whose artefact is gone fails', () => {
    const result = checkEvidenceIndex([
      row({ artefact: 'vanished', where: '`docs/readiness/H9_DOES_NOT_EXIST.md`' }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/does not exist/);
  });

  it('is a real check: an undated or unowned PRESENT row fails', () => {
    const undated = checkEvidenceIndex([row({ date: '—' })]);
    expect(undated.ok).toBe(false);
    expect(undated.failures.join('\n')).toMatch(/no ISO date/);

    const unowned = checkEvidenceIndex([row({ owner: '—' })]);
    expect(unowned.ok).toBe(false);
    expect(unowned.failures.join('\n')).toMatch(/names no owner/);
  });

  it('is a real check: a MISSING row cannot quietly acquire a date', () => {
    const result = checkEvidenceIndex([
      row({ artefact: 'backup', status: 'MISSING', date: '2026-09-26', where: 'nothing exists' }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/MISSING but carries a date/);
  });

  it('keeps the four absent evidence classes recorded rather than deleted', () => {
    const missing = rows.filter((r) => r.status === 'MISSING').map((r) => r.artefact);
    for (const expected of [
      'Backup artefact',
      'Restore drill record',
      'Deployment record',
      'Alert',
    ]) {
      expect(missing.join(' | ')).toMatch(new RegExp(expected, 'i'));
    }
  });
});
