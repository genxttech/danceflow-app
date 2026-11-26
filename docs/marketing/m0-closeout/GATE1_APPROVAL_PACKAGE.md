# M-0 Gate 1 owner approval package (prepared 2026-11-26; NOT run on PROD)

**Ask:** approve one read-only PROD query, to check whether a genuine transactional email has been accepted since the M-0 stage-1 apply.

Why this is a package and not a routine run: the closeout runbook does not define Gate 1 or mark it routine. Gate 1 is the owner's 2026-10-14 precondition for the unfreeze; it failed that day (no qualifying row existed yet).

## Exact SQL (read-only)

| File (in this folder) | SHA-256 |
|---|---|
| `m0_gate1_transactional_evidence_readonly.sql` | `9aaf9622e7cf128d1208c696920917d37d53c798ec71aadbc057a8a0c70f28f5` |
| Preflight: `m0_state_reconcile_readonly.sql` | `48efedc5a80b9068582ae4948fd573f8271073a10746151039c5db3a88558ca6` |
| Preflight: `m0_c1_repair_candidates_readonly.sql` | `a2934ed32b02e4d69eb2062b7722060915a3f3d2f2f43472ff932d92095fcc71` |

Run each with `sb.sh prod-read <file>` from a clean checkout (LF line endings; compare the SHA-256 first). `sb.sh` wraps the file in `BEGIN READ ONLY ... ROLLBACK`. No apply mode is involved.

DEV dry run of the Gate 1 file on 2026-11-26: exit 0, 0 qualifying rows, freeze on.

## Preflight (stop if any differs)

- Freeze row `frozen=true`; stage-2 indicators S6 and S7 = none; S8 = postgres,service_role (runbook section 1).
- C1 candidates R1 and R3 = 0.

## Pass rule (owner rule, 2026-10-14)

PASS only if "G1 qualifying transactional emails" is at least 1: an email row created after 2026-10-14 02:26 UTC, status `sent`, with a provider message id and `sent_at`, and not in the commercial family. Cron or digest HTTP 200s do not count. No test send or artificial activity may be created to satisfy it.

- **0 rows:** stop. Stay frozen. Report pending.
- **1 or more:** Gate 1 is met. This does not release the freeze. The unfreeze still follows runbook section 3 and needs its own explicit approval of the exact unfreeze file and SHA-256. The 2026-10-14 conditional authorization named further gates (2 to 4) that are not written down in the repository, so please restate them or replace them with the runbook section 6 checklist.

## Rollback

None needed: the transaction is read-only and rolled back. Nothing is written, sent or configured.

## Other open preconditions for the unfreeze (unchanged)

Runbook sections 3, 6 and 8: the live deployment SHA, sender-domain separation, the M-0D decision, the first-send audience. The reminder-deletion fix (runbook step A0) has merged to the live line (PR #768, `96d91ea69`); the release record shows that line promoted on 2026-11-22 (R+3b), not re-verified here.
