# CF1 package A0 — contract for downstream packages (A4a, A6, B, C, A2/A3/A5 integration)

Migration `20270120090000_competition_cf1_callback_final_advancement.sql` (rollback in `rollback/`, suites `sql-tests/test_T_competition_cf1_callback_final_advancement.sql` and `test_T_competition_cf1_concurrency.sh`).
Design: `callback-to-final-advancement-design.md` (rev 21) §1–§6, §12, A.2, A.3, A.9. Stack: HL1 → A1 (`20270120085000`) → **A0 (`20270120090000`)**.
Status of this file: **published at the first milestone; names below are final unless a later revision of this file says otherwise.** The "Status / not delivered" section at the end is authoritative for what is and is not implemented.

## Common properties

* Every function is `SECURITY DEFINER`, `set search_path = public, pg_temp`. Tables: RLS **on**, **no policies**, `revoke all` from `public`, `anon`, `authenticated`, `service_role`. History protection (`protect_competition_history_evidence()`, `ENABLE ALWAYS`, row UPDATE/DELETE + statement TRUNCATE) on every evidence table.
* All CF1 foreign keys to entries, rounds, heats, divisions, programs and schedule versions are `ON DELETE NO ACTION ON UPDATE NO ACTION`; the FK to `events` is `ON DELETE CASCADE` (design §4.5 D4, gates U40/U50).
* Errors are `raise exception 'CODE: text'`, SQLSTATE `P0001` unless the table below says otherwise. Retryable: `55P03` / `40P01` (message `COMP_ADVANCEMENT_CONCURRENT_CHANGE` where CF1 maps it). Permanent: everything else.
* Authorizers are **transaction-bound** (`txid_current()`), the codebase pattern:
  * **A-apply** = a row in `event_competition_round_advancements` for the Final round written in this transaction;
  * **A-revoke** = a row in `event_competition_round_advancement_revocations` (for an advancement of that round) written in this transaction;
  * **A-cancel** = an O1 `round_cancelled` row in `event_competition_round_transition_events` for the round written in this transaction.

## Grants

| Object | Grant |
|---|---|
| `competition_round_advancement_preview(uuid)` | `authenticated` |
| `apply_competition_round_advancement(uuid, uuid, uuid)` | `authenticated` |
| `set_competition_round_heat_capacity(uuid, integer, text, uuid)` (new) | `authenticated` |
| `set_competition_round_heat_capacity(uuid, integer)` (legacy, rewritten: always refuses) | unchanged (whatever it had) |
| `_cf1_auth_apply(uuid)`, `_cf1_auth_apply_heat(uuid)`, `_cf1_auth_apply_floor_heat(uuid, uuid, integer)` | `authenticated`, `service_role` (see below) |
| everything else (`_cf1_revoke_advancement`, `_cf1_withdrawn_entries`, `_cf1_callback_target_check`, guard functions, tables) | **none** |

The three `_cf1_auth_*` boolean helpers are granted because the 10D placement trigger `validate_competition_heat_schedule_placement` is an **invoker** function (as it was) and now calls `_cf1_auth_apply`; without the grant a direct write by `authenticated` would fail with `permission denied for function` instead of the original refusal. They read only the caller-visible fact "an advancement row of this transaction exists" and return a boolean.

## Tables (all insert-only, no grants)

| Table | Columns (essential) | Notes |
|---|---|---|
| `event_competition_round_advancements` | `id`, `event_id`, `program_id`, `division_id`, `source_round_id`, `target_round_id`, `generation int ≥ 1`, `source_result_version_id`, `source_input_hash`, `source_trace_hash`, `advanced_count`, `carried_count`, `target_capacity`, `applied_by`, `applied_at`, `request_id` (unique), `transaction_id` (default `txid_current()`) | `unique (source_round_id, generation)`. **Active** = no revocation row. At most one active per source round (deferred constraint trigger `cf1_check_one_active_advancement`). |
| `event_competition_round_advancement_entries` | `advancement_id`, `event_id`, `division_id`, `entry_id`, `tally jsonb`, `carried_withdrawal_id uuid null` | PK `(advancement_id, entry_id)`. The immutable advanced-entry list (copy of the `advanced = true` result rows). `carried_withdrawal_id` ≠ null ⇒ the couple was withdrawn (effective state) at apply: **no heat entry was created**. |
| `event_competition_round_advancement_heats` | `advancement_id`, `event_id`, `heat_id`, `floor_heat_id` | PK `(advancement_id, heat_id)`. Every linked heat was created by apply. |
| `event_competition_round_advancement_revocations` | `id`, `advancement_id` (unique), `event_id`, `revoked_by`, `revoked_at`, `reason`, `cause`, `request_id`, `transaction_id` | `cause` ∈ `source_correction_opened`. No direct revoke exists. |
| `event_competition_final_withdrawals` (**for A6**) | `id`, `event_id`, `target_round_id`, `entry_id`, `seq bigint`, `kind` (`withdraw` \| `reinstate`), `reason` (3–500), `requested_by`, `cosigned_by`, `cosigned_role` (`chair` \| `manager`), `request_id` (unique), `transaction_id` (default `txid_current()`), `heat_entry_id uuid null`, `prior_heat_entry_status` (`scheduled`, `checked_in`, `scratched`, null), `at` | `unique (target_round_id, seq)`. Keyed by **(target round, entry), not by generation**. Effective state of a pair = the row with the highest `seq`. A0 only **reads** it (apply, start guard, correction pre-check) and creates it; **A6 owns every writer**, including assigning `seq = coalesce(max(seq),0)+1` under the Final round `FOR UPDATE`. Composite FKs: `(target_round_id, event_id)` → rounds, `(entry_id, event_id)` → entries, `(heat_entry_id)` → heat entries (`NO ACTION`). `cosigned_by <> requested_by` is a CHECK. |
| `event_competition_round_capacity_events` | `id`, `event_id`, `round_id`, `old_capacity`, `new_capacity`, `reason`, `actor`, `at`, `request_id` (unique), `transaction_id`, `exemption text null` (`f1_raise_to_t`), `target_t int null`, `callback_round_id uuid null`, `callback_round_status text null`, `callback_result_version_ids uuid[] null` | Authorizer of the capacity trigger. |

## Functions

| Signature | Returns | Meaning |
|---|---|---|
| `competition_round_advancement_preview(p_round_id uuid)` | `jsonb` | Manager only (`_compe2_round_role = 'manager'`, verified email). `{state: ready|blocked|applied|revoked|not_applicable, blockers:[{code, detail}], advanced_entries, target_round_id, target_capacity, heats, generation, carried_withdrawals}`. Read-only, no locks. |
| `apply_competition_round_advancement(p_round_id uuid, p_result_version_id uuid, p_request_id uuid)` | `jsonb` `{replayed, advancement_id, generation, heat_id, floor_heat_id, entry_count, carried}` | Manager (+ verified email). Idempotent on `p_request_id` (replay `replayed: true`; reuse with other args `COMP_REQUEST_REUSED`). `set lock_timeout = '5s'` at function level. Lock order: `_compo1_lock_event` → source round → target round → result version `FOR UPDATE` → live schedule version `FOR KEY SHARE` → advanced entries `FOR SHARE` (id order) → revalidation (fresh statement) → inserts. **Takes no heat row.** |
| `_cf1_revoke_advancement(p_source_round_id uuid, p_reason text, p_cause text)` | `uuid` (revocation id) or null | Internal, no grants. Called only by the correction trigger. Cancels every non-cancelled heat of the Final round (A-revoke), writes the revocation row and the `advancement_revoked` event. Takes the Final heats `FOR UPDATE NOWAIT` in id order; **takes no event lock**. |
| `_cf1_withdrawn_entries(p_target_round_id uuid)` (**for A6/B**) | `table(entry_id uuid, withdrawal_id uuid)` | The pairs whose effective state is `withdraw`. No grants. |
| `_cf1_callback_target_check(p_t integer, p_capacity integer)` (**A4a extension point**) | `text` | Returns the error code for an invalid after-state `(T, capacity)` or null. A0: `COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY` when `T > capacity`. **A4a replaces this one function** (`create or replace`, same signature) to add `COMP_CALLBACK_TARGET_BELOW_MINIMUM` for `T < 2`; the guards below raise whatever code it returns. |
| `_cf1_reason_is_substantive(p_reason text)` | `boolean` | 20–500 chars trimmed, ≥ 4 words, ≥ 3 distinct (case-insensitive), not one repeated char/word, not a placeholder. |
| `set_competition_round_heat_capacity(p_round_id uuid, p_capacity integer, p_reason text, p_request_id uuid)` | `jsonb` | New reasoned RPC (B1–B7, F1). Manager + verified email. Lock order: event lock → round `FOR UPDATE`. |
| `set_competition_round_heat_capacity(p_round_id uuid, p_capacity integer)` | `void` | **Rewritten to always raise `COMP_CAPACITY_REASON_REQUIRED`** for every round (OD-14 A), changes nothing, writes no event. |

## Triggers (all `ENABLE ALWAYS` where marked ⚑)

| Trigger (function of the same name unless noted) | Table / event | Refuses |
|---|---|---|
| `cf1_guard_final_heat_insert` ⚑ | heats, BEFORE INSERT | callback Final: null `schedule_version_id`; and, once any advancement exists for the round, any insert unless A-apply. `COMP_ADVANCEMENT_FINAL_HEAT_WRITER` (`42501`) |
| `cf1_guard_final_heat_status` ⚑ | heats, BEFORE UPDATE OF status | advanced Final: any move out of `cancelled` (`COMP_ADVANCEMENT_FINAL_HEAT_REVIVE`); a move into `cancelled` unless A-revoke or A-cancel (`COMP_ADVANCEMENT_FINAL_HEAT_CANCEL`). Pre-advancement `draft/scheduled` callback Final: a revive takes the round `FOR SHARE NOWAIT` and re-reads (`55P03` → `COMP_ADVANCEMENT_CONCURRENT_CHANGE`) |
| `cf1_guard_final_heat_identity` ⚑ | heats, BEFORE UPDATE OF `round_id, division_id, event_id, contest_id, schedule_version_id, floor_heat_id, schedule_block_id` | advanced Final (old or new round): any change unless A-apply. `COMP_ADVANCEMENT_FINAL_HEAT_IDENTITY` |
| `cf1_guard_final_heat_entry` ⚑ | heat entries, BEFORE INSERT OR UPDATE OF `heat_id, entry_id` | callback Final (advanced or not): unless A-apply **and** the entry is in that advancement's list and not carried. `COMP_ADVANCEMENT_FINAL_ENTRY_WRITER`. Status-only updates (scratch/un-scratch) are **not** covered here; A6's `cf1_guard_withdrawn_heat_entry` covers them. |
| `cf1_guard_final_heat_dance` ⚑ | heat dances, BEFORE INSERT OR UPDATE OF `heat_id, dance_id` OR DELETE | advanced Final unless A-apply (event/heat-gone cascade excepted). `COMP_ADVANCEMENT_FINAL_DANCE_WRITER` |
| `cf1_check_final_single_live_heat` | heats, CONSTRAINT TRIGGER AFTER INSERT OR UPDATE OF `status, schedule_version_id, round_id`, deferred | advanced Final with more than one non-cancelled heat in the live version. `COMP_ADVANCEMENT_FINAL_MULTIPLE_HEATS` (`23514`) |
| `cf1_check_one_active_advancement` | advancements, CONSTRAINT TRIGGER AFTER INSERT, deferred | two active advancements for one source round (`23514`) |
| `cf1_guard_publish_final_heats` ⚑ | schedule versions, BEFORE INSERT OR UPDATE OF status | transition into `published`/`live` breaking rule A (`COMP_ADVANCEMENT_PUBLISH_FINAL_HEAT`), rule B (`…_PUBLISH_FROZEN`) or consistency (`…_PUBLISH_INCONSISTENT`); all `23514`. Fires before `compo1_guard_publish_during_run`. Takes the O1 event lock. Closed advancements (target round `cancelled`) are skipped. |
| `cf1_guard_final_start` ⚑ | rounds, BEFORE UPDATE OF status, `scheduled → active` of a callback Final | no active advancement (`COMP_ADVANCEMENT_NOT_APPLIED`); roster completeness (I7, `COMP_ADVANCEMENT_ROSTER_INCOMPLETE`); predicate P / wrong division (`COMP_ADVANCEMENT_ROSTER_STALE`); fewer than two eligible (`COMP_ADVANCEMENT_BELOW_MINIMUM`). Locks (after the event + round locks the start holds): Final heats `FOR SHARE NOWAIT` (id order, cancelled included), their heat entries `FOR SHARE` (scratched included), then the entries `FOR SHARE`; all in id order; then a **fresh statement** revalidates. `55P03` → `COMP_ADVANCEMENT_CONCURRENT_CHANGE`. |
| `cf1_guard_advancement_approval` ⚑ | result versions, BEFORE UPDATE OF status, `calculated → approved` | callback preliminary round with any result row `advanced is null`: `COMP_ADVANCEMENT_BLOCKED` |
| `cf1_guard_advancement_correction` ⚑ | rounds, AFTER UPDATE OF status when `correction_open` becomes true | see "Correction trigger" |
| `cf1_guard_round_capacity` ⚑ | rounds, BEFORE INSERT OR UPDATE OF `configuration` | a change of `max_entries_per_heat` (UPDATE) or a `max_entries_per_heat` key on INSERT unless a capacity-event row of this transaction for this round and value exists. `COMP_CAPACITY_DIRECT_WRITE` |
| `cf1_guard_callback_target_capacity` ⚑ | rounds, BEFORE INSERT OR UPDATE OF `target_advancement_count, configuration, sequence_number, round_type` | F2 arms: T edit, capacity edit, successor insert. Error code = `_cf1_callback_target_check(T, capacity)` |
| `cf1_guard_callback_target_program_lock` ⚑ | programs, AFTER UPDATE OF `profile_locked_at` (null → not null) | F2 publish/lock arm, same check across the program's callback rounds |

Fire order notes: trigger names sort alphabetically; `cf1_*` fire before `comp10d_*`, `compe2_*`, `compf2_*`, `compo1_*` on the same table/event.

## Correction trigger (`cf1_guard_advancement_correction`)

Fires when a round's `status` becomes `ballots_locked` with `correction_open` (edges `calculated|approved|published → ballots_locked`), for a round that is the **callback preliminary** of a Final:

1. successor Final `cancelled` → `COMP_ADVANCEMENT_FINAL_CANCELLED` (with **or without** an advancement; OD-10, gate U84). Aborts the whole F2 correction.
2. With an **active** advancement: old status `published` → `COMP_ADVANCEMENT_PUBLISHED_NEEDS_F3`; Final round not `draft`/`scheduled` or any Final heat `staging/active/complete` → `COMP_ADVANCEMENT_FINAL_STARTED`; any non-cancelled Final heat `lock_state <> 'open'` → `COMP_ADVANCEMENT_FINAL_LOCKED`; then `_cf1_revoke_advancement` (cause `source_correction_opened`).
3. Pre-check (§4.5): any entry of the current roster (active advancement entries, else the latest result version's `advanced = true` rows) minus effective withdrawals that is unavailable by predicate P → `COMP_ADVANCEMENT_CORRECTION_UNRECOVERABLE`.

(The OD-13 cause/co-sign/ballot-correction machinery of §4.1 is **not** in this package; see "Status / not delivered".)

## Pinned redefinitions (md5 of `pg_get_functiondef` with CRs removed, taken from the replayed chain REG→…→HL1→A1; asserted in the preflight; restored in the rollback)

| Function | md5 pin | How |
|---|---|---|
| `complete_competition_round(uuid, uuid)` | `dd0e1cd4c02bb51bbd75471c113a1f9f` | text-replace of the single `advanced is true` refusal: passes when an active advancement of that approved version exists |
| `set_competition_round_heat_capacity(uuid, integer)` | `4fbc864079928710917ea67d7968d8bb` | full replacement (always refuses) |
| `competition_audit_log(uuid, uuid, integer)` | `d38b87512d066907b37702addc6cd116` | text-replace: adds a capacity-events union branch |
| `_comp10d_copy_floor_plan(uuid, uuid)` | `8162a7341b7bcd00a141e81392c8c602` | full replacement: skips heats of a callback Final that has any advancement row; omits a floor heat whose scoring heats were all skipped and renumbers; pre-locks callback + Final rounds `FOR KEY SHARE` in `(division_id, sequence_number)` order |
| `_comp10d_guard_floor_heat()` | `bd20973caffce985813daadde8be947a` | text-replace: floor-heat INSERT authorized by event + live version + append (`_cf1_auth_apply_floor_heat`) |
| `_comp10d_guard_heat_child()` | `9bb78230385387a3c6a39e66f2d9f8d0` | text-replace: first (new-heat) published-version check passes under A-apply |
| `validate_competition_heat_schedule_placement()` | `f2079401a3a92c3289405547d2fe511b` | text-replace: non-draft version passes under A-apply |

Not pinned by A0 (owned by others): `lock_competition_round_ballots` (A2, HL1 pin `6e417534…`), `calculate_/approve_competition_round_*` (A3), the E2 ranking-set functions and `_compf2_evidence` (A3). `_compe2_insert_ballot` is **not** touched in this package (see below).

Also replaced: `event_competition_result_events_kind_check` (adds `advancement_applied`, `advancement_revoked`). A5/A3 packages that add kinds replace it again from this list.

## Error codes raised by A0 (SQLSTATE `P0001` unless stated)

Apply/preview: `COMP_FORBIDDEN` (`42501`), `COMP_REQUEST_ID_REQUIRED`, `COMP_REQUEST_REUSED`, `COMP_ADVANCEMENT_SOURCE_STATE`, `COMP_ADVANCEMENT_ALREADY_APPLIED`, `COMP_RESULT_STALE`, `COMP_ADVANCEMENT_BLOCKED`, `COMP_ADVANCEMENT_TARGET_ROUND_STATE`, `COMP_ADVANCEMENT_NO_LIVE_VERSION`, `COMP_ADVANCEMENT_FINAL_PLACEMENT_MODE`, `COMP_ADVANCEMENT_FINAL_HEATS_PRESENT`, `COMP_ADVANCEMENT_MULTI_DANCE`, `COMP_ADVANCEMENT_BELOW_MINIMUM`, `COMP_ADVANCEMENT_OVER_CAPACITY`, `COMP_ADVANCEMENT_ENTRY_UNAVAILABLE` (detail JSON `{entries:[{entry_id, reason}]}`), `COMP_ADVANCEMENT_FINAL_COMPETITOR_CONFLICT`, `COMP_ADVANCEMENT_FLOOR_HEAT_PROBLEM`, `COMP_ADVANCEMENT_CONCURRENT_CHANGE` (`55P03`/`40P01`, retryable).
Guards: see the trigger table; plus start guard `COMP_ADVANCEMENT_NOT_APPLIED`, `…_ROSTER_STALE`, `…_ROSTER_INCOMPLETE`, `…_BELOW_MINIMUM`.
Correction: `COMP_ADVANCEMENT_FINAL_CANCELLED`, `…_FINAL_STARTED`, `…_FINAL_LOCKED`, `…_PUBLISHED_NEEDS_F3`, `…_CORRECTION_UNRECOVERABLE`.
Capacity: `COMP_CAPACITY_REASON_REQUIRED` (legacy RPC, and missing/blank reason), `COMP_CAPACITY_REASON_WEAK`, `COMP_CAPACITY_FORBIDDEN` (`42501`), `COMP_CAPACITY_RANGE` (B7), `COMP_CAPACITY_ROUND_STATE` (B1), `COMP_CAPACITY_HEAT_STATE` (B2), `COMP_CAPACITY_BALLOTS` (B3), `COMP_CAPACITY_ADVANCED` (B4), `COMP_CAPACITY_CALLBACK_FROZEN` (B5), `COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY` (B6 / F2), `COMP_CAPACITY_F1_NOT_EXACT_T`, `COMP_CAPACITY_F1_CALLBACK_STATE`, `COMP_CAPACITY_F1_BLOCKED_TIE`, `COMP_CAPACITY_DIRECT_WRITE`.

## What A6 must do against this contract

* Insert into `event_competition_final_withdrawals` (kinds `withdraw` / `reinstate`), under the event lock then the Final round `FOR UPDATE`, assigning `seq`.
* **Apply's carried-withdrawal handling (A0):** for every advanced entry whose pair `(target round, entry)` has effective state `withdraw` (via `_cf1_withdrawn_entries`), apply writes the advancement-entry row with `carried_withdrawal_id = <that withdrawal row id>`, creates **no heat entry**, does **not** validate predicate P for it, and does not count it toward the eligible roster; the audit refs list `carried_withdrawals: [{entry_id, withdrawal_id}]`; the roster minimum counts the advanced entries minus carried. Reinstatement after a revoke writes only its own row (OD-18 A); the next apply includes the couple if the corrected callback still advances them.
* The start guard compares the non-scratched Final heat entries with `advancement entries − effective withdrawals`; a direct scratch with no withdrawal row ⇒ `COMP_ADVANCEMENT_ROSTER_INCOMPLETE` (the exit is a withdrawal row against the already-scratched heat entry, `prior_heat_entry_status = 'scratched'`).
* A0's `cf1_guard_final_heat_entry` does **not** see `status` updates. A6's `cf1_guard_withdrawn_heat_entry` (INSERT, UPDATE OF status/entry_id/heat_id, DELETE) owns I8.
* Minimum on withdrawal: use `_cf1_count_available_entries(roster − this entry)` (A1).

## Status / not delivered (authoritative)

See the PR description for the QA matrix. Items the design assigns to A0's neighbourhood but that this package does **not** deliver, with the ownership decision:

* **OD-13 correction machinery (§4.1):** `event_competition_correction_causes`, `event_competition_correction_cosigns`, `event_competition_ballot_corrections`, `cosign_competition_correction`, `_cf1_check_correction_ballot`, the pinned `_compe2_insert_ballot` insertion and the deferred ballot backstop. The A.9.2 A0 row lists the "correction trigger including the cancelled-Final arm", not these; they depend on the F2 exclusion-set derivation (`_compf2_no_show_entries`, scratched heat entries) that A3/A5 touch. Narrowest ownership: **a separate follow-up slice (suggest slot `…096000`, "A0b")**. The correction trigger above is complete without it (the cause-required arm is not part of it).
* **P-1 reader inventory (§3.6)** is a documentation deliverable of the CF1-A PR; not produced here (B owns reader gating); apply must not be enabled in an environment with an ungated reader.
* Gates U7/U46 (hosted grants), U18, U28 and U66 are external to a local SQL run.

## Addenda after the first DB runs (SNAP, supabase_admin)

* **Owners.** The replaced 10D functions keep their original owner (on the SNAP image `_comp10d_copy_floor_plan` and `validate_competition_heat_schedule_placement` are owned by `postgres`, the rest by `supabase_admin`). Section 9b of the migration grants the five `_cf1_*` helpers those functions call (`_cf1_callback_successor`, `_cf1_callback_source`, `_cf1_auth_apply`, `_cf1_auth_apply_heat`, `_cf1_auth_apply_floor_heat`) to those owner roles only, never to `anon`, `authenticated` (except the three `_cf1_auth_*` already listed), `service_role` or `PUBLIC`. A uniform-owner chain makes the block a no-op.
* **Setup guard trigger columns** are `INSERT OR UPDATE OF target_advancement_count, configuration, sequence_number, round_type` (the contract table above is now exact).
* **Template copy (A4a note).** `add_competition_division` copies `target_advancement_count` from a template in one INSERT. With A4a's `2 <= T` lower bound, a template whose callback round has `T = 1` and a Final can no longer be copied.
* **Existing suites that this package changes (test lines belong to the owner of the changed object; not edited by A0):** `test_T_competition_ss1_round_lock.sql` l.156 sets `max_entries_per_heat` by direct UPDATE (now `COMP_CAPACITY_DIRECT_WRITE`); `test_T_competition_ns1_no_show.sql` l.331 pins 4 triggers on `event_competition_heat_entries` (A0 adds `cf1_guard_final_heat_entry`, so 5); `test_T_phase10d_floor_schedule.sql` ~l.374 uses the 2-argument capacity RPC (design-known). `test_T_competition_cf1_a1_helpers.sql` fixtures hand-insert heat entries into a callback Final heat, which `cf1_guard_final_heat_entry` refuses (A1 fixture change needed on composition).

## Addenda after the independent static review (PR #370, M1/M2/L1-L5)

* **M1 (start guard scope).** `cf1_guard_final_start` now also fires for a Final that holds an *active advancement* but is no longer the callback's Final (sequence, round type or advancement method changed after apply): the start is refused with `COMP_ADVANCEMENT_ROSTER_STALE`. The insert and entry arms already keyed on `_cf1_has_advancement(...) OR _cf1_is_callback_final(...)`.
* **M2 (dance slot).** `cf1_guard_final_heat_dance` is now `BEFORE INSERT OR UPDATE OF heat_id, dance_id, status, sequence_number, dance_key OR DELETE`. A status / order / key change of a dance slot of an advanced Final heat is refused (`COMP_ADVANCEMENT_FINAL_DANCE_WRITER`, `42501`) unless it is apply, the correction path (A-revoke) or a round cancel (A-cancel). `cf1_guard_final_start` additionally requires exactly one non-cancelled dance on the single live Final heat, equal (by `dance_key`) to the callback round's one dance: `COMP_ADVANCEMENT_FINAL_DANCE` (`P0001`, detail `{final_dances, source_dances}`).
* **L1.** The postflight loops all six CF1 tables and asserts no privilege for `anon`, `authenticated`, `service_role` (`has_table_privilege` for SELECT, INSERT, UPDATE, DELETE, TRUNCATE) and no `role_table_grants` row for those roles or PUBLIC.
* **L2 (replay of a revoked request).** Replaying the request id of an advancement that has since been revoked raises `COMP_ADVANCEMENT_REVOKED` (`P0001`) instead of returning `replayed: true`. The success shape is unchanged. B must map the new code (the client uses a new request id to advance again).
* **L3.** Apply pre-checks `event_competition_result_events.request_id`: a request id already held by any result event (for example a correction's) raises `COMP_REQUEST_REUSED`, not a raw unique violation.
* **L4.** `apply_competition_round_advancement`, `competition_round_advancement_preview` and the reasoned `set_competition_round_heat_capacity(uuid,integer,text,uuid)` are executable by `authenticated` only (revoked from PUBLIC, anon and service_role; asserted in the postflight).
* **L5 (owner decision: preserved).** After apply, the Final heat lives in the live schedule version; a *new draft schedule version* cannot be published afterwards (rule `COMP_ADVANCEMENT_PUBLISH_FROZEN`: only the version that holds the generated Final can be published). The owner decided to PRESERVE this freeze: publish never copies Final heats into another version. Publishing a different running order goes through the authorized revoke / correction path first; after the revoke the other version publishes and the revoked advancement's audit history (advancement, revocation, `advancement_revoked` event, cancelled Final heat) stays intact. No behaviour change; clarified by suite section 8b (L5 (1)-(3)).
