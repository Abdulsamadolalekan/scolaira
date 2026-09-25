/**
 * Build identity, shared by the liveness and readiness surfaces so the two can
 * never disagree about which build is answering.
 *
 * `commit` is stamped at deploy time. Sources, in order:
 *   NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA  (Vercel)
 *   SCOLAIRA_BUILD_COMMIT              (any other pipeline)
 *   `development`                      (unstamped local run)
 * The value is a build identifier, never a secret.
 */

export interface BuildInfo {
  version: string;
  commit: string;
  environment: string;
}

export function buildInfo(): BuildInfo {
  return {
    version: process.env.npm_package_version ?? '0.0.0',
    commit:
      process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
      process.env.SCOLAIRA_BUILD_COMMIT ??
      'development',
    environment: process.env.NODE_ENV ?? 'development',
  };
}
