# CF1 package A1 — contract for downstream packages

Migration `20270120085000_competition_cf1_a1_eligibility_helpers.sql` (rollback in `rollback/`, suite `sql-tests/test_T_competition_cf1_a1_helpers.sql`).
Design: `callback-to-final-advancement-design.md` §4.6, §4.7, A.9.1–A.9.2. A1 adds new objects only; it redefines no existing function.

## Common properties (all functions)

* `SECURITY DEFINER`, `set search_path = public, pg_temp`, **no grant to `public`, `anon`, `authenticated` or `service_role`** (U70). Only another definer function (or a superuser/owner session) can call them; callers outside the database cannot.
* Plain readers: **no locks of their own**, no writes. The answer is only as stable as the caller's locks; callers take the locks (entries `FOR SHARE` in id order, then call in a fresh statement, A.3) and call the helpers *after* their replay branch.
* Volatility: `STABLE` except `_cf1_require_roster_eligible` (`VOLATILE`) and `_cf1_error_codes` (`IMMUTABLE`).
* All of them resolve unknown/null ids to a defined value (never an error): see each row.

## Functions (all in `public`)

| Signature | Returns | Meaning / null handling |
|---|---|---|
| `_cf1_entry_unavailable_reason(p_entry_id uuid)` *(A1 extra)* | `text` or null | First matching reason, else null (available). Order: `entry_missing`, `entry_not_confirmed` (`status <> 'confirmed'`), `entry_ineligible`, `registration_cancelled`, `registration_refunded` (registration `status = 'refunded'`), `registration_payment_failed`, `registration_payment_refunded`, `order_payment_failed`, `order_payment_refunded`. |
| `_cf1_entry_unavailable(p_entry_id uuid)` | `boolean` | Predicate **P** (§4.6). Unknown or null entry → `true`. |
| `_cf1_round_roster_problems(p_round_id uuid)` | `table(entry_id uuid, reason text)` | Entries of **`_compe2_round_entries(round)`** (E2's ranking set, reused, never re-derived) that are unavailable, one row per entry, ordered by `entry_id`. Unknown round → no rows. Once A3 lands, excluded and no-show couples are already outside the ranking set. |
| `_cf1_require_roster_eligible(p_round_id uuid, p_stage text)` *(A1 extra)* | `void` | The shared raiser for the OD-17 D check. `p_stage` ∈ `lock`, `calculate`, `approve` (else `P0001`, message `CF1-A1: unknown roster stage …`). Raises `COMP_ROSTER_ENTRY_UNAVAILABLE`, else (callback Final only) `COMP_ROSTER_BELOW_MINIMUM`. **A2/A3 insert one `perform public._cf1_require_roster_eligible(round, stage)` after their replay branch and locks.** |
| `_cf1_is_callback_final(p_round_id uuid)` | `boolean` | `round_type = 'final'`, the same division's round with `sequence_number - 1` is a `preliminary`, and the program's `advancement_method = 'promote_callback'`. Unknown/null → `false`. |
| `_cf1_count_available_entries(p_entry_ids uuid[])` *(A1 extra)* | `integer` | Distinct, non-null entries in the list that are not P. For apply / start (A0), which count an explicit list. |
| `_cf1_eligible_roster_count(p_round_id uuid)` | `integer` | `_cf1_count_available_entries(_compe2_round_entries(round))`. |
| `_cf1_final_minimum_ok(p_round_id uuid)` | `boolean` | `false` **only** for a callback Final with fewer than two eligible couples; `true` for every other round (Final-only divisions, non-callback programs, unknown round). |
| `_cf1_heat_entry_is_excluded(p_heat_entry_id uuid)` | `boolean` | True for **every** heat entry of an entry that is currently excluded **in that heat's round**. Effective state = the highest-`seq` **co-signed** row (`exclude_cosigned` / `reverse_cosigned`) for `(round, entry)`; requests alone have no effect. Unknown/null → `false`. |
| `_cf1_excluded_entries(p_round_id uuid)` | `table(entry_id, exclusion_id, decision_id, reason_kind, reason, seq)` | One row per currently excluded entry: the effective co-signed row (`exclusion_id` = that row, `decision_id` = the request it completes). Ordered by `entry_id`. |
| `_cf1_error_codes()` | `table(code, sqlstate_code, retryable, raised_by, meaning)` | The A1 catalogue below. |

Predicate P (one definition, §4.6): `status <> 'confirmed'` **or** `eligibility_status = 'ineligible'` **or** the entry's **own** `registration_id` is a registration with `status in ('cancelled','refunded')` or `payment_status in ('failed','refunded')` **or** the entry's **own** `order_id` is an order with `payment_status in ('failed','refunded')`. `partially_refunded` excludes nobody; a refund of one entry inside a still-paid order and an entry with neither link are accepted false negatives until R2.

## Table `public.event_competition_round_exclusions` (insert-only)

Columns: `id`, `event_id` (→ `events`, cascade), `round_id`, `entry_id`, `evidence_heat_entry_ids uuid[]`, `kind` (`exclude_requested`, `exclude_cosigned`, `reverse_requested`, `reverse_cosigned`), `reason_kind` (`ineligible`, `refunded`, `other`), `reason` (3–500 chars after trim), `actor`, `actor_role` (`chair`, `manager`), `at`, `request_id` (unique), `transaction_id`, `seq` (≥ 1, `unique (round_id, seq)`), `decision_id` and `reverses_id` (self FKs, `NO ACTION`).

* Composite FKs `(round_id, event_id)` → rounds and `(entry_id, event_id)` → entries (`NO ACTION`). There is no FK to heats or heat entries (the snapshot is the `uuid[]`).
* CHECKs: `decision_id` is null **iff** `kind` is a `*_requested`; `reverse_requested` requires `reverses_id`; `exclude_*` rows must have `reverses_id` null; `reverse_cosigned` may carry it; a row cannot reference itself.
* RLS **on**, **no policies**, `revoke all` from `public`, `anon`, `authenticated`, `service_role`: **no direct access of any kind**; A5's definer functions are the only writers. A5 assigns `seq` under the round `FOR UPDATE` (max+1) and enforces separation of duties, lifecycle and the `P`-gate (these are **not** in the table).
* History protection: `BEFORE UPDATE OR DELETE` (row) and `BEFORE TRUNCATE` (statement) triggers calling `protect_competition_history_evidence()`, **`ENABLE ALWAYS`** (fire under `session_replication_role = replica`). The only removal is the cascade of deleting the event.
* Index `(round_id, entry_id, seq desc) where kind in (cosigned kinds)` backs the readers.

## Error codes (all `P0001`, permanent; lock timeout / deadlock stay the retryable `55P03` / `40P01`)

| Code | Raised by | Detail |
|---|---|---|
| `COMP_ROSTER_ENTRY_UNAVAILABLE` | A2 lock, A3 calculate/approve via `_cf1_require_roster_eligible` | `detail` = JSON `{stage, round_id, entries:[{entry_id, reason}]}` |
| `COMP_ROSTER_BELOW_MINIMUM` | same (callback Final only) | `detail` = JSON `{stage, round_id, eligible, minimum:2}` |
| `COMP_ADVANCEMENT_BELOW_MINIMUM` | A0 apply, A6 withdrawal | A0/A6 raise it themselves (use `_cf1_count_available_entries`) |
| `COMP_ADVANCEMENT_ROSTER_STALE` | A0 Final-start guard | A0 raises (use `_cf1_entry_unavailable`) |
| `COMP_ADVANCEMENT_ROSTER_INCOMPLETE` | A0 Final-start guard | A0 raises |
| `COMP_EXCLUSION_NOT_DANCED` | A5 | A5 raises |

Only the first two are raised by A1 code. The messages start `CODE: …` like the other competition errors.

## What each package may call

* **A0** (apply, start guard, withdrawal-count): `_cf1_entry_unavailable`, `_cf1_count_available_entries`, `_cf1_is_callback_final`, `_cf1_final_minimum_ok`, `_cf1_eligible_roster_count`, `_cf1_round_roster_problems`.
* **A2** (lock): `_cf1_require_roster_eligible(round, 'lock')` after the replay branch and its own locks; the entry `FOR SHARE` (id order) and the revalidating statement are A2's.
* **A3** (calculate, approve, ranking set, evidence, review): `_cf1_require_roster_eligible(round, 'calculate' | 'approve')`; `_cf1_heat_entry_is_excluded(he.id)` next to the NS1 no-show condition in the six E2 functions; `_cf1_excluded_entries(round)` for the evidence `excludedEntries` branch `'excluded'` and the review `excluded` section.
* **A5** (exclusion functions): the table (insert via its own definer), `_cf1_entry_unavailable` for the `P`-gate, `_cf1_heat_entry_is_excluded` / `_cf1_excluded_entries` for state.
* **A6**: `_cf1_count_available_entries`, `_cf1_final_minimum_ok`.
* **B / C**: no direct calls (no grants); they see the codes above through the A0/A2/A3/A5 RPC errors.

Dependency note: the helpers are plain definer functions called at run time (PL/pgSQL or SQL bodies); `_cf1_round_roster_problems` and `_cf1_eligible_roster_count` call `_compe2_round_entries` at run time, so A3's redefinition (excluded couples leave the ranking set) is picked up with no change here.

## Rollback

`rollback/20270120085000_…_rollback.sql` is the **last** CF1 rollback (CF1 before HL1). It refuses if any exclusion row exists (roll forward only), if any other function body still mentions an A1 helper or the table, or if another table references the exclusion table. Restores state by dropping the 11 functions and the table.
