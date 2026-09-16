/**
 * Auth test support — lightweight cookie jar + request factory for in-process
 * route-handler testing. We do NOT use magic headers or dev bypasses. All auth
 * flows exercise exactly the code path a real HTTP request would, including
 * cookie parsing and CSRF verification.
 */
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from '@/lib/auth/config';
import { verifySessionCookie, verifyCsrfToken } from '@/lib/auth/cookies';
import { __setCookieStoreForTest } from '@/lib/auth';
import { getSql } from '@/lib/db';

export class CookieJar {
  private _cookies = new Map<string, string>();

  setFromSetCookie(headerValue: string | null | undefined): void {
    if (!headerValue) return;
    // Set-Cookie: name=value; Path=/; ... — parse the name/value pair.
    const first = headerValue.split(', ')[0] ?? headerValue;
    const nv = first.split(';')[0];
    if (!nv) return;
    const eq = nv.indexOf('=');
    if (eq < 0) return;
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1).trim();
    this._cookies.set(name, value);
  }

  applyMany(headers: Headers): void {
    headers.getSetCookie?.().forEach((v) => this.setFromSetCookie(v));
    // Fallback: some Node versions expose set-cookie via entries.
    const setHeader = headers.get('set-cookie');
    if (setHeader && !headers.getSetCookie) this.setFromSetCookie(setHeader);
  }

  get(name: string): string | undefined { return this._cookies.get(name); }

  delete(name: string): void { this._cookies.delete(name); }

  toCookieHeader(): string {
    return Array.from(this._cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /** Inject into a Request (cookie header). */
  attach(req: RequestInit & { headers?: HeadersInit }): void {
    const h = new Headers(req.headers ?? {});
    const existing = h.get('cookie');
    h.set('cookie', existing ? `${existing}; ${this.toCookieHeader()}` : this.toCookieHeader());
    req.headers = h;
  }

  /** Attach a CSRF header from the stored csrf cookie + signed session. */
  attachCsrfHeader(req: RequestInit & { headers?: HeadersInit }): void {
    const h = new Headers(req.headers ?? {});
    const session = this.get(SESSION_COOKIE_NAME);
    const parsed = verifySessionCookie(session);
    const csrfFull = this.get(CSRF_COOKIE_NAME);
    if (!parsed || !csrfFull) {
      // Can't attach (e.g. logged out)
      req.headers = h;
      return;
    }
    // csrf cookie format: <token>.<sig>; we send exactly that in the header.
    h.set('x-csrf-token', csrfFull);
    req.headers = h;
    // Sanity: verify against ourselves
    const tokenVal = csrfFull.split('.')[0]!;
    if (!verifyCsrfToken(csrfFull, tokenVal, parsed.sessionId)) {
      throw new Error('CSRF sanity check failed in test harness');
    }
  }
}

/** Invoke a route handler with a given body and cookie jar; update jar.
 *  We inject the jar as the auth module's cookie store (so reads/writes
 *  operate on the jar directly rather than Next's request-scope store).
 *  Request headers ALSO include a `cookie` header for any code path that
 *  reads cookies via the request object (none in our handlers, but it is
 *  cheap and accurate). */
type CallInit = {
  method?: string;
  path?: string;
  csrf?: boolean;
  body?: unknown;
  headers?: HeadersInit;
  args?: unknown[]; // extra positional args forwarded to the handler (e.g. { params })
};

export async function call(
  handler: (req: Request, ...args: unknown[]) => Promise<Response>,
  jar: CookieJar,
  init: CallInit = {},
): Promise<{ status: number; data: any; response: Response }> {
  // Build a cookie-store adapter that routes through our jar.
  const store: {
    get(name: string): { value: string } | undefined;
    set(opts: { name: string; value: string } & Record<string, unknown>): void;
    delete(name: string): void;
  } = {
    get(name: string) {
      const v = jar.get(name);
      return v !== undefined ? { name, value: v } : undefined;
    },
    set(opts: { name: string; value: string } & Record<string, unknown>) {
      // Mimic Set-Cookie serialization of just the name=value pair for the jar.
      jar.setFromSetCookie(`${opts.name}=${opts.value}; Path=/`);
    },
    delete(name: string) { jar.delete(name); },
  };
  __setCookieStoreForTest(store);

  // Place a SAVEPOINT so any SQL error thrown inside the handler rolls back
  // to this point rather than aborting the outer per-test BEGIN transaction.
  // Without this, the first failed login attempt in a test would poison the
  // transaction and every subsequent call would see "current transaction is
  // aborted" — not because production has that bug, but because the test
  // harness reuses one connection across requests (unlike real HTTP requests
  // which each have their own connection/transaction).
  const sql = getSql();
  const spName = 'sp_' + Math.random().toString(36).slice(2, 10);
  // postgres.js does not allow parameterized identifiers for SAVEPOINT, so we
  // generate the name ourselves (20 chars from [a-z0-9_], safe).
  try { await sql.unsafe(`SAVEPOINT ${spName}`); } catch { /* not in a txn */ }

  const headers = new Headers(init.headers ?? {});
  headers.set('content-type', 'application/json');
  headers.set('user-agent', 'scolaira-test/1.0');
  const cookieHeader = jar.toCookieHeader();
  if (cookieHeader) headers.set('cookie', cookieHeader);
  if (init.csrf) {
    const session = jar.get(SESSION_COOKIE_NAME);
    const parsed = verifySessionCookie(session);
    const csrfFull = jar.get(CSRF_COOKIE_NAME);
    if (parsed && csrfFull) {
      headers.set('x-csrf-token', csrfFull);
    }
  }
  const req = new Request(`http://test.local${init.path ?? '/'}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) as BodyInit : undefined,
  });
  try {
    const res = init.args ? await handler(req, ...init.args) : await handler(req);
    try { await sql.unsafe(`RELEASE SAVEPOINT ${spName}`); } catch { /* ignore */ }
    if (typeof res.headers.getSetCookie === 'function') {
      for (const v of res.headers.getSetCookie()) jar.setFromSetCookie(v);
    } else {
      jar.setFromSetCookie(res.headers.get('set-cookie'));
    }
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, response: res };
  } catch (e) {
    try { await sql.unsafe(`ROLLBACK TO SAVEPOINT ${spName}`); } catch { /* ignore */ }
    throw e;
  } finally {
    __setCookieStoreForTest(null);
  }
}

export const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
