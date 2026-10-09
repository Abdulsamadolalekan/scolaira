/**
 * Evidence-index integrity (H-9, F16/F17).
 *
 * The project's strongest release evidence — hosted CI runs — expires with GitHub's artefact
 * retention (7–14 days). `docs/readiness/H9_EVIDENCE_INDEX.md` is therefore the durable record, and a
 * durable record that can rot silently is worse than none: a row claiming `PRESENT` for a file that
 * no longer exists would let a reader believe evidence exists when it does not.
 *
 * This module is the check. It parses the index's markdown table and validates each row:
 *
 *   - `PRESENT` rows must name a path that resolves **and** carry an ISO date.
 *   - `MISSING` rows must not name a path (nothing to resolve) and must not carry a date; they
 *     describe something absent, and the index must keep describing it as absent.
 *   - a row that is neither is an error, not a warning.
 *
 * Nothing here touches a database or a network; it is pure text and filesystem inspection, so it runs
 * in the unit test project (`lib/ops/evidence-index.test.ts`) on every CI run.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface EvidenceRow {
  artefact: string;
  owner: string;
  date: string;
  status: 'PRESENT' | 'MISSING';
  where: string;
  line: number;
}

const PLACEHOLDER = '—';

/** Split a markdown table row into trimmed cells, dropping the outer pipes. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Extract the evidence rows from the index document. Only the table under `## Index` is parsed:
 * prose tables elsewhere in the file (the hosted run ledger, for example) are not evidence rows.
 */
export function parseEvidenceIndex(markdown: string): EvidenceRow[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^##\s+Index\s*$/.test(line.trim()));
  if (start === -1) throw new Error('evidence index has no "## Index" section');

  const rows: EvidenceRow[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^##\s/.test(line.trim())) break; // next section ends the table
    if (!line.trim().startsWith('|')) {
      if (rows.length > 0) break; // blank line after the table ends it
      continue;
    }
    const parts = cells(line);
    if (parts.length < 5) continue;
    const status = (parts[3] ?? '').toUpperCase();
    if (status !== 'PRESENT' && status !== 'MISSING') continue; // header + separator rows
    rows.push({
      artefact: parts[0] ?? '',
      owner: parts[1] ?? '',
      date: parts[2] ?? '',
      status,
      where: parts.slice(4).join(' | '),
      line: i + 1,
    });
  }
  if (rows.length === 0) throw new Error('evidence index contains no parseable rows');
  return rows;
}

export interface EvidenceCheck {
  ok: boolean;
  failures: string[];
  present: number;
  missing: number;
}

/**
 * Validate the rows. `fileExists` is injectable so the check itself can be tested without touching
 * the filesystem — including the case that matters most: a `PRESENT` row whose file is gone.
 */
export function checkEvidenceIndex(
  rows: EvidenceRow[],
  options: { root?: string; fileExists?: (path: string) => boolean } = {},
): EvidenceCheck {
  const root = options.root ?? process.cwd();
  const fileExists = options.fileExists ?? ((path: string) => existsSync(resolve(root, path)));
  const failures: string[] = [];
  let present = 0;
  let missing = 0;

  for (const row of rows) {
    const where = row.where;
    const before = failures.length;

    if (row.status === 'PRESENT') {
      present += 1;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
        failures.push(`line ${row.line}: "${row.artefact}" is PRESENT but carries no ISO date`);
      }
      if (row.owner.trim() === '' || row.owner.trim() === PLACEHOLDER) {
        failures.push(`line ${row.line}: "${row.artefact}" is PRESENT but names no owner`);
      }
      // A PRESENT row must point at repository content. Rows whose evidence lives on a host (a CI
      // run) are allowed to name no path, but they must say where to look.
      const paths = where.match(/`([^`]+)`/g) ?? [];
      const filePaths = paths
        .map((token) => token.replace(/`/g, ''))
        .filter((candidate) => /^[\w./-]+\.\w+$/.test(candidate));
      if (filePaths.length === 0 && !/run `?\d+`?/.test(where) && !/Run `?\d/.test(where)) {
        failures.push(
          `line ${row.line}: "${row.artefact}" is PRESENT but names neither a file nor a run id`,
        );
      }
      for (const path of filePaths) {
        if (!fileExists(path)) {
          failures.push(
            `line ${row.line}: "${row.artefact}" points at a path that does not exist: ${path}`,
          );
        }
      }
    } else {
      missing += 1;
      if (/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
        failures.push(`line ${row.line}: "${row.artefact}" is MISSING but carries a date`);
      }
      // A MISSING row may point at material that documents the gap — a shape, a template, a plan —
      // but each such path must be labelled as one of those, so that a row cannot cite a real
      // artefact and still call it missing.
      const referenced = (where.match(/`([^`]+)`/g) ?? [])
        .map((token) => token.replace(/`/g, ''))
        .filter((candidate) => /^[\w./-]+\.\w+$/.test(candidate) && fileExists(candidate));
      for (const path of referenced) {
        const before = where.slice(0, where.indexOf(path));
        if (!/(shape|template|plan|described by|blocked by)/i.test(before)) {
          failures.push(
            `line ${row.line}: "${row.artefact}" is marked MISSING but cites an existing file without ` +
              `labelling it as a shape/template/plan: ${path}`,
          );
        }
      }
    }

    if (failures.length === before && row.artefact.trim() === '') {
      failures.push(`line ${row.line}: evidence row has no artefact name`);
    }
  }

  return { ok: failures.length === 0, failures, present, missing };
}
