# Competition Stripe TEST workflows: validated pin (replaces the CF1_PINNED_COMMIT file edit)

Scope: `.github/workflows/competition-stripe-canary.yml` and `.github/workflows/competition-stripe-test-acceptance.yml` only. No change to CODEOWNERS, branch protection, the environment, or any other workflow.
Status: DRAFT. Nothing is activated by this change. It needs the owner's code-owner review (`/.github/` is code-owned).

## Before and after

Before: the code under test was a one-line `CF1_PINNED_COMMIT` literal in each workflow file. Changing it needed its own code-owner PR approval each time (`set-pin.mjs` helped produce the edit).

After: `workflow_dispatch` takes one required input, `pin` (40-hex commit id). A new first job, `validate-pin`, proves the commit is fit to approve BEFORE the environment-protected job exists as a pending deployment. The owner's environment approval is unchanged and now authorizes a commit that has already been checked, whose evidence is in the run summary above the approval prompt. `set-pin.mjs` is removed (the literal it edited no longer exists).

## Flow

1. `validate-pin` (no environment, no secret, `contents: read` + `pull-requests: read` on the run's `github.token`): fetches main at `github.sha` (the dispatched workflow commit, so the validator and CODEOWNERS are trusted main code), runs `validatePin.mjs` under `env -i` with only `PIN`, the token and summary paths. On success it alone writes the job output `sha`. On any failure: exit 1, no output, FAILED summary, and the next job never starts, so no approval is ever requested.
2. The secret job `needs: validate-pin`; `CF1_PINNED_COMMIT: ${{ needs.validate-pin.outputs.sha }}`. The raw input is never referenced there. Existing guards (shape, placeholders, account ids), fetch of the release branch plus `merge-base --is-ancestor`, and the `rev-parse HEAD == pin` check remain; the pin is now fetched by SHA (`git fetch --depth=1 origin <sha>`) before checkout. The secret still appears only in the named Stripe-guard step's `env`.
3. The environment `competition-stripe-test` approval (owner only reviewer) is requested when the secret job becomes pending, i.e. after step 1 passed.

## What the validator proves (all from the GitHub API, never PR text)

| # | Check | API |
|---|---|---|
| 1 | pin is exactly 40 lowercase hex; commit exists and the API returns that same sha; 1 or 2 parents | `GET commits/{sha}` |
| 2 | ancestor of (or equal to) `origin/release/website-embeds` | `GET compare/{sha}...{branch}`: `ahead`/`identical` and `merge_base_commit == sha` |
| 3 | exactly one merged PR into the release branch whose `merge_commit_sha` is the pin | `GET commits/{sha}/pulls`, `GET pulls/{n}` |
| 4 | no extra commits: a 2-parent merge commit's second parent is the PR head; the PR head is the last PR commit and the count matches | `GET pulls/{n}/commits` |
| 5 | no extra diff: PR file list (name, status, rename source, additions, deletions, patch with hunk headers stripped) equals the commit's diff against its first parent | `GET pulls/{n}/files`, `GET compare/{parent}...{sha}` |
| 6 | code-owner approval: a user in CODEOWNERS (main) for `/.github/` whose latest decisive review (APPROVED / CHANGES_REQUESTED / DISMISSED) is APPROVED, is a `User`, is not the PR author, is on `commit_id == PR head at merge`, and was submitted at or before `merged_at`; no code owner has a later open change request | `GET pulls/{n}/reviews` |
| 7 | every list is read to the end; more than 3000 items, any non-200, any thrown error, any malformed shape => fail | all |

A rebase merge of several commits fails check 5 by design (the commit holds only the last commit's diff); use squash or a merge commit for release PRs.

## Threat model

Trusted: the workflow file and validator on main at `github.sha` (owner-gated by CODEOWNERS, and a dispatch uses main's copy; a PR cannot change what runs), GitHub's API, the `competition-stripe-test` environment protection.
Untrusted: the `pin` input, PR titles/bodies/commit messages (never read), the code at the pin (it runs only in the secret job, after the owner approves, as before).

| Attack | Defense |
|---|---|
| Shell/expression injection through `pin` | Used only as an `env` value of one step and in `run-name`; no `${{ }}` in any `run:` text; validated as 40-hex before anything else; secret job never sees the raw input (tripwire tests). |
| Pin an unreviewed commit (direct push, or a PR with no/only non-owner approval) | Checks 3 and 6. |
| Push a malicious commit after the owner approved | Approval `commit_id` must equal the PR head at merge, and that head is the last PR commit (checks 4, 6); the pin must be the PR's merge commit with diff equal to the PR (check 5). |
| Extra commits or edits smuggled into the merge commit | Checks 4 and 5. |
| Commit not on the live line (fork, side branch, diverged) | Check 2 (API) plus the existing git re-check in the secret job. |
| Retroactive approval after merge; dismissed approval; later change request | Check 6 (`submitted_at <= merged_at`, latest decisive review wins, change request blocks). |
| Edit the validator in the PR being validated | Validator and workflow run from main; `/.github/` is owner-gated; the validator directory is not yet (see Residual risks). |
| API outage or partial data | Fail closed; nothing runs, no approval requested. |
| Approver is a bot / author approves own PR | Excluded (check 6). |

What a validator bug would allow, in the worst case: the owner is shown a PASSED summary for a commit that was not properly reviewed. It cannot by itself reach the secret: the owner's environment approval, the environment's branch rule (main only), the secret job's own guards, and the TEST-only Stripe key guard all still apply. The summary names the commit, PR, reviewer and ancestry so the owner can spot a mismatch with the approval message at the prompt.

## Residual risks and decisions for the owner

- `scripts/qa/cf1-stripe-workflow/` is NOT currently listed in CODEOWNERS (only `/.github/` is). The validator is the control, so a PR editing `validatePin.mjs` merges without owner review today. Recommended one-line CODEOWNERS addition: `/scripts/qa/cf1-stripe-workflow/ @genxttech` (like the D24 proof directories). Not included here because this change is scoped to the two workflows only; the owner decides.
- "Code owner" is the set of user owners of the `/.github/` rule (currently `genxttech`); team owners are ignored. A PR needing a different owner for other paths is still accepted if the `/.github/` owner approved it.
- Dismissal and review state are read at dispatch time; a review dismissed between validation and the owner's click is not noticed (the commit was valid when shown).
- Squash/merge commits only (see above). Rebase merges and merge queues fail closed.
- The git-based ancestry re-check in the secret job still uses depth 300; a pin older than 300 commits fails there (fail closed) even though validation passed.

## Self-test matrix (all offline, `scripts/qa/cf1-stripe-workflow/__tests__/validatePin.test.ts`)

Happy: squash; merge commit; branch tip; multi-page lists with superseded review.
Negative (each asserts the exact failure code): N01 malformed pin; N02 missing commit / wrong object; N03 parent count; N04 not an ancestor (diverged, behind, wrong merge base); N05 no PR; N06 PR not merged / other base / other merge sha; N07 two PRs; N08 unapproved (none, comment, pending); N09 non-code-owner approval; N10 post-approval push (approval on older commit); N11 head not last PR commit / count mismatch; N12 dismissed; N13 later change request; N14 self-approval, bot reviewer; N15 approval after merge; N16 extra commits (second parent); N17 extra/missing/altered files, lines, patch, rename; N18 rebase merge; N19 API error (500/403/404/502) at every endpoint; N20 throwing client / empty body; N21 truncated list; N22 CODEOWNERS without user owner; N23 bad repo/branch input.
Workflow tripwires (`workflows.test.ts`, both files): exact input set; two jobs; `validate-pin` has no environment and no `secrets.` reference and read-only permissions; the secret job `needs` it and takes the pin only from its output; validator fetched from `github.sha`; raw input appears exactly twice (run-name, validator env); fetch by SHA retained; the original 23 hardening tripwires retained (the placeholder-pin test became "pin is the validated output").
Live check (read-only, App token, 2026-11-20): the real PR 737 merge commit PASSED; main's tip (diverged from the release line) FAILED `ancestry`; malformed pins FAILED `shape`.
