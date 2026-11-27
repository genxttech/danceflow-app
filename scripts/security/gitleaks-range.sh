#!/usr/bin/env bash
# Prints the git revision arguments that gitleaks must scan for one CI event.
# It exits non-zero instead of printing a range it cannot trust, so a scan never silently covers nothing.
# Environment: EVENT_NAME, PR_BASE_SHA, PR_HEAD_SHA, PUSH_BEFORE_SHA, PUSH_AFTER_SHA, REF_NAME, DEFAULT_BRANCH
set -euo pipefail

die() { echo "gitleaks-range: $*" >&2; exit 1; }
is_commit() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] && git cat-file -e "$1^{commit}" 2>/dev/null; }

case "${EVENT_NAME:-}" in
  pull_request)
    is_commit "${PR_BASE_SHA:-}" || die "pull request base commit is not available"
    is_commit "${PR_HEAD_SHA:-}" || die "pull request head commit is not available"
    range="$PR_BASE_SHA..$PR_HEAD_SHA"
    ;;
  push)
    is_commit "${PUSH_AFTER_SHA:-}" || die "pushed commit is not available"
    [ -n "${REF_NAME:-}" ] && [ -n "${DEFAULT_BRANCH:-}" ] || die "branch names are missing"
    main_ref="refs/remotes/origin/$DEFAULT_BRANCH"
    if [ "$REF_NAME" = "$DEFAULT_BRANCH" ]; then
      if is_commit "${PUSH_BEFORE_SHA:-}"; then
        range="$PUSH_BEFORE_SHA..$PUSH_AFTER_SHA"
      else
        range="$PUSH_AFTER_SHA" # no usable previous tip on the default branch: scan its whole history
      fi
    else
      git rev-parse --verify --quiet "$main_ref^{commit}" >/dev/null || die "$main_ref is not available"
      # Commits already on the default branch are scanned by its own pushes, so they are excluded here.
      if is_commit "${PUSH_BEFORE_SHA:-}"; then
        range="$PUSH_BEFORE_SHA..$PUSH_AFTER_SHA ^$main_ref"
      else
        range="$main_ref..$PUSH_AFTER_SHA" # new branch or force push
      fi
    fi
    ;;
  *)
    die "unsupported event '${EVENT_NAME:-}'"
    ;;
esac

# shellcheck disable=SC2086
git rev-list --count $range >/dev/null || die "git cannot read the range"
printf '%s\n' "$range"
