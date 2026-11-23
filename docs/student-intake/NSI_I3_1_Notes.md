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
