# Secret scanning (gitleaks)

## What runs in CI

`.github/workflows/secret-scan.yml` runs on every push to a branch and on every pull request. It is **not** a required check.

1. Downloads the pinned gitleaks release and verifies its SHA-256 before running it. No third-party action is used.
2. Runs `scripts/security/gitleaks-selftest.mjs`, which proves what the configuration reports and what it allows.
3. Scans the commits the event introduces (`scripts/security/gitleaks-range.sh`). Any finding fails the job.
4. Prints how many findings the current tree has outside the allowlist, per rule. This step never fails the job.

Inline `gitleaks:allow` comments are ignored.

## Limits

- Only commits introduced by the event are scanned. Older history is not rescanned.
- A secret added only while resolving a merge conflict is not seen in the branch scan.
- It reports a secret after it has been pushed. It does not block the push.

## When it reports a finding

A real credential: rotate it first. Removing it from the branch does not make it safe again.

A test fixture: change the fixture so that it is visibly synthetic (short, or containing a separator), or add a narrow
allowlist to `.gitleaks.toml` together with a flagged and an allowed case in the self-test.

## Optional pre-commit hook

Needs gitleaks installed (the version in the workflow). Git worktrees of one clone share their hooks, so installing
it applies to all of them. Do not overwrite an existing `pre-commit` hook.

```bash
cp scripts/security/pre-commit-gitleaks.sh "$(git rev-parse --git-path hooks)/pre-commit"
chmod +x "$(git rev-parse --git-path hooks)/pre-commit"
```

## Updating gitleaks

Change `GITLEAKS_VERSION` and `GITLEAKS_SHA256` together, taking the checksum from the release's checksums file.
