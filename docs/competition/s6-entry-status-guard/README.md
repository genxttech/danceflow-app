# S6: guard for direct changes to a competition entry's status (DRAFT, NOT APPLIED)

Owner decision 2026-11-24, option B (corrects OD-31 findings F1 and F2). **Nothing here is applied, merged or authorized for any hosted database.** Two new migrations (`20270301140000`, `20270301141000`), their rollbacks, a SQL suite, a concurrency script, an F3 read-back experiment and a local runner; two edits to existing test files (section 9). Stacked on PR 867 (it uses the `current_user in ('postgres','supabase_admin')` allowlist convention of U18 and S4/R15 and the guards that PR lands); retarget to `release/website-embeds` after PR 867 merges.

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

**Chosen:** one guard function with two triggers (`cf1_s6_guard_entry_status` AFTER INSERT OR UPDATE; `cf1_s6_guard_entry_delete` BEFORE DELETE). For any role that is not `postgres` / `supabase_admin` it refuses every status change, every change of the registration/order links, any INSERT that is not an unlinked `pending` entry, and any DELETE of an entry that is not pending, is linked, or has change history.

Why not narrower: direct `complete`, `scratched` and `withdrawn` writes matter as much as `disqualified` (R2 skips the cascade and exception recording; the sync skips the entry; A5/A6/advancement treat it as unavailable; `withdrawn`/`scratched` satisfies R2's `withdrawn_after_unlock` gate); `waitlisted` / `pending` flip the eligibility predicate. A per-value list leaves a gap for every value not listed and every value added later. After the one client-facing writer becomes DEFINER, **no legitimate client-role status writer exists**, so the general rule loses nothing.

| Role / path | INSERT | UPDATE of `status` or links | DELETE |
|---|---|---|---|
| anon, authenticated, service_role, any other non-owner role | unlinked `pending` only | refused (`COMP_S6_ENTRY_STATUS_WRITER`, `COMP_S6_ENTRY_LINK_WRITER`) | only an unused pending entry (`COMP_S6_ENTRY_DELETE_WRITER` otherwise) |
| owner-run definers (registration, sync, R2, lifecycle RPC) | any | any, subject to their own rules | any |
| owner SQL session, referential cascades (run as the table owner) | any | any | any |

All refusals are SQLSTATE `42501` and roll the statement back, including an audit row written earlier in it. A transition matrix for owner-run writers was rejected: the existing suites legitimately move entries between arbitrary states as the owner.

## 4. Authorization model: nothing spoofable

The guard reads `current_user` and row values only; it reads no custom setting. `app.competition_entry_change_type` (finding F3) is a plain setting any SQL session can set, so it authorizes nothing here. The one client path, the lifecycle RPC, authorizes with `can_manage_event_competition()` and runs as the owner because it is SECURITY DEFINER with a fixed `search_path`.

## 5. The lifecycle RPC (`140000`)

Same signature; EXECUTE limited to `authenticated`. Because a definer function bypasses RLS and the invoker-side guards, `140000` makes these rules **mandatory** (each differs from June, and the owner should confirm them): (1) only `pending`, `confirmed`, `waitlisted` entries can be scratched or withdrawn (`COMP_ENTRY_LIFECYCLE_STATE`), so a disqualification or completion cannot be cleared; (2) placed entries are refused (`COMP_ENTRY_LIFECYCLE_PLACED`, the R2 locked/certified class) besides the existing locked-heat refusal; (3) repeating the call for the current state writes no audit row or version bump and, after the same checks, completes the heat-entry cascade; (4) heats are locked FOR SHARE in id order, then the entry FOR NO KEY UPDATE, and decisions use what is read under those locks. The SC1 session was told the error codes and keeps the same call.

The rollback restores the June invoker definition and ACL order. **"Exact" is relative to the repository text:** the hosted body contains CR characters from its original apply, so a rollback restores the CR-free repository definition; the pins compare `md5(replace(prosrc, chr(13), ''))`.

## 6. Reassessment of the 2026-11-13 residual acceptance

On 2026-11-13 the owner accepted that "a manager can still change `event_competition_entries.status` directly (audited, reason optional)". **That acceptance does not authorize the bypass now.** It predates OD-20 item 4 (no unintended client-role route to `disqualified`), R-08 (Scratch, No-show, Excluded and Disqualified stay distinct with only their authorized workflows), R-12 and the newer integrity requirements (preserved, authorized audit evidence; refund, roster and heat consistency). A direct write skips all of them.

## 7. Integration with other work

Triggers on `event_competition_entries` (same-timing triggers fire in name order):

| Timing | Trigger | Source | Concern |
|---|---|---|---|
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
* `TRUNCATE` is still granted to the client roles (not reachable through the table API).
* Owner-role sessions are trusted.
* F3 for **heat** entries (the U18-S marker) is unchanged; section 10 records what the read-back showed.
* F7 stays limited to what was observed: published-schedule heat entries are protected by the 10D guard; draft-schedule delete/re-insert is not covered here.

## 9. Test files

`test_T_competition_s6_entry_status_guard.sql` (sections A every status × role, B leaving every status, C unaffected writes, D INSERT, links and DELETE, E bypass attempts, F legitimate operations, H lifecycle rules, G consistency and coexisting triggers), `test_T_competition_s6_entry_status_concurrency.sh` (four real connections; asserts the racers wait), `f3-readback.sql`, `run-s6.sh`. **Edited existing file:** `test_T_competition_u18s_heat_entry_scratch_audit.sql`, two setup writes of the parent entry now run as the owner (as a client they are refused once S6 is installed); the U18-S assertions are unchanged. Roles are simulated with `SET ROLE`; there is no PostgREST/HTTP request.

## 10. Results

See the section appended after the local run. Until then nothing in this directory is verified by execution.

## 11. Independent review

A reviewer that had not seen these conclusions reviewed the first version and found: service_role reach through the internal R2 definers; indirect transitions through registration links; delete and re-create; an unsafe re-grant against SC1; the optional lifecycle rules being necessary; the repeat-call branch skipping checks; missing heat locks; two existing-test and one new-test defects; rollback ACL order, TRIGGER re-grant and missing rollback preflights; and weak assertions. All were addressed in the current version except those listed in section 8. The fixes have not yet had a second review.
