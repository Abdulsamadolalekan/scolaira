/**
 * Client-identity resolution for unauthenticated rate limiting and audit.
 *
 * `x-forwarded-for` is a *client-supplied* header: any caller can set it, so
 * trusting it by default lets an attacker mint a fresh rate-limit bucket per
 * request — measured on the register endpoint: 7 spoofed headers were accepted
 * against a 5-per-hour policy (H-4/F9).
 *
 * The policy is therefore fail-closed: the header is ignored unless the
 * deployment declares how many proxies it actually runs behind.
 *
 *   TRUSTED_PROXY_HOPS unset / 0 / invalid  → no client IP is derived. Rate
 *       limits and audit rows fall back to a single deployment-wide bucket
 *       ("unknown"), which is *safe* and *deliberate*: it cannot be bypassed by
 *       a header, only by the operator declaring the topology.
 *   TRUSTED_PROXY_HOPS = n (n >= 1)        → the n-th entry counted from the
 *       RIGHT of the header is used. Entries appended by untrusted hops sit to
 *       the left, so a client that prepends fake addresses cannot move itself
 *       into a fresh bucket.
 *
 * Deployments MUST set TRUSTED_PROXY_HOPS to the real number of proxies in
 * front of the app (1 for a single nginx/ELB hop that sets the header) or
 * accept the shared bucket.
 */

/** Marker used when no trustworthy client address exists. */
export const UNKNOWN_CLIENT_IP = 'unknown';

/**
 * Derive the client address for rate-limit keys and audit rows, honouring the
 * deployment's declared proxy topology. Returns `undefined` when the request
 * carries no address this deployment is allowed to believe.
 */
export function clientIpFor(request: Request): string | undefined {
  const configured = (process.env.TRUSTED_PROXY_HOPS ?? '').trim();
  if (configured === '') return undefined;
  const hops = Number.parseInt(configured, 10);
  if (!Number.isInteger(hops) || hops <= 0) return undefined;

  const header = request.headers.get('x-forwarded-for');
  if (!header) return undefined;

  const parts = header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;

  const index = parts.length - hops;
  const candidate = parts[index >= 0 ? index : 0]!;
  // A hop value must at least look like an address or host; anything else is
  // not worth keying a rate limit on.
  if (candidate.length > 64 || !/^[0-9a-fA-F.:\[\]%_-]+$/.test(candidate)) return undefined;
  return candidate;
}

/** Rate-limit key component: the resolved address, or the shared bucket marker. */
export function clientIpKey(request: Request): string {
  return clientIpFor(request) ?? UNKNOWN_CLIENT_IP;
}
