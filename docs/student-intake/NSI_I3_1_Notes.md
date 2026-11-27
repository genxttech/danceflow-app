# NSI I3-1 (M12): invitations, sessions and rate limits, local implementation notes

Status: **implemented and validated on fresh local disposable stacks only. NOT applied to DEV or PROD. Needs the independent review before any DEV apply.** No email, no outbox, no UI, Gate A closed, no billing gating. Specification: `NSI_I3_1_DB_Spec.md` (revision 2).

Files: `src/lib/supabase/migrations/20261118101000_nsi_i3_m12_invitations_sessions.sql` (sha256 `e7c1381a9d71bf4415f24634c574f47e3542ef8079333af5a7c8c5d2b8e51e09`), rollback `rollback/20261118101000_nsi_i3_m12_invitations_sessions_rollback.sql` (sha256 `e494ada10e9358504eece826c2e87f5d86b3750eca7b1b01d239b3eaef9a8c68`), `sql-tests/test_T_nsi_i3_1_local.sql` (21 checks), `sql-tests/nsi_i3_1_lifecycle_local.sh`, evidence `rehearsal/m12_local/lifecycle_run_2026-11-23.txt`. TypeScript helpers: `src/lib/intake/invitationToken.ts` (separate commit).

## What exists
- Tables (catalog level 10): `intake_invitations`, `intake_sessions`, `intake_rate_limits`; RLS on, no API-role grants, destructive-role select and delete only.
- Staff RPCs (authenticated, `assert_staff(..., 'send')`, actor = `auth.uid()`, no actor parameter): `intake_issue_invitation`, `intake_revoke_invitations`.
- Service-role RPCs: `intake_exchange_invitation`, `intake_session_context`, `intake_revoke_session`, `intake_rate_limit_hit`, `intake_revoke_all_invitations_for_key`, `intake_purge_expired` (wrapper over a role-owned implementation).
- `intake_private.link_valid`: the single validity check used by exchange and by every context call.
- `erase_client_impl` replaced (marker m12): sessions then invitations are deleted before requests.

## Evidence (local; heavy lock held and released)
- Catalog M11 `9c575d50…|670` to M12 `39aeb74d…|764` (94 parts added).
- Suites on M12: M12 21/21, M11 18/18, M10 17/17, M7 36/36, M9 17/17, I1 foundation 109/109, I2-local 92/92 (the legacy count and surface checks are now version-aware: 22 tables, 100 functions and the new service surface from M12).
- **Mutation probes** (each mutated copy of M12 must make the suite fail): context skipping `link_valid` (S05), issue skipping `assert_staff` (S01), exchange skipping the rate limit (S08b): all detected; the good file is re-applied and the catalog is identical afterwards.
- Rollback restores the M11 fingerprint exactly; re-apply identical; rollback refused once an M12 audit event exists and leaves the catalog unchanged; M12 replay idempotent; M11 replay fails closed.
- Defects found and fixed during the local runs (so the first apply is not the first test): an extra execute grant on `link_valid`; an audit metadata key outside the allowlist (`reason` to `reason_code`); the rate-limit primary key omitted the window length, so two window lengths could share a counter at common boundaries (key is now `bucket_hash, window_seconds, window_start`); a test that did not discriminate the rate limit from the live-session cap.

## Deviations from the specification (stated plainly)
1. **Purge is not audited** (`audit_write` is studio-scoped and the purge spans studios); it returns counts for the I4 cron to log.
2. **Request closure revoke** (spec 4a, `request_closed`) is not a separate writer: `link_valid` already refuses closed, suspended and submitted requests at the next call. A revoke on cancel arrives with the request-cancel writer.
3. **Not built in M12:** the parallel-issue concurrency script, the level-10 DEV-safe suite for shared DEV (the existing I1 DEV-safe suite now covers the new tables and surface and runs on DEV unchanged), and the full-chain replay on the M12 bytes. They are required before a PROD discussion; the first two are needed before the DEV apply review closes.
4. The I3-4 signature swap of `intake_save_draft` and `intake_submit_response` (session-hash forms) is not part of M12; M12 must not be wired to a UI until that migration exists.
5. `intake_issue_invitation` is the only issue path; the reconciler's service-role path is I4.

## Update after the independent reviews (final bytes, still unapplied)

- Migration sha256 `54e62dfb669f56b4019359b62f567667b4276780dbcfadf3b090f6c4a8fc4187` (LF; the stored blob is what the DEV apply must hash), rollback sha256 `04da22c2e3713fc0585e9da0c72335ec40447ed920bd04a54a044b86c4ab3c01`. Catalog M11 `9c575d50…|670` to M12 `3353ac98…|768`.
- Review items folded in place: lock order (client lock, then request, then invitation rows) for exchange, issue, revoke, bulk revoke and erase; expected-generation parameter and the staff next-generation read; live-appointment pre-check before any revoke; unknown tokens write nothing; the live-session cap is exact under concurrency (invitation row lock); sessions record and enforce the minting actor; `link_exchanged` is a system event carrying the generation; bulk revoke capped at 500 per call in a fixed lock order; purge uses a non-waiting client lock (`try_lock_client`) so it can never wait on, or deadlock with, a writer. Spec revision 3 reconciles the text with the SQL (section 0).
- Suites on M12: M12 26, M11 18, M10 17, M7 36, M9 17, I1 foundation 109, I2-local 92 (function count 103), level-10 DEV-safe 9.
- **13 mutation probes detected** (11 behavior probes via the suite; 2 lock-removal probes via the deterministic concurrency checks).
- Concurrency C1-C6: one winner among eight parallel issues; exactly 10 sessions for 12 parallel exchanges; resend vs exchange; rate-limit counter exact; deterministic proof that exchange, bulk revoke and issue wait for the client lock without holding the invitation row; erase vs exchange, revoke vs exchange and erase vs issue over six rounds: zero deadlocks, consistent end states.
- Defects found by the local runs and fixed before any apply: extra execute grant; audit key outside the allowlist; rate-limit PK without the window length; a non-discriminating probe; purge row locks needing a privilege the restricted role does not have (replaced by `try_lock_client`); harness bugs (timing measured against unrelated background jobs, short ids).
- Still deviations: no `p_reason` on revoke; purge not audited; no separate request-closure writer; I3-4 signature swap pending.
- Evidence: `rehearsal/m12_local/lifecycle_run_final_2026-11-23.txt`.
