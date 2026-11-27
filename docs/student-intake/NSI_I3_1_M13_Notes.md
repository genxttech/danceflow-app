# NSI I3-1 (M13): purge hardening and audit-actor consistency

Status: **implemented and validated on fresh local disposable stacks only. NOT applied to DEV or PROD.** It replaces lock and privilege-adjacent logic (the role-owned purge), so it needs an independent delta review before any DEV apply. The purge is unreachable on DEV until an I4 cron exists; no purge cron, UI or outbox wiring is part of this.

Files: `src/lib/supabase/migrations/20261118102000_nsi_i3_m13_purge_hardening.sql` (sha256 `3a6413ce775c292faca347fed096884ab4eb4961b2bd3f98f9aeffc995e3df4b`), rollback `rollback/20261118102000_nsi_i3_m13_purge_hardening_rollback.sql` (sha256 `a705ca533c80a1c8cc48e258767dfffe23eeffed32aa64bcc259f2277a60b9c4`), `sql-tests/test_T_nsi_i3_1_m13_local.sql` (5 checks), `sql-tests/nsi_i3_1_m13_lifecycle_local.sh`, concurrency harness extended (C5d, C7), evidence `rehearsal/m13_local/lifecycle_run_2026-11-23.txt`.

## What changes (carry-forward H1-H5 of the M12 reviews)
| Item | Change |
|---|---|
| H1 | The purge first picks a **bounded set of candidate clients (at most 50 per call, ordered)** with reads only, so the number of advisory locks per call is bounded and far below `max_locks_per_transaction`. A larger backlog is cleared over successive calls |
| H2 | The non-waiting client locks (`try_lock_client`) are taken in **one statement**; the legal-hold check and the deletes run in **later statements** (fresh snapshot), only for clients whose lock this call holds. A client whose lock another writer holds is skipped and cleared on a later call |
| H3 | Tests and probes: bounded purge across calls (55 clients: 50, then 5, then 0), purge honors holds, minting-actor guard negative test with a positive control, deterministic C7 (purge never waits and skips a held client) and its mutation probe, separate lock-removal probes for bulk revoke (C5b), staff revoke (C5d, new) and issue (C5c) |
| H4 | `session_revoked` is audited as a **system** event (same as `link_exchanged`) |
| H5 | Operations: run the purge one call at a time; the cron ships with I4 |
| Markers | `purge_expired_impl` and `intake_revoke_session` carry `nsi-body:m13`, listed in `assert_catalog`; no new objects, no grant changes |

## Evidence (local; heavy lock taken and released by the harness itself)
- Catalog M12 `3353ac98…|768` to M13 `97e13781…|768` (same parts, two bodies changed plus assert_catalog).
- Suites on M13: M13 5/5, M12 26/26, M11 18/18, I1 foundation 109/109, I2-local 92/92, level-10 DEV-safe 9/9.
- Probes detected: purge unbounded (P01), purge ignoring holds (P02), revoke_session actor (P03), purge without try_lock_client (C7), bulk revoke / staff revoke / issue without lock_client (C5b, C5d, C5c).
- Rollback restores the M12 fingerprint exactly; a second rollback is refused; re-apply identical; M13 replay idempotent.
- Concurrency C1-C7 (including C5d and C7): 0 failures, 0 deadlocks.
- **Documented limitation:** replaying the M12 migration file on an M13 database silently restores the M12 purge and `intake_revoke_session` bodies (the M12 self-check cannot know about M13 markers); the catalog then equals M12, and re-applying M13 restores it. Never replay an older migration on a newer database.
- Not covered: the full-chain replay on the M13 bytes (to run before the DEV apply).
