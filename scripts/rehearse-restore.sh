#!/usr/bin/env bash
# scripts/rehearse-restore.sh — H-9: provider-independent restore rehearsal.
#
# WHAT THIS PROVES
#   That a dump of a real database can be restored into a CLEAN database, brought to
#   the schema this build expects, and verified — end to end, leaving evidence.
#
# WHAT THIS DOES NOT PROVE
#   That any backup exists. That a provider's point-in-time recovery works. Anything
#   about production. This is a REHEARSAL against a database you can throw away; it is
#   the same procedure that will be run against a real provider instance, which is the
#   point of writing it now (docs/ops/RECOVERY_DRILL.md).
#
# PROVIDER-AGNOSTIC BY CONSTRUCTION
#   Every step is driven by connection URIs, so the identical script runs against a
#   local PostgreSQL cluster today and against a managed/managed-vendor instance later.
#   Nothing here assumes a hostname shape, a cloud, or a superuser named `postgres`.
#
# F25 — THE CREDENTIAL TRAP (do not "fix" this by weakening policy)
#   Tenant tables run with FORCE ROW LEVEL SECURITY and pg_dump establishes no tenant
#   context, so a dump taken as the schema owner FAILS:
#       ERROR: query would be affected by row-level security policy for table "..."
#   Dumping therefore requires a role that bypasses RLS: a superuser, or a dedicated
#   backup role with BYPASSRLS (which does not exist in this project — adding one is a
#   founder decision, H9-F25). This script ASSERTS the dump credential can bypass RLS
#   and STOPS if it cannot. It never runs ALTER TABLE ... NO FORCE ROW LEVEL SECURITY,
#   never disables a policy, and never edits the schema to make a dump succeed.
#
# USAGE
#   export RESTORE_REHEARSAL_SOURCE_ADMIN_URL='postgresql://<admin-or-bypassrolerole>@<host>:5432/<source_db>'
#   export RESTORE_REHEARSAL_TARGET_OWNER_URL='postgresql://<owner>@<host>:5432/scolaira_rehearsal'
#   [export RESTORE_REHEARSAL_PLATFORM_ADMIN='ops@example.com']
#   [export RESTORE_REHEARSAL_TARGET_DB='scolaira_rehearsal']
#   [export RESTORE_REHEARSAL_KEEP=1]      # keep the target for inspection
#   ./scripts/rehearse-restore.sh
#
# EXIT CODES   0 verified · 1 STOP (see the printed reason) · 2 usage/preflight
set -uo pipefail

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET_DB="${RESTORE_REHEARSAL_TARGET_DB:-scolaira_rehearsal}"
OUT="${RESTORE_REHEARSAL_OUT:-./h9-evidence/restore-rehearsal-$STAMP}"
DUMP="$OUT/source-$STAMP.dump"
LOG="$OUT/transcript.log"
SUMMARY="$OUT/summary.json"

mkdir -p "$OUT"
: >"$LOG"

say()  { printf '%s\n' "$*" | tee -a "$LOG"; }
step() { printf '\n=== %s :: %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
stop() { printf '\nSTOP: %s\n' "$*" | tee -a "$LOG"; say "Evidence so far: $OUT"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || stop "$1 not found on PATH"; }
secs() { date +%s; }

need psql; need pg_dump; need pg_restore; need node; need sha256sum

: "${RESTORE_REHEARSAL_SOURCE_ADMIN_URL:?set RESTORE_REHEARSAL_SOURCE_ADMIN_URL (admin or BYPASSRLS role for the source)}"
: "${RESTORE_REHEARSAL_TARGET_OWNER_URL:?set RESTORE_REHEARSAL_TARGET_OWNER_URL (schema owner for the target)}"

dump_url="$RESTORE_REHEARSAL_SOURCE_ADMIN_URL"
owner_url="$RESTORE_REHEARSAL_TARGET_OWNER_URL"
tgt="$TARGET_DB"

# Identifying a database in a URI is the one thing this script must get right: it is
# derived, never separately configured, so it cannot restore into one database while
# verifying another.
mkurl() { printf '%s' "$1" | sed -E "s#/[^/?]+(\?|$)#/$2\1#"; }
# CREATE/DROP DATABASE must run against a database that already exists (a maintenance
# database) — connecting to the target to create the target cannot work.
MAINT_DB="${RESTORE_REHEARSAL_TARGET_ADMIN_MAINTENANCE_DB:-postgres}"
admin_base="${RESTORE_REHEARSAL_TARGET_ADMIN_URL:-$dump_url}"
target_admin_url="$(mkurl "$admin_base" "$MAINT_DB")"     # drop/create/teardown
target_admin_db_url="$(mkurl "$admin_base" "$tgt")"       # inside the target, once it exists
db_of() { printf '%s' "$1" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#'; }
user_of() { printf '%s' "$1" | sed -E 's#^[a-z]+://([^:@/]+).*#\1#'; }

SOURCE_DB="$(db_of "$dump_url")"
OWNER_ROLE="$(user_of "$owner_url")"

step "0 · preflight"
say "postgres client: $(psql --version | awk '{print $3}')"
say "source database: $SOURCE_DB"
say "target database: $tgt  (will be DROPPED and recreated — never point this at a live database)"
say "owner role for target: $OWNER_ROLE"
say "admin maintenance database for DROP/CREATE: $MAINT_DB"

# F25 guard: the dump credential must be able to bypass RLS, or the dump cannot be taken.
attrs="$(psql "$dump_url" -X -tAc \
  "SELECT rolname||' super='||rolsuper||' bypassrls='||rolbypassrls FROM pg_roles WHERE rolname = current_user" 2>>"$LOG")" \
  || stop "could not read role attributes for the dump credential"
can_bypass="$(psql "$dump_url" -X -tAc \
  "SELECT (rolsuper OR rolbypassrls) FROM pg_roles WHERE rolname = current_user" 2>>"$LOG" | tr -d '[:space:]')"
say "dump credential: $attrs"
case "$can_bypass" in
  t) say "  -> OK: the dump credential can bypass RLS (required, F25)" ;;
  *) stop "the dump credential cannot bypass RLS ($attrs).
     This is H9-F25, not a script defect. Take the dump as a superuser or as a
     dedicated BYPASSRLS backup role. Do NOT disable RLS to work around it." ;;
esac

# A rehearsal must never run against a database whose name looks like production data.
case "$tgt" in
  scolaira|scolaira_test|postgres|template0|template1)
    if [ "${RESTORE_REHEARSAL_ALLOW_SHARED_TARGET:-0}" != "1" ]; then
      stop "'$tgt' is a shared/dev database. The rehearsal DROPS its target.
     Choose another name, or set RESTORE_REHEARSAL_ALLOW_SHARED_TARGET=1 if you
     really mean to destroy and restore that database."
    fi ;;
esac

step "1 · take a dump (timed)"
t0=$(secs)
pg_dump "$dump_url" -Fc -f "$DUMP" >>"$LOG" 2>&1
rc=$?
t1=$(secs); dump_s=$((t1 - t0))
[ $rc -eq 0 ] || stop "pg_dump exited $rc — see $LOG"
size=$(stat -c '%s' "$DUMP" 2>/dev/null || echo 0)
[ "$size" -gt 4096 ] || stop "dump is $size bytes — pg_dump can write a partial file and still fail; this one is not usable"
sha=$(sha256sum "$DUMP" | awk '{print $1}')
say "dump: $DUMP · $size bytes · sha256 ${sha:0:16}… · ${dump_s}s"

step "2 · create a clean target"
psql "$target_admin_url" -X -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$tgt\" WITH (FORCE);" >>"$LOG" 2>&1 \
  || stop "could not drop '$tgt' (does the admin credential have CREATEDB?)"
psql "$target_admin_url" -X -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$tgt\" OWNER \"$OWNER_ROLE\";" >>"$LOG" 2>&1 \
  || stop "could not create '$tgt'"
# pgcrypto needs superuser, so it is created here rather than by the restore.
psql "$target_admin_db_url" -X -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" >>"$LOG" 2>&1 \
  || stop "could not create pgcrypto in '$tgt' (the restore would fail on the extension)"

step "3 · restore"
t0=$(secs)
pg_restore -d "$owner_url" --no-owner --role="$OWNER_ROLE" "$DUMP" >>"$LOG" 2>&1
rc=$?
t1=$(secs); restore_s=$((t1 - t0))
ignored=$(grep -c "errors ignored on restore" "$LOG" || true)
ignored_n=$(grep -oE "errors ignored on restore: [0-9]+" "$LOG" | tail -1 | grep -oE "[0-9]+$" || echo 0)
say "pg_restore exit=$rc · ${restore_s}s · ignored errors: ${ignored_n:-0}"
if [ "${ignored_n:-0}" -gt 1 ]; then
  say "  !! MORE THAN ONE IGNORED ERROR — inspect $LOG before trusting this restore."
elif [ "${ignored_n:-0}" -eq 1 ]; then
  say "  (1 ignored error is expected when pgcrypto was pre-created above — confirm it is that one)"
fi

step "4 · prove the data actually landed (read as the admin credential)"
# Read as admin on purpose: the owner sees zero rows through FORCE RLS without tenant
# context, which makes an EMPTY restore look exactly like a successful one.
rows="$(psql "$target_admin_db_url" -X -tAc \
  "SELECT 'organizations='||(SELECT count(*) FROM organizations)
        ||' users='||(SELECT count(*) FROM users)
        ||' invoices='||(SELECT count(*) FROM invoices)" 2>>"$LOG")" \
  || stop "could not count rows in the restored copy"
say "rows: $rows"

step "5 · bring the restored copy to the schema this build expects"
t0=$(secs)
mig_out="$(DATABASE_MIGRATION_URL="$owner_url" npm run db:migrate 2>&1)"
rc=$?
printf '%s\n' "$mig_out" >>"$LOG"
t1=$(secs); migrate_s=$((t1 - t0))
[ $rc -eq 0 ] || stop "migrations failed on the restored copy (exit $rc) — see $LOG"
say "migrations: $(printf '%s' "$mig_out" | grep -oE 'new=[0-9]+ total=[0-9]+' | tail -1) · ${migrate_s}s"

step "6 · verify the restored copy (scripts/verify-restored-db.ts, read-only)"
verify_args=(--json)
[ -n "${RESTORE_REHEARSAL_PLATFORM_ADMIN:-}" ] && verify_args+=(--platform-admin "$RESTORE_REHEARSAL_PLATFORM_ADMIN")
verify_out="$(DATABASE_MIGRATION_URL="$owner_url" npm run --silent db:verify -- "${verify_args[@]}" 2>>"$LOG")"
rc=$?
printf '%s\n' "$verify_out" >"$OUT/restore-verification.json"
verdict="$(printf '%s' "$verify_out" | grep -oE '"ok": *(true|false)' | head -1 | grep -oE 'true|false' || echo unknown)"
passed="$(printf '%s' "$verify_out" | grep -oE '"passed": *[0-9]+' | head -1 | grep -oE '[0-9]+' || echo '?')"
failed="$(printf '%s' "$verify_out" | grep -oE '"failed": *[0-9]+' | head -1 | grep -oE '[0-9]+' || echo '?')"
skipped="$(printf '%s' "$verify_out" | grep -oE '"skipped": *[0-9]+' | head -1 | grep -oE '[0-9]+' || echo '?')"
say "verification: ok=$verdict passed=$passed failed=$failed skipped=$skipped (exit $rc)"
if [ -z "${RESTORE_REHEARSAL_PLATFORM_ADMIN:-}" ]; then
  say "  (no RESTORE_REHEARSAL_PLATFORM_ADMIN set, so data checks are SKIPPED — that is NOT a pass)"
fi

step "7 · evidence"
total_s=$(( $(secs) - t0 + dump_s + restore_s + migrate_s ))
cat >"$SUMMARY" <<JSON
{
  "rehearsal": "h9-restore-rehearsal",
  "classification": "LOCAL REHEARSAL — not production, not provider evidence",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": { "database": "$SOURCE_DB" },
  "dump": { "file": "$DUMP", "bytes": $size, "sha256": "$sha", "seconds": $dump_s },
  "restore": { "targetDatabase": "$tgt", "seconds": $restore_s, "ignoredErrors": ${ignored_n:-0} },
  "migrations": { "seconds": $migrate_s },
  "rows": "$rows",
  "verification": { "ok": "$verdict", "passed": "$passed", "failed": "$failed", "skipped": "$skipped",
                    "platformAdminSupplied": $([ -n "${RESTORE_REHEARSAL_PLATFORM_ADMIN:-}" ] && echo true || echo false) },
  "wallClockSeconds": $total_s
}
JSON
say "summary: $SUMMARY"
say "transcript: $LOG"

if [ "${RESTORE_REHEARSAL_KEEP:-0}" = "1" ]; then
  say "RESTORE_REHEARSAL_KEEP=1 — target '$tgt' left in place for inspection"
else
  psql "$target_admin_url" -X -c "DROP DATABASE IF EXISTS \"$tgt\" WITH (FORCE);" >>"$LOG" 2>&1 \
    && say "target '$tgt' dropped (no residue)" || say "!! could not drop '$tgt' — drop it by hand"
fi

[ "$verdict" = "true" ] || stop "restore verification did not pass (ok=$verdict). Evidence retained in $OUT."
printf '\nRESULT: RESTORE REHEARSAL VERIFIED (local) — %s\n' "$rows"
exit 0
