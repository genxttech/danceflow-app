#!/usr/bin/env bash
# Optional local pre-commit hook: scans the staged changes with gitleaks. Setup: docs/ops/Secret_Scanning.md.
# Environment: GITLEAKS_BIN (default: gitleaks on PATH).
set -euo pipefail

bin="${GITLEAKS_BIN:-gitleaks}"
if ! command -v "$bin" >/dev/null 2>&1; then
  echo "pre-commit: gitleaks was not found, so nothing was scanned. Install it, set GITLEAKS_BIN, or remove this hook." >&2
  exit 1
fi

top="$(git rev-parse --show-toplevel)"
args=(git --pre-commit --staged --redact --verbose --no-banner --ignore-gitleaks-allow)
# A branch cut before the configuration existed is scanned with the default rules.
if [ -f "$top/.gitleaks.toml" ]; then args+=(--config "$top/.gitleaks.toml"); fi
exec "$bin" "${args[@]}" "$top"
