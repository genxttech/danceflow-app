# S6: guard for direct changes to a competition entry's status (DRAFT, NOT APPLIED)

Owner decision 2026-11-24, option B (corrects OD-31 findings F1 and F2). **Nothing here is applied, merged or authorized for any hosted database.** Two new migrations (`20270301140000`, `20270301141000`), their rollbacks, a SQL suite, a concurrency script, an F3 read-back experiment and a local runner; no existing test file modified, one adapted suite copy added (section 9). Stacked on PR 867 (it uses the `current_user in ('postgres','supabase_admin')` allowlist convention of U18 and S4/R15 and the guards that PR lands); retarget to `release/website-embeds` after PR 867 merges.

Rule-dependence: no governing-body rule is involved. Status values and their effects on refunds, eligibility and registration are DanceFlow behaviour: **NOT SPECIFIED IN PROVIDED SOURCE**, the same class as U18 / U18-S.

## 1. Status values and today's schema

CHECK on `event_competition_entries.status` (identical on DEV and PROD): `pending, confirmed, waitlisted, scratched, withdrawn, disqualified, complete`. Owner `postgres`; RLS on (not forced); policy `competition_manage` FOR ALL to `authenticated`; anon, authenticated and service_role hold SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES and **TRIGGER**. The only trigger that reacts to a status change is the audit trigger (origin-only; writes a row, refuses nothing).

## 2. Inventory of writers (live line `49dbaee1b` + PR 867)

Function owner / security / ACL read from DEV and PROD (identical) on 2026-11-24, read-only.

| Writer | Latest definition | Runs as | What it writes | Under S6 |
|---|---|---|---|---|
| `start_competition_registration` | `20261110090000_phase10c4…` (insert near line 875) | DEFINER, `postgres`; EXECUTE postgres + service_role | inserts `pending` or `confirmed`, with registration/order links | exempt (owner) |
| `finalize_competition_registration` | `20261109090000_phase10c…` (near 1871) | DEFINER, `postgres`; service_role | `pending` → `confirmed` | exempt |
| `release_competition_registration` | same file (near 1884) | DEFINER, `postgres`; service_role | order / registration / dance rows; entries change through the sync | n/a |
| `sync_competition_entries_from_registration` (trigger on `event_registrations`) | `20270103090000_competition_r2…` (1388) | DEFINER, `postgres` | `pending` → `confirmed`; non-terminal → `withdrawn`; scratches heat entries | exempt |
| `_r2_apply_participation` → `_r2_withdraw_entry` (R2 refund cascade) | same file (663, 689) | DEFINER, `postgres`; **EXECUTE postgres + service_role today** | non-terminal → `withdrawn` | exempt as owner; **S6 revokes service_role EXECUTE** (no app caller; only owner-run definers call them) |
| `change_competition_entry_lifecycle` | `20260620_competition_generation_operations_v1.sql:322` | **INVOKER today** (PUBLIC, anon, authenticated, service_role) | `scratched`, `withdrawn`; scratches heat entries | **DEFINER by `140000`**, authenticated only |
| `mark_competition_entry_late` | same file | INVOKER | late flag only | not affected |
| A6 withdrawal / reinstatement | `20270120095000…` | DEFINER | reads the parent status; scratches heat entries | n/a |
| App code (`src/**`) | `checkin/actions.ts`, `registrations/actions.ts` | authenticated user client | `verification_status`, `eligibility_status`, `entry_number` only | not affected |
| Stripe / provider callbacks | webhook routes call the definers above | service role calls a definer | via the functions | exempt through the owner |
| Crons | `vercel.json` | n/a | none | n/a |
| QA fixtures (`sql-tests`) | superuser / replica-mode writes of status, eligibility and links | superuser | any | exempt |
| SC1 port (app only, confirmed by that session) | calls `change_competition_entry_lifecycle` as the signed-in manager | authenticated | via the RPC | works before and after S6 |

`waitlisted`, `disqualified` and `complete` have **no writer at all** outside owner sessions.

## 3. Decision: a general, fail-closed guard

**Chosen:** one guard function with three triggers. For any role that is not `postgres` / `supabase_admin`: `cf1_s6_guard_entry_status` (AFTER INSERT OR UPDATE) refuses every status change and any INSERT that is not an unlinked `pending` entry; `cf1_s6_guard_entry_links` (BEFORE UPDATE) refuses changes of `id`, `event_id` and the registration / order / order-item / cart links; `cf1_s6_guard_entry_delete` (BEFORE DELETE) refuses deleting an entry whose status is not `pending` or `confirmed`, whose history ever held `scratched`, `withdrawn`, `disqualified` or `complete`, or that is `confirmed` and linked to a registration or order. The link and delete rules are BEFORE triggers so that a foreign-key referential action (ON DELETE SET NULL, cascade delete), which runs as the table owner at that point, is not refused (inferred; no registration fixture exercises it yet).

Why not narrower: direct `complete`, `scratched` and `withdrawn` writes matter as much as `disqualified` (R2 skips the cascade and exception recording; the sync skips the entry; A5/A6/advancement treat it as unavailable; `withdrawn`/`scratched` satisfies R2's `withdrawn_after_unlock` gate); `waitlisted` / `pending` flip the eligibility predicate. A per-value list leaves a gap for every value not listed and every value added later. After the one client-facing writer becomes DEFINER, **no legitimate client-role status writer exists**, so the general rule loses nothing.

| Role / path | INSERT | UPDATE of `status`, identity or links | DELETE |
|---|---|---|---|
| anon, authenticated, service_role, any other non-owner role | unlinked `pending` only | refused (`COMP_S6_ENTRY_STATUS_WRITER`, `COMP_S6_ENTRY_LINK_WRITER`) | allowed only for a pending entry, or an unlinked confirmed one, that never held a protected status (`COMP_S6_ENTRY_DELETE_WRITER` otherwise). This keeps the two existing behaviours the 10A and callback-final suites assert |
| owner-run definers (registration, sync, R2, lifecycle RPC) | any | any, subject to their own rules | any |
| owner SQL session, referential cascades (run as the table owner) | any | any | any |

All refusals are SQLSTATE `42501` and roll the statement back, including an audit row written earlier in it. A transition matrix for owner-run writers was rejected: the existing suites legitimately move entries between arbitrary states as the owner.

## 4. Authorization model: nothing spoofable

The guard reads `current_user` and row values only; it reads no custom setting. `app.competition_entry_change_type` (finding F3) is a plain setting any SQL session can set, so it authorizes nothing here. The one client path, the lifecycle RPC, authorizes with `can_manage_event_competition()` and runs as the owner because it is SECURITY DEFINER with a fixed `search_path`.

## 5. The lifecycle RPC (`140000`)

Same signature; EXECUTE limited to `authenticated`. Because a definer function bypasses RLS and the invoker-side guards, `140000` makes these rules **mandatory** (each differs from June, and the owner should confirm them): (1) only `pending`, `confirmed`, `waitlisted` entries can be scratched or withdrawn (`COMP_ENTRY_LIFECYCLE_STATE`), so a disqualification or completion cannot be cleared; (2) placed entries are refused (`COMP_ENTRY_LIFECYCLE_PLACED`, the R2 locked/certified class) besides the existing locked-heat refusal; (3) repeating the call for the current state writes no audit row or version bump and, after the same checks, completes the heat-entry cascade; (4) the locked/certified and placed refusals run first **without** a row lock (a refused call must not lock an advanced couple, CF1 rows U55/U22), then heats are locked FOR SHARE in id order and the entry FOR NO KEY UPDATE and the refusals are repeated under the locks. A heat entry inserted into an active heat between the heat locks and the cascade is a narrow remaining window. The SC1 session was told the error codes and keeps the same call.

The rollback restores the June invoker definition and ACL order. **"Exact" is relative to the repository text:** the hosted body contains CR characters from its original apply, so a rollback restores the CR-free repository definition; the pins compare `md5(replace(prosrc, chr(13), ''))`.

## 6. Reassessment of the 2026-11-13 residual acceptance

On 2026-11-13 the owner accepted that "a manager can still change `event_competition_entries.status` directly (audited, reason optional)". **That acceptance does not authorize the bypass now.** It predates OD-20 item 4 (no unintended client-role route to `disqualified`), R-08 (Scratch, No-show, Excluded and Disqualified stay distinct with only their authorized workflows), R-12 and the newer integrity requirements (preserved, authorized audit evidence; refund, roster and heat consistency). A direct write skips all of them.

## 7. Integration with other work

Triggers on `event_competition_entries` (same-timing triggers fire in name order):

| Timing | Trigger | Source | Concern |
|---|---|---|---|
| BEFORE UPDATE | `cf1_s6_guard_entry_links` (ALWAYS) | this PR | fires first (name order), before the next two |
| BEFORE UPDATE / INSERT | `set_event_competition_updated_at`, `validate_competition_entry_registration_links` | live line | unchanged |
| BEFORE DELETE | `cf1_s6_guard_entry_delete` (ALWAYS) | this PR | runs before the audit trigger writes the delete row |
| AFTER | `audit_competition_entry_change` (origin-only) | live line | rolled back with a refused statement |
| AFTER | `cf1_s6_guard_entry_status` (ALWAYS) | this PR | status and links |
| AFTER | `r15_guard_entry_eligibility_write` (ALWAYS) | S4, PR 866 (`20270301131000`) | eligibility columns only: disjoint |

* **S4:** no conflict forward. The `141000` rollback re-grants TRIGGER only to service_role when the S4 guard is installed, so it does not undo S4's revoke.
* **S5 (PR 863), S3 (PR 864), S1/S2 (PR 865):** no trigger or grant on the entries table.
* **SC1:** the live-line port is app-only (confirmed by that session); it does not carry PR 306's `scratch_competition_entry`, its revoke or its denylist trigger. S6 owns every SQL change to the lifecycle RPC. If PR 306's SQL were ever applied, `140000` refuses to run (it will not re-grant a retired function or coexist with `scratch_competition_entry`).

## 8. Not closed by this correction (owner decisions)

* A manager (or `service_role`) changing an `event_registrations` row that is **legitimately** linked to an entry still drives the sync: marking it paid/free confirms a pending entry, cancelling withdraws it (`paywh1` guards allow some of this). Closing it belongs to the registration guards, not this table.
* Parent cascades (deleting a division, program or event) delete entries as the table owner (OD-04 covers events).
* A client can still delete an unlinked `confirmed` entry that never held a protected status and re-create it as `pending` (kept because existing suites assert that deletion).
* `TRUNCATE` is still granted to the client roles (not reachable through the table API).
* Further delete routes (third review): a **pending linked** entry with no restricting cart reference can be deleted and re-created unlinked; deleting a registration that has no order clears `registration_id`, after which a formerly protected confirmed entry becomes deletable; deleting a deletable entry cascades away its heat entries, including `danced` / `disqualified` ones in unlocked draft or version-less heats.
* Lifecycle evidence columns (`scratched_at`, `scratch_reason`, `withdrawn_at`, `withdrawal_reason`, `confirmed_at`, `lifecycle_version`) are **not** guarded: a manager can erase or pre-plant them without an audit row.
* Owner-role sessions are trusted.
* F3 for **heat** entries (the U18-S marker) is unchanged; section 10 records what the read-back showed.
* F7 stays limited to what was observed: published-schedule heat entries are protected by the 10D guard; draft-schedule delete/re-insert is not covered here.

## 9. Test files

`test_T_competition_s6_entry_status_guard.sql` (sections A every status × role, B leaving every status, C unaffected writes, D INSERT, links and DELETE, E bypass attempts, F legitimate operations, H lifecycle rules, G consistency and coexisting triggers), `test_T_competition_s6_entry_status_concurrency.sh` (four real connections; asserts the racers wait), `f3-readback.sql`, `run-s6.sh`. **No existing suite file is modified.** One adapted copy is added: `test_T_competition_u18s_heat_entry_scratch_audit_with_s6.sql` (section 9a). Roles are simulated with `SET ROLE`; there is no PostgREST/HTTP request.

### 9a. The adapted U18-S suite

* **Pinned original, unchanged:** `test_T_competition_u18s_heat_entry_scratch_audit.sql`, sha256 `ff95a63dee7e14c6e48110bece0646c1ecbe192f367e40e7d6b39920970833fe`, byte-identical in this PR, in PR 867 and on the candidate branch. It is the suite for a chain **without** S6.
* **Why a copy is needed:** two of its setup steps write the parent entry's status as the client role `authenticated` and expect `OK`. S6's purpose is to refuse exactly that write (`COMP_S6_ENTRY_STATUS_WRITER`), so on a chain with S6 those two checks of the original fail.
* **Exact difference (besides a four-line header):**

```diff
-insert into t_dir select pg_temp.try_as('authenticated', $q$update public.event_competition_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1019800002'$q$);
+insert into t_dir select pg_temp.try_as('postgres', $q$update public.event_competition_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1019800002'$q$);
-insert into t_old select pg_temp.try_as('authenticated', $q$update public.event_competition_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1019800006'$q$);
+insert into t_old select pg_temp.try_as('postgres', $q$update public.event_competition_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1019800006'$q$);
```

* **Coverage:** no assertion is added, removed or reworded (17 checks in each). What does change in meaning: the check "direct parent-entry status write does not unlock a direct heat-entry scratch" now proves it for a parent status written by the owner; the claim that a *client* cannot make that parent write at all is proved by the S6 suite instead.
* Runs: the originals passed 8/8 on the PR 867 chain (run 1). In run 1 the same two-line change had been applied to the file in place; its 17-check pass with S6 applied is evidence for the adapted text, not for the new file. Run 2 (section 10): original on the pre-S6 chain **PASS 17**; original with S6 **FAIL on exactly the two expected checks** (both report `COMP_S6_ENTRY_STATUS_WRITER` for the client parent write); adapted copy with S6 **PASS 17**.

## 10. Results

### Run 1 (executed 2026-11-26 11:02-11:14Z, local only; head `9236cc4fd`; evidence in `evidence/run1/`)

Container from `cf1host:found` (`sha256:a9ff85eb...afd3`, PostgreSQL 17.6), role `supabase_admin`, roles simulated with `SET ROLE`; 39 competition migration files composed (fingerprint `6783fe12...f95d`); 23 applied before S6 with 0 failures, then both S6 files, both rollbacks (exit 0) and both S6 files again.

| Stage | Result |
|---|---|
| **PR 867 migration set** (before any S6 file; suites from the PR 867 head) | **8 / 8 PASS**: U18 21, U18-S 17, JC1 15, callback-final 199, A5 186, A6 247, HL1 42, F2 198 |
| S6 suite, S6 applied, and again after rollback + re-apply | **PASS, 89 checks, both times** |
| Regression suites with S6 applied | **PASS**: U18 21, U18-S 17 (**adapted**, then an in-place edit), JC1 15, A2 35, A5 186, A6 247, HL1 42, F2 198, OD-17 59, A4 55, callback-final 199, R2 write gate 21, E2 211, 10D.1 22 |
| `test_T_competition_o1_day_of` | **FAIL**: calls `pg_temp.compo1_fixture_activate_round`, defined by another suite (not runnable alone) |
| `test_T_phase10a_competition_foundation` | **FAIL**, 2 checks, both "Competition template not found" (starter template not present in this database). No other check in it failed, including the manager delete of an erroneous entry. Pre-S6 baseline of this and the previous suite: queued in run 2 |
| Concurrency script | **INVALID, not a pass**: its client-side polling was too slow on this machine, the racers started after A had committed (0 lock waiters). The end-state checks held, the race was not exercised. Script rewritten to synchronise inside the database; queued in run 2 |
| Rollback proof | **INVALID as run**: the state query stopped at an ambiguous-operator error after the function rows, so "identical" covered function definitions, ACLs and security flags only, not triggers or table grants. Query fixed and the check now fails if any part is missing; queued in run 2 |

**F3, now executed with a state read-back (`evidence/run1/f3-readback-*.log`).** Before S6, in a SQL session as `authenticated`: the direct parent scratch succeeded, then with the forged marker the direct heat-entry scratch succeeded and the heat entry **read back as `scratched`** (marker alone, parent not scratched: refused). So F3 is a **confirmed bypass** on the U18-S chain (SQL session only; no API path is known to set that setting). After S6 the first step is refused (`COMP_S6_ENTRY_STATUS_WRITER`), the second is refused (`COMP_U18S_SCRATCH_UNAUDITED`) and nothing changes.

### Run 2 (executed 2026-11-26 13:33-13:35Z, local only; head `7341af1df`; evidence in `evidence/run2/`)

Same image, role and 39-file composition (fingerprint `6783fe12...f95d`) as run 1; 23 migrations before S6, 0 failed; both rollbacks exit 0. It closes what run 1 left invalid or pending.

| Stage | Result |
|---|---|
| Pre-S6 chain (suites from the PR 867 head) | original U18-S **PASS 17**; `o1_day_of` **FAIL**; 10A **FAIL** |
| S6 applied | S6 suite **PASS 89**; adapted U18-S **PASS 17**; original U18-S **FAIL (expected: the two client parent-write checks)** |
| `o1_day_of` and 10A with S6 | **FAIL with the same first error as before S6** (missing fixture helper; "Competition template not found"). Pre-existing in this composition, not caused by S6; neither suite has passed here |
| Concurrency | **PASS, 7 checks, 3 lock waiters observed**: the direct write waited and was refused, the owner R2 writer and a second submit waited and changed nothing, one audit row |
| Rollback proof | **PASS**: pre-S6 and post-rollback state identical over all 10 lines (lifecycle and both R2 functions: body md5 without CR, owner, security, ACL, config; the three entry triggers; table ACL; client privileges) |
| S6 suite after re-apply | **PASS 89** |

Not executed anywhere: PostgREST/HTTP requests, referential SET NULL / cascade from registrations or orders, a composed run with S4 / S5, any hosted database.

**SQL suites never run with S6** (not evidence either way): R2 entry refunds (the main consumer of the lifecycle RPC), NS1 no-show, A3, A7, F3 publication, RB3 / RB3R, U66, and every CF1 concurrency script. **One is expected to FAIL with S6 (by reading, not executed): `test_T_competition_cf1_a5_concurrency.sh`** probes P1/P2 scratch entries that sit `scheduled` in an `active` heat through the lifecycle RPC, which S6 now refuses (`COMP_ENTRY_LIFECYCLE_PLACED`) before taking a lock; June allowed it. Whether an active-heat scratch must be refused (it affects day-of use) is an owner decision.

**Blocked checks inside passing suites** (reported by the suites themselves, not passes): A5 4, A6 3, A2 1, A4 3, callback-final 5, including multi-session probes.

## 11. Independent review

Two reviewers that had not seen these conclusions reviewed the work. The first found: service_role reach through the internal R2 definers; indirect transitions through registration links; delete and re-create; an unsafe re-grant against SC1; the optional lifecycle rules being necessary; the repeat-call branch skipping checks; missing heat locks; test defects; rollback ACL order, TRIGGER re-grant and missing rollback preflights. The second reviewed the fixes and found: the delete rule breaking two behaviours the 10A and callback-final suites assert; the link rule refusing referential SET NULL actions (AFTER trigger); locks taken before refusals (CF1 U55); assertions made in the same statement as the action (vacuous or failing) and other suite defects; an incomplete rollback proof; unrecorded prior privileges; client-changeable `id`/`event_id`; stale references. All were addressed in the current version except the items in section 8 and the narrow concurrency window in section 5. 

**Third review (2026-11-26), of the second round of fixes.** Verdict: no blocker to owner review of this as a **draft**; no direct client status write found past the three triggers (by reading). It ran no SQL. Sound by reading: trigger branching; referential actions passing the BEFORE guards (PostgreSQL semantics, untested); upserts; authorization before any lock; history row-level security does not fail open today; the adapted U18-S copy and pin.

**Open findings, NOT fixed; to be fixed before any apply approval** (the tested SQL is deliberately unchanged):

| ID | Sev | Finding |
|---|---|---|
| R3-F1 | P2 | A5 concurrency probes P1/P2 expected to fail under the placed-entry refusal (above) |
| R3-F3 | P2 | Test gaps that a broken guard would pass: the INSERT link rule is never exercised; the delete rule's current-status branch is not isolated (e.g. owner-inserted disqualified or waitlisted entry without history); only the registration arm of the linked-delete rule is tested |
| R3-F5 | P3 | The race test would also pass without the entry lock (it does not assert `lifecycle_version` / reason are unchanged) and has no heats, so heat locking and the under-lock refusals are untested |
| R3-F6 | P3 | `141000` rollback after S4 has been applied and then rolled back re-grants TRIGGER that was absent before S6; it restores privileges from assumption and does not pin the guard body. Rollback is proven only without S4 |
| R3-F7 | P3 | Further delete routes (section 8) |
| R3-F8 | P3 | `140000` preflight does not pin the exact prior ACL, so a rollback could re-grant a privilege another change had revoked |
| R3-F9 | P3 | Lifecycle evidence columns unguarded (section 8) |
| R3-F10/11 | info | Preflight does not check the audit trigger / history protections the rules rely on; the runner records head and fingerprint before the lock wait (run 2 composed 11:25Z, executed 13:33Z; no SQL or test file changed in between), and classifies any line containing PASS as a pass |

R3-F2 (evidence logs excluded by `.gitignore`) and R3-F4 (suites not run, blocked counts) are addressed here: the logs are now committed.
