# CF1 package A5 — contract for downstream packages (B app, C QA, A3 review/evidence)

Migration `20270120094000_competition_cf1_a5_exclusion_action.sql` (rollback in `rollback/`, suites `sql-tests/test_T_competition_cf1_a5_exclusion.sql` and `sql-tests/test_T_competition_cf1_a5_concurrency.sh`).
Design: `callback-to-final-advancement-design.md` §4.7 (OD-20), §4.6 (predicate P, OD-17 D, OD-19 D), A.2/A.3 (writer and lock-order matrices), A.9.2 (package A5).
Depends on A1 (`event_competition_round_exclusions`, `_cf1_entry_unavailable`, `_cf1_heat_entry_is_excluded`, `_cf1_excluded_entries`; see `cf1-a1-contract.md`).
A5 redefines **no** existing function, edits **no** A1 object, writes **no** heat entry / ballot / round / result row, and adds **no** round transition.

## Model

One decision per `(round, entry)`, never per heat entry. A decision is two insert-only rows: a **request** (`exclude_requested` / `reverse_requested`) and its **co-sign** (`exclude_cosigned` / `reverse_cosigned`, `decision_id` = the request row). Only the co-sign takes effect; the effective state of a couple is its highest-`seq` co-signed row (A1's readers). `seq` is unique per round, assigned `max+1` under the round `FOR UPDATE`; gaps never occur in practice (a refused call writes nothing), but readers must only rely on ordering.

* The co-sign row **copies** `reason_kind` and `reason` from its request. A reversal request **inherits** `reason_kind` from the exclusion it reverses (the caller supplies only a reason).
* `reverses_id` of a reversal request and of its co-sign names the **co-signed exclusion row** being reversed.
* `evidence_heat_entry_ids` = ids (ascending) of the entry's heat entries in the round's **non-cancelled** heats, taken at the time each row is written (a snapshot; scratched heat entries included). Statuses are not stored (the column is `uuid[]`).
* Several requests for the same couple may be pending; a request is stale once a later decision for the couple is effective (see `COMP_EXCLUSION_REQUEST_STALE`). There is no "withdraw a request" operation (insert-only); a stale or unwanted request simply never gets co-signed.

## Functions (all `SECURITY DEFINER`, `search_path = public, pg_temp`, `grant execute … to authenticated` only; revoked from `public`, `anon`, `service_role`)

Every call returns `jsonb`: `{replayed, exclusion_id, kind, decision_id, reverses_id, round_id, entry_id, seq, reason_kind, in_effect}`. `exclusion_id` is the row just written (or replayed); the **request's `exclusion_id` is the `p_decision_id` for the matching co-sign call**. `in_effect` is true only for the two co-signed kinds.

| Signature | Who | Writes |
|---|---|---|
| `request_round_exclusion(p_round_id uuid, p_entry_id uuid, p_reason_kind text, p_reason text, p_request_id uuid)` | event **manager** (`_compe2_round_role = 'manager'`) with a verified email | `exclude_requested` |
| `cosign_round_exclusion(p_decision_id uuid, p_request_id uuid)` | **chair** or **manager**, verified email, a different person from the requester, not a replacement-ballot filer of the round | `exclude_cosigned` (takes effect) |
| `request_round_exclusion_reversal(p_round_id uuid, p_entry_id uuid, p_reason text, p_request_id uuid)` | manager, verified email | `reverse_requested` |
| `cosign_round_exclusion_reversal(p_decision_id uuid, p_request_id uuid)` | chair or manager, same rules | `reverse_cosigned` (takes effect) |
| `competition_round_exclusions(p_round_id uuid)` — **A5 extra**, read only | chair or manager, verified email | `{round_id, rows:[{id, seq, kind, entry_id, reason_kind, reason, actor, actor_role, at, decision_id, reverses_id, evidence_heat_entry_ids, completed}]}` in `seq` order |

`competition_round_exclusions` is added because the table has no grants, so a co-signer's UI otherwise cannot list the **pending** requests it must co-sign. `completed` = a co-sign row names this row as its `decision_id`. A3's review `excluded` section covers only the *effective* decisions.

Internal helpers `_a5_cf1_*` have no grants (U70 style). The BEFORE INSERT trigger `cf1_a5_guard_replacement_ballot_filer` on `event_competition_ballots` is described below.

### Decision flow for B

1. Manager: `request_round_exclusion(round, entry, 'ineligible' | 'refunded' | 'other', reason, request_id)` → show `exclusion_id` as the pending decision.
2. Chair or another manager (never the requester): `cosign_round_exclusion(exclusion_id, new_request_id)`.
3. After the cause is corrected (so P is false): manager `request_round_exclusion_reversal(round, entry, reason, request_id)`, then co-sign with `cosign_round_exclusion_reversal(reversal_exclusion_id, new_request_id)`.

A request id is single-use across **all four functions and all kinds** (`unique (request_id)`). Generate a fresh uuid per call; reuse the **same** uuid to retry a call whose answer was lost (see replay).

## Rules each call enforces (in this order)

1. Authentication and role (before any lock): no user, unknown round / decision, or insufficient role → `COMP_FORBIDDEN` (`42501`; unknown ids give the same answer as no-permission). Missing verified email → `COMP_VERIFIED_EMAIL_REQUIRED` (`42501`). Missing request id → `COMP_REQUEST_ID_REQUIRED`. Request functions validate `reason_kind` (`COMP_EXCLUSION_REASON_KIND`) and the trimmed reason length 3–500 (`COMP_EXCLUSION_REASON_REQUIRED`). Co-sign functions refuse a decision of the wrong kind (`COMP_EXCLUSION_DECISION_KIND`).
2. Locks (A.3, the order of `change_competition_entry_lifecycle`): event advisory lock `_compo1_lock_event` → round `FOR UPDATE` → entry `FOR SHARE` → the couple's heat entries (the round's non-cancelled heats) `FOR SHARE` in id order. Lock waits are unbounded (no function `lock_timeout`), like E2's reopen; deadlock would surface as `40P01` (none observed, see the QA matrix).
3. **Replay** (after the round lock, before every state check, like NS1/E2): a row with this `request_id` that matches the call (same kind, actor, round, entry, reason (kind), or same decision for a co-sign) → the same result with `replayed: true`, no new row. Any other use of the id → `COMP_REQUEST_REUSED`. A cross-round unique-violation race is mapped to `COMP_REQUEST_REUSED` too.
4. Lifecycle: round status must be `active` or `ballots_locked` (`COMP_EXCLUSION_WINDOW`; from `calculated`/`approved` the manager first uses the F2 correction, §4.6 route 4) **and the round must have no publication row** (`COMP_EXCLUSION_PUBLICATION_EXISTS`): if `event_competition_result_publications` exists, any row for the round (withdrawn included) refuses; an unreadable shape refuses (fail closed); if the table does not exist (F3 absent) nothing can exist. This is release blocker **RB2**: until F3 provides its withdraw/supersede exit, a published round cannot be excluded-from or reinstated.
5. Separation of duties (co-signs): requester ≠ co-signer (`COMP_EXCLUSION_COSIGN_SAME_PERSON`); the co-signer has not filed a **replacement ballot** (`supersedes_id` not null) in the round as `submitted_by`, as the judge (`official.user_id`) or as the entering scorer (`COMP_EXCLUSION_COSIGNER_FILED_BALLOT`). `actor_role` records `chair` or `manager` from `_compe2_round_role` (a person who is both is recorded `manager`). A request that already has a co-sign row → `COMP_EXCLUSION_DECISION_COMPLETED`.
6. Per-request state (re-evaluated at **both** request and co-sign time; the co-sign is a fresh decision):
   * exclude: the entry belongs to the round's event and has a heat entry in a non-cancelled heat of the round (`COMP_EXCLUSION_ENTRY_NOT_IN_ROUND`); the couple **danced** by the heat (`COMP_EXCLUSION_NOT_DANCED`): a non-scratched, non-NS1-no-show heat entry in a heat that HL1 reads as danced (`_hl1_heat_is_danced`: `active`/`complete`, or a `danced`/`disqualified` placement); the heat entry's own status need not read `danced`; not already excluded (`COMP_EXCLUSION_ALREADY`); **P currently true** (`_cf1_entry_unavailable`, `COMP_EXCLUSION_NOT_UNAVAILABLE`).
   * reverse: the couple is currently excluded (`COMP_EXCLUSION_NOT_ACTIVE`); **P currently false** (`COMP_EXCLUSION_STILL_UNAVAILABLE`: a still-refunded or still-ineligible couple cannot be reinstated). At co-sign the request must still name the couple's effective exclusion (`COMP_EXCLUSION_REQUEST_STALE`).
   * co-sign of an exclusion: `COMP_EXCLUSION_REQUEST_STALE` if a later decision for the couple is already effective.

## Replacement-ballot trigger (A5 addition, not in the A.9.2 list; flagged)

`cf1_a5_guard_replacement_ballot_filer` (BEFORE INSERT on `event_competition_ballots`, `WHEN` evaluated inside: `supersedes_id is not null`) raises `COMP_EXCLUSION_COSIGNER_CONFLICT` when the filer (`submitted_by`, or the judge's / entering scorer's user) already co-signed an exclusion decision of that round. This is the second half of "never anyone filing a replacement ballot" (the co-sign call checks the filers that exist *now*; the trigger covers filers *later*). Ballot filing holds the round `FOR SHARE` (E2) and the co-sign holds it `FOR UPDATE`, so the two are serialized. It reads the exclusion table only for replacement ballots; original ballots are untouched. B should map the code on the correction-ballot screen. **A3 note**: because A3/CX1 will add their own replacement-ballot checks (`_cf1_check_correction_ballot`), they need not repeat this one.

## Error codes (all `P0001` unless noted)

`COMP_FORBIDDEN` (`42501`), `COMP_VERIFIED_EMAIL_REQUIRED` (`42501`), `COMP_REQUEST_ID_REQUIRED`, `COMP_REQUEST_REUSED`, `COMP_EXCLUSION_REASON_KIND`, `COMP_EXCLUSION_REASON_REQUIRED`, `COMP_EXCLUSION_WINDOW`, `COMP_EXCLUSION_PUBLICATION_EXISTS`, `COMP_EXCLUSION_ENTRY_NOT_IN_ROUND`, `COMP_EXCLUSION_NOT_DANCED` (A1's catalogue code), `COMP_EXCLUSION_NOT_UNAVAILABLE`, `COMP_EXCLUSION_ALREADY`, `COMP_EXCLUSION_NOT_ACTIVE`, `COMP_EXCLUSION_STILL_UNAVAILABLE`, `COMP_EXCLUSION_DECISION_KIND`, `COMP_EXCLUSION_DECISION_COMPLETED`, `COMP_EXCLUSION_REQUEST_STALE`, `COMP_EXCLUSION_COSIGN_SAME_PERSON`, `COMP_EXCLUSION_COSIGNER_FILED_BALLOT`, `COMP_EXCLUSION_COSIGNER_CONFLICT` (trigger). Lock timeout / deadlock stay the retryable `55P03` / `40P01`. Messages start `CODE: …` like the other competition errors; none carries personal data.

## What an excluded couple means downstream

A5 only records decisions. The ranking-set effect comes from A3's readers (`_cf1_heat_entry_is_excluded`, `_cf1_excluded_entries`); until A3 is composed, an effective exclusion changes nothing in E2/F2 (U76's lock refusal is therefore **BLOCKED** in the A5 suite). An exclusion or a reversal after judges submitted makes ballots stale (E2 stale-ballot rule); heat entries, ballots and marks are never edited.

## Decisions made while implementing (for the coordinator)

* **Requester = manager only** (design §4.7: "the requester is an event manager"); the **co-signer = chair or manager**. A chair cannot request.
* **Verified-email rule** applied to requester and co-signer like NS1 (the role helper only enforces it for chairs).
* **Pending requests are not exclusive** and have no expiry; staleness is decided at co-sign (see rules). This avoids a permanently stuck couple (requests are insert-only and cannot be cancelled).
* **Reversal `reason_kind`** is inherited (the column is NOT NULL and the design gives the reversal no kind).
* **Danced** additionally excludes scratched and NS1 no-show heat entries (a scratched/no-show couple did not dance; they use scratch / NS1) — the design text only names the heat rule.
* **Cancelled heats** are ignored for both "danced" and the snapshot (E2's `_compe2_round_heats` ignores them too).
* **Read function** `competition_round_exclusions` and the **replacement-ballot trigger** are additions to the four functions A.9.2 lists (reason above).
* `_compo1_lock_event(event)` is taken first as A.3 specifies; it is an advisory lock shared with O1 writers, so a long O1 transaction on the same event delays an exclusion (and vice versa), never deadlocks (both take the event lock first).

## Limits / not covered

* **Refund inputs are not locked** (registration / order rows): P can change between the check and the commit (the A1 caveat). The window is the same as for lock/approve; approve is the last check. Both request and co-sign re-check P.
* **No unique "one open request per couple"** and no database constraint ties `decision_id`/`reverses_id` to `(round, entry, kind)`; only these functions write the table, and the QA suite asserts consistency of every row they wrote.
* **Superuser / table owner** can still write the table (the A1 triggers refuse UPDATE/DELETE/TRUNCATE even in replica mode, not INSERT).
* The lock refusal when an exclusion drops a callback round to `T` or fewer (U76) and the exits "cancel the round" (O1) are not exercised in the A5 suite (A3 not composed; the fixture heat is active).

## Rollback

`rollback/20270120094000_…_rollback.sql` is position 2 (A6 first; A3, A2, A4a, A0, A1 after). It takes `ACCESS EXCLUSIVE` on the exclusion table, refuses if any exclusion row exists (roll forward only), refuses while another function body still mentions an A5 name, then drops the trigger and the functions. A1's rollback additionally refuses while A5 functions exist (they mention the table).

## Review follow-ups (independent review, no P0/P1)

* **P2 fixed:** a co-signer who holds a judge letter on the round's panel is refused up front (`COMP_EXCLUSION_COSIGNER_FILED_BALLOT`), so the replacement-ballot trigger can never trap a round by blocking a judge who co-signed.
* P3 fixed: missing round after the lock, non-request-id unique violations no longer masked as `COMP_REQUEST_REUSED`, one snapshot array both locked and stored, `published`/`live` schedule-version filter (as `_compe2_round_heats`), rollback regex written `E'\m'`.
* ~~Open note~~ superseded in round 2: `reason_kind` is now cross-checked (L2) and the design 4.1 vs 4.7 conflict is settled by the A7-1 decision.
* Helper names use the prefix `_a5_cf1_` (not `_cf1_`) because A1's suite asserts properties of every `_cf1_%` function.

## Review round 2 (coordinator static review of PR #367)

* **M1:** the co-sign pre-check now refuses a co-signer who holds **any** panel assignment on the round (judge letter or scorer), or who filed/entered/owns a replacement ballot, matching the users the replacement-ballot trigger blocks. **Converse (not blocked):** a person assigned to the panel *after* they co-signed is not stopped; if they later try to file a replacement ballot the trigger refuses it (`COMP_EXCLUSION_COSIGNER_CONFLICT`) and another judge/scorer must file or the judge be marked absent. B should avoid assigning a round's co-signer to its panel.
* **L1:** a reason needs at least three **visible** characters at request, reversal request and co-sign (whitespace, NBSP, zero-width space/joiners, word joiner and BOM do not count); max 500 after trimming. A1's table check (`btrim` length 3–500) is looser; tightening it is an A1 follow-up for the coordinator to route.
* **L2:** `reason_kind` must match the real cause at request and co-sign (`COMP_EXCLUSION_REASON_MISMATCH`): `ineligible` needs A1's `entry_not_confirmed`/`entry_ineligible`; `refunded` needs a registration/order refund-or-cancel reason; `other` only needs P true. A1 reports the **first** matching reason, so a couple that is both ineligible and refunded is recorded `ineligible` or `other`. A reversal inherits the kind.
* **L3:** all four functions lock the round's non-cancelled heats `FOR SHARE` in id order after the entry and before the heat entries (compatible with E2 lock-ballots' heats → heat entries order).
* **A7-1:** the owner decided a new exclusion is refused while a ballot correction is open; A7 (PR #375) implements it as a trigger on the exclusion table. A5 implements none of it and no A5 test assumes the opposite; the earlier "design §4.1 vs §4.7" open note is superseded by that decision.
* **Limits (reviewer P3s, documented, not changed):** the visible-character check strips `[[:space:]]` plus NBSP, U+200B-200D, U+2060 and BOM. Other invisibles (LRM/RLM, soft hyphen, Hangul filler, U+2028/9) are not stripped, and non-ASCII spaces such as U+3000 depend on the database locale for `[[:space:]]`. It guards against accidental empty reasons; it is not a hostile-input filter. **Co-sign re-check:** the reason kind is re-validated against the cause as of the co-sign, so if the cause shifts between request and co-sign (e.g. ineligible to refunded) an `ineligible`/`refunded` request cannot be co-signed and must be re-requested; only `other` survives while P holds.
