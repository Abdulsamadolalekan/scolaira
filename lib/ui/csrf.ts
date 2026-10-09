/**
 * Read a cookie by name from document.cookie (client-only). Used to send the
 * double-submit CSRF token on mutating fetch() calls. The value is the full
 * `<token>.<sig>` string; the server extracts the token prefix and verifies
 * the HMAC signature.
 */
export function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const entries = document.cookie.split(';').map(s => s.trim());
  const prefix = name + '=';
  for (const e of entries) {
    if (e.startsWith(prefix)) return decodeURIComponent(e.slice(prefix.length));
  }
  return null;
}

export function csrfHeaders(): Record<string, string> {
  const t = getCookie('sc_csrf');
  return t ? { 'x-csrf-token': t } : {};
}
