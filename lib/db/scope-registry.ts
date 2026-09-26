/**
 * Scope registry — AsyncLocalStorage binding for request-scoped connections.
 *
 * WHY THIS EXISTS
 * ---------------
 * R1 (C-1) requires that tenant/database context is bound to the connection
 * that executes the protected queries. SCOLAIRA stores its authorization
 * context in Postgres session GUCs (`app.organization_id`, `app.tenant_token`,
 * …), which are a property of a *connection*, not of a JS call stack.
 *
 * Before R1 the codebase relied on `getSql()` returning a pool handle whose
 * size happened to be 1, so "the connection" was implicitly the same one.
 * That is not a guarantee the database or the application can keep.
 *
 * After R1 every context-bearing operation runs inside `runScoped()` (see
 * ./scope.ts), which:
 *   1. reserves an exclusive connection from the pool (`sql.reserve()`);
 *   2. opens a transaction on it;
 *   3. applies context with transaction-local semantics (`SET LOCAL`);
 *   4. publishes the reserved client here, so that *every* `getSql()` /
 *      `getDb()` call made anywhere inside the callback — application code,
 *      repositories, auth helpers, or test code that forgot to accept the
 *      handle as an argument — resolves to that same connection.
 *
 * Step 4 is what makes "context is bound to the connection executing the
 * protected queries" structurally true instead of conventionally true.
 *
 * This module deliberately imports nothing, so that both `lib/db/index.ts`
 * and `lib/db/scope.ts` can depend on it without a cycle.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** A single database handle published for the duration of a scope. */
export interface ScopeHandles {
  /** Reserved postgres.js client (single connection, exclusive). */
  readonly sql: unknown;
  /** Drizzle instance bound to that reserved client. */
  readonly db: unknown;
  /** Human-readable scope purpose, used in diagnostics only. */
  readonly label: string;
  /**
   * Nesting depth of this scope (1 = outermost). Published to Postgres as the
   * transaction-local marker `app.r1_scope_depth`, which tells the legacy
   * session-scoped context setters to write transaction-locally instead.
   */
  readonly depth: number;
}

const store = new AsyncLocalStorage<ScopeHandles>();

/** Run `fn` with `handles` published as the ambient database handles. */
export function runInScope<T>(handles: ScopeHandles, fn: () => Promise<T>): Promise<T> {
  return store.run(handles, fn);
}

/** The currently published handles, or undefined when outside any scope. */
export function currentScope(): ScopeHandles | undefined {
  return store.getStore();
}
