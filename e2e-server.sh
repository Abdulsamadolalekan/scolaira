#!/usr/bin/env bash
# Serves the BUILT artifact for the Playwright release gate.
#
# The gate must exercise what ships, not what compiles on demand. Playwright's
# default `webServer.command` is `npm run dev`, and on a two-core runner that
# turns the first visit to each route into a compilation pause; measured on this
# repo, a page load in dev mode can exceed the suite's 30s `expect` timeout, and
# the suite then reports a working product as broken. The config's own comment
# says the budget is generous for that reason — it is not generous enough for a
# cold route, and a flaky green/red line on an unrelated spec is worse evidence
# than a slow run.
#
# So the gate sets E2E_SERVER_COMMAND to this script and runs `next build` first.
# Everything else the config already injects into the child process is kept:
# DATABASE_URL (the seeded e2e database), TRUSTED_PROXY_HOPS, NODE_EXTRA_CA_CERTS
# for the throwaway TLS front end, and the heap cap that stops the OOM killer
# taking `next-server` mid-suite. Cookie flags are NOT relaxed anywhere here: the
# suite talks to the app over https://localhost:3443 precisely so that the
# production build's `Secure` cookies are exercised the way a school's browser
# will see them.
set -euo pipefail
cd "$(dirname "$0")"

export NODE_ENV=production
export NEXT_TELEMETRY_DISABLED=1

if [ ! -d .next ]; then
  echo "e2e-server.sh: no .next build directory — run 'npm run build' first" >&2
  exit 2
fi

exec npx next start -p "${E2E_PORT:-3000}"
