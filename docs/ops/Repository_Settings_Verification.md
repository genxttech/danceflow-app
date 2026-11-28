# Repository settings verification

`scripts/ops/verify-repo-settings.mjs` compares the repository's live GitHub settings with a saved baseline. Use it
before and after any repository transfer, plan change or visibility change. It changes no setting.

The baseline is a folder of saved API responses and is kept outside the repository: `repo.json`, `workflows.json`,
`environments.json`, `env_branch_policies_<environment>.json`, `ruleset_<id>.json`, `github_app_installation.json`.

```bash
node scripts/ops/verify-repo-settings.mjs --baseline <folder> --repo <owner/name> --app-id <id> --app-key <pem file> \
  --expect private --owner-type Organization --pr <number>
```

| Option | Meaning |
|---|---|
| `--expect` | `private` (default) or `public`: what an anonymous visitor must see |
| `--owner-type` | expected owner account type; defaults to the baseline's |
| `--pr` | a pull request opened for this verification, to prove the required checks still report |
| `--verbose` | also list the checks that passed |

Exit code `0`: every automated check passed. `1`: at least one difference. `2`: something could not be verified.

It checks anonymous access, the App and its installation, repository identity and settings, each ruleset and the rules
GitHub applies to a matching branch, environments and their branch policies, workflow states, and the required checks.

Every run ends with `MANUAL` lines. The token cannot check those, so exit code `0` does not cover them.

The App private key is read locally to sign requests. The installation token it issues has read permissions only and is
never printed or stored.

Tests (not part of the required checks):

```bash
node --test scripts/ops/__tests__/verify-repo-settings.test.mjs
```
