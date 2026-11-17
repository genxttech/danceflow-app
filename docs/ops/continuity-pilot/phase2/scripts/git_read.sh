#!/bin/bash
# Reviewed helper: read-only git inside ONE repository directly under C:/Dev. The isolated pilot child has no direct access to
# git subcommands that take arguments; this script is its only path to them. It validates every argument against a per-subcommand
# allowlist (argv level, not raw command text), so flags that read arbitrary files (--no-index, -O<orderfile>, --ext-diff,
# --textconv, --output, --file, config injection) can never reach git.
# usage: git_read.sh <C:/Dev/name> <ls-tree|show|cat-file|log|diff|rev-parse|status> [allowed flags and revisions/paths...]
# Positional revisions match [A-Za-z0-9._/@^~{}+:-] (no leading "-" or ":"), no ".." path segment, no drive or absolute path.
# Paths come only after a literal "--" and match [A-Za-z0-9._/-], relative, no ".." segment.
export MSYS_NO_PATHCONV=1
set -eu
for v in $(compgen -e | grep '^GIT_' || true); do unset "$v"; done
unset BASH_ENV ENV PAGER
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1
refuse() { echo "refused: $1" >&2; exit 2; }
[ "$#" -ge 2 ] || refuse "usage git_read.sh <C:/Dev/name> <subcommand> [args]"
[ "$#" -le 20 ] || refuse "too many arguments"
D=$1; SUB=$2; shift 2
[[ "$D" =~ ^C:/Dev/[A-Za-z0-9_-][A-Za-z0-9._-]*$ ]] || refuse "directory must be C:/Dev/<name>"
[ -d "$D" ] || refuse "no such directory"
# the directory must be the TOP LEVEL of a git worktree: in a plain directory `git diff -- a b` would fall into implicit --no-index (arbitrary file reads)
TOP=$(git --no-pager -C "$D" -c safe.bareRepository=explicit -c core.fsmonitor=false rev-parse --show-toplevel 2>/dev/null) || refuse "not a git worktree"
[ "$(printf %s "$TOP" | tr A-Z a-z)" = "$(printf %s "$D" | tr A-Z a-z)" ] || refuse "directory is not a worktree top level"
FLAGS=""
case "$SUB" in
  ls-tree)   FLAGS=" -r -t -l -d -z --name-only --name-status --full-name --full-tree --long " ;;
  show)      FLAGS=" --stat --name-only --name-status --oneline --no-patch -s --shortstat --numstat --no-color -p --summary --no-renames " ;;
  cat-file)  FLAGS=" -p -t -s -e " ;;
  log)       FLAGS=" --oneline --stat --name-only --name-status --shortstat --numstat --no-color --decorate --graph -p --first-parent --reverse --no-merges --merges --no-renames " ;;
  diff)      FLAGS=" --stat --name-only --name-status --shortstat --numstat --cached --staged --no-color -p --summary --no-renames " ;;
  rev-parse) FLAGS=" --abbrev-ref --short --verify --is-inside-work-tree --is-bare-repository " ;;
  status)    FLAGS=" --short -s --porcelain --branch -b --no-renames -uall -uno " ;;
  *) refuse "subcommand not allowed" ;;
esac
ARGS=(); PATHS=(); AFTER=0
for a in "$@"; do
  [ "${#a}" -le 200 ] || refuse "argument too long"
  if [ "$AFTER" = 1 ]; then
    [[ "$a" =~ ^[A-Za-z0-9._/-]+$ ]] || refuse "path argument: bad characters"
    [[ "$a" != /* ]] || refuse "path argument: absolute"
    [[ "$a" =~ ^[A-Za-z]: ]] && refuse "path argument: drive path"
    [[ "$a" =~ (^|/)\.\.(/|$) ]] && refuse "path argument: .. segment"
    PATHS+=("$a"); continue
  fi
  if [ "$a" = "--" ]; then AFTER=1; continue; fi
  case "$a" in
    -*)
      if [[ "$a" =~ ^-[0-9]{1,4}$ ]] && { [ "$SUB" = log ] || [ "$SUB" = show ]; }; then ARGS+=("$a"); continue; fi
      if [[ "$a" =~ ^-U[0-9]{1,2}$ ]] && { [ "$SUB" = diff ] || [ "$SUB" = show ]; }; then ARGS+=("$a"); continue; fi
      if [[ "$a" =~ ^--max-count=[0-9]{1,4}$ ]] && [ "$SUB" = log ]; then ARGS+=("$a"); continue; fi
      case "$FLAGS" in *" $a "*) ARGS+=("$a") ;; *) refuse "flag not allowed for $SUB" ;; esac
      ;;
    *)
      [[ "$a" =~ ^[A-Za-z0-9._/@^~{}+:-]+$ ]] || refuse "revision argument: bad characters"
      [[ "$a" != :* ]] || refuse "revision argument: leading colon"
      [[ "$a" != /* ]] || refuse "revision argument: absolute"
      [[ "$a" =~ ^[A-Za-z]: ]] && refuse "revision argument: drive path (absolute or drive-relative)"
      [[ "$a" =~ (^|[/:])\.\.(/|$) ]] && refuse "revision argument: .. segment"
      ARGS+=("$a")
      ;;
  esac
done
# diff/show/log always get a literal "--" after the revisions: git can then never reinterpret two positional arguments as file paths
# (implicit --no-index mode, which reads arbitrary files). status/diff never recurse into nested repositories.
TAIL=(); if [ "${#PATHS[@]}" -gt 0 ]; then TAIL=(-- "${PATHS[@]}"); else case "$SUB" in diff|show|log) TAIL=(--) ;; esac; fi
EXTRA=(); case "$SUB" in diff|show|log) EXTRA=(--no-ext-diff --no-textconv) ;; esac
case "$SUB" in status|diff) EXTRA+=(--ignore-submodules=all) ;; esac
exec git --no-pager --no-replace-objects --no-optional-locks -C "$D" -c core.pager=cat -c core.fsmonitor=false -c core.hooksPath=/dev/null -c safe.bareRepository=explicit -c protocol.allow=never "$SUB" "${EXTRA[@]}" "${ARGS[@]}" "${TAIL[@]}"
