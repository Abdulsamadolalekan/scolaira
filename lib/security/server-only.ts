/**
 * Re-export of `server-only` for explicit import.
 *
 * Any module that imports from this file (directly or via `lib/security/env`,
 * `lib/db/*`, audit logic, etc.) is guaranteed by Next.js to be excluded from
 * the client bundle. If a client component accidentally imports such a module,
 * the build fails.
 */
import 'server-only';
