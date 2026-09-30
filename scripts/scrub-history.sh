#!/usr/bin/env bash
#
# Rewrite git history to remove strings and files that should never have been
# published, then verify the result.
#
# This exists because "the current tree is clean" is not the same as "the
# repository is clean". Deleting a line does not delete it from history: anyone
# can recover it with `git log -p`, and GitHub serves that history to every
# clone. Before publishing a repository that was developed on a personal
# machine, check the history, not just HEAD.
#
# Usage:
#   scripts/scrub-history.sh --replace 'old.example==>new.example' [--replace ...]
#                           [--remove-path path ...]
#
# Add --dry-run to report what would change without changing it. This is the
# mode to use first: it is the only way to find out what is actually in the
# history before committing to a rewrite.
#
# WHAT THIS DOES, AND WHY IT IS DESTRUCTIVE
# ----------------------------------------
# It rewrites every commit, so every commit hash changes. That means:
#
#   * `git push --force-with-lease` is required. Everyone else must re-clone.
#   * Open pull requests and any fork will break.
#   * This cannot be undone once pushed. Take a backup first.
#   * Deployment tokens, CI caches and `CHANGELOG` links to commits may break.
#
# It deliberately does NOT push. It rewrites the local repository and tells you
# what to run next, so the force-push stays a separate, explicit decision.
#
set -euo pipefail

REPLACEMENTS=()
REMOVE_PATHS=()
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --replace)     REPLACEMENTS+=("$2"); shift 2 ;;
    --remove-path) REMOVE_PATHS+=("$2"); shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

# Counts rather than using `grep -q`: grep exits at the first match, git log
# dies of SIGPIPE, and `set -o pipefail` reports that as failure. The result is
# a path that was correctly removed still reading as "present", so the script
# could never report success.
history_has_path() {
  [ "$(git log --all --oneline -- "$1" 2>/dev/null | wc -l)" -gt 0 ]
}

# ---------------------------------------------------------------------------
# Audit mode (default): report, change nothing.
# ---------------------------------------------------------------------------
audit() {
  echo "Auditing history in $(git rev-list --count HEAD) commits."
  echo "This changes nothing. Re-run without --dry-run to act."
  echo
  local dirty=0
  local hit
  for hit in "${REPLACEMENTS[@]:-}"; do
    [ -n "$hit" ] || continue
    local needle="${hit%%==>*}"
    local n_blob n_msg
    n_blob=$(git log --all -p 2>/dev/null | grep -cF -- "$needle" || true)
    n_msg=$(git log --all --format=%B 2>/dev/null | grep -cF -- "$needle" || true)
    if [ "$n_blob" -gt 0 ] || [ "$n_msg" -gt 0 ]; then
      dirty=1
      printf '  %-40s %s in blobs, %s in commit messages\n' \
        "$needle" "$n_blob" "$n_msg"
      git log --all --format= --name-only -S"$needle" 2>/dev/null \
        | sort -u | grep -v '^$' | head -8 | sed 's/^/      /'
    fi
  done
  if [ "${#REMOVE_PATHS[@]}" -gt 0 ]; then
    for p in "${REMOVE_PATHS[@]}"; do
      if history_has_path "$p"; then
        dirty=1
        printf '  %-40s present in history\n' "$p"
      fi
    done
  fi
  [ "$dirty" -eq 0 ] && echo "  Nothing matched."
  echo
  echo "Also worth checking by hand, because they are easy to miss:"
  echo "  * RFC1918 (10/8, 172.16/12, 192.168/16) and CGNAT (100.64/10)"
  echo "    addresses -- the latter is what Tailscale hands out."
  echo "  * Bare hostnames, which are ambiguous: a grep for 'pve' in this"
  echo "    project's history matched 26 lines of minified JavaScript variable"
  echo "    names and not one reference to a host."
}

if [ "$DRY_RUN" -eq 1 ] || { [ "${#REPLACEMENTS[@]}" -eq 0 ] && [ "${#REMOVE_PATHS[@]}" -eq 0 ]; }; then
  audit
  exit 0
fi

# ---------------------------------------------------------------------------
# Rewrite.
# ---------------------------------------------------------------------------
# Respect a caller-supplied location before looking on PATH.
FILTER_REPO="${FILTER_REPO:-$(command -v git-filter-repo || true)}"
if [ -z "$FILTER_REPO" ]; then
  cat >&2 <<'MSG'
git-filter-repo is not installed. It is strongly preferred over filter-branch,
which is known to leave refs and reflogs behind -- exactly the thing this
script is meant to clean up.

  curl -sSLo /tmp/git-filter-repo \
    https://raw.githubusercontent.com/newren/git-filter-repo/main/git-filter-repo
  chmod +x /tmp/git-filter-repo
  FILTER_REPO=/tmp/git-filter-repo

MSG
  exit 1
fi

echo "This rewrites every commit hash in the local repository."
echo "Press Ctrl-C to stop. Taking a backup ref at refs/pre-scrub."
git update-ref refs/pre-scrub HEAD

REPLACE_FILE="$(mktemp)"
trap 'rm -f "$REPLACE_FILE"' EXIT
: > "$REPLACE_FILE"
for r in "${REPLACEMENTS[@]}"; do
  # shellcheck disable=SC2001
  sed 's/^\(.*\)$/literal:\1/' <<<"$r" >> "$REPLACE_FILE"
done

set -- --force
# --path *restricts* the rewrite to the named paths. Without --invert-paths it
# is an include filter, so the files are never removed and the rewrite is
# applied to the wrong scope. --invert-paths turns the list into "exclude these",
# which is what removing a file means.
if [ "${#REMOVE_PATHS[@]}" -gt 0 ]; then
  set -- "$@" --invert-paths
  for p in "${REMOVE_PATHS[@]}"; do set -- "$@" --path "$p"; done
fi
if [ "${#REPLACEMENTS[@]}" -gt 0 ]; then
  set -- "$@" --replace-text "$REPLACE_FILE"
  # --replace-text rewrites blob content only. Commit messages need their own
  # pass, or a domain mentioned only in a commit subject survives the rewrite.
  set -- "$@" --replace-message "$REPLACE_FILE"
fi

"$FILTER_REPO" "$@"

echo
echo "Verifying."
fail=0
for r in "${REPLACEMENTS[@]}"; do
  needle="${r%%==>*}"
  n=$(git log --all -p 2>/dev/null | grep -cF -- "$needle" || true)
  m=$(git log --all --format=%B 2>/dev/null | grep -cF -- "$needle" || true)
  if [ "$n" -gt 0 ] || [ "$m" -gt 0 ]; then
    echo "  STILL PRESENT: $needle ($n blobs, $m messages)"
    fail=1
  else
    echo "  gone: $needle"
  fi
done
for p in "${REMOVE_PATHS[@]}"; do
  if history_has_path "$p"; then
    echo "  STILL PRESENT: $p"
    fail=1
  else
    echo "  gone: $p"
  fi
done

[ "$fail" -eq 0 ] || { echo "Scrub incomplete; do not push."; exit 1; }

cat <<'MSG'

Rewrite complete and verified locally.

Next steps, in order:
  1. Re-run your test suite and confirm the tree at HEAD is unchanged
     (git diff refs/pre-scrub --stat should show only the intended edits).
  2. Re-tag releases if you care about them keeping their hashes:
       git tag -d v0.1.0 && git tag v0.1.0
  3. Force-push every ref, including tags:
       git push --force-with-lease --follow-tags origin main --tags
  4. Tell anyone who cloned to re-clone. Their old commits will no longer
     resolve.
  5. On GitHub, open Settings -> Danger Zone and ask support to garbage
     collect the old objects. Until then the previous history is still
     reachable from a cached clone even though the refs are gone.

MSG
