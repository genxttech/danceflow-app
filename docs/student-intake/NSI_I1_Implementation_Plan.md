# NSI I1 — Implementation Breakdown (M1–M5)

| | |
|---|---|
| Status | **I1 DEV foundation COMPLETE: M1–M5 applied to shared DEV 2026-10-14 (D-1…D-5, all postflights PASS, 93/93 DEV-safe on DEV); dark (Gate A closed); PROD not applied.** **Not production-deployed and not available to students; collection remains closed** (closeout record §9.12). Untracked, uncommitted. Evidence: `rehearsal/d0_dev_preflight` … `rehearsal/d5_dev_m5`. |
| Design source | `NSI_I1_Schema_Plan.md` revision 4.3 (18 tables, restricted role `intake_destructive`, private schema `intake_private`, Hybrid Instructor capability model, rules R1–R25) |
| Baseline | `origin/main` `13c4d547f5494a8bf75fc472b5d4b48a1f1440f9` |
| Scope of I1 | Database foundation only, shipped **dark**: Gate A stays closed because no platform retention periods are approved, so no personal data can be written. No application code, UI, cron, email, invitations, exports or retention jobs. |

## 1. Authorization gates (in order)

| Gate | What | Who | Status |
|---|---|---|---|
| A1 | Owner confirms the security-policy items in §6 | Owner | Done (approved V1 baseline) |
| A2 | Owner authorizes writing the I1 SQL, rollbacks and SQL tests on a branch (no apply) | Owner | Done |
| A3 | Independent review of the written SQL against the schema plan and this breakdown | Reviewer (Opus) | Done: 0 P0, 3 P1, 12 P2; remediated (§9.6) |
| A3b | Independent re-review of the remediation | Reviewer (Opus) | Done: all P1 closed; GO for M1, conditional GO for M1–M5; final corrections P2-A, P2-B, P3-A, P3-D applied (§9.9) |
| A4 | Owner authorizes applying M1–M5 to **shared DEV**, one migration at a time with the gates in §4 | Owner | Done (D-1–D-5, 2026-10-14; §9.11, §9.12) |
| A5 | Separate, earlier or later: DEV branching / `supabase_migrations` cleanup (§8) | Owner | Open; independent of I1 |
| A6 | PROD: G2 parity, G9 backup/restore, fresh Postgres check (§7), then a separate PROD apply authorization | Owner | Later |

## 2. Conventions for every migration file

- Location and naming follow the repo: `src/lib/supabase/migrations/<timestamp>_nsi_i1_m<N>_<name>.sql`, with `rollback/<same>_rollback.sql` and `sql-tests/test_T_nsi_i1_m<N>.sql`. Timestamps are chosen when written and must sort after the latest migration on main (currently `20261117091000_m0_recipient_write_lockdown.sql`).
- One transaction per migration (`BEGIN … COMMIT`); LF line endings; function bodies fingerprinted (the CRLF function-body lesson from Phase 10D).
- **Header block** lists: objects created; objects depended on (existing tables, helper functions from earlier migrations); privilege statements; rollback file; expected catalog fingerprint after apply.
- **R25 privilege seal, in the same migration as each CREATE:** for each table — `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`, `ENABLE ROW LEVEL SECURITY`, then the §7.1 grants and policies; for each function (every overload) — `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated, service_role`, then the §7.2 grant; `SET search_path = pg_catalog, pg_temp` on every function including triggers; all non-catalog names schema-qualified.
- **Catalog self-check:** M1 creates `intake_private.assert_catalog()` (owner `postgres`, no grants) encoding the expected ACL/owner/RLS/policy matrix for every `intake_%` object; it raises if any present object deviates or if any object has a `NULL` ACL. **Every migration calls it as its last statement**, so a deviation aborts that migration.
- Role-owned implementations are created with `SET LOCAL ROLE intake_destructive … RESET ROLE` (schema plan §6.1); `ALTER FUNCTION … OWNER` is not used.
- No object, trigger, foreign key or index on `appointments`; no change to existing tables (`clients`, `client_account_links`, Documents, `profiles`, `user_studio_roles`, `instructors`).

## 3. Migration contents

| # | Contents | Depends on (must already exist) | Tests (inventory ids, schema plan §10/§16.7) |
|---|---|---|---|
| **M1** config, helpers, role | `intake_destructive` (`IF NOT EXISTS`), `GRANT intake_destructive TO postgres WITH SET TRUE, INHERIT FALSE`; schema `intake_private` (USAGE/CREATE only for the role; nothing for API roles); tables 1–5 with config RLS; `intake_platform_policy()`; `intake_is_platform_admin()` (`profiles.platform_role`); `intake_assert_staff()`; tenant helpers for `clients`, `client_account_links`, Documents (F9/A12); Gate A `intake_retention_gate_open()`; Gate B `intake_new_obligation_allowed()`; version/floor/pin/immutability triggers on tables 3–5; `intake_private.assert_catalog()` | `studios`, `clients`, `client_account_links`, `document_templates`, `document_template_versions`, `profiles`, `user_studio_roles`, `instructors` | 11, 27, 33, 48–49, 81–84, 113–114 (M1 subset), G7 checks |
| **M2** governance | tables 6–7 (holds, audit with environment-marker rule); `intake_is_held()`; `intake_audit_write()` (marker `ON CONFLICT DO NOTHING`); `intake_erasure_barrier_active()`; append-only and TRUNCATE guards | M1 | 50–51, 107–108 |
| **M3** live personal | tables 8–16; R5 tenant triggers; R20 immutable references and documented exceptions; allowlist triggers; delete guards (`current_user = 'intake_destructive'` + `intake_is_held`); collection-gate `BEFORE INSERT` triggers (Gate A always, Gate B on 8/9, barrier always, marker write); TRUNCATE guards; `intake_fulfillment_state()`; RLS policies `TO intake_destructive`; role `SELECT, DELETE` | M1, M2 | 1–10, 15–19, 28, 31, 87–89, 93, 95, 101–106, 112 |
| **M4** retained evidence | tables 17–18; insert-time soft-reference validation (same studio, consistent client); append-only and TRUNCATE guards; Gate A/barrier insert triggers; fail-closed evidence retention (`evidence_retention_unapproved`) | M1–M3 | 20–24, 80 (evidence part) |
| **M5** functions | staff RPCs (publish, floor, assignments, retention choice, status, scoped answers, designate/select guardian, attestation, drift report, draft extension); service RPCs (ensure request, attach appointment, draft save, submit); `public.intake_erase_client` + `public.intake_release_erasure_barrier` wrappers; `intake_private.erase_client_impl` created as the role; hold create/release (platform admin, interim); `intake_break_glass` (owner only) | M1–M4 | 12–14, 25–26 (rollback), 42–47, 85–86, 90–92, 94, 96 (I5 placeholder), 99–100 |

The instructor summary RPC (Hybrid Instructor capability model, tests 96 and 109–111) is **not** in I1; it ships in I5. I1 records the rule only.

## 4. DEV verification gates (apply only after A4)

| Step | Action | Pass criteria | Stop condition |
|---|---|---|---|
| **D-0** read-only preflight | DEV ref check (`epdrtzcydvnoidwrepqz`); `server_version` (expect 17.6); `postgres` `createrole`; `createrole_self_grant`; supautils reserved lists; no `intake_*` objects, no `intake_destructive`, no `intake_private`; default ACLs in `public`; `appointments` trigger/constraint/index/inbound-FK fingerprints = I0 baseline; full catalog fingerprint recorded, **excluding `supabase_migrations` and branching state** (separate cleanup, §8); confirm no Marketing M-0 or other release in progress; record the appointments fingerprint with the exact query in `test_T_nsi_i1_foundation.sql` (passed as `nsi.appointments_fp`, mandatory for F14); confirm `extensions.digest` (pgcrypto in `extensions`) | All as expected | Any intake object already present; fingerprint drift outside the documented exclusions |
| **D-1 … D-5** per migration | Apply Mk as one batch through `supabase db query --linked` from a scratch workdir pinned to DEV; then immediately: `intake_private.assert_catalog()`; that migration's SQL tests (each in a rolled-back transaction, executed as real roles via `SET ROLE` with simulated JWT claims); `appointments` fingerprints unchanged; role/membership fingerprint; boundary smoke (every trigger created so far fires) | All tests for Mk pass; self-check passes; fingerprints as expected | Any failure → stop, do not apply Mk+1; run Mk's rollback (eligible because no data) after recording evidence |
| **D-6** final | Full I1 test subset (§3); re-run M1–M5 setup idempotency check where scripts are re-runnable; Gate A confirmed closed (every personal-data writer refuses with `retention_policy_incomplete`); environment marker absent; erasure wrapper reachable only by `authenticated` and refuses non-admins | All pass | Any failure → stop and report |

**API-level G10 checks on shared DEV** require creating synthetic `auth.users` on DEV, which is a write to shared auth and is **not** included in A4 unless the owner explicitly adds it. Default: SQL-simulated JWT claims (as in RH02 G10-S1/S2) on DEV, relying on the hosted API evidence (§18 of the schema plan) for PostgREST behavior.

## 5. Rollback gates

- Order: M5 → M4 → M3 → M2 → M1; each rollback in one transaction with `SET LOCAL lock_timeout = '5s'`, `ACCESS EXCLUSIVE` locks on every existing intake table in table-number order, then eligibility, then drops.
- **Eligibility (schema plan §11):** refused if any row exists in tables 6–18 other than config-only audit rows, or if the environment marker exists; config rows (tables 1–5) require an exported config SHA-256 acknowledgment. During the dark DEV phase no personal data can be written (Gate A closed); config rows need the export acknowledgment, read-only drift reports are reference-free operational events and do not block, and legal holds cannot be created without existing intake records. A platform-admin erasure (or barrier release) on DEV is a lawful record and makes rollback forward-fix only.
- **Role context:** objects owned by `intake_destructive` are dropped under `SET LOCAL ROLE intake_destructive`; then the schema, policies and grants as `postgres`; `REVOKE intake_destructive FROM postgres`; `DROP ROLE intake_destructive` last after a catalog check that it owns nothing.
- After any rollback: D-0 fingerprint must match the pre-apply fingerprint.
- After first personal-data use (marker present): forward-fix only.

## 6. Owner security-policy confirmations required before A2/A4

1. Platform administrators have **no default access** to intake answers.
2. Front-desk guardian selection is a per-studio flag, **off by default**, allowed only before guardian submission.
3. Draft-retention extensions: studio owners always; admins only when the studio enables `draft_extension_admins_enabled`.
4. Instructor access uses the **Hybrid Instructor capability model**: an active `instructors` row in the studio with `can_instruct = true`, assigned to the appointment, `instructor_visible` fields only; `independent_instructor` status or floor rental alone grants nothing (I5).
5. Interim authority for legal holds and erasure-barrier release: **platform admin only** (`profiles.platform_role`), pending a final hold-roles decision.
6. Client erasure deletes live answers immediately (retained evidence follows its own retention).
7. I1 ships dark with all non-draft retention periods NULL (Gate A closed); approving those periods is a later launch gate.
8. Whether D-6 may create synthetic `auth.users` on shared DEV for API-level checks (default: no).

## 7. PROD-specific checks (before any PROD authorization)

- **G2 parity (read-only):** `server_version` (fresh check; previously 17.6 on 2026-10-12); `postgres` attributes incl. `createrole`; `createrole_self_grant`; supautils reserved roles/memberships; default ACLs in `public`; `appointments` fingerprints against I0; no `intake_*` objects or role; `supabase_realtime` publication membership; parameter-logging settings (`log_min_duration_statement`, `log_statement`, `log_parameter_max_length*`); confirm PROD has **no** branching or `supabase_migrations` artifacts (DEV's are excluded from parity).
- **G9 backup/restore (not yet authorized):** verify on an isolated restore target that the role, its SET membership, `intake_private`, function ownership/grants, RLS policies and the environment marker survive; otherwise apply the P3-b runbook and record whether every restore needs it. Supported paths: Duplicate Project (new paid project) or restore of a dedicated non-production project; never in-place restore or PITR on DEV/PROD.
- P3-b role-recovery runbook rehearsed, and the release record prepared.

## 8. Separate operation: DEV branching cleanup (own authorization, A5)

Artifacts from the 2026-10-14 preview-branch attempt: branching enabled on DEV (`main` record) and `supabase_migrations.schema_migrations` with one `remote_schema` row (7,680 DDL statements, no data, owner-only). Recommended sequence, each with read-only before/after fingerprints: (1) `supabase branches disable`; (2) re-check dependencies; (3) `DROP SCHEMA supabase_migrations CASCADE`. Until done, D-0 and G2 exclude these artifacts explicitly. This cleanup is independent of I1 and can happen before or after A4.

## 9. I1 as authored, remediated, corrected and applied to shared DEV (2026-10-14)

> §9.1–§9.10 record the pre-application state (authoring, review, remediation, local validation). DEV application is recorded in §9.11 and the I1 DEV closeout in §9.12. Statements below that nothing was applied describe the situation before A4.

*Pre-A4 record:* A2 (SQL authoring) and A3 (independent Opus review) were completed; the review's findings were remediated under the owner's "Independent Review Remediation" authorization (§9.6). The re-review (A3b) found all P1 closed and two new P2s (P2-A, P2-B) plus P3-A/P3-D; these were corrected under the owner's "Final Pre-DEV SQL Corrections" authorization (§9.9). The owner then approved §9.8 and A4; M1–M5 were applied to shared DEV (§9.11) and I1 was closed out on DEV (§9.12). Nothing has been applied to PROD, committed or pushed.

### 9.1 Files (untracked in the worktree; LF line endings, no CR bytes)

| File | Lines | sha256 (12) |
|---|---|---|
| `src/lib/supabase/migrations/20261118090000_nsi_i1_m1_config_helpers.sql` | 898 | `2b1f924d4b1f` |
| `src/lib/supabase/migrations/20261118091000_nsi_i1_m2_governance.sql` | 267 | `3712c5ca3841` |
| `src/lib/supabase/migrations/20261118092000_nsi_i1_m3_live_personal.sql` | 762 | `43fcd0a7b945` |
| `src/lib/supabase/migrations/20261118093000_nsi_i1_m4_retained_evidence.sql` | 193 | `795e0fb393e8` |
| `src/lib/supabase/migrations/20261118094000_nsi_i1_m5_functions.sql` | 1192 | `50bc7a4f3df4` (M5 final round; M1–M4 unchanged and applied on DEV) |
| `rollback/20261118090000_nsi_i1_m1_config_helpers_rollback.sql` | 101 | `39a246310469` |
| `rollback/20261118091000_nsi_i1_m2_governance_rollback.sql` | 76 | `e15dd39f1316` |
| `rollback/20261118092000_nsi_i1_m3_live_personal_rollback.sql` | 89 | `5b4fb674dac5` |
| `rollback/20261118093000_nsi_i1_m4_retained_evidence_rollback.sql` | 72 | `e4dfabf470e8` |
| `rollback/20261118094000_nsi_i1_m5_functions_rollback.sql` | 97 | `742f13b39113` |
| `sql-tests/test_T_nsi_i1_foundation.sql` (DEV-safe, no auth users; needs `nsi.appointments_fp`) | 177 | `a1b31d290b4b` |
| `sql-tests/test_T_nsi_i1_local.sql` (local only; refuses unless `nsi.test_local = 'on'`) | 1014 | `bda122a07426` (D-5 N2 tests) |
| `sql-tests/nsi_i1_boundary_local.sh` (local only; container `supabase_db_nsi*`) | 120 | `b34ff604760c` |
| `sql-tests/concurrency/nsi_i1_concurrency_local.sh` (local only) | 76 | `ddde8daea594` |

Evidence: `rehearsal/i1_validation/` (`full_run_2026-10-14_final.log` = final run; earlier run log and mutation-probe notes kept; no credentials).

### 9.2 Schema inventory (as built)
18 tables exactly as schema plan §2 (5 config, 2 governance, 9 live personal, 2 retained evidence); role `intake_destructive`; schema `intake_private` (functions only; USAGE for the role, no CREATE after M5). 70 functions: 20 executable by `authenticated` (3 boolean/policy helpers + 17 staff/operator RPCs), 4 by `service_role` (`intake_platform_policy`, `intake_ensure_request`, `intake_save_draft`, `intake_submit_response`), none by `anon`; 6 helpers executable by the restricted role; one role-owned implementation (`intake_private.erase_client_impl(uuid, uuid, uuid, text, boolean, text)`); operator signatures `intake_erase_client(uuid, uuid, text, text default null)` and `intake_release_erasure_barrier(uuid, uuid, text, text default null)`. 67 non-internal triggers, 23 RLS policies. No trigger, FK or index on `appointments`.

### 9.3 Privilege and catalog-check design
- R25 in every migration: tables `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role` + RLS on + intended grants/policies; each migration's revoke loop names **only its own functions** (re-applying any single migration never touches another migration's grants); the role-owned implementation is created, revoked and granted **as** `intake_destructive` (`SET LOCAL ROLE`), with schema CREATE granted to the role only inside M5's transaction.
- Every forward migration and rollback sets `lock_timeout = '5s'`.
- `intake_private.assert_catalog()` (M1; last statement of every migration and rollback) holds the full inventory of relations, functions, triggers and policies tagged by migration. It derives which migrations are present and fails the transaction on: a partially deployed migration or a non-prefix set (M1..Mk); any unexpected intake relation of any kind (tables, views, sequences, composite types) or function; function overloads; wrong owner; RLS off; unpinned `search_path`; SECURITY DEFINER drift; direct ACLs not exactly as designed (missing or excess, any grantee, PUBLIC, PG17 MAINTAIN); effective privileges of `anon` / `authenticated` / `service_role` / `intake_destructive` not exactly as designed (inherited grants included); any column-level grant; trigger set not exact — compared by full `pg_get_triggerdef` (timing, events, row/statement level, WHEN condition, function schema and arguments) — or any trigger not enabled in origin mode; policy set not exact (name, command, permissive, roles, USING, WITH CHECK); restricted-role attributes; any member other than `postgres`, any INHERIT membership, or the role being a member of another role; schema privileges other than `intake_destructive:USAGE`; CREATE on `public` for the role; default ACLs for `intake_private` or defined by the role; `session_replication_role` other than `origin`; any intake trigger or FK on `appointments`. Hosted creation adds an implicit admin-only membership row for the creator; that shape (admin, no SET, no INHERIT) is accepted.

### 9.4 Deviations from schema plan Rev 4.3 (implementation-level)
1. Internal helpers live in `intake_private` rather than `public`. Effect: smaller exposed surface.
2. `public.intake_is_platform_admin()` and `public.intake_has_staff_role(uuid)` are EXECUTE-granted to `authenticated` because config RLS policies call them; both return only a boolean about the caller.
3. Config read access is limited to studio staff roles (owner, admin, front desk, instructor) or platform admin (client and organizer roles excluded).
4. Intra-config foreign keys use `NO ACTION` instead of `RESTRICT` so the studio CASCADE (R8) can remove configuration; standalone deletes are still refused at statement end (test S01/S02).
5. Published or archived template versions may be deleted only as part of a studio deletion; referenced versions remain protected by RESTRICT FKs from personal tables. A studio with retained audit/hold/evidence rows cannot be deleted (RESTRICT, test S03) until the I6 offboarding procedure.
6. No `intake_break_glass()` function: break-glass is the documented owner procedure (disable a named trigger in a reviewed session). `assert_catalog` now fails while any intake trigger is disabled or the session runs in replica mode, so a break-glass session cannot end with a successful migration until triggers are re-enabled. A written runbook is required before PROD (§9.7).
7. Added `public.intake_record_minor_determination`: **owner/admin only** (capability `minor_override`, separate from front-desk `attest`), mandatory non-blank reason (RPC and table CHECK).
8. Draft saves do not write `intake_response_revisions` (reserved for post-submission corrections in a later slice), avoiding extra retained copies of personal data.
9. Completion is created when the student response is submitted, a minor determination exists, and — if the latest determination is minor — the guardian response is submitted; a later determination never updates the completion (fulfillment is derived).
10. Versions are pinned at issuance (I3); I1 has no pin RPC (tests pin via owner SQL). I1 also has no RPC that records `birthday`/`declared` minor determinations; I3 must record one before student submission (§9.7).
11. Studio permission flags (`front_desk_guardian_selection`, `draft_extension_admins_enabled`) can be changed only by the studio owner.
12. Assurance ranking (`intake_private.assurance_rank`): `link_verified` (3) > `email_code_verified` = `staff_attested` (2) > `declared_unverified` (0); the required level is pinned on the evidence row (N5).
13. The evidence text-hash check uses `extensions.digest` (pgcrypto in schema `extensions`). D-0 must confirm this on DEV/PROD.
14. `intake_platform_policy()` is `SECURITY INVOKER` (constants only; no table access).
15. **Respondent assurance is derived, never supplied (P1-2).** `intake_save_draft` refuses `assurance` / `auth_user_id` in the payload; a verified link of the client (studio-initiated linked guardian/parent link for the guardian; the client's own linked self link for the student) yields `link_verified` and binds `auth_user_id` to that link's account; otherwise `declared_unverified`. The table guard refuses `link_verified` without such a link, an account without a verified link, and **`email_code_verified` / `staff_attested` entirely in I1** (their verification records arrive with I3). Consequence while I1 is dark: a guardian can satisfy the studio minimum only through a verified link.
16. When a guardian recipient has been selected, only that recipient's link may create the guardian respondent.
17. Read paths (`intake_get_status`, `intake_get_answers`) on tenant drift return no rows and persist a `tenant_drift_detected` security event (only when this studio holds intake records for that client); write paths refuse with a generic error (an event written there would roll back with the error) — drift stays visible through `intake_drift_report`. `intake_drift_report` is audited as a reference-free **operational** event.
18. Erasure under a legal hold **returns** `{"refused":"legal_hold"}` (the refusal event persists) instead of raising. Erasure and barrier release take a **reason code** (erasure: `data_subject_request`, `guardian_request`, `studio_request`, `legal_requirement`, `other`; release: `erased_in_error`, `new_relationship`, `legal_requirement`, `other`) stored in the audit metadata; free-text reasons are not taken. The erasure record stores the wrapper's real drift flag.
19. Legal-hold eligibility: while Gate A is closed, a hold may be created only when the studio already holds intake records for the subject (records collected before the gate closed stay holdable); with no records there is nothing to preserve. Once Gate A is open, any in-studio subject is eligible.
20. Guardian submissions must carry consent evidence (non-blank consent text) from a respondent whose assurance meets the studio minimum.
21. **Only affirmative guardian consent completes a guardian response in I1 (P2-A).** `event_type` other than `acknowledged` (e.g. `declined`, `withdrawn`) is refused before anything is written, so the guardian draft stays a draft and a later acknowledgment can still submit. Recording a decline as evidence (a terminal "declined" fulfillment state) is an I3 design item.
22. **Erasure while dark writes nothing when there is nothing to erase (P2-B).** `intake_erase_client` refuses unknown clients (no client row and no intake records), and when Gate A is closed and the studio holds no intake records for the client it returns `{"outcome":"no_records","erased":false}` without any audit event, erasure barrier or first-use marker. Lawful erasure of existing records is unchanged. Every result carries `outcome` = `erased` | `refused` | `no_records`.
23. Erasure and barrier release accept an optional support-case reference (`p_case_ref`): NULL or a ticket identifier matching `^[A-Z]{2,10}-[0-9]{1,12}$` (owner decision; e.g. `SUP-1234`, at most 23 characters, no names, e-mail addresses or free text), stored as audit metadata key `case_ref` (in the M2 allowlist).
24. `intake_erase_client` refuses a NULL or nonexistent studio (`unknown studio`) after the platform-admin check and before any lock or write.
25. Consent consistency (any audience): an `acknowledged` consent (or one with no `event_type`) must carry `outcome = accepted` (or none); a contradictory pair such as acknowledged + rejected is refused before anything is written. Guardian declines remain refused (deviation 21) until the I3 decline workflow.

### 9.5 Test results (fresh-stack run after the A3b corrections, 2026-10-14 13:07–13:10Z; later counts in §9.10 and §9.12)
Isolated disposable local stack `nsi-i1-sqlvalidate` (recreated with `--no-backup`, PostgreSQL 17.6 image 17.6.1.106, DanceFlow `public` schema restored schema-only from the existing local-staging stack: 321 tables, no customer data). Pre-migration appointments fingerprint `76103dd728657c76a6391f1307e18d73`; NSI catalog fingerprint after apply `f5e061497632561740ebb1c1fdfe39a5`.

| Suite | Result |
|---|---|
| `test_T_nsi_i1_foundation.sql` (DEV-safe) | **93/93 PASS** with the fingerprint; **FAIL on F14 only** without it (mandatory) |
| `test_T_nsi_i1_local.sql` | **280/280 PASS**; refuses to run without `nsi.test_local = 'on'` |
| Mutation probes (fix reverted inside the suite's rolled-back transaction) | **5/5 detected**: h no-records branch removed → G13c/d/e, L17; h2 unknown-client check removed → G13a; i decline refusal removed → P2A-a/b/c (+ dependants); j `ensure_request` writes an extra request while reusing → O13a, O13e (the pre-fix single-statement form of O13a, run in the same probe, did **not** fail — it was blind); k trigger comparison reduced to names → D19–D22 |
| Fingerprint probe | pre-fix formula on a table without triggers/indexes/inbound FKs returns an empty value (would have matched); new `fp_of` returns `MISSING:triggers,constraints,indexes,inbound_fks` (B0) |
| `nsi_i1_boundary_local.sh` | **23/23 PASS** (B1, B0, B2, B3×5, B4, B5a/b, B9×5 incl. M1 re-applied after M5, B10, B6a/b, B7/B7b, B11, B8) |
| `nsi_i1_concurrency_local.sh` | **C1 10/10, C2 10/10, 0 deadlocks**; after re-applying M1 last: gate closed, `assert_catalog` clean, service grants intact |

Previous round (12:01Z): 93 / 268 / 21 / 2×10, 6/6 earlier mutation probes (P1-1, P1-2×2, P1-3, P2-1, P2-2) — those probes still apply to unchanged code.

**Excluded / not executed:** none of the authored tests were skipped. **Requires shared DEV or hosted services (not run):** the DEV-safe suite on DEV after an authorized apply (D-1…D-6); API-level G10 on DEV (needs synthetic auth users, excluded by baseline item 8) and a re-run of the hosted G10 rehearsal against the new operator signatures (before PROD); G9 backup/restore; PROD G2. Live "permission denied for function" probes under a switched role crash the local 17.6 image (documented repo limitation), so local suites use catalog checks there.

### 9.6 Independent review findings — closure matrix

| Finding | Status | Change | Evidence |
|---|---|---|---|
| P1-1 front desk can waive guardian consent | **Closed** | capability `minor_override` (owner/admin); reason required in RPC and table CHECK | P11a–e; mutation a |
| P1-2 self-asserted assurance | **Closed** | assurance derived from verified links; table guard; email-code/staff attestation refused until I3 records exist (deviation 15) | R01–R08, R05/R05b, R06a/b, O13h; mutations c, g |
| P1-3 submit ignores request status | **Closed** | status check in submit + table guard on draft→submitted and on response insert | P13b–i; mutation e |
| P2-1 audit-then-raise events lost | **Closed** (read paths, erasure); **documented** (write paths) | deviation 17/18 | A07b/c, L05; mutation d |
| P2-2 NULL bypasses compare-and-set | **Closed** | `is distinct from` on both paths and on first save | P22a–c; mutation f |
| P2-3 unsatisfiable minor submission | **Closed** | guardian submit requires evidence and sufficient assurance | P23a/b |
| P2-4 minors default to adult | **Closed** (DB) / I3 gate | student submit requires a recorded determination | P24a; §9.7 |
| P2-5 catalog self-check gaps | **Closed** | inventory-based exact check (§9.3) | D01–D18, C09 |
| P2-6 M1 re-apply strips M5 grants | **Closed** | per-migration revoke lists (M1 and M5); also found and fixed: M2 lacked its own `client_has_active_hold` grant | B9×5; concurrency post-check |
| P2-7 rollback barrier while dark | **Closed** | drift report → operational, reference-free; hold eligibility rule (deviation 19). By design a platform-admin erasure or barrier event still makes rollback permanent (it is a lawful record) | G10, G11a–c, B10, B11, H03 |
| P2-8 no forward lock_timeout | **Closed** | `set local lock_timeout = '5s'` in M1–M5 | file review |
| P2-9 erasure record content | **Closed** | real drift flag; reason codes | L11, L08a/b, L16b |
| P2-10 tenant coherence only in RPCs | **Closed** | table guards for request pin/supersedes, response respondent, completion responses/version | P10a–d |
| P2-11 evidence hold scope / identity cascade | **Deferred to I6** (unreachable in I1) | documented in M4 and §9.7 | — |
| P2-12 test false positives | **Closed** | helpers, mandatory fingerprint, T03, O12b | mutation probes; F14 without fingerprint fails |
| P3 lock strength (`FOR NO KEY UPDATE`), FK indexes, mutable post-submit metadata columns, unverified rollback export hash, owner break-glass runbook | **Open (P3)** | not changed in this remediation | — |

### 9.7 Remaining later-slice and PROD gates (not implemented here)
- **I3 entry gate:** email-code verification and staff in-person attestation records plus the table-guard update before `email_code_verified` / `staff_attested` can be used; a service path recording the `birthday` / `declared` minor determination before student submission; version pinning at issuance; an `expires_at` check on submission; a decline model (terminal "declined" state excluded from completion reuse) if declines are to be recorded; the service must derive `source_link_id` from the authenticated session; re-validation of respondent link status (stale assurance after a link is disconnected); confirm which staff roles may create guardian invitations (overlaps the front-desk guardian-selection policy).
- **I4 entry gate (delivery, spec §22, owner decision 2026-10-14 — shared transactional outbox):** T1 timezone consistency; T2 transactional dispatcher reliability; T3 branded intake templates, renderers and previews (intake keys registered as client-facing and transactional); T4 shared outbound SQL including claim-by-ID — only after Marketing M-0 closes and its rollback window expires (M-0's `claim_outbound_deliveries` stays unchanged); Resend open/click tracking verified off on the sending domain; secure-link (fragment) testing across email clients; decision on staff/instructor visibility of intake delivery rows. No `intake_deliveries` table is built.
- **Separate security backlog (not NSI-blocking):** SB-OUTBOX-1 — staff access to stored transactional email bodies (`outbound_deliveries.body_html`) and to bearer document-signing links in existing emails (spec §22.5).
- **Before Gate A opens:** remove the "no determination = adult" default in `fulfillment_state` or enforce a determination at table level; re-confirm P2-A behaviour with the I3 decline model.
- **I6 entry gate (P2-11):** before the restricted role receives UPDATE/DELETE on evidence tables, `evidence_guard` must honour request- and response-scoped holds; identity rows must be deleted explicitly by the role (the cascade runs as the table owner and is refused); studio offboarding (S03); redaction role with UPDATE grants.
- **PROD gates:** written break-glass runbook (deviation 6); G2 parity; G9 backup/restore; re-run hosted G10 against the new operator signatures; real verification of the rollback config-export hash (currently format-only); document `assert_catalog` limitations (objects outside the `intake_` / `intake_private` names, triggers or policies on non-intake tables calling intake functions, function bodies, transitive role membership).

### 9.8 V1 policy decisions recorded with this release (owner-approved 2026-10-14, before A4)
1. **Assurance:** `email_code_verified` and `staff_attested` are unavailable until I3 implements real verification records. Until then a guardian meets the studio minimum only through a verified, studio-initiated guardian link. (Differs from Schema Plan test 112; reversed at the I3 gate.)
2. **Minor-to-adult overrides:** owner or studio admin only (capability `minor_override`, never front desk), with a mandatory non-blank reason, audited (`minor_determination_recorded`). Accepted consent evidence is never changed.
3. **Guardian recipient:** once a guardian recipient is selected, only that verified recipient's link can create the guardian respondent and submit; front-desk selection remains a per-studio flag, off by default, and never overrides submitted guardian consent.
4. **Guardian consent:** only affirmative `acknowledged` consent completes a guardian response in I1.
5. **Erasure and barrier release:** require a valid reason code (erasure: `data_subject_request`, `guardian_request`, `studio_request`, `legal_requirement`, `other`; release: `erased_in_error`, `new_relationship`, `legal_requirement`, `other`) and accept an optional support-case reference that must be NULL or a ticket identifier `^[A-Z]{2,10}-[0-9]{1,12}$` (owner-selected format). Free-text reasons are not stored.
6. **Erasure results:** callers MUST treat `outcome = "refused"` (legal hold) as a failure and `outcome = "no_records"` as "nothing to erase", never as a completed erasure. Only `outcome = "erased"` is an erasure.
7. **Legal holds while collection is closed** require existing intake records for the subject; with Gate A open any in-studio subject is eligible.
8. **Instructor access:** no new Hybrid Instructor role. Access stays capability-based (authorized host-studio relationship, active instructor with `can_instruct`, actual appointment assignment, field visibility), delivered in I5.
9. Also in effect (from earlier deviations): drift read paths return an empty result (indistinguishable from "no intake"); read RPCs write audit rows, so clients must call them with POST; in I1 the minor determination needed before student submission is recorded by owner/admin until the I3 service path exists.

### 9.9 Re-review (A3b) findings and final corrections

| Item | Status | Change | Evidence |
|---|---|---|---|
| P2-A guardian decline leaves request stuck | **Closed for I1** | non-acknowledged guardian consent refused before any write (deviation 21) | P2A-a/b/c, O14a after decline; probe i |
| P2-B dark erasure poisons rollback | **Closed** | unknown clients refused; dark + no records → `no_records`, nothing written (deviation 22) | G13a–e, L09; probes h, h2 |
| P3-A trigger comparison ignores timing/events/args | **Closed** | full `pg_get_triggerdef` comparison | D19–D22; probe k |
| P3-D fingerprint tautology / snapshot counts | **Closed** | `fp_of` fails closed + B0/B2; O13a/O13e capture the RPC result first | B0, B2; probe j, fp probe |
| P3-B catalog blind spots | **Documented** (PROD gate) | — | §9.7 |
| P3-C assurance trust residuals | **I3 gate** | — | §9.7 |
| P3-E stale hosted G10 evidence | **PROD gate** | — | §9.7 |
| P3-F erasure refusal returns normally | **Policy** | `outcome` key; caller contract | §9.8 item 6 |
| P3-G read RPCs write audit | **Policy** | POST-only contract | §9.8 item 9 |
| P1-3 residual: `expires_at` not compared | **I3 gate** | — | §9.7 |
| P2-4 residual: adult default in `fulfillment_state` | **Before Gate A** | — | §9.7 |

### 9.10 M5 final remediation round (2026-10-14; at the time M1–M4 were applied on DEV and M5 was not — M5 was applied in D-5, §9.11)

| Item | Change | Evidence (local suite / probes) |
|---|---|---|
| 1 Strict `case_ref` | NULL or `^[A-Z]{2,10}-[0-9]{1,12}$` in erasure and barrier release; authorization and audit semantics unchanged (validated after the platform-admin check, before any write) | valid `SUP-1001`, `SUP-2042`, `SUP-3003` (erasure) and `INC-77` (release, stored as metadata) accepted; refused: free text, lowercase, name-like, e-mail-like, 65 characters, 13 digits, single-letter prefix, empty string (G13b-1…7), malformed release reference (G13h); probe c |
| 2 Studio existence | NULL or nonexistent studio refused (`unknown studio`) before any lock or write | G13f, G13g (no audit rows written); probe s |
| 3 Dark erasure regressions | — (tests) | H05: with the gate closed again, a client with records is erased (`outcome erased`, 2 requests removed), not `no_records`; H06: held client with records is refused, not `no_records`; H07: probes rolled back; G13a: unknown client refused and no governance record; L05: hold refusal with the gate open; probes h, h2, n |
| 4 Reference tests | — (tests) | see item 1 |
| 5 Probe j | the old-form check is gone; the injected extra request is non-open (`cancelled_by_staff`), so no unique-index conflict can occur | probe j: O13a fails with `requests=2` and O13e with `requests=3` while the returned id is the reused request (count-based failures) |
| 6 Schema Plan signatures | §5.3 and the §7 privilege table now show `intake_erase_client(uuid, uuid, text, text)`, `erase_client_impl(uuid, uuid, uuid, text, boolean, text)`, `intake_release_erasure_barrier(uuid, uuid, text, text)`, reason codes, `case_ref`, outcomes | consistent with M5 definitions, grants, revoke loop, `assert_catalog` inventory (names), M5 rollback, foundation F09 and local C05d/L04 |
| 7 Consent consistency | acknowledged consent must have outcome `accepted` (deviation 25) | P2A-d (acknowledged + rejected), P2A-e (no event type + declined), P2A-f (nothing written; later valid acknowledgment completes, O14a); probe o |

Fresh-stack run (2026-10-14 17:12–17:15Z; PostgreSQL 17.6; DanceFlow schema; synthetic data only): DEV-safe suite **93/93** (fails on F14 only without the fingerprint); local suite **296/296**; mutation probes **9/9** detected (h, h2, s, n, c, i, o, j, k); boundary **23/23**; concurrency **2 × 10, 0 failures, 0 deadlocks** (gate closed, catalog clean, service grants intact after M1 re-apply). `appointments` fingerprint unchanged; collection gate closed. M1–M4 files are byte-identical to the DEV-applied versions; rollback files unchanged (no signature change).

### 9.11 DEV application record (2026-10-14)
| Step | Migration (sha256 prefix) | Applied (UTC) | Evidence |
|---|---|---|---|
| D-0 | read-only preflight | — | `rehearsal/d0_dev_preflight/` |
| D-1 | M1 `2b1f924d4b1f` | 14:41:58 | `rehearsal/d1_dev_m1/` |
| D-2 | M2 `3712c5ca3841` | 15:24:59 | `rehearsal/d2_dev_m2/` |
| D-3 | M3 `43fcd0a7b945` | 16:55:47 | `rehearsal/d3_dev_m3/` |
| D-4 | M4 `795e0fb393e8` | 17:05:14 | `rehearsal/d4_dev_m4/` |
| D-5 | M5 `50bc7a4f3df4` | 17:45:12 | `rehearsal/d5_dev_m5/` (93/93 DEV-safe on DEV) |

N2 closed with G13i–G13l (local suite 300/300). Remaining pre-Gate-A items: §9.7 plus the M5 review notes N1 (student-path event/outcome enum), N3 (minor test tightening), N4 (retained evidence makes an erased-and-deleted client "known"; with Gate A open a repeat erasure appends another erasure record).

### 9.12 I1 DEV closeout record (2026-10-14)
Owner authorization: "I1 DEV Closeout and I3 Readiness". Documentation only; no SQL, environment, data or email change was made for this record. Evidence: `rehearsal/d5_dev_m5/D5_report_2026-10-14.md` and `rehearsal/i1_validation/full_run_2026-10-14_d5_n2.log`.

| Item | State |
|---|---|
| Migrations on shared DEV `epdrtzcydvnoidwrepqz` | M1–M5 **applied and verified** (D-1…D-5, §9.11); every postflight PASS; `assert_catalog()` ok |
| M5 SHA-256 | `50bc7a4f3df4f5703f1d7bb56634884b508c8f34fa994ca2a51549df1e787e54` (matches the file) |
| Test results | DEV-safe suite **93/93 on DEV**; local functional 300/300; boundary 23/23; mutation probes 9/9; concurrency 2 × 10 rounds, 0 failures, 0 deadlocks |
| Collection gate | **closed** (`retention_gate_open()` = false; no approved platform retention periods) |
| Intake personal and evidence tables | all 9 live tables, `intake_consent_evidence` and `intake_consent_evidence_identity`: **0 rows**; 0 audit events, 0 holds, 0 erasure events |
| First-use marker | **none** (rollback eligibility unchanged, §5) |
| `appointments` fingerprint | `e0c4db1b4d1b027df0e6e1593d0f14ce` (unchanged since D-0) |
| PROD | **has not received these migrations**; PROD requires A6 (§7) |
| DEV branching artifacts | unresolved; separate A5 authorization (§8); excluded from parity |

**Status statement:** I1 is complete as a **DEV database foundation only**. M1–M5 are applied and verified on shared DEV. Intake is **not production-deployed and not available to students or studios**: there is no application code, UI, cron or email, and collection remains closed (Gate A). Nothing in this record authorizes opening Gate A, applying to PROD or sending email.

## 10. Delivery architecture decision (2026-10-14)
Owner approved **Option A: shared transactional outbox** after the T0 audit. Intake email (invitations, reminders, verification codes, resends) is queued in `outbound_deliveries` by intake RPCs in the same transaction as the invitation or challenge row, carries references only (no token, code, answers or body), and is rendered and revalidated at send time by an intake renderer called from the generic dispatcher, which keeps its stable `outbound-delivery:{id}` idempotency key, skips unsupported keys instead of sending a fallback, and uses the studio-specific sender. Product defaults: guardian invitation omits the student's name; guardian reminders only while guardian consent is outstanding; staff submission/exception notices in-app; completion acknowledgment email deferred; no ARIA intake emails; transactional (no campaign or unsubscribe semantics). Full rules: `NSI_V1_Engineering_Spec.md` §22.

**T0 audit findings** (reported to the owner with the Option A decision; there is no T0 report file in this repository, so the findings are summarised here and the repository facts were re-checked read-only): the existing `outbound_deliveries` pipeline can support intake email; it already provides a leased batch claim (`claim_outbound_deliveries(uuid, int, int)`, introduced by PAY-WH-1 and redefined by Marketing M-0 to hold commercial mail while frozen), a dispatcher that sends with the stable idempotency key `outbound-delivery:{id}`, and studio-specific sender resolution for client-facing template keys (unregistered keys fall back to the system sender). Gaps that must close before intake email: timezone consistency (T1), dispatcher reliability including retries, dead-letter and skip-unsupported-key (T2), branded intake templates and renderers (T3), and shared outbound SQL including claim-by-ID (T4, after M-0); plus Resend tracking verification, secure-link client testing and a staff/instructor delivery-visibility decision before I4. Stored transactional bodies and bearer signing links in existing emails were flagged as a separate security concern (SB-OUTBOX-1).

Effect on this plan: none for I1 (applied, no delivery table); `intake_deliveries` removed from the I4 scope; I4 entry gates in §9.7. Documentation only — no SQL, code, environment change, email or M-0 change.

**No Intake transactional email may be queued or sent in any environment while the Marketing M-0 release dependencies remain open.** This covers invitations, reminders, verification codes and staff resends. The M-0 dependencies are: the conditional freeze release (Gate 1 pending), its 24-hour integrity review, M-0 close-out, and expiry of the M-0 rollback window. T4 (shared outbound SQL, including claim-by-ID) and every intake `outbound_deliveries` producer come only after that close-out. Reason: until then a rollback target without the T2 "skip unsupported key" behaviour (the M-0 rollback-compatible build) could still be promoted, and T4 changes the outbox objects M-0 fingerprints.

## 11. I3 readiness checklist (planning; nothing authorized by this list)
Two distinct lists. **Part A** must be satisfied before I3 code or SQL can be authorized and merged. **Part B** must be satisfied before Gate A (collection) may open in any environment. Completing I3 does not open Gate A.

### 11.1 Part A — I3 implementation prerequisites
| # | Area | Requirement | Source |
|---|---|---|---|
| A1 | Invitation generations and token lifecycle | `intake_invitations` stores `token_hash`, per-row salt, `kid`, generation, `expires_at`, `revoked_at`; token derived from `INTAKE_ROOT_SECRET` via HKDF and never stored; resend issues a new generation and revokes the previous one; invalid, expired, revoked and suspended links give one identical response; Gate A, Gate B and barrier checked on issue (Schema Plan gate table) | spec §5.1, §22 |
| A2 | Account-free sessions | fragment-to-cookie exchange (`__Host-`, HttpOnly, Secure), audience claim read from the session (never a parameter), sliding and absolute limits, origin/CSRF checks, `noindex`/`no-store`/`no-referrer`; `intake_sessions` and DB-backed `intake_rate_limits` (fail closed); trusted client-IP source on Vercel confirmed | spec §4.2, §5.2, §5.3 |
| A3 | Guardian email-code verification and staff attestation | `intake_email_challenges`: code derived from the challenge id (never stored), 10-minute expiry, 5 attempts, per-request/email/IP limits, guardian email must differ from the student's; audited in-person staff attestation with reason and method; the respondent table guard updated so `email_code_verified` / `staff_attested` require a matching verification record (reverses §9.8 item 1) | spec §4.3; §9.7 |
| A4 | Verified identity vs guardianship designation | assurance records only how the respondent's email or presence was verified, never legal guardianship; designation stays in `intake_guardian_designations` referencing a verified link; wording rule ("email verified", "declared relationship"); nothing writes `client_account_links` or `can_sign_documents`; `source_link_id` derived from the authenticated session; respondent link status revalidated (stale assurance after disconnect) | spec §4.3, §14.6; §9.7 |
| A5 | Minor determination service path | a service path records the `birthday` / `declared` determination before student submission (replacing the owner/admin-only interim path, §9.8 item 9) | §9.7 |
| A6 | Guardian decline | decline model with a terminal "declined" state excluded from completion reuse; decline evidence recorded without completing; P2-A behaviour re-confirmed against it | §9.7, §9.9 |
| A7 | Version pinning and expiry | version pinned once at invitation issue (I1 has no pin RPC); submission refused after `expires_at` (P1-3 residual) | §9.7, §9.9 |
| A8 | Role authorization for guardian invitations | owner confirms which staff roles may create guardian invitations and select recipients (overlaps the per-studio front-desk flag, off by default); enforced through `assert_staff` capabilities | §9.7, §9.8 item 3 |
| A9 | N1 student outcome consistency | student-path event types and outcome values aligned with the guardian path (M5 review note N1) | §9.11 |
| A10 | Shared transactional outbox | invitation or challenge row and its `outbound_deliveries` row inserted in the same transaction; payload carries references only (no token, code, answers or body); `intake_*` keys registered as client-facing and transactional; send-time renderer revalidates and re-derives; unsupported keys skipped, never sent generically; audit allowlist extended (invitation and delivery events) | spec §22 |
| A11 | Dependencies | T1 timezone consistency, T2 dispatcher reliability, T3 templates/renderers/previews (code-only, each separately authorized); T4 shared outbound SQL and claim-by-ID **only after Marketing M-0 close-out and rollback-window expiry**; `INTAKE_ROOT_SECRET` provisioned; I2 entitlement key and settings; Resend open/click tracking confirmed off; email-client fragment matrix (needs authorized test sends) before any invitation email | spec §22.6; §9.7 |

### 11.2 Part B — requirements that block opening Gate A
| # | Requirement | Source |
|---|---|---|
| B1 | Owner-approved platform retention periods so `intake_platform_policy()` returns non-NULL values (the Gate A condition itself) | Schema Plan Gate A; spec §14.9 |
| B2 | Remove the "no determination = adult" default in `fulfillment_state`, or enforce a determination at table level; re-confirm P2-A with the decline model | §9.7 |
| B3 | **N4 repeated-erasure handling**: retained evidence makes an erased-and-deleted client "known", and with Gate A open a repeat erasure appends another erasure record; resolve before collection opens | §9.11 |
| B4 | N3 test tightening from the M5 review: G13d combines the call and its check in one statement; G13a's no-record check does not discriminate on its own; the `"requests": N` LIKE patterns also match larger numbers | §9.11 |
| B5 | Database-side entitlement for Gate B (N2, Schema Plan §16.5) in place before collection | Schema Plan §16 |
| B6 | Part A items A3 (verification records) and A5 (minor service path) live, so assurance and minor status come from real records | §9.8 items 1 and 9 |
| B7 | For PROD collection: A6 (§7: G2 parity, G9 backup/restore, break-glass runbook, hosted G10 re-run, real rollback-export hash verification, documented `assert_catalog` limits) and a separate PROD apply authorization | §7, §9.7 |
| B8 | Launch-blocking owner/legal decisions in spec §14.9 (evidence and audit retention periods and bases; minors requirements) | spec §14.9 |

Not a Gate A blocker on DEV but still open: A5 DEV branching cleanup (§8). Email remains governed by the M-0 rule above, independently of Gate A.
