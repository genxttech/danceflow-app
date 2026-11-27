# NSI I2 M11: ensure_request hardening after the M10 review

Status: validated on fresh local disposable stacks (and the full-chain replay for the pre-amendment bytes). Applied to DEV only after the amendments below (see `rehearsal/d7_dev_m11/` once applied). **Never PROD without owner approval.**

Files: `src/lib/supabase/migrations/20261118100000_nsi_i2_m11_ensure_request_hardening.sql` (sha256 `e34649e1bfbdefc8b1aa9759ba5cd74b8cfb447f46597db12c9665b4160f8191`), rollback `rollback/20261118100000_nsi_i2_m11_ensure_request_hardening_rollback.sql` (sha256 `b5b98d0c9cc073b2a8216cc7a4a06eaa33c04ee75d1715b637161507777f0309`), `sql-tests/test_T_nsi_i2_m11_ensure_request_local.sql` (18 checks), `sql-tests/nsi_i2_m11_lifecycle_local.sh`. Evidence: `rehearsal/m11_local/lifecycle_run_amended_2026-11-23.txt` (first, pre-amendment run kept as `lifecycle_run_first_2026-11-23.txt`).

## What M11 changes
| Item | Change |
|---|---|
| P2-2 detached link | Evaluator returns `detached_from_request` (class not_applicable) when the open request has a detached link for the appointment; `ensure_request` returns NULL and writes nothing. The write attempt that could never succeed is gone. The reconciler still evaluates such an appointment; but the **preview no longer lists any appointment that has a link, attached or detached** (replaced function, marker m11). Evaluation churn is therefore removed from the preview path only; the reconciler itself (I4) must also skip linked appointments. |
| P2-3 anchor (spec 3.4 step 2) | After every attach (auto or manual) the anchor is recomputed as the earliest live attached appointment **of this client** (client or partner) that **has not ended**: status scheduled, rescheduled or confirmed, `ends_at > now()`, ordered by start then id. It moves earlier when a sooner booking attaches and later when the current anchor is cancelled, attended, no-show, detached, reassigned or ended. An ended-but-unmarked lesson never takes the anchor (no regression vs M10); a lesson under way does. With no qualifying appointment the anchor is left as is. The row is written only when the anchor changes (no write, no tuple churn, when unchanged). |
| Draft retention | `compute_draft_retention` copies the anchor into `draft_anchor_appointment_id` at the first draft save and uses that column from then on, with `draft_max_at` fixed at first save. So: before the first draft the anchor determines retention; afterwards later anchor moves change neither the draft anchor nor `draft_max_at` (test H14). |
| P2-5 comment | The client lock does not serialize appointment changes (appointments are intentionally not locked); the I4 caller must use READ COMMITTED per call. |
| Precondition | A DO block refuses M11 unless `intake_ensure_request` is at the M10/M11 level and `intake_archive_template` (M9) exists. |

Not covered, and a correction to the earlier wording: the anchor is recomputed only when a call attaches an appointment to that request. Because the preview (and the I4 reconciler contract) skip appointments that already have a link, nothing re-evaluates an already-linked appointment, so a cancelled or ended anchor is **not** refreshed by a later reconciler pass. I4 needs an explicit per-open-request anchor-refresh step (for example a small RPC that recomputes the anchor for one open request, called for open requests whose anchor appointment is no longer live). Until then a stale anchor is corrected only when another appointment attaches.

## Tests (M11 suite 18 checks)
H01 detached (evaluator, write path, preview), H02 anchor moves earlier, H03 partner-only history, H04 cancelled vs no_show history, H05 exact 10-minute and enabled_at edges, H06 re-intake before/after floor, H07 catalog and ACLs, H08 anchor leaves a cancelled, no-show or attended anchor, H09 tie on starts_at (lower id), H10 manual path recompute, H11 reassigned-client appointment, H12 ended-unmarked does not anchor / ongoing does, H13 no write when unchanged (same tuple), H14 draft retention. Concurrency: existing K1-K3 harness (8 sessions) on M11.

## Evidence (amended bytes, local fresh containers, heavy lock held then released)
- Catalog M10 `c6b3d46b…|670` to M11 `9c575d50…|670`; exactly four parts differ: `assert_catalog`, `evaluate_appointment_eligibility`, `intake_reconcile_preview`, `intake_ensure_request`.
- Suites on M11: M11 18/18, M10 17/17, M7 36/36, M9 17/17, I1 foundation 97/97, I2-local 92/92.
- Rollback restores M10 exactly (M10 suite passes again); second rollback refused; re-apply identical; M11 replay idempotent; M10 replay on M11 fails closed; M11 refused on an M9 database; concurrency K1-K3: 0 failures, 0 deadlocks.
- Full-chain replay (NSI last vs NSI inside history): identical catalogs, see `NSI_Full_Chain_Replay_Plan.md`. It ran on the pre-amendment M11 and should be repeated for the final bytes.
