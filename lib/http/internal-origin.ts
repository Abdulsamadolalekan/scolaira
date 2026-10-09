/**
 * SCOLAIRA — internal origin resolution for server-side self-fetches.
 *
 * WHY THIS FILE EXISTS
 *   Server components across the product load their data by calling SCOLAIRA's OWN
 *   JSON API over HTTP and forwarding the session cookie. That is a legitimate
 *   pattern, but the URL was derived entirely from the INBOUND request
 *   (`x-forwarded-proto` + `x-forwarded-host`). The consequence: the round-trip
 *   left the process, traversed whatever TLS front end sat in front of the app,
 *   and came back in — so Node had to validate the certificate of the app's own
 *   front end.
 *
 *   Behind a real certificate that works. Behind a self-signed one it fails hard:
 *
 *     TypeError: fetch failed
 *       [cause]: Error: self-signed certificate  { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }
 *
 *   Measured on the Command Center: six failed self-fetches per page load, the
 *   error boundary rendered instead of the dashboard, and the whole authenticated
 *   end-to-end suite unable to complete its setup. Staging, preview deployments and
 *   any TLS terminator with a non-public CA hit exactly this.
 *
 * THE FIX — AND WHY IT IS THE RIGHT ONE
 *   `SCOLAIRA_INTERNAL_ORIGIN`, when set, is where the app reaches itself. That is
 *   the deployment's own address (typically loopback), not the public one. The
 *   request then never leaves the host and no certificate is involved — so there is
 *   nothing to trust, and crucially NOTHING IS DISABLED. TLS verification is not
 *   weakened, `NODE_TLS_REJECT_UNAUTHORIZED` is not touched, and no bypass exists.
 *
 *   Unset (the default) it falls back to the inbound origin — byte-for-byte the
 *   previous behaviour — so an existing deployment is unaffected and adoption is
 *   opt-in per environment.
 *
 * WHAT THIS DOES NOT CHANGE
 *   Only the URL. The session cookie is still forwarded, the request still passes
 *   through the same route handler, and `withAuthorizedRoute` still enforces
 *   session, tenant, role and RLS exactly as before. This is transport, not
 *   authority. The endpoint being called is unchanged, and no data crosses a
 *   boundary it did not already cross.
 */
import { headers } from 'next/headers';

/** Env var read by every server-side self-fetch. Documented in `.env.example`. */
export const INTERNAL_ORIGIN_ENV = 'SCOLAIRA_INTERNAL_ORIGIN';

/**
 * The base URL the server should use to call its own API.
 *
 * Returns `null` when no origin can be determined, so callers keep their existing
 * "degrade rather than throw" behaviour.
 */
export async function internalBaseUrl(): Promise<string | null> {
  const configured = process.env[INTERNAL_ORIGIN_ENV]?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  if (!host) return null;
  const proto = h.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}`;
}

/** The inbound request's cookie header, forwarded to the internal call. */
export async function requestCookieHeader(): Promise<string> {
  const h = await headers();
  return h.get('cookie') ?? '';
}
