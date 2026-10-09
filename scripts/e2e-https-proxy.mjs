/**
 * TLS front end for the E2E suite (H-6).
 *
 * Why this exists: the app sets `Secure` on its session and CSRF cookies in a
 * production build, and real deployments serve HTTPS. Running the browser suite
 * over plain http therefore tested a configuration no customer ever sees — and
 * WebKit (Safari) correctly refused to treat those cookies as usable over http,
 * so the whole authenticated journey failed in the non-Chromium engine while
 * passing in Chromium. The wrong fix would have been to relax the cookie flags
 * for tests; the right fix is to serve the suite the way the product is served.
 *
 * So: `next start` on 127.0.0.1:3000, and this process terminates TLS on
 * 127.0.0.1:3443 with a self-signed certificate for localhost, forwarding
 * requests to it. Playwright is configured with `ignoreHTTPSErrors: true` for
 * that origin only.
 *
 * The certificate is generated on first use into e2e/.artifacts/tls (ignored by
 * git). It is a throwaway for a throwaway local origin — never a product secret.
 */
import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TLS_DIR = resolve(process.cwd(), 'e2e/.artifacts/tls');
const KEY = resolve(TLS_DIR, 'localhost-key.pem');
const CRT = resolve(TLS_DIR, 'localhost-cert.pem');
const UPSTREAM = { host: '127.0.0.1', port: Number(process.env.UPSTREAM_PORT ?? 3000) };
const LISTEN_PORT = Number(process.env.TLS_PORT ?? 3443);

function loadCertificate() {
  if (!existsSync(KEY) || !existsSync(CRT)) {
    // Fail loudly: `npm run e2e:seed` prepares the certificate, and a missing
    // certificate would otherwise surface as an unexplained 500 deep into the
    // suite.
    console.error(`[e2e-tls] no certificate in ${TLS_DIR} — run \`npm run e2e:seed\` first`);
    process.exit(1);
  }
  return { key: readFileSync(KEY, 'utf8'), cert: readFileSync(CRT, 'utf8') };
}

const { key, cert } = loadCertificate();

createServer({ key, cert }, (req, res) => {
  const forwardedFor = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '';
  const upstream = httpRequest(
    {
      ...UPSTREAM,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        // The app sees the browser's address the way a real proxy would report it.
        'x-forwarded-for': forwardedFor,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': req.headers.host ?? `localhost:${LISTEN_PORT}`,
        // Keep Next's own routing happy about which host it is behind.
        host: `localhost:${UPSTREAM.port}`,
      },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`[e2e-tls] upstream error: ${error.message}`);
  });
  req.pipe(upstream);
}).listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(
    `[e2e-tls] https://localhost:${LISTEN_PORT} → http://${UPSTREAM.host}:${UPSTREAM.port}`,
  );
});
