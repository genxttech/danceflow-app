# NSI I2 M11: ensure_request hardening after the M10 review

Status: **authored and validated on a fresh local disposable stack only. NOT applied to DEV or PROD.** Needs an independent review pass before a DEV apply (standing DEV authorization covers the apply itself; PROD is an owner gate).

Files: `src/lib/supabase/migrations/20261118100000_nsi_i2_m11_ensure_request_hardening.sql` (sha256 `919f7eda98a9078c861228830598c3c112ba7f21d20912310bcadacd053c67a6`), rollback `rollback/20261118100000_nsi_i2_m11_ensure_request_hardening_rollback.sql` (sha256 `6c7bb776bde64b971219c98cd8a87497fe909fd3cea155a971da02ff21e719ba`), `sql-tests/test_T_nsi_i2_m11_ensure_request_local.sql` (9 checks), `sql-tests/nsi_i2_m11_lifecycle_local.sh`, evidence log `rehearsal/m11_local/lifecycle_run_2026-11-23.log`.

## Review items addressed
| Item | Change |
|---|---|
| P2-2 detached link cannot re-attach, reconciler churn | Evaluator returns the new outcome `detached_from_request` (class not_applicable; plain-language explanation added in TypeScript) when the open request already has a detached link for that appointment; `ensure_request` returns NULL and writes nothing. A different appointment of the same client still joins the request. |
| P2-3 anchor recompute (spec 3.4 step 2) | After an attach, `anchor_appointment_id` is set to the earliest live attached appointment (never later). The draft anchor used for retention is untouched. Not covered: re-anchoring when the anchor appointment is later cancelled (needs a reconciler pass; I4). |
| P2-5 comment | The client lock does not serialize appointment changes (appointments are intentionally not locked); the I4 caller must use READ COMMITTED per call. |
| Nit: explicit precondition | A DO block refuses M11 unless `intake_ensure_request` is at the M10/M11 level and `intake_archive_template` (M9) exists. Proven: M11 is refused on an M9 database. |
| P2-4 test gaps | Partner-only history (existing student), cancelled earlier lesson (does not count) vs no_show (counts), exact 10-minute and `enabled_at` boundaries (equal is eligible, one second off is not), re-intake (after floor: new request; before floor: none), concurrent calls (existing K1-K3 harness, 8 sessions, run on M11). |

## Evidence (local, fresh containers, heavy lock held then released)
- Catalog M10 `c6b3d46b…|670` to M11 `5c8ef043…|670`; exactly three parts differ: `assert_catalog`, `evaluate_appointment_eligibility`, `intake_ensure_request`.
- Suites on M11: M11 9/9, M10 17/17, M7 36/36, M9 17/17, I1 foundation 97/97, I2-local 92/92 (E23 updated: detached is now `detached_from_request`).
- Rollback restores the M10 fingerprint exactly (M10 suite passes again); a second rollback is refused; re-apply reproduces M11; M11 replay is idempotent; M10 replay on M11 fails closed.
- Concurrency K1-K3: 0 failures, 0 deadlocks; gate closed again afterwards.
- Behavior unchanged from M10: NULL for every no-obligation outcome, manual requests unchanged, ACLs unchanged.
