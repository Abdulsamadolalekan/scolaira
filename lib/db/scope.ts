/**
 * Scoped database execution (R1, C-1).
 *
 * A "scope" is the unit of database isolation in SCOLAIRA. Whatever the
 * connection mode, a scope guarantees:
 *
 *   - authorization context applied with **transaction-local** semantics
 *     (`set_config(..., true)`), so Postgres itself reverts it with the
 *     transaction — the database, not application cleanup, is what makes
 *     context un-inheritable;
 *   - the context is established **before** any protected query runs;
 *   - every `getSql()`/`getDb()` call made during the callback resolves to the
 *     connection the scope is using (AsyncLocalStorage), so a handler cannot
 *     accidentally run protected queries on an unscoped handle;
 *   - context is **cleared/reset unconditionally** at exit, on both the
 *     transaction-local and the session layer, and the result is **read back
 *     from Postgres and verified**; a connection that cannot be proven neutral
 *     raises `ScopeIntegrityError` (fail closed) and is not reused;
 *   - the registry covers every identity-bearing variable (see ./context.ts);
 *   - absent or invalid context fails closed: the database rejects the scope
 *     (`auth_scope_*_local` verifies membership / mints HMAC proofs) and the
 *     verification step refuses to continue silently.
 *
 * TWO CONNECTION MODES
 *
 *   reserved  (pool can spare a connection, `max > 1`)
 *       The scope takes an **exclusive** connection (`sql.reserve()`) for its
 *       entire lifetime. No other request can be scheduled onto it, so
 *       concurrent requests for different tenants are physically unable to
 *       interleave context. This is the recommended production configuration
 *       and the mode the R1 concurrency tests exercise with a multi-connection
 *       pool.
 *
 *   shared    (single-connection pool, `max == 1`, e.g. the integration test
 *             harness, which pins one connection for its per-test transaction)
 *       There is no second connection to give, and every handle in the process
 *       (including handles captured before the scope) resolves to the same
 *       connection. The scope therefore uses that connection but (a) still
 *       applies context transaction-locally, (b) *serializes* scopes with an
 *       in-process mutex so two concurrent requests can never share one
 *       transaction, and (c) applies the same verified teardown. Isolation
 *       does not depend on the pool size in either mode — that is the point of
 *       the R1 fix — it only changes whether a scope is physically exclusive.
 *
 * Transactions are opened by the scope itself; a nested scope (or a nested
 * drizzle `.transaction()`) becomes a SAVEPOINT, never a second `BEGIN`, so a
 * callback can never commit an enclosing transaction. Whether an enclosing
 * transaction exists is asked of Postgres (the `app.r1_tx_probe` marker), not
 * guessed in JavaScript.
 *
 * This layer does not replace RLS: RLS remains the authorization decision.
 * This layer guarantees *which* authorization decision applies to *which*
 * connection, and that it cannot be inherited by an unrelated request.
 */
import 'server-only';

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
import { getRootSql, type Database } from './index';
import { currentScope, runInScope } from './scope-registry';
import {
  CONTEXT_GUCS,
  SCOPE_DEPTH_GUC,
  ScopeIntegrityError,
  TX_PROBE_GUC,
  clearContextLayers,
  readContextState,
  sameContextState,
  type ContextState,
} from './context';

/** What kind of authorization context a scope establishes. */
export type ScopeSpec =
  | { kind: 'tenant'; organizationId: string; userId: string }
  | { kind: 'system' }
  /** Seeding/testing context (migrations, seeds, tests). Never a request path. */
  | { kind: 'seed'; organizationId: string | null; userId: string | null }
  | { kind: 'platform'; userId: string }
  | { kind: 'public'; token: string }
  | { kind: 'none' };

export interface ScopeOptions {
  /**
   * Pool to use. Defaults to the shared application pool. R1 tests pass a
   * dedicated multi-connection pool to prove isolation without any reliance on
   * the default pool size.
   */
  client?: postgres.Sql;
  /** Diagnostics label only. */
  label?: string;
}

/** A postgres.js client (pool handle, reserved client, or scope shim). */
interface ScopedClient {
  (strings: TemplateStringsArray, ...args: unknown[]): unknown;
  unsafe(query: string, params?: unknown[], options?: unknown): unknown;
  release?(): void;
  options?: { max?: number; [key: string]: unknown };
  begin?<T>(fn: (client: ScopedClient) => Promise<T> | T): Promise<T>;
  savepoint?<T>(fn: (client: ScopedClient) => Promise<T> | T): Promise<T>;
  [key: string]: unknown;
}

interface ScopedDb {
  transaction<R>(cb: (tx: Database) => Promise<R>): Promise<R>;
}

interface ScopeOutcome<T> {
  value: T;
  preState: ContextState;
}

function asRows(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
}

/** Pool size of a postgres.js client (1 when it cannot be determined). */
function poolMax(pool: unknown): number {
  const options = (pool as ScopedClient | undefined)?.options;
  const max = Number(options?.max);
  return Number.isFinite(max) && max > 0 ? max : 1;
}

/**
 * Ask Postgres — not JavaScript — whether a transaction block is currently
 * open on this connection.
 *
 * `set_config(name, value, is_local => true)` is reverted at the end of the
 * statement when no transaction block is open, and at the end of the
 * transaction when one is. Reading the marker back in a second statement
 * therefore answers the question definitively, using documented Postgres
 * semantics only.
 */
async function inTransaction(client: ScopedClient): Promise<boolean> {
  await client.unsafe(`SELECT set_config('${TX_PROBE_GUC}', '1', true)`);
  const rows = asRows(
    // Compare against the sentinel rather than testing for NULL: an emptied
    // GUC is '' (not NULL) and would otherwise read as "transaction open".
    await client.unsafe(
      `SELECT current_setting('${TX_PROBE_GUC}', true) = '1' AS in_tx`,
    ),
  );
  return rows[0]?.in_tx === true;
}

let savepointCounter = 0;
function nextSavepointName(): string {
  savepointCounter += 1;
  return `r1_sp_${savepointCounter}`;
}

/**
 * Attach transaction-scoping methods to a client so drizzle's postgres-js
 * driver can run on it.
 *
 * drizzle's `PostgresJsSession.transaction()` calls `client.begin(...)` and
 * `PostgresJsTransaction.transaction()` calls `client.savepoint(...)`. Both are
 * provided here, and both are **savepoint-aware**: they ask Postgres whether a
 * transaction is already open and only issue `BEGIN` when they actually own
 * the outermost transaction. A nested `.transaction()` can therefore never
 * emit a bare `BEGIN` inside an open transaction (which would commit the outer
 * transaction on return) and can never commit an enclosing scope.
 */
function augmentClient(client: ScopedClient, options: unknown): ScopedClient {
  let depth = 0;

  client.options = (options ?? client.options) as ScopedClient['options'];

  const openUnitOfWork = async <T>(
    fn: (c: ScopedClient) => Promise<T> | T,
    forceSavepoint: boolean,
  ): Promise<T> => {
    const nested = depth > 0 || forceSavepoint || (await inTransaction(client));
    const name = nextSavepointName();
    await client.unsafe(nested ? `SAVEPOINT ${name}` : 'BEGIN');
    depth += 1;
    try {
      const result = await fn(client);
      await client.unsafe(nested ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
      return result;
    } catch (error) {
      try {
        await client.unsafe(nested ? `ROLLBACK TO SAVEPOINT ${name}` : 'ROLLBACK');
        if (nested) await client.unsafe(`RELEASE SAVEPOINT ${name}`);
      } catch {
        // Preserve the original error; teardown handles a broken connection.
      }
      throw error;
    } finally {
      depth -= 1;
    }
  };

  client.begin = <T>(fn: (c: ScopedClient) => Promise<T> | T) => openUnitOfWork(fn, false);
  client.savepoint = <T>(fn: (c: ScopedClient) => Promise<T> | T) => openUnitOfWork(fn, true);

  return client;
}

/**
 * Build the scoped client for single-connection mode.
 *
 * A pool handle cannot be wrapped destructively (other code holds it and must
 * keep working), so this returns a thin function-object shim that forwards
 * everything to the pool handle but owns the transaction methods. Everything
 * in the process resolves to the same underlying connection in this mode, so
 * the shim has exactly the pool's semantics.
 */
function shimSharedClient(pool: ScopedClient): ScopedClient {
  // The pool handle is itself callable (tagged template); this shim forwards
  // calls to it without re-typing it as the banned `Function` construct.
  type Callable = (strings: TemplateStringsArray, ...args: unknown[]) => unknown;
  const call = pool as unknown as Callable;
  const shim = ((strings: TemplateStringsArray, ...args: unknown[]) =>
    call(strings, ...args)) as unknown as ScopedClient;

  for (const key of Object.keys(pool)) {
    const descriptor = Object.getOwnPropertyDescriptor(pool, key);
    if (!descriptor) continue;
    try {
      Object.defineProperty(shim, key, descriptor);
    } catch {
      // Non-configurable properties (if any) stay undefined; the explicit
      // forwards below cover everything the driver and repositories need.
    }
  }
  const proto = Object.getPrototypeOf(pool) as object | null;
  if (proto) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor' || key in shim) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (!descriptor) continue;
      try {
        Object.defineProperty(shim, key, descriptor);
      } catch {
        /* ignore */
      }
    }
  }

  shim.unsafe = (query: string, params?: unknown[], options?: unknown) =>
    pool.unsafe(query, params, options);
  shim.options = pool.options;

  return augmentClient(shim, pool.options);
}

/**
 * Serialize scopes in single-connection mode.
 *
 * With one connection, two overlapping requests would otherwise share a
 * transaction (the second scope would see the first one's transaction and
 * SAVEPOINT into it), which is exactly the kind of interleaving R1 exists to
 * make impossible. Nested scopes re-enter the same scope object and never take
 * this lock.
 */
let sharedChain: Promise<unknown> = Promise.resolve();
async function withSharedConnectionLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = sharedChain;
  let release!: () => void;
  sharedChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Apply a scope specification to the connection, transaction-locally. */
async function applyContext(client: ScopedClient, spec: ScopeSpec): Promise<void> {
  switch (spec.kind) {
    case 'tenant':
      await client.unsafe(`SELECT auth_scope_tenant_local($1::uuid, $2::uuid)`, [
        spec.organizationId,
        spec.userId,
      ]);
      return;
    case 'system':
      await client.unsafe(`SELECT auth_scope_system_local()`);
      return;
    case 'seed':
      await client.unsafe(`SELECT auth_scope_seed_local($1::uuid, $2::uuid)`, [
        spec.organizationId,
        spec.userId,
      ]);
      return;
    case 'platform':
      await client.unsafe(`SELECT auth_scope_platform_local($1::uuid)`, [spec.userId]);
      return;
    case 'public':
      // Resolves the bearer token itself and mints the public proof; it never
      // accepts a caller-supplied organization. See migration 0040.
      await client.unsafe(`SELECT auth_scope_public_local($1::text)`, [spec.token]);
      return;
    case 'none':
      await clearContextLayers(client, { local: true, session: true });
      return;
    default: {
      const never: ScopeSpec = spec;
      throw new Error(`Unreachable scope spec: ${JSON.stringify(never)}`);
    }
  }
}

/** Restore a previously-captured context state, transaction-locally. */
async function restoreContextLocal(
  client: ScopedClient,
  target: ContextState | null,
): Promise<void> {
  const assignments: string[] = [];
  const values: string[] = [];
  for (const name of CONTEXT_GUCS) {
    values.push(target?.[name] ?? '');
    assignments.push(`set_config('${name}', $${values.length}, true)`);
  }
  values.push('');
  assignments.push(`set_config('${TX_PROBE_GUC}', $${values.length}, true)`);
  await client.unsafe(`SELECT ${assignments.join(', ')}`, values);
}

/**
 * Run `fn` inside a scope transaction on an already-selected connection:
 * capture the enclosing context, apply the requested context, invoke the
 * caller, and report both the result and the context that must be restored.
 */
async function executeOnScopedClient<T>(
  scoped: ScopedClient,
  scopedDb: ScopedDb,
  spec: ScopeSpec,
  fn: (db: Database, client: postgres.Sql) => Promise<T>,
  depth: number,
): Promise<ScopeOutcome<T>> {
  const preState = await readContextState(scoped);
  return scopedDb.transaction(async (tx) => {
    // Mark the transaction as a SCOLAIRA scope BEFORE applying context, so the
    // scope-aware legacy setters (migration 0039) write transaction-locally.
    await scoped.unsafe(`SELECT set_config('${SCOPE_DEPTH_GUC}', $1, true)`, [String(depth)]);
    await applyContext(scoped, spec);
    const value = await fn(tx, scoped as unknown as postgres.Sql);
    return { value, preState };
  });
}

/** Build a drizzle handle over a client (needs `options.parsers`). */
function drizzleOver(client: ScopedClient): ScopedDb {
  return drizzle(client as unknown as postgres.Sql, { schema }) as unknown as ScopedDb;
}

/**
 * Run `fn` with a scoped connection carrying `spec`.
 *
 * The callback receives a drizzle handle bound to the scope's connection
 * (usable exactly like `db`, including nested `.transaction()`, which becomes
 * a savepoint) and that connection's raw client.
 */
export async function runScoped<T>(
  spec: ScopeSpec,
  fn: (db: Database, client: postgres.Sql) => Promise<T>,
  options: ScopeOptions = {},
): Promise<T> {
  const parent = currentScope();

  // Already inside a scope: reuse the connection. Reservation, teardown and
  // release belong to the outermost scope.
  if (parent) {
    const scoped = parent.sql as ScopedClient;
    const scopedDb = parent.db as unknown as ScopedDb;
    const outcome = await runInScope(parent, () =>
      executeOnScopedClient(scoped, scopedDb, spec, fn, parent.depth),
    );
    await restoreEnclosingContext(scoped, outcome.preState);
    return outcome.value;
  }

  const pool = (options.client ?? getRootSql()) as unknown as ScopedClient;
  const label = options.label ?? spec.kind;

  if (poolMax(pool) > 1) {
    return runReserved(spec, fn, pool, label);
  }
  return withSharedConnectionLock(() => runShared(spec, fn, pool, label));
}

/** Exclusive-connection mode (pool can spare a connection). */
async function runReserved<T>(
  spec: ScopeSpec,
  fn: (db: Database, client: postgres.Sql) => Promise<T>,
  pool: ScopedClient,
  label: string,
): Promise<T> {
  const reserved = (await (pool as unknown as { reserve(): Promise<unknown> }).reserve()) as ScopedClient;
  const scoped = augmentClient(reserved, pool.options);
  const scopedDb = drizzleOver(scoped);

  let outcome: ScopeOutcome<T> | undefined;
  let failure: unknown;
  try {
    outcome = await runInScope(
      { sql: scoped, db: scopedDb, label, depth: 1 },
      () => executeOnScopedClient(scoped, scopedDb, spec, fn, 1),
    );
  } catch (error) {
    failure = error;
  }

  try {
    await finaliseConnection(scoped, outcome?.preState, failure);
  } catch (teardownError) {
    throw failure ?? teardownError;
  }
  if (failure) throw failure;
  return (outcome as ScopeOutcome<T>).value;
}

/** Shared-connection mode (single-connection pool). */
async function runShared<T>(
  spec: ScopeSpec,
  fn: (db: Database, client: postgres.Sql) => Promise<T>,
  pool: ScopedClient,
  label: string,
): Promise<T> {
  const scoped = shimSharedClient(pool);
  const scopedDb = drizzleOver(scoped);

  // Own the outermost transaction if nobody else does; otherwise nest inside
  // the ambient one (the integration harness opens a transaction per test).
  const ownsTransaction = !(await inTransaction(scoped));
  const name = nextSavepointName();
  await scoped.unsafe(ownsTransaction ? 'BEGIN' : `SAVEPOINT ${name}`);

  let value: T | undefined;
  let failure: unknown;
  try {
    value = await runInScope({ sql: scoped, db: scopedDb, label, depth: 1 }, async () => {
      await scoped.unsafe(`SELECT set_config('${SCOPE_DEPTH_GUC}', '1', true)`);
      await applyContext(scoped, spec);
      return fn(scopedDb as unknown as Database, scoped as unknown as postgres.Sql);
    });
  } catch (error) {
    failure = error;
  }

  try {
    if (ownsTransaction) {
      await scoped.unsafe(failure ? 'ROLLBACK' : 'COMMIT');
    } else {
      await scoped.unsafe(failure ? `ROLLBACK TO SAVEPOINT ${name}` : `RELEASE SAVEPOINT ${name}`);
      if (failure) await scoped.unsafe(`RELEASE SAVEPOINT ${name}`);
    }
  } catch (error) {
    if (!failure) failure = error;
  }

  try {
    await neutralise(scoped);
  } catch (teardownError) {
    if (!failure) failure = teardownError;
  }

  if (failure) throw failure;
  return value as T;
}

/**
 * Nested-scope teardown: the enclosing transaction is still open, so restore
 * exactly the context that was in force before the nested scope and prove the
 * restoration by reading every variable back.
 */
async function restoreEnclosingContext(
  client: ScopedClient,
  preState: ContextState,
): Promise<void> {
  const stillInTransaction = await inTransaction(client);
  if (!stillInTransaction) {
    // The scope's transaction was the outermost one after all; nothing of it
    // survives, but assert the connection really is neutral.
    await neutralise(client);
    return;
  }
  // The enclosing scope still owns this transaction: put its context back.
  // The session layer is NOT restored — no SCOLAIRA scope may leave
  // session-scoped identity behind, because that is the layer a later request
  // on this connection would inherit.
  await clearContextLayers(client, { session: true });
  await restoreContextLocal(client, preState);
  const restored = await readContextState(client);
  if (!sameContextState(restored, preState)) {
    throw new ScopeIntegrityError(
      `Scoped connection could not be restored to its enclosing context; refusing to continue (dirty: ${dirtyNames(restored).join(', ') || 'none'})`,
    );
  }
}

/**
 * Outermost-scope teardown, then release.
 *
 * The connection must be reduced to NEUTRAL — not "restored". Pre-R1 the
 * equivalent helpers cleared the registry at every exit (lib/db/tenant.ts
 * `finally`), and the same rule is what R1 requires: a connection handed back
 * must carry no identity, because the next user of that connection must not
 * inherit anything. Clearing the local layer matters when the scope ran inside
 * a transaction it does not own (savepoint case, e.g. the test harness); the
 * session layer matters always.
 *
 * A failed verification raises ScopeIntegrityError: the caller fails closed
 * rather than proceeding on a connection whose context cannot be proven.
 */
async function finaliseConnection(
  client: ScopedClient,
  preState: ContextState | undefined,
  originalError: unknown,
): Promise<void> {
  try {
    if (preState === undefined) {
      // Failed before the enclosing state could be captured: leave nothing
      // behind on either layer rather than guessing.
      await clearContextLayers(client, { local: true, session: true });
      return;
    }
    await neutralise(client);
  } catch (error) {
    if (error instanceof ScopeIntegrityError) throw error;
    // A connection that cannot be inspected or cleaned is not safe to reuse.
    if (!originalError) {
      throw new ScopeIntegrityError(
        `Scoped connection teardown failed: ${(error as Error)?.message ?? String(error)}`,
      );
    }
  } finally {
    try {
      client.release?.();
    } catch {
      // release() on an already-broken connection must not mask the real error.
    }
  }
}

/**
 * Clear every layer and verify by reading the registry back.
 *
 * The expectation is always "empty": a connection must never be handed back
 * (or continue within an ambient transaction) carrying identity.
 */
async function neutralise(client: ScopedClient): Promise<void> {
  await clearContextLayers(client, { local: true, session: true });
  const cleared = await readContextState(client);
  const dirty = dirtyNames(cleared);
  if (dirty.length > 0) {
    throw new ScopeIntegrityError(
      `Scoped connection returned dirty context after cleanup: ${dirty.join(', ')}`,
    );
  }
}

function dirtyNames(state: ContextState): string[] {
  return CONTEXT_GUCS.filter((n) => (state[n] ?? '') !== '');
}
