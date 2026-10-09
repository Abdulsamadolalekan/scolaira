/**
 * The manifest cannot drift from the migrations that ship.
 *
 * `lib/ops/migration-manifest.ts` is what the readiness probe compares the
 * database against. If someone adds a migration and forgets the constant, every
 * correctly-migrated deployment would report "schema ahead of build"; if
 * someone edits the constant by hand, a half-applied schema could report ready.
 * Both are caught here, against the real directory.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXPECTED_MIGRATION_COUNT, LATEST_MIGRATION_TAG } from './migration-manifest';

const MIGRATIONS_DIR = resolve(process.cwd(), 'lib/db/migrations');

describe('migration manifest', () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  it('counts every shipped migration', () => {
    expect(files.length).toBe(EXPECTED_MIGRATION_COUNT);
  });

  it('names the newest shipped migration', () => {
    const latest = files[files.length - 1]!.replace(/\.sql$/, '');
    expect(latest).toBe(LATEST_MIGRATION_TAG);
  });

  it('is ordered — the latest tag sorts last', () => {
    const tags = files.map((f) => f.replace(/\.sql$/, ''));
    expect(tags[tags.length - 1]).toBe(LATEST_MIGRATION_TAG);
    expect(tags).toEqual([...tags].sort());
  });
});
