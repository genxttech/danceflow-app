# S6: guard for direct writes of `event_competition_entries.status` (DRAFT, NOT APPLIED)

Owner decision 2026-11-24, option B (corrects the OD-31 finding F1/F2). **Nothing here is applied, merged or authorized for any hosted database.** Two new migration files (slots `20270301140000`, `20270301141000`), their byte-exact rollbacks, a SQL suite, a concurrency script and a local runner. Stacked on PR 867 (it relies on the U18 `current_user in ('postgres','supabase_admin')` allowlist convention and the guards that PR lands); retarget to `release/website-embeds` after PR 867 merges.

Rule-dependence: none of this is a governing-body rule. It is a DanceFlow integrity control (status values and their effects on refunds, scoring eligibility and registration are DanceFlow behaviour): **NOT SPECIFIED IN PROVIDED SOURCE**, same class as U18/U18-S.

## 1. The status values and what the schema allows

CHECK on `event_competition_entries.status` (identical on DEV and PROD): `pending, confirmed, waitlisted, scratched, withdrawn, disqualified, complete`. Table owner `postgres`; RLS on (not forced); policy `competition_manage` FOR ALL to `authenticated`; anon/authenticated/service_role hold SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES and **TRIGGER**; only trigger that touches status is the audit trigger (origin-only, writes a row, refuses nothing).

## 2. Inventory of every legitimate writer (live line `49dbaee1b` + PR 867)

Hosted `proowner`/`prosecdef`/`proacl` verified read-only on DEV and PROD (identical), query `queries` in PR 856 (`q9`-style probe, 2026-11-24).

| Writer | File:line (latest definition) | Runs as | Statuses written | Reaches the guard? |
|---|---|---|---|---|
| `start_competition_registration` | `20261110090000_phase10c4…:875` | SECURITY DEFINER, owner `postgres`, exec: postgres + service_role | INSERT `pending` or `confirmed` (free entry) | exempt (owner) |
| `finalize_competition_registration` | `20261109090000_phase10c…:1871` | DEFINER, `postgres` | `pending` → `confirmed` | exempt |
| `release_competition_registration` | `20261109090000_phase10c…:1884` | DEFINER, `postgres` | none (releases the order; entry rows handled by sync) | n/a |
| `sync_competition_entries_from_registration` (trigger) | `20270103090000_competition_r2…:1388` | DEFINER, `postgres` | `pending` → `confirmed`; non-terminal → `withdrawn` | exempt |
| `_r2_withdraw_entry` (R2 cascade) | `20270103090000_competition_r2…:663` | DEFINER, `postgres` | non-terminal → `withdrawn` | exempt |
| `change_competition_entry_lifecycle` | `20260620_competition_generation_operations_v1.sql:322` | **INVOKER today** (ACL PUBLIC/anon/authenticated/service_role) → **DEFINER by S6 `140000`** | `scratched`, `withdrawn` (any current status) | exempt after `140000`; refused before |
| `mark_competition_entry_late` | same file:392 | INVOKER | none (late flag only) | not a status write |
| A6 withdrawal / reinstatement | `20270120095000_competition_cf1_a6_withdrawal.sql` | DEFINER | **none** on the parent (reads status; scratches heat entries) | n/a |
| App code (`src/**`, live line) | `checkin/actions.ts:150`, `registrations/actions.ts:40,51` | authenticated user client | `verification_status`, `eligibility_status`, `entry_number` only; **never `status`** | not affected (guard checks `status` only) |
| Stripe / provider callbacks | webhook route calls the DEFINER RPCs above (finalize, release, refund cascade) | service role *calls* a DEFINER function | via the functions | exempt through the function owner |
| Crons / background jobs | no cron writes entries (checked `vercel.json`) | n/a | none | n/a |
| QA / e2e fixtures | SQL suites (`sql-tests/*.sql`) write entry `status` and `eligibility_status` as the **superuser** (helpers `pg_temp.su`, replica mode, e.g. `a2_lock:311`, `a3_results:579,583`) and 40+ suites INSERT entries as superuser; no TypeScript fixture writes entries | superuser (`supabase_admin`) | any | exempt (owner role); **verified by re-running the A2/A5/A6/A0/F2/OD-17/A4 suites on the chain with the guard** |
| Not yet on the live line | SC1 `scratch_competition_entry` (branch `competition-sc1-scratch-workflow`, PR 306): DEFINER | `postgres` | `scratched` | exempt; see section 7 |

**Statuses with no writer at all:** `waitlisted`, `disqualified`, `complete` (no function, no app path). They can be set today only by a client direct write or an owner-role session; after S6 only an owner-role session.

## 3. Decision: general guard, not transition-specific

**Chosen: one general, fail-closed trigger** (`cf1_s6_guard_entry_status`) that, for any role that is not an owner role, refuses *every* change of `status` on UPDATE and any INSERT with `status <> 'pending'`.

Why not narrower (guard only `disqualified`, or only some transitions):
* The review of the first design found direct `complete`, `scratched`, `withdrawn` writes matter as much as `disqualified`: each makes R2 skip the withdrawal/refund cascade or exception recording, the registration sync skip the entry, and the A5/A6/advancement checks treat the entry as unavailable; `withdrawn`/`scratched` also satisfies R2's `withdrawn_after_unlock` gate with no heat scratch and no reason; `waitlisted`/`pending` flip the eligibility predicate. A value-by-value deny list leaves a gap for every value not listed and for every value the CHECK may gain later.
* After the lifecycle RPC becomes DEFINER the set of legitimate client-role writers is **empty**: every legitimate writer already runs as the owner. So the general rule loses nothing and needs no allowed-transition matrix for clients.
* An allowlist keyed on `current_user` (owner roles) is the convention already shipped in U18, U18-S and S4/R15; it blocks `service_role`, `authenticated`, `anon` and any future client-like role by default.

**Allowed-transition table (enforced = who may write; business transitions of owner-role workflows are not re-validated here, by design):**

| Role / path | INSERT | UPDATE status | Result |
|---|---|---|---|
| `anon`, `authenticated`, `service_role`, any other non-owner role (direct table API) | only `pending` | **none, any value, any direction** | refused `42501 COMP_S6_ENTRY_STATUS_WRITER`; whole statement rolls back (including the audit row) |
| Owner-role DEFINER workflows (registration, sync, R2, lifecycle RPC, SC1) | any | any | allowed; their own checks apply (e.g. R2/sync only act on non-terminal entries, lifecycle RPC only `scratched`/`withdrawn`) |
| Owner-role SQL session (migrations, support) | any | any | allowed (trusted by definition; tests/fixtures rely on it) |

**Fail-closed:** an unknown role, a new client-like role, or a role added to `authenticated` is refused by default; the only way through is running as `postgres`/`supabase_admin`. The migration's preflight refuses to install if any SECURITY DEFINER writer of the table is owned by another role.

A transition matrix **for owner-role writers** was considered and rejected: the existing SQL suites legitimately move entries between arbitrary states as the owner (e.g. withdrawn → confirmed in `a3_results`), and constraining the owner would break tests and operations without closing a client path.

## 4. Authorization model: no spoofable marker

The guard reads **only `current_user`** (a role the session cannot change without membership) and the row values. It does **not** read any custom GUC and does not depend on `app.competition_entry_change_type`, which is a plain setting any SQL session can set (finding F3; U18-S still uses it for heat entries, out of scope here). The one client-callable path (`change_competition_entry_lifecycle`) is authorized by its own `can_manage_event_competition()` check and runs as the owner because it is SECURITY DEFINER with a fixed `search_path`. Test E1 sets the forged marker and still gets refused.

Proof obligations and where they are tested (all in `test_T_competition_s6_entry_status_guard.sql`): A1 (7 values × authenticated, service_role, anon, member probe role), B (leaving 6 statuses), D (INSERT), E1 (marker forgery), E2 (upsert), E3 (bulk), E4 (SET ROLE), E5/E6 (TRIGGER privilege, client-created triggers, F2), E7 (disable/drop/replace the guard), E8 (replica mode, ENABLE ALWAYS, AFTER), F (legitimate writers), G (R2 class and ballot set unchanged, heat/entry consistency, coexisting triggers), plus the concurrency script and the rollback proof.

## 5. What changes for the one existing RPC

`change_competition_entry_lifecycle` becomes SECURITY DEFINER (body byte-identical, md5 `3b4622d846fa2e6b223b3005d2425650` after CR removal, the same pin U18's preflight uses; hosted body contains CR characters from the original apply, so the pin always strips them) and EXECUTE is limited to `authenticated` (it previously had PUBLIC, anon, authenticated, service_role). anon and service_role were always refused by the body (`auth.uid()` null). The rollback restores the invoker definition and the exact previous ACL; **"byte-exact" is relative to the repository text**: the hosted body carries CRs the repository text does not, so a rollback restores the repository definition (CR-free), and the proof compares `md5(prosrc)`, ACL, security flag and trigger set before and after.

## 6. Reassessment of the 2026-11-13 residual acceptance

On 2026-11-13 the owner accepted, as a documented residual of U18/U18-S, that "a manager can still change `event_competition_entries.status` directly (audited by the entry audit trigger, reason optional)". **That acceptance does not authorize the bypass today.** It was made before, and without, the later decisions: OD-20 (2026-11-23) item 4 requires that `disqualified` cannot be reached through an unintended client-role bypass and must not be presentable as a disciplinary action; R-08 (2026-11-23) keeps Scratch, No-show, Excluded and Disqualified distinct with only their authorized workflows; R-12 and the newer integrity requirements demand preserved, authorized audit evidence and no status change that skips refund/roster/heat consistency. A direct write of any status skips all of those, so the earlier acceptance is **superseded** for the status column by this correction; other residuals (draft-schedule heat-entry DELETE/re-INSERT, TRUNCATE) are unchanged and out of scope.

## 7. Integration: other triggers/PRs and the SC1 session

Triggers on `event_competition_entries` (all AFTER ROW unless noted; PostgreSQL fires same-timing triggers in **name order**):

| Order | Trigger | Source | Concern |
|---|---|---|---|
| 1 | `audit_competition_entry_change` (origin-only, DEFINER) | live line | writes the audit row; rolled back with the statement when a later guard raises |
| 2 | `cf1_s6_guard_entry_status` (ENABLE ALWAYS) | **this PR** | refuses any non-owner `status` change |
| 3 | `r15_guard_entry_eligibility_write` (ENABLE ALWAYS) | S4 PR 866 (`20270301131000`) | refuses non-owner changes of `eligibility_status` and `metadata.eligibility_determination`; **disjoint columns**, same allowlist convention |
| – | `set_event_competition_updated_at`, `validate_competition_entry_registration_links` | live line | BEFORE / other timing; unaffected |

* **S4 (PR 866)**: no conflict. Both guards use the same owner allowlist; they watch different columns. S4's `revoke trigger … from anon, authenticated` and S4's postflight (`has_table_privilege('authenticated', TRIGGER)` must be false) are satisfied in either order; S6 additionally revokes `service_role`. Slot order: S6 (`140000`/`141000`) sorts after S4's `131000`, so on a database with both, S4's postflight sees S6's revoke already or not yet applied; either is fine.
* **S5 (PR 863, `20270301120000`)**: its triggers are on `event_competition_entry_participants` and `event_competition_competitors`, not on entries. No overlap.
* **S3 (PR 864, `100000`..`102000`)** and **S1/S2 (PR 865, `090000`)**: no trigger or grant on `event_competition_entries`. No overlap. (Their SQL-test edits touch other suites.)
* **SC1 (branch `competition-sc1-scratch-workflow`, PR 306; being ported by session `sc1-port`)**: its migration already revokes client EXECUTE on `change_competition_entry_lifecycle` and adds a **denylist** trigger (`sc1_guard_api_scratch_entries`, `current_user in ('authenticated','anon')`, `scratched`/`withdrawn` only, **does not cover `service_role`**) plus the DEFINER RPC `scratch_competition_entry`. Compatible with S6: S6 is the general allowlist (all statuses, all non-owner roles including `service_role`); SC1's RPC is DEFINER so it passes S6; SC1's revoke of the old RPC is idempotent with S6's ACL tightening. **Proposed ownership (to confirm with the SC1 session):** SC1 owns `scratch_competition_entry`, the scratch policy objects and the decision whether to retire or keep `change_competition_entry_lifecycle`; S6 owns the entry-status guard and the `140000` conversion (it keeps the RPC working until SC1 retires it). SC1's denylist trigger becomes redundant once S6 is applied and can be dropped from the port.

## 8. Not covered (kept explicit)

DELETE of an entry followed by INSERT as `pending` (audited as a delete); `TRUNCATE`; owner-role sessions (trusted); heat-entry DELETE/re-INSERT on unpublished schedules (F7, observed scope only: published schedules are protected by the 10D guard; not generalized here); the F3 marker for heat entries (U18-S).

## 9. Results

See the section appended after the local run (executed vs pending is stated there).
