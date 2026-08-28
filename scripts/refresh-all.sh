#!/usr/bin/env bash
#
# scripts/refresh-all.sh — full local data refresh, ONE commit, never pushes.
#
#   1. npm run data:build                      fetch + parse
#   2. npm run data:fuses -- --cookies <file>  local-only CV pass (the slow one)
#   3. npm run data:parse                      merges detections into videos.json
#   4. npm run data:fuse-gaps                  diagnostic, writes only cache/
#   5. stage the committed pipeline artifacts, make one commit
#
# Stage 3 is not redundant: stage 1's parse runs BEFORE the CV pass and cannot
# see its output. fuses-detected.json only reaches videos.json through a parse,
# and a gap report run on a stale parse reports already-solved detections as
# anomalies (README, "Fuse detection").
#
# Stage 2 needs yt-dlp + ffmpeg and a Netscape-format youtube.com cookie export
# (this host's IP is bot-flagged; every unauthenticated yt-dlp player client is
# challenged). That file is a LIVE Google session — see the README section
# "YouTube session cookies" for how to create one and why it must stay
# untracked.
#
# Exit codes
#   0    ran clean; committed, or there was nothing to commit
#   1    hard failure — nothing was committed
#   2    committed (or no-op) but the fuse pass failed; detections are partial
#   3    another refresh-all holds the lock; nothing was done
#   64   usage error (unknown or malformed flag)
#   130  interrupted with Ctrl-C; nothing was committed
#
# Deliberately does NOT push and does NOT set a git identity: the commit lands
# under your local user.name / user.email. The daily Action
# (.github/workflows/data-refresh.yml) owns the bot identity and the push.

set -euo pipefail

# ── locate the repo (works from any cwd) ──────────────────────────────────────
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null) || {
  printf '✖ %s is not inside a git repository.\n' "$SCRIPT_DIR" >&2
  exit 1
}
cd "$REPO_ROOT"

# ── output helpers ────────────────────────────────────────────────────────────
say()   { printf '%s\n' "$*"; }
warn()  { printf '! %s\n' "$*" >&2; }
fail()  { printf '\n✖ %s\n' "$*" >&2; exit 1; }
usage_error() { printf '✖ %s\n\n' "$*" >&2; usage >&2; exit 64; }
banner() { printf '\n──── %s ────────────────────────────────────\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: scripts/refresh-all.sh [options]
       npm run data:refresh-all -- [options]

Runs the full local pipeline (build -> fuses -> parse -> fuse-gaps) and makes
one commit. Never pushes.

Options
  --cookies <path>   Netscape-format youtube.com cookie export.
                     Default: secrets/yt-cookies.txt, falling back to
                     ~/yt-cookies.txt. A leading ~/ is expanded.
  --skip-fuses       Skip the CV pass (fetch + parse + gaps + commit only).
                     Also skips the yt-dlp / ffmpeg / cookie preflight.
  --limit N          Forwarded to data:fuses. Positive integer. Smoke tests.
  --sleep MIN-MAX    Forwarded to data:fuses. Seconds between download
                     attempts, e.g. 4-8. Default in fuses.ts is 1-3.
  --no-commit        Run everything, stage nothing, commit nothing.
  --no-fetch         Skip the `git fetch` behind-upstream preflight (offline).
  --check            Run preflight only, then exit. Do this before committing
                     to a long run.
  -h, --help         This text.

Not forwarded on purpose: --force, --ids, --clean, --promote-lows, --validate,
--cookies-from-browser. They change what "new detections" means, or are
destructive. Run those by hand with `npm run data:fuses -- ...`.

Exit codes: 0 ok · 1 hard failure (nothing committed) · 2 committed but the
fuse pass failed · 3 already running · 64 usage error · 130 interrupted.
EOF
}

# ── defaults ──────────────────────────────────────────────────────────────────
COOKIES=""
SKIP_FUSES=0
DO_COMMIT=1
DO_FETCH=1
CHECK_ONLY=0
FUSE_LIMIT=""
FUSE_SLEEP=""
COOKIE_MAX_AGE_DAYS=14

DETECTIONS="data/fuses-detected.json"
LOCK_FILE="cache/refresh-all.lock"
LOG_DIR="cache/refresh-all"

# Files the commit may touch. The first six mirror data-refresh.yml exactly.
#   fuses-detected.json — the whole point of running locally.
#   patchGroups.json    — scripts/emit.ts writes it and it IS tracked, but the
#                         workflow's `git add` list omits it. Harmless in CI
#                         (ephemeral worktree); locally that would leave the
#                         tree dirty after a "commit everything" run.
STAGE_PATHS=(
  data/videos.json
  data/replays.json
  data/stats.json
  data/players.json
  data/summary.json
  data/report.md
  data/fuses-detected.json
  data/patchGroups.json
  # The carry pin for local-first sources. data:parse rewrites it whenever it
  # builds one from a dump, and it MUST travel with videos.json: committing a new
  # record count while leaving the pin behind makes the next carrying run — every
  # cron run — hard-fail on pin drift.
  data/source-pins.json
)

# ── argument parsing ──────────────────────────────────────────────────────────
# fuses.ts silently ignores unknown flags, so a typo'd flag there would quietly
# start a full multi-hour run. This wrapper rejects them loudly instead.
expand_tilde() {
  case "$1" in
    '~')   printf '%s' "$HOME" ;;
    '~/'*) printf '%s' "$HOME/${1#\~/}" ;;
    *)     printf '%s' "$1" ;;
  esac
}

need_value() { [ "$2" -ge 2 ] || usage_error "$1 requires a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --cookies)     need_value "$1" $#; COOKIES=$(expand_tilde "$2"); shift 2 ;;
    --cookies=*)   COOKIES=$(expand_tilde "${1#*=}"); shift ;;
    --limit)       need_value "$1" $#; FUSE_LIMIT=$2; shift 2 ;;
    --limit=*)     FUSE_LIMIT=${1#*=}; shift ;;
    --sleep)       need_value "$1" $#; FUSE_SLEEP=$2; shift 2 ;;
    --sleep=*)     FUSE_SLEEP=${1#*=}; shift ;;
    --skip-fuses)  SKIP_FUSES=1; shift ;;
    --no-commit)   DO_COMMIT=0; shift ;;
    --no-fetch)    DO_FETCH=0; shift ;;
    --check)       CHECK_ONLY=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    --)            shift; [ $# -eq 0 ] || usage_error "unexpected argument: $1" ;;
    *)             usage_error "unknown argument: $1" ;;
  esac
done

# Default: the in-repo copy, falling back to the home export.
if [ -z "$COOKIES" ]; then
  if [ -f "$REPO_ROOT/secrets/yt-cookies.txt" ]; then
    COOKIES="$REPO_ROOT/secrets/yt-cookies.txt"
  else
    COOKIES="$HOME/yt-cookies.txt"
  fi
fi
case "$COOKIES" in
  '~'*) usage_error "--cookies: ~user/ paths are not expanded; pass an absolute path" ;;
  /*)   ;;
  *)    COOKIES="$REPO_ROOT/$COOKIES" ;;
esac

if [ -n "$FUSE_LIMIT" ]; then
  # fuses.ts does Number(opt('--limit') ?? 0) and gates on LIMIT > 0, so a
  # non-numeric value becomes NaN and silently means "no limit" — turning an
  # intended smoke test into a full run.
  [[ $FUSE_LIMIT =~ ^[1-9][0-9]*$ ]] \
    || usage_error "--limit must be a positive integer (got: $FUSE_LIMIT)"
fi

if [ -n "$FUSE_SLEEP" ]; then
  # fuses.ts splits --sleep on '-' and maps Number; '3' or 'abc' yields NaN and
  # setTimeout(NaN) — i.e. no pacing at all, which is the throttle spiral the
  # sleep option exists to avoid.
  [[ $FUSE_SLEEP =~ ^[0-9]+(\.[0-9]+)?-[0-9]+(\.[0-9]+)?$ ]] \
    || usage_error "--sleep must be MIN-MAX, e.g. 4-8 (got: $FUSE_SLEEP)"
  awk -v a="${FUSE_SLEEP%%-*}" -v b="${FUSE_SLEEP##*-}" 'BEGIN { exit !(a <= b) }' \
    || usage_error "--sleep MIN must be <= MAX (got: $FUSE_SLEEP)"
fi

# ── single-instance lock ──────────────────────────────────────────────────────
# Nothing in the pipeline guards concurrency: fuses.ts rewrites the whole of
# data/fuses-detected.json every 10 items, so two overlapping runs lose
# detections silently. cache/ is gitignored.
mkdir -p "$LOG_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || {
  printf '✖ another refresh-all is already running (lock: %s/%s).\n' \
    "$REPO_ROOT" "$LOCK_FILE" >&2
  exit 3
}

# ── logging ───────────────────────────────────────────────────────────────────
# The terminal gets the raw stream (including fuses.ts's \r progress/ETA
# readout); the file copy has \r translated to \n so the log stays readable
# instead of collapsing into one giant line. Saving fds 3/4 and waiting on tee
# at exit closes the flush race where the shell outruns the writer.
LOG="$LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ).log"
exec 3>&1 4>&2
exec > >(tee >(tr '\r' '\n' >> "$LOG")) 2>&1
TEE_PID=$!

INTERRUPTED=0
cleanup() {
  local rc=$?
  if [ "$INTERRUPTED" -eq 1 ]; then
    printf '\n! interrupted — no commit was made.\n'
    printf '  fuses.ts flushes %s every 10 videos, so the detections it\n' "$DETECTIONS"
    printf '  already found are on disk. Re-run to resume: it only processes ids\n'
    printf '  missing from the output. Nothing was staged; `git status` to inspect.\n'
  fi
  exec 1>&3 2>&4
  exec 3>&- 4>&-
  if [ -n "${TEE_PID:-}" ]; then wait "$TEE_PID" 2>/dev/null || true; fi
  printf 'log: %s\n' "$REPO_ROOT/$LOG" >&2
  exit "$rc"
}
trap cleanup EXIT
trap 'INTERRUPTED=1; exit 130' INT
trap 'INTERRUPTED=1; exit 143' TERM

# ── JSON helpers (jq is not installed on this host; node only) ────────────────
json_object_count() {
  # key count of a JSON object; 0 when absent; non-zero exit when corrupt.
  node -e '
    const fs = require("node:fs");
    const p = process.argv[1];
    if (!fs.existsSync(p)) { process.stdout.write("0"); process.exit(0); }
    const o = JSON.parse(fs.readFileSync(p, "utf8"));
    if (o === null || typeof o !== "object" || Array.isArray(o)) throw new Error("not an object");
    process.stdout.write(String(Object.keys(o).length));
  ' "$1" 2>/dev/null
}

json_array_length() {
  node -e '
    const fs = require("node:fs");
    const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(a)) throw new Error("not an array");
    process.stdout.write(String(a.length));
  ' "$1" 2>/dev/null
}

have() { command -v "$1" >/dev/null 2>&1; }

is_inside_repo() {
  case "$(cd -- "$(dirname -- "$1")" 2>/dev/null && pwd -P)/" in
    "$REPO_ROOT"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# ── preflight ─────────────────────────────────────────────────────────────────
banner "preflight"

[ -f package.json ] || fail "package.json not found in $REPO_ROOT."
[ -d node_modules ] || fail "node_modules missing — run \`npm ci\` first."

have node || fail "node is not on PATH."
have npm  || fail "npm is not on PATH."

NODE_V=$(node -v); NODE_V=${NODE_V#v}
if [ "${NODE_V%%.*}" != "24" ]; then
  warn "node ${NODE_V} — package.json engines pins >=24 <25 and .nvmrc says 24."
fi

# The index must be empty: `git add <paths>` + `git commit` would otherwise
# sweep any pre-staged change into the data commit. CI never hits this; a dev
# box does.
git diff --cached --quiet || fail \
  "your index already has staged changes. Commit or unstage them first —
  this script's commit would otherwise sweep them into the data refresh."

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$DO_FETCH" -eq 1 ] \
  && UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null); then
  if git fetch --quiet --no-tags 2>/dev/null; then
    BEHIND=$(git rev-list --count "HEAD..@{u}")
    [ "$BEHIND" -eq 0 ] || fail \
      "$BRANCH is $BEHIND commit(s) behind $UPSTREAM.
  The daily cron pushes data commits at 06:17 UTC; refreshing on a stale base
  means conflict-resolving a 6 MB videos.json after the run. Pull first:
      git pull --rebase
  (or pass --no-fetch to skip this check)"
  else
    warn "git fetch failed — skipping the behind-upstream check."
  fi
fi

# YT_API_KEY: data:fetch loads .env via tsx --env-file-if-exists=.env, so either
# source counts. Match the NAME only; never echo the value.
if [ -z "${YT_API_KEY:-}" ] \
  && ! grep -qE '^[[:space:]]*YT_API_KEY[[:space:]]*=[^[:space:]]' .env 2>/dev/null; then
  fail "YT_API_KEY not found in the environment or in .env — scripts/fetch.ts exits 1 without it."
fi
say "✓ index clean · node ${NODE_V} · YT_API_KEY present"

if [ "$SKIP_FUSES" -eq 1 ]; then
  say "✓ --skip-fuses: yt-dlp / ffmpeg / cookie checks skipped"
else
  have yt-dlp || fail "yt-dlp is not on PATH (needed by scripts/fuses.ts). Pass --skip-fuses to run without the CV pass."
  have ffmpeg || fail "ffmpeg is not on PATH (needed by scripts/fuses.ts). Pass --skip-fuses to run without the CV pass."
  say "✓ yt-dlp $(yt-dlp --version 2>/dev/null || echo '?') · ffmpeg present"

  [ -e "$COOKIES" ] || fail \
    "cookie file not found: $COOKIES
  Export youtube.com cookies in Netscape format WHILE SIGNED IN (see the README
  section \"YouTube session cookies\"), or pass --cookies <path>, or run with
  --skip-fuses."
  [ -f "$COOKIES" ] || fail "cookie path is not a regular file: $COOKIES"
  [ -s "$COOKIES" ] || fail "cookie file is empty: $COOKIES"

  # Safety net: if the credential lives inside the worktree, git MUST already
  # ignore it. `git check-ignore` exits 128 on out-of-tree paths, so gate the
  # check on the path actually being under the repo.
  if is_inside_repo "$COOKIES"; then
    git check-ignore -q "$COOKIES" || fail \
      "$COOKIES is inside the repo and is NOT gitignored.
  Refusing to run — one \`git add -A\` would publish a live Google session.
  Add it to .gitignore AND mirror the rule in .vercelignore, or move the file
  outside the worktree."
  fi

  COOKIE_MODE=$(stat -c %a "$COOKIES")
  if [ $(( 8#$COOKIE_MODE & 8#077 )) -ne 0 ]; then
    fail "cookie file is group/world-readable (mode $COOKIE_MODE): $COOKIES
  This is a live Google session. Fix it:
      chmod 600 \"$COOKIES\""
  fi

  # Field 6 of a Netscape cookie line is the NAME. Names only are read — a
  # value is never printed, matched, or logged. An export taken while signed
  # OUT parses fine but has none of these, and yt-dlp then fails instantly with
  # the same bot-check message as no cookies at all.
  MISSING_COOKIES=""
  for want in SAPISID LOGIN_INFO; do
    awk -F'\t' -v want="$want" 'NF>=7 && $6==want { found=1 } END { exit !found }' "$COOKIES" \
      || MISSING_COOKIES="$MISSING_COOKIES $want"
  done
  [ -z "$MISSING_COOKIES" ] || fail \
    "cookie file is missing session cookie(s):$MISSING_COOKIES
  $COOKIES
  That is what an export taken while SIGNED OUT looks like (opening an
  incognito window is not enough — you must sign in inside it first).
  Sign in to youtube.com, then re-export."

  COOKIE_AGE_DAYS=$(( ( $(date +%s) - $(stat -c %Y "$COOKIES") ) / 86400 ))
  if [ "$COOKIE_AGE_DAYS" -ge "$COOKIE_MAX_AGE_DAYS" ]; then
    warn "cookie file is ${COOKIE_AGE_DAYS} days old — YouTube sessions rotate."
    warn "  if the run dies on a bot-check, re-export before retrying."
  fi
  say "✓ cookies: ${COOKIES#$REPO_ROOT/} · mode $COOKIE_MODE · ${COOKIE_AGE_DAYS}d old · SAPISID + LOGIN_INFO present"
fi

# Detections must be readable BEFORE we start, or the delta is meaningless.
FUSES_BEFORE=$(json_object_count "$DETECTIONS") \
  || fail "$DETECTIONS exists but is not parseable as a JSON object.
  Fix or restore it (git checkout -- $DETECTIONS) before running."
say "✓ detections baseline: ${FUSES_BEFORE} records"

if [ "$CHECK_ONLY" -eq 1 ]; then
  say ""
  say "✓ preflight passed (--check: stopping here, nothing was run)."
  exit 0
fi

# ── 1. fetch + parse ──────────────────────────────────────────────────────────
banner "1/4  npm run data:build  (fetch + parse)"
npm run data:build   # hard-required: set -e aborts here, nothing is staged

# ── 2. fuse detection (tolerated failure) ─────────────────────────────────────
FUSE_RC=0
FUSE_DELTA=0
if [ "$SKIP_FUSES" -eq 1 ]; then
  say ""
  say "2/4  data:fuses SKIPPED (--skip-fuses)"
  say "3/4  data:parse SKIPPED (nothing new to merge)"
else
  banner "2/4  npm run data:fuses  (local CV pass — this is the slow one)"
  say "cookies: $COOKIES"
  say "note:    ~0.09-0.10 videos/sec for uncached ids. Ctrl-C is safe; it resumes."

  FUSE_ARGS=(--cookies "$COOKIES")
  [ -z "$FUSE_LIMIT" ] || FUSE_ARGS+=(--limit "$FUSE_LIMIT")
  [ -z "$FUSE_SLEEP" ] || FUSE_ARGS+=(--sleep "$FUSE_SLEEP")

  # `rc=0; cmd || rc=$?` is the only idiom that both survives `set -e` and
  # preserves the code. `if ! cmd` discards it ($? is 0 inside the branch).
  npm run data:fuses -- "${FUSE_ARGS[@]}" || FUSE_RC=$?

  if [ "$FUSE_RC" -ne 0 ]; then
    say ""
    say "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    if [ "$FUSE_RC" -eq 2 ]; then
      warn "data:fuses hit the YouTube bot-check and exited 2."
      warn "  The session cookies are stale or rejected. Re-export youtube.com"
      warn "  cookies WHILE SIGNED IN, then re-run — the pass resumes."
      warn "  Before burning a fresh export, probe with:"
      warn "      npm run data:fuses -- --cookies \"$COOKIES\" --limit 1"
      warn "  a transient throttle stop often clears on its own."
    else
      warn "data:fuses failed with exit code ${FUSE_RC}."
      warn "  Per-video download failures do NOT exit, so this was a hard error."
    fi
    warn "Continuing: whatever it detected before dying is already flushed to"
    warn "$DETECTIONS and will be parsed in and committed. This script exits 2"
    warn "at the end to mark the refresh as partial."
    say "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  fi

  FUSES_AFTER=$(json_object_count "$DETECTIONS") \
    || fail "$DETECTIONS is unparseable after the fuse pass — refusing to stage a corrupt artifact.
  Recover with: git checkout -- $DETECTIONS   (this run's detections are lost)"
  FUSE_DELTA=$(( FUSES_AFTER - FUSES_BEFORE ))
  [ "$FUSE_DELTA" -ge 0 ] || FUSE_DELTA=0
  say ""
  say "detections: ${FUSES_BEFORE} -> ${FUSES_AFTER}  (+${FUSE_DELTA})"

  # ── 3. re-parse so detections reach videos.json ─────────────────────────────
  # Unconditional, even at delta 0: it costs seconds, and gating it on the delta
  # bakes in an assumption that stops holding the moment --force or --ids gets
  # forwarded.
  banner "3/4  npm run data:parse  (merge detections into videos.json)"
  npm run data:parse
fi

# ── 4. gap report (diagnostic; writes only cache/fuse/review/) ────────────────
banner "4/4  npm run data:fuse-gaps  (diagnostic)"
GAPS_RC=0
npm run data:fuse-gaps || GAPS_RC=$?
if [ "$GAPS_RC" -ne 0 ]; then
  warn "data:fuse-gaps exited ${GAPS_RC}. It has no process.exit of its own, so"
  warn "  this was an uncaught throw. It writes only to cache/fuse/review/, so"
  warn "  the data artifacts are unaffected and the commit proceeds."
fi

# ── commit ────────────────────────────────────────────────────────────────────
banner "commit"

if [ "$DO_COMMIT" -eq 0 ]; then
  say "--no-commit: nothing staged, nothing committed. Working tree:"
  git status --short -- data/
  [ "$FUSE_RC" -eq 0 ] || exit 2
  exit 0
fi

git add -- "${STAGE_PATHS[@]}"

# report.md carries a "_Generated <ISO ts>_" line that changes on every parse.
# A diff that is ONLY that line is not a data change, so drop it — that is what
# keeps a report.md diff in history meaningful.
#
# The workflow does this with a grep pipeline ending in `|| true`, which is
# correct under GitHub's default `bash -e {0}` (no pipefail) but ABORTS under
# `set -euo pipefail`: on an empty diff the FIRST grep exits 1 and pipefail
# promotes that to the pipeline's status, killing the script at the assignment —
# after the multi-hour fuse run and before the commit. awk is exit-code-neutral
# and always prints a number.
REPORT_REAL_LINES=$(
  git diff --cached -- data/report.md | awk '
    /^(\+\+\+|---)/    { next }
    /^[+-]_Generated / { next }
    /^[+-]/            { n++ }
    END                { print n + 0 }
  '
)
if [ "$REPORT_REAL_LINES" -eq 0 ]; then
  git restore --staged --worktree -- data/report.md
fi

if git diff --cached --quiet; then
  say "No data changes — skipping commit."
else
  N=$(json_array_length data/videos.json) \
    || fail "data/videos.json is unparseable — refusing to commit."

  # Count fuses against HEAD, not against this run's starting worktree: the
  # subject should describe what the COMMIT contains. Those differ whenever a
  # previous run left detections uncommitted (--no-commit, or an interrupt).
  # Falls back to this run's delta if the file is new or unreadable in HEAD.
  COMMITTED_FUSES=$FUSE_DELTA
  if HEAD_FUSES=$(json_object_count <(git show "HEAD:$DETECTIONS" 2>/dev/null) 2>/dev/null); then
    NOW_FUSES=$(json_object_count "$DETECTIONS") || NOW_FUSES=""
    if [ -n "$NOW_FUSES" ] && [ "$NOW_FUSES" -ge "$HEAD_FUSES" ]; then
      COMMITTED_FUSES=$(( NOW_FUSES - HEAD_FUSES ))
    fi
  fi

  SUBJECT="data: refresh $(date -u +%F) — ${N} videos"
  if [ "$COMMITTED_FUSES" -gt 0 ]; then
    SUBJECT="${SUBJECT}, ${COMMITTED_FUSES} fuses"
  fi
  git commit -q -m "$SUBJECT"
  say "✓ committed: $SUBJECT"
  git --no-pager show --stat --format='  %h  %an  %s' HEAD
  say ""
  say "Not pushed. Review, then: git push"
fi

# ── outcome ───────────────────────────────────────────────────────────────────
if [ "$FUSE_RC" -ne 0 ]; then
  say ""
  warn "PARTIAL REFRESH: the fuse pass failed (exit ${FUSE_RC}); detections are incomplete."
  warn "  Fix the cause and re-run — data:fuses is incremental and resumes."
  exit 2
fi

say ""
say "✓ refresh complete."
exit 0
