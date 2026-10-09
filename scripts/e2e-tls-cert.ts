/**
 * Throwaway TLS material for the E2E run (H-6).
 *
 * The release-gate suite talks to the app over HTTPS (see
 * scripts/e2e-https-proxy.mjs for why), so the run needs a certificate for
 * `localhost` and every process that participates — the TLS front end, the
 * application server doing its own server-side fetch, Playwright — must trust
 * it. Nothing here is a product secret: it is a self-signed certificate, valid
 * for 30 days, for a local test origin, written under the git-ignored
 * `e2e/.artifacts/`.
 *
 * Calling `ensureTlsCertificate()` from the seed step means "prepare the run"
 * happens in exactly one place: a missing certificate is then a seed problem
 * with a clear message, not a mysterious dashboard 500 half-way through a gate.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const TLS_DIR = resolve(process.cwd(), 'e2e/.artifacts/tls');
export const TLS_KEY_PATH = resolve(TLS_DIR, 'localhost-key.pem');
export const TLS_CERT_PATH = resolve(TLS_DIR, 'localhost-cert.pem');

export function ensureTlsCertificate(): { key: string; cert: string } {
  if (!existsSync(TLS_KEY_PATH) || !existsSync(TLS_CERT_PATH)) {
    mkdirSync(TLS_DIR, { recursive: true });
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        TLS_KEY_PATH,
        '-out',
        TLS_CERT_PATH,
        '-days',
        '30',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    console.log(`[e2e-tls] generated a throwaway localhost certificate in ${TLS_DIR}`);
  }
  return { key: TLS_KEY_PATH, cert: TLS_CERT_PATH };
}
