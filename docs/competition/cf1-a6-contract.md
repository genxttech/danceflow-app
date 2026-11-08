# CF1 package A6 — contract (withdrawal and reinstatement of an advanced couple)

Migration `20270120095000_competition_cf1_a6_withdrawal.sql` (rollback in `rollback/`, suites `sql-tests/test_T_competition_cf1_a6_withdrawal.sql` and `test_T_competition_cf1_a6_concurrency.sh`).
Design: `callback-to-final-advancement-design.md` (rev 21) §4.3–§4.6, §5 (I7/I8), A.2, A.3, A.9. Stack: HL1 → A1 (`…085000`) → A0 (`…090000`) → **A6 (`…095000`)**. A6 is the **first** CF1 rollback.
A6 changes **no existing function** (no pins). It adds one table, eleven functions and one trigger.

## What A6 owns / does not own

| Owns | Does not own |
|---|---|
| every **writer** of `event_competition_final_withdrawals` (A0 created the table and only reads it); the request table; the four RPCs; `cf1_guard_withdrawn_heat_entry` | the withdrawal table itself, apply's carried-withdrawal handling, the start guard, the correction pre-check (A0); the exclusion action (A5); the app (B) |

## Ownership decision: two halves (read this first)

A0's table requires `requested_by`, `cosigned_by` (`<>` each other, NOT NULL) and `cosigned_role` in **one** row, and an authenticated function can only ever prove one identity (`auth.uid()`). The design allows "a co-sign row **or a two-step request**" (§4.3). A6 therefore keeps A0's table untouched and adds a small insert-only **request** table:

1. **Requester's half** — `withdraw_advanced_entry_from_final` / `reinstate_withdrawn_entry_to_final`: a verified manager records a pending request (early refusal of anything already impossible). **No heat entry or advancement row is touched.**
2. **Co-signer's half** — `cosign_final_withdrawal_request`: a different person (chair or verified manager) co-signs. Only this call writes `event_competition_final_withdrawals` and changes a heat entry, under the full lock order, with every precondition re-checked.

The co-sign reuses the requester's `request_id` as the withdrawal row's `request_id` (unique in both tables), which is also the idempotency key.
A pending request has no expiry and no cancellation in A6 (it is harmless: it grants nothing until a co-sign revalidates). An expiry/cancel is a follow-up if B wants one.

## Grants

| Object | Grant |
|---|---|
| `withdraw_advanced_entry_from_final(uuid, uuid, text, uuid)`, `reinstate_withdrawn_entry_to_final(uuid, uuid, text, uuid)`, `cosign_final_withdrawal_request(uuid)`, `competition_final_withdrawal_state(uuid)` | `authenticated` only (revoked from `public`, `anon`, `service_role`) |
| `_cf1_a6_request`, `_cf1_a6_precheck`, `_cf1_a6_pair_state`, `_cf1_a6_current_roster`, `_cf1_a6_on_roster`, `_cf1_a6_active_heat`, `cf1_guard_withdrawn_heat_entry` | **none** |
| `event_competition_final_withdrawal_requests` | **none** (RLS on, no policy; history triggers `ENABLE ALWAYS`) |

All functions are `SECURITY DEFINER`, `set search_path = public, pg_temp`. The two RPCs that take a lock budget carry `set lock_timeout = '5s'` (request half, co-sign half).

## RPCs

| Signature | Returns | Meaning |
|---|---|---|
| `withdraw_advanced_entry_from_final(p_round_id uuid, p_entry_id uuid, p_reason text, p_request_id uuid)` | `jsonb {replayed, state: 'pending'\|'completed', request_id, kind}` | `p_round_id` is the **Final** round. Requester must be `_compe2_round_role = 'manager'` **and** have a verified email. Locks: event lock → Final round `FOR UPDATE`. Replay (before any state check): same round/entry/kind/requester → `replayed: true`; otherwise `COMP_REQUEST_REUSED`. Reason must pass `_cf1_reason_is_substantive` (`COMP_WITHDRAWAL_REASON_WEAK`). Then the shared precheck. |
| `reinstate_withdrawn_entry_to_final(p_round_id uuid, p_entry_id uuid, p_reason text, p_request_id uuid)` | same | Same authorization/locks/replay; kind `reinstate`. |
| `cosign_final_withdrawal_request(p_request_id uuid)` | `jsonb {replayed, withdrawal_id, kind, seq, entry_id, heat_entry_id, prior_heat_entry_status}` | Co-signer: `_compe2_round_role` in (`manager`, `chair`) **and** verified email; a different person from the requester (`COMP_WITHDRAWAL_COSIGN_SAME_PERSON`, `42501`). Replay by the same co-signer → `replayed: true`; by anyone else → `COMP_REQUEST_REUSED`. Lock order (A.3): event lock → Final round `FOR UPDATE` → **all** Final heats `FOR UPDATE NOWAIT` (id order) → their heat entries `FOR UPDATE` (id order) → the entry `FOR SHARE`; then the precheck in fresh statements; `seq = coalesce(max(seq),0)+1` read under the round lock; the row; then the heat entry status. `55P03`/`40P01` → `COMP_ADVANCEMENT_CONCURRENT_CHANGE` (`55P03`, retryable). |
| `competition_final_withdrawal_state(p_round_id uuid)` | `jsonb {withdrawn: [{entry_id, withdrawal_id}], pending: [{request_id, kind, entry_id, requested_by, reason, at}]}` | Read only, no locks; manager or chair with a verified email. Added so B can list pending requests (without it a co-signer cannot find the request id). |

### What a completed withdrawal does

* Writes **one** `event_competition_final_withdrawals` row (`kind='withdraw'`, `cosigned_role` = the co-signer's role, `heat_entry_id`/`prior_heat_entry_status` from the Final's **active** (non-cancelled) heat while an advancement is active, else null).
* If the couple has a `scheduled`/`checked_in` heat entry in the active heat: sets **only** that row to `scratched` (status-only update). An already `scratched` row is left as is and recorded with `prior_heat_entry_status = 'scratched'` (U49). A row in any other status (`danced`, `disqualified`) is refused `COMP_WITHDRAWAL_PRIOR_STATUS`.
* Never touches the callback heat entries, the advancement rows, `entries.status` / `eligibility_status`, or the registration. Allowed with **no** advancement (between a revoke and the next apply): the row is written alone (§4.4).

### What a completed reinstatement does

* Refused unless the pair's effective state is `withdraw` (`COMP_WITHDRAWAL_NOT_ACTIVE`), and refused `COMP_ADVANCEMENT_REINSTATE_PRIOR_SCRATCH` when the withdrawal's `prior_heat_entry_status = 'scratched'` (the earlier scratch is not undone).
* Refused `COMP_WITHDRAWAL_ENTRY_UNAVAILABLE` when predicate P (`_cf1_entry_unavailable`) is true or the entry is not in the Final's `(event, program, division)`.
* **OD-18 A, no heat entry is ever inserted.** While an **active Final heat** exists the couple must still have its scratched row there (it is un-scratched to the stored prior status), else `COMP_ADVANCEMENT_REINSTATE_NO_HEAT_ENTRY` (carried couple of generation 2: U48 a). With **no** active advancement/heat (after a revoke) the reinstatement writes **only its row** (`heat_entry_id` null, prior null) and touches nothing in the cancelled earlier-generation heat (U62); the next apply includes the couple only if the corrected callback still advances them (U48 b).
* The row is inserted **before** the un-scratch, so it is the highest `seq` and the guard no longer treats the pair as withdrawn.

### Shared preconditions (request half and co-sign half, in this order)

`COMP_WITHDRAWAL_NOT_CALLBACK_FINAL` · entry not of the event → `COMP_WITHDRAWAL_NOT_ON_ROSTER` · Final not `draft`/`scheduled`, or any Final heat `staging/active/complete` → `COMP_ADVANCEMENT_FINAL_STARTED` · any ballot on the Final → `COMP_WITHDRAWAL_BALLOTS` · any non-cancelled Final heat with `lock_state <> 'open'` → `COMP_ADVANCEMENT_FINAL_LOCKED` · then kind-specific. Withdraw: `COMP_WITHDRAWAL_ALREADY`; on the roster (some advancement of the round, or the latest callback result's advanced rows) else `COMP_WITHDRAWAL_NOT_ON_ROSTER`; heat-entry status; **OD-15 A minimum**: `_cf1_count_available_entries(current roster − effective withdrawals − this couple) < 2` → `COMP_ADVANCEMENT_BELOW_MINIMUM`. "Current roster" = the active advancement's list, else the latest callback result version's `advanced = true` rows (between a revoke and the next apply the roster is not final; apply re-checks the minimum and is authoritative).

## Guard `cf1_guard_withdrawn_heat_entry` (I8)

`BEFORE INSERT OR UPDATE OF status, entry_id, heat_id OR DELETE ON event_competition_heat_entries FOR EACH ROW`, **`ENABLE ALWAYS`**, **`VOLATILE`**, definer, no error swallowing. The round of a row is the round of its heat. A pair is **withdrawn** when its highest-`seq` row is `withdraw`. Refuses (`COMP_WITHDRAWAL_GUARD`, `42501`), at any time, before and after the start, for every role:

* UPDATE moving a withdrawn pair's row **out of `scratched`**; UPDATE of `entry_id`/`heat_id` of a withdrawn pair's row; UPDATE re-pointing a row **at** a withdrawn entry;
* INSERT of a heat entry for a withdrawn pair into **any** heat of that round (also defence in depth against apply);
* DELETE of a withdrawn pair's row, except when the event or the heat is going away (cascade; the FK `final_withdrawals.heat_entry_id` NO ACTION backstops a direct heat delete).

The only way out is the pair's effective state ceasing to be `withdraw`, i.e. a reinstatement row of the same transaction being the highest `seq` (an authorized reinstatement). A status change **into** `scratched` is always allowed (it is the withdrawal's own write). A0's `cf1_guard_final_heat_entry` (insert / `heat_id`, `entry_id`) fires first alphabetically for those columns; both must pass.

Residuals (unchanged by A6, recorded): table owner / superuser can `DISABLE TRIGGER`; `TRUNCATE` is not seen by a row trigger (U46 is A1's hosted-privilege gate); `session_replication_role = replica` **is** covered (`ENABLE ALWAYS`, U52).

## Request table `event_competition_final_withdrawal_requests`

`id`, `event_id` (→ `events` cascade), `target_round_id`, `entry_id`, `kind` (`withdraw`/`reinstate`), `reason` (3–500), `requested_by`, `request_id` (unique), `transaction_id` (default `txid_current()`), `at`. Composite FKs `(target_round_id, event_id)` → rounds and `(entry_id, event_id)` → entries, both `NO ACTION`. Insert-only (`protect_competition_history_evidence`, row + truncate, `ENABLE ALWAYS`), RLS on, no policies, no grants. Index `(target_round_id, entry_id)`.

## Error codes (SQLSTATE `P0001` unless stated)

New: `COMP_WITHDRAWAL_NOT_CALLBACK_FINAL`, `COMP_WITHDRAWAL_NOT_ON_ROSTER`, `COMP_WITHDRAWAL_ALREADY`, `COMP_WITHDRAWAL_NOT_ACTIVE`, `COMP_WITHDRAWAL_BALLOTS`, `COMP_WITHDRAWAL_PRIOR_STATUS`, `COMP_WITHDRAWAL_ENTRY_UNAVAILABLE`, `COMP_WITHDRAWAL_REASON_WEAK`, `COMP_WITHDRAWAL_REQUEST_NOT_FOUND`, `COMP_WITHDRAWAL_COSIGN_SAME_PERSON` (`42501`), `COMP_WITHDRAWAL_GUARD` (`42501`).
Reused: `COMP_FORBIDDEN` (`42501`), `COMP_REQUEST_ID_REQUIRED`, `COMP_REQUEST_REUSED`, `COMP_ADVANCEMENT_FINAL_STARTED`, `COMP_ADVANCEMENT_FINAL_LOCKED`, `COMP_ADVANCEMENT_BELOW_MINIMUM`, `COMP_ADVANCEMENT_REINSTATE_NO_HEAT_ENTRY`, `COMP_ADVANCEMENT_REINSTATE_PRIOR_SCRATCH`, `COMP_ADVANCEMENT_CONCURRENT_CHANGE` (`55P03`, retryable; also raised for `40P01`).

## Rollback

`rollback/…095000_…_rollback.sql` is the **first** CF1 rollback. It locks both tables, **refuses if any withdrawal row or request row exists** (roll forward), refuses if another function still references an A6 object, then drops the trigger, the eleven functions and the request table. It leaves A0's table and apply untouched.

## Verified against the real SQL (not the design text)

A0 table columns, checks and FKs, `_cf1_withdrawn_entries`, `_cf1_active_advancement`, apply's carried handling and the start guard's roster/minimum, `_compe2_round_role` (manager before the verified-email check, chair/scorer need it), `can_manage_event_competition`, `protect_competition_history_evidence`'s event-gone exception, A1's `_cf1_count_available_entries` / `_cf1_entry_unavailable(_reason)` / `_cf1_is_callback_final`, `open_competition_round_correction` (F2) as the revoke trigger. Re-check this file if A0's contract changes: the names `event_competition_final_withdrawals` columns, `_cf1_withdrawn_entries`, `_cf1_active_advancement`, `_cf1_callback_source`, `_cf1_reason_is_substantive` are load-bearing.

## Not delivered / follow-ups

* "Not anyone who files a replacement ballot" (OD-19 D's inherited clause) is **vacuous** here: a withdrawal is refused once the Final has any ballot (`COMP_WITHDRAWAL_BALLOTS`). It matters for the OD-13 judge-entry correction (A0b / A5).
* Pending-request expiry/cancel, a UI list beyond `competition_final_withdrawal_state`, an audit-log projection of withdrawals (`competition_audit_log`): not in A6.
* The `lock_competition_round_ballots` cross-check for a withdrawn pair on the roster (OD-17 D third leg, §4.5) belongs to A2.

## Independent review (read-only subagent): no P0/P1

Fixed: reinstate precheck now also requires the active heat entry to be the row the withdrawal recorded, with a restorable prior status (no stuck-pending request).
Accepted and recorded (P2/P3): requester authority is not re-checked at co-sign and requests do not expire or cancel (follow-up with B); the guard reads in the caller's snapshot, so REPEATABLE READ/SERIALIZABLE writers are outside its guarantee (PostgREST is READ COMMITTED; U51 covers that); the DELETE "heat gone" exemption relies on the withdrawals FK, which does not fire under `session_replication_role = replica`; withdrawn rows in cancelled heats cannot be cleaned up; co-sign returns REQUEST_NOT_FOUND before the role check (uuid probe, negligible).

## Coordinator review round (PR 368 review) — changes

* **M1 roster source.** `_cf1_a6_current_roster` with no active advancement now reads the latest **approved** callback version (`status = 'approved'`, `engine_key like '%callback_tally%'`, highest version), exactly like apply; if a correction left no approved version at all, the last applied (revoked) advancement's couple list is used (never an unapproved version), so the OD-18 withdrawal between a revoke and the next apply still counts the minimum correctly. A newer calculated/invalidated version never widens the roster or the OD-15 count.
* **M2 requester revalidation and binding.** The request table has `advancement_id` (the active advancement when the request was made, nullable, FK `NO ACTION`). At co-sign: the requester must still be a manager and have a verified email (`_cf1_a6_can_manage(uid, event)` + `verified_email_for_user(requested_by)`; else `COMP_WITHDRAWAL_REQUESTER_INVALID`, `42501`), and the Final's active advancement must equal the stored one (else `COMP_WITHDRAWAL_REQUEST_STALE`). `_cf1_a6_can_manage` copies the four branches of `can_manage_event_competition` for an explicit user id; re-check both if the original changes. **No TTL** (policy, with the owner).
* **Low-1.** A request is *live* when it has no withdrawal row and is bound to the current active advancement. A new request for the same (round, couple, kind) while a live one exists is `COMP_WITHDRAWAL_REQUEST_PENDING`; **cap: 10 live requests per round** (`COMP_WITHDRAWAL_TOO_MANY_PENDING`). Stale or completed requests do not block or count. `competition_final_withdrawal_state` flags `stale` per pending request.
* **Low-3.** The rollback sets `lock_timeout = '5s'` before locking tables and dropping the trigger.
* **Low-2 (owner question, unchanged):** the minimum-two refusal (`COMP_ADVANCEMENT_BELOW_MINIMUM`) also refuses withdrawing an already-ineligible couple when the Final is already below two eligible couples (for example 2 couples, one of them ineligible): there is then no supported withdrawal and the way out is reverting the eligibility or a correction. Left as designed (design 4.6 b: "a withdrawal that would leave fewer than two is refused").

## Re-review of the review-fix round (no P0/P1) — recorded residuals

* **ABA on the NULL binding (P2).** A request made while no advancement is active (NULL) and still NULL after an apply + revoke is not flagged stale; the co-sign `_cf1_a6_precheck` still revalidates the roster under the locks, so only semantic staleness remains. Candidate follow-up: bind to the latest advancement id regardless of revocation.
* **Withdrawals during the no-approved-version window (P2).** Rows are keyed by (round, entry), not by advancement; apply carries the withdrawn set (`_cf1_withdrawn_entries`). Owner question alongside Low-2: refuse requests in that window or keep OD-18 row-only behavior (current).
* **No cancel path (P2).** There is no TTL and no cancel; one manager can hold up to 10 live slots. Policy item raised with the coordinator (TTL / cancel RPC).
* **P3.** A6 must roll back before A0 (FK `advancement_id`); a replayed request reports `pending` even when stale (the state reader flags `stale`); `_cf1_a6_live_requests` is declared volatile (read-only; it calls the volatile `_cf1_active_advancement`).

## Re-review corrections (owner-authorized) and open owner decisions

### Done (policy-neutral)

* **P2-1 ABA on the NULL binding — fixed.** A request now stores `advancement_id` (active advancement, null if none) **and** `advancement_generation` (highest generation of the Final, 0 if none ever). `_cf1_a6_is_stale(round, advancement_id, generation)` is true when either differs from the Final's current state. Apply-then-revoke returns the active advancement to null but raises the generation, so the request is `COMP_WITHDRAWAL_REQUEST_STALE` at co-sign, flagged `stale` by the reader, and no longer counts toward the duplicate / cap rules. The same predicate is used by the cap, the duplicate check, the co-sign and the reader.
* **P3 replay.** A replay of a request that is no longer co-signable reports `state: 'stale'` (a completed one still `completed`).
* **P2-2 test gap closed.** Scenario 12 pins the current behavior: with no approved version after a correction, a withdrawal is accepted (row only, roster = last applied list); when the corrected version omits that couple, apply succeeds and the withdrawn couple gets no heat entry. Scenario 11 pins P2-1.
* **P3 rollback order.** A6 rolls back before A0 (FK from the request table to the advancements table).

### Owner decisions D-A, D-B, D-C (RESOLVED by the owner; see "Owner decisions ... implemented" below)

**D-A. Withdrawal while a correction has left the Final with no approved callback result** (P2-2).
* Scenario: the chair opens a correction on the callback round (the advancement is revoked, the approved version is invalidated); a manager and a co-signer record a withdrawal of couple X before the corrected result is approved. The corrected result may then rank X out of the Final, or the roster may differ entirely.
* Current behavior (proposed default): accept it, row only, minimum counted on the last applied roster; apply carries the withdrawal and X is simply not seated. No data is lost; the withdrawal row is evidence and stays in the history.
* Alternatives: (1) refuse withdraw/reinstate until a new result is approved (`COMP_WITHDRAWAL_NO_APPROVED_RESULT`); (2) accept but mark the row "provisional" and re-validate at apply, refusing apply if X is not on the new list.
* Consequences: (1) cannot withdraw a couple who drops out during a correction, so the director must wait for the corrected result — blocks an urgent real-world withdrawal; (2) needs an A0 apply change and a new column. Depends on: nothing in P2-1; related to D-C.

**D-B. Stuck pending requests: TTL and/or a cancel call** (P2-3).
* Scenario: a manager files 10 requests (the per-round cap) that no one co-signs, or files one for a couple and leaves; another manager cannot file for that couple and kind until a *different* manager (never the requester) co-signs it, or a revoke/apply makes it stale.
* Proposed default: add `cancel_final_withdrawal_request(request_id)` callable by the requester or any manager/chair (evidence row `event_competition_final_withdrawal_request_cancellations`, insert-only, reason required), no TTL. Cancelled requests drop out of "live".
* Alternatives: a TTL (e.g. 24 h) after which a request is treated as stale; both; or leave as is (operational: any other manager can co-sign and then reinstate).
* Consequences: cancel adds a table, an RPC and tests; TTL adds a clock dependency and surprising expiries during a live event; leaving it as is keeps the griefing window for a verified manager (not an outside attacker). Depends on: P2-1 (stale already frees slots after a re-advance; cancel/TTL covers the no-advance case).

**D-C. Withdrawal refused when the Final is already below two because of an ineligible couple** (Low-2; unchanged).
* Scenario: three couples advanced, one becomes ineligible, a manager withdraws another: one eligible couple would remain, below two, so BELOW_MINIMUM. The director cannot reach a valid state without an ineligibility change.
* Proposed default: keep the refusal (OD-15 A). Alternatives: let a chair override with a recorded reason; allow it and let the start guard refuse the Final. Consequences: override needs a new authority path and evidence; allow-and-refuse-at-start moves the failure to the day of the event. Depends on: none.

### Re-review of the P2 corrections (no P0/P1) — residuals

* **Generation scope (P2).** `advancement_generation` is the `max(generation)` over the advancements of the target round. Generation is unique per (source round, generation); the Final has exactly one callback source (`_cf1_callback_source`), so the max is monotonic per Final. If a later package ever allows two sources for one Final, switch the current-state value to `count(*)` of the target's advancements (advancements are history-protected, never deleted).
* **P3.** The insert computes the generation inline (same expression as the helper); the column default 0 lets a direct insert omit it (the table has no direct grants). Untested edges: completed-and-stale replay reports `completed`; a stale request freeing a cap slot; request → apply → revoke → re-apply.

## Owner decisions D-A, D-B, D-C — implemented (supersedes "Open owner decisions" above)

Slot unchanged: the revised `20270120095000_competition_cf1_a6_withdrawal.sql` (nothing is applied hosted, so no new slot).

### D-A — no new withdrawal / reinstatement while the callback result is being corrected

* **Rule.** `_cf1_a6_roster_blocked(round)` is true when the Final has no active advancement **and** its callback round has no approved callback result. Opening a correction revokes the advancement and invalidates the approved result in the same transaction (F2 / A0), and only approving a corrected result ends the window, so this is exactly "under correction (or never approved)". `_cf1_a6_precheck` (shared by the request and the co-sign) raises `COMP_WITHDRAWAL_NO_APPROVED_RESULT` (P0001) for **both kinds**, after the started / ballots / locked checks and before any pair-state or roster test.
* **No outdated roster.** `_cf1_a6_current_roster` no longer falls back to the last applied advancement; with no active advancement and no approved result it is empty. A new action is never validated against an outdated list.
* **Reinstatement in the window.** The owner text was silent; the default was applied: the same refusal for any NEW action that changes the Final roster. Reinstatement works again once a corrected result is approved (it writes only its row, OD-18 A).
* **Already-completed history is untouched.** No code path rewrites or deletes a withdrawal row; scenario 12 proves the count and a content digest are identical across the correction.
* **Already-OPEN requests at the moment a correction opens.** Two cases, both proven (scenarios 12 and 13):
  1. A request bound to an active advancement (the normal case): the revoke changes the active advancement, so the existing staleness check refuses the co-sign with `COMP_WITHDRAWAL_REQUEST_STALE` before anything else. The reader flags it `stale`. No new policy was added.
  2. A request made before any apply (no advancement): it is also bound to the approved callback result version it was made against (`source_result_version_id`). Invalidating that result makes it `COMP_WITHDRAWAL_REQUEST_STALE`, and it stays stale after a corrected result with a different roster is approved (the second person never co-signs a request made against another result). The precheck refusal `COMP_WITHDRAWAL_NO_APPROVED_RESULT` at the co-sign is the second line of defence. It can be cancelled (D-B).

### D-B — audited cancel

* `cancel_final_withdrawal_request(p_request_id uuid, p_reason text) returns jsonb` (authenticated only; revoked from public / anon / service_role).
* **Who.** The round role must be manager or chair and the caller must have a verified email. The requester qualifies only while still a manager (a requester who lost the role cannot cancel; another manager can). `by_requester` and `cancelled_role` are recorded.
* **Reason.** `_cf1_reason_is_substantive` (20-500 characters, at least 4 words, not a placeholder): `COMP_WITHDRAWAL_REASON_WEAK`.
* **Evidence.** `event_competition_final_withdrawal_request_cancellations`: insert-only, RLS on, no policies, no grants, history triggers `protect_cf1_wdcxl_history[_truncate]` ENABLE ALWAYS, one row per request (`request_id` unique, FK to the request), composite FK to the round, event cascade like the other evidence tables.
* **Idempotent.** The same person cancelling again gets `{replayed: true, state: 'cancelled', cancellation_id}` and no second row. A different person gets `COMP_WITHDRAWAL_REQUEST_CANCELLED`.
* **Lock order.** event lock -> Final round `FOR UPDATE` (same as the co-sign and apply), `lock_timeout 5s`; 55P03 / 40P01 -> `COMP_ADVANCEMENT_CONCURRENT_CHANGE`. A cancel and a co-sign of the same request serialize on the event lock and exactly one wins: the loser gets `COMP_WITHDRAWAL_REQUEST_CANCELLED` (co-sign) or `COMP_WITHDRAWAL_REQUEST_COMPLETED` (cancel). Two-session proof: concurrency R6a, R6b, R7.
* **Cannot undo.** A completed request: `COMP_WITHDRAWAL_REQUEST_COMPLETED`; a completed withdrawal is undone only by a reinstatement. A published result is not touched (the function writes only its own table).
* **Live definition.** `_cf1_a6_live_requests` also excludes cancelled requests: they free their duplicate slot and their cap slot. A replay of the request itself reports `state: 'cancelled'`. `competition_final_withdrawal_state` returns `pending` (without cancelled ones) and a new `cancelled` array (`request_id, kind, entry_id, requested_by, cancelled_by, by_requester, reason, at`).
* **No TTL.**

### D-C — OD-15 A unchanged

Clarification tests only (scenario 15): with three advanced and one made ineligible, a request that would leave fewer than two eligible couples is refused at the request and again at the co-sign **by the chair too** (`COMP_ADVANCEMENT_BELOW_MINIMUM`); nothing is written, and nothing is deferred to the Final start.

### Stable errors added (the app maps these)

| Code | SQLSTATE | Raised by |
|---|---|---|
| `COMP_WITHDRAWAL_NO_APPROVED_RESULT` | P0001 | request, co-sign (D-A) |
| `COMP_WITHDRAWAL_REQUEST_CANCELLED` | P0001 | co-sign, a second canceller |
| `COMP_WITHDRAWAL_REQUEST_COMPLETED` | P0001 | cancel of an already co-signed request |

Earlier review-round codes the app must also map if it does not yet: `COMP_WITHDRAWAL_REQUESTER_INVALID` (42501), `COMP_WITHDRAWAL_REQUEST_STALE`, `COMP_WITHDRAWAL_REQUEST_PENDING`, `COMP_WITHDRAWAL_TOO_MANY_PENDING`.

### App-facing change list (packages B / B2)

* `src/lib/competition/results/messages.ts`: add the seven codes above (none is mapped on `cf1/b-app` today).
* `src/app/app/events/[id]/competition/results/actions.ts`: a cancel action calling `cancel_final_withdrawal_request` (request id + reason, same reason validation as withdrawals); surface `replayed`.
* `src/app/app/events/[id]/competition/results/[roundId]/CallbackPanels.tsx` and `.../page.tsx`: a Cancel control on pending requests (requester and other managers/chair), the `stale` flag, and a "cancelled requests" list; disable new withdraw / reinstate controls with the D-A message while the callback has no approved result.
* `src/lib/competition/results/advancement.ts`: the withdrawal-state reader type gains `cancelled` and the pending `stale` flag.
* `src/lib/competition/results/__tests__/wiring.cf1b.test.ts`: assert the new RPC name.

### Re-review of D-A / D-B (no P0/P1) — corrections and accepted residuals

* **Fixed (P2): version binding.** A request now stores `source_result_version_id` (the approved callback result at request time); `_cf1_a6_is_stale(round, advancement_id, generation, version)` is also true when the current approved version differs. This closes the case of a request made against one result and co-signed after another result with a different roster was approved with no apply in between (scenario 13).
* **Accepted (P2): a co-sign racing a correction when no advancement exists.** A0's correction trigger takes no event lock when there is no advancement to revoke, so a co-sign that already passed the roster check can commit its row just after the correction commits. This is equivalent to the withdrawal committing first; completed history is never rewritten and the next apply carries it. Taking the event lock inside the correction trigger would close it and belongs to A0.
* **Fixed (P3):** the cancellations table has a composite FK (request_id, event_id, target_round_id, entry_id) to the request row.
* **Accepted (P3):** cancel-then-re-request has no cap on the `cancelled` list (each cancel needs a manager or chair with a verified email and a substantive reason, and the live-request cap still applies); under REPEATABLE READ / SERIALIZABLE the cancel / co-sign exclusion would need a trigger (Supabase runs READ COMMITTED).
