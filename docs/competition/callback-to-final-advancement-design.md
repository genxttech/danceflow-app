# Competition OS — Callback → Final advancement (CF1 design)

Status: **DESIGN ONLY, DRAFT for coordinator/owner review.** Docs, Git-only: no app code, no SQL, no migration. Baseline: branch `competition-hl1-heat-lock` @ `ca6c0b8d` (HL1, PR #350), which stacks REG #338 → F2 #339 → SS1 #344 → CX1 #347 → HL1. Migration slot proposed: `20270120090000` (verified free on every `origin/competition-*` / `claude/*` branch at authoring time; 0119 is HL1).

Nothing here changes an approved rule. Where an approved rule is silent this document says so, lays out options, recommends one, and lists it in §9 as an **OPEN owner decision**. Competition OS is not discussed with outsiders.

## 0. Problem and verified facts

QA-A (PR #341, `docs/qa/competition-qa-sut6-prod-acceptance-2026-10-30.md`) ran the callback half once: SCN-0c, 1.3, 11.1, 11.2, 11.3a, 11.3 PASS (exactly `T=2` couples advance); **SCN-11.4 (tie at the callback line) and SCN-11.5 (the Final is built from the advanced couples and judged in one heat) are NOT RUN**: "no screen creating the Final's heat was found".

Facts verified in the HL1 tree (file → what it establishes):

| # | Fact | Source |
|---|---|---|
| F-1 | `apply_competition_round_advancement` is named by K0 §6 and referenced by F2, but **does not exist**. | `grep` of `src/lib/supabase/migrations` (only F2 header/comment mentions) |
| F-2 | F2 `complete_competition_round` refuses a round whose approved result has any `advanced is true` row (`COMP_ADVANCEMENT_NOT_APPROVED`) until advancement is applied. It also needs an F3 publication, and F3 is not built, so no round can complete today. | `20270114090000_…f2_results_lifecycle.sql` ~l.1164 |
| F-3 | F1/F2 engine output carries `advanced` per row; the engine sets **no** `advanced` on any row when a tie exceeds the Final's capacity (`tie_over_capacity`). F2 `calculate` accepts `advanced` boolean-or-null. `finalCapacity` in the evidence is the next round's `configuration.max_entries_per_heat`, default 8. | `callback_tally@1` spec §4/§5; F2 `_compf2_evidence`, calculate row validation |
| F-4 | Entries are **division-level** (`event_competition_entries`); a round has no entry table. A round's entries are the entries on its heats (`event_competition_heat_entries`). The Final's roster is therefore "heat entries of the Final's heat(s)", pointing at the same `entry_id`s. | foundation v1 l.136, l.203; F2 `_compf2_evidence`; E2 `_compe2_round_entries` |
| F-5 | **There is no path to build a later round's heats during a running event.** (a) The heat planner plans only the division's *first* round. (b) `apply_competition_floor_plan` works on a *draft* schedule version with no heats. (c) Floor heats, heat entries and heat dances of a *published* version are frozen (`comp10d_guard_floor_heat`, `comp10d_guard_heat_entry`, `comp10d_guard_heat_dance` → `COMP10D_SCHEDULE_PUBLISHED`). (d) Publishing a new version is refused once any heat is `staging/active/complete` (`COMPO1_RUN_IN_PROGRESS`), and copying a plan resets heats to `scheduled`. (e) `schedule_competition_round` and `start_competition_round` need the round's heats in the live published version. | 10D `20261111090000`; O1 `20270106090000` ll.217–360; `floorPlanner.ts` l.136 |
| F-6 | The Final is single-heat by design: `studio_ordinal_majority@1` is a single-heat method (X-7); readiness reports `COMP_ORDINAL_MULTI_HEAT` if the Final has more than one heat. | `studioReadiness.ts` l.149–151; `studioSetup.ts` header |
| F-7 | Round status edges are a static list; there is **no** edge back to `draft` (e.g. `scheduled → draft`), and `sequence_number`, `round_type`, `scoring_method` are frozen once the program is locked. `unique (division_id, sequence_number)`. | O1 `_compo1_guard_round_status`; SS1 `20270116090000` |
| F-8 | F2 `open_competition_round_correction` is allowed from `calculated/approved/published`; it refuses (O5) only if a later round of the division holds **any ballot**, row-locking later rounds first. It invalidates live versions (`result_invalidated`). | F2 ll.1190–1240 |
| F-9 | `advancement_method` is frozen at publish (SS1 #344), and the callback engine accepts a round only if round_type `preliminary` and program `advancement_method = promote_callback`. | SS1 `20270118090000`; `studioReadiness.ts` l.141 |
| F-10 | Approval certifies every locked heat of the round through `set_competition_heat_lock_state(..., 'certified')`; certified heats are never reopened. HL1 added reopen/lock guards for earlier states. | F2 `approve_competition_round_result`; HL1 header |

**Two findings that change the shape of the work** (they are not in the coordinator's brief):

1. **F-5**: even with a perfect advanced-entry list, nothing can create the Final's heat after the callback is danced. CF1 must include a *controlled, audited* way to add a heat to the live running order. This is the largest design risk in CF1.
2. **P5 leak**: K0 P5 says unpublished results are never readable outside result managers. A Final heat that lists the advanced couples reveals the callback result as soon as it exists, possibly before F3 publication. See §3.6 and OD-6.

## 1. Advancement record, RPC, trigger, audit, immutability

### 1.1 Rule (K0 §6, D-CT-10)

Next-round heats are created **only** from a round in `approved` or later, by `apply_competition_round_advancement`. D-CT-10: nothing is carried into the Final (the tally is staff information); the Final starts clean, from the advanced *set* only.

### 1.2 Data model (all insert-only, composite FKs `(id, event_id)`, history-protection trigger like E2/NS1)

| Table | Columns (essential) | Notes |
|---|---|---|
| `event_competition_round_advancements` | `id`, `event_id`, `program_id`, `division_id`, `source_round_id`, `target_round_id`, `generation` (1,2,…), `source_result_version_id`, `source_input_hash`, `source_trace_hash`, `advanced_count`, `target_capacity` (value read at apply), `applied_by`, `applied_at`, `request_id` (unique), `transaction_id` | One row per application. `unique (source_round_id, generation)`. "Active" = has no revocation row. At most one active per source round, enforced under the round row lock and by a deferred constraint trigger. |
| `event_competition_round_advancement_entries` | `advancement_id`, `entry_id`, `tally` (copied from the result row `output`, informational only) | `unique (advancement_id, entry_id)`; FK `(entry_id, division_id, event_id)`. This is the immutable **advanced-entry list**; it is a copy of the result rows with `advanced = true`, frozen so a later change in live data cannot rewrite what was advanced. |
| `event_competition_round_advancement_heats` | `advancement_id`, `heat_id`, `floor_heat_id` | Links the heats CF1 created. |
| `event_competition_round_advancement_revocations` | `advancement_id` (unique), `revoked_by`, `revoked_at`, `reason`, `cause`, `request_id`, `transaction_id` | Same pattern as NS1 voids: UPDATE is blocked, so a revoke is its own row. |

Audit: two new fixed kinds in `event_competition_result_events` — `advancement_applied`, `advancement_revoked` — added by replacing `event_competition_result_events_kind_check` (K0 §8: kinds are fixed by the contract, never caller-supplied). Each row carries `refs {advancement_id, generation, source_result_version_id, entry_count, heat_ids, request_id}`. `competition_audit_log` (F2 unified audit) then picks them up with no change to the reader. `contract.ts` `RESULT_EVENT_KINDS` and K0 §3/§6 are updated in the same implementation PR.

### 1.3 RPCs (SECURITY DEFINER, `set search_path = public, pg_temp`, `authenticated` only, never `anon`)

| RPC | Actor | Purpose |
|---|---|---|
| `competition_round_advancement_preview(p_round_id)` read | manager (`_compe2_round_role = 'manager'`; chair/scorer **no**) | Returns the approved version, the advanced list, state `ready / blocked / applied / revoked`, blockers (tie over capacity, capacity, unavailable entries, target round not eligible), target round and its heats. Never returns data to non-managers (P5). |
| `apply_competition_round_advancement(p_round_id, p_result_version_id, p_request_id)` | manager | Applies the approved version: writes the advancement, entries, **creates the Final's heat** (§3), writes the audit row. Idempotent on `p_request_id` (replay returns `replayed: true`; reuse with other args → `COMP_REQUEST_REUSED`). |
| `_cf1_revoke_advancement(...)` | **internal only, no grants** | Called by the correction trigger (§4). A manager has no direct revoke: the only way to undo an advancement is the existing, reasoned, audited correction path. |

**Who triggers:** an explicit manager action ("Advance to Final") from the results review, after approval. Not automatic at approve (keeps F2's approve a single-purpose writer, one writer per transition, and lets the manager see the preview first); not coupled to publication (F3 does not exist and K0 §6 says `approved or later`). Recommendation; OD-4.

**Preconditions (all raise a stable `COMP_ADVANCEMENT_*` error; first failure wins):**

1. Caller is a manager of the event; request id present.
2. Source round: `status in ('approved','published')`, `round_type = 'preliminary'`, program `advancement_method = 'promote_callback'`, scoring pin = `studio_callback_tally@1`.
3. `p_result_version_id` is the round's **latest `approved`** version, and its `input_hash` still equals the hash rebuilt from current ballots (`COMP_RESULT_STALE`, same check as F2 approve).
4. **No result row has `advanced is null`.** This is the SQL-checkable form of "blocked" (the engine never sets `advanced` when blocked). Refused with `COMP_ADVANCEMENT_BLOCKED` (see §2: such a version should never reach `approved`; this is the second layer).
5. Target round = the division's round with `sequence_number = source + 1`, `round_type = 'final'`, status `draft` or `scheduled`, **no non-cancelled heats**, same program/division/event.
6. Advanced count `> 0` and `≤` the target's **live** capacity (`configuration->>'max_entries_per_heat'`, default 8), re-read at apply, not trusted from the calculation (capacity is editable until the Final starts). Otherwise `COMP_ADVANCEMENT_OVER_CAPACITY`. This also covers `T > capacity` with no tie, which D-CT-4 does not address and the engine does not check (callback spec §11); it is required by F-6 (single-heat Final). OD-2.
7. Every advanced entry is still `confirmed` and not `ineligible` and has no active refund exception that blocks participation. Otherwise `COMP_ADVANCEMENT_ENTRY_UNAVAILABLE` listing the entries. No substitution (see OD-5).

**Immutability.** An advancement never changes. Its only end is a revocation row (§4). The Final's membership after apply changes only through the existing scratch/no-show flows on the Final's heat (SC1, NS1), which exclude the couple from the Final calculation (X-5). A scratched couple is **not replaced** by the next-ranked couple (that would be a manager-style selection that D-CT-4 rejects, and D-CT-10 carries nothing forward).

### 1.4 Interaction with F2 states

| Event | Effect on advancement |
|---|---|
| calculate (new version) | No advancement exists before approval, so none to affect. |
| approve | Certifies callback heats (F2/F-10). A **blocked** callback result cannot be approved (§2.4). |
| apply | Allowed only from `approved`/`published`; the callback round status is **not** changed by apply (O1/F2 own those edges). |
| stale / `COMP_RESULT_STALE` | Any new ballot after calculation stales the version; apply refuses a stale hash. |
| open correction (calculated/approved/published → ballots_locked) | §4: active advancement is revoked **in the same transaction** (or the correction is refused). |
| `complete_competition_round` | CF1 changes only the F2 advancement check: it must pass when an **active** advancement exists for the approved version (today it refuses forever). It still needs F3 publication. Implemented by pinned text-replace of the single block (see §6), not a rewrite. |

### 1.5 `set_competition_heat_lock_state` and heat locks

CF1 never calls `set_competition_heat_lock_state` and never touches a callback heat (they are certified; certified heats are immutable). The Final's heat is created `open`/`scheduled`; HL1's early lock/reopen applies to it like any heat. Revocation (§4) refuses unless every Final heat is `lock_state = 'open'` (`COMP_ADVANCEMENT_FINAL_LOCKED`): the manager reopens it first (HL1, with reason), which is an existing audited step. CF1 does not add a new lock mode.

## 2. Tie at the cut-off (SCN-11.4)

Approved (D-CT-4, 2026-10-24): advance **all** tied couples when the Final can safely accommodate them (count ≤ the Final's 10D capacity); if it would exceed that capacity, **no manager-picked advancement**, a separately approved, auditable tie-break process is required, and advancement stays **blocked** until that process is specified and completed. A callback runoff is a **candidate only**. Manager decision (c) is **rejected**.

So there are two sub-cases:

* **2a. Tie, count ≤ capacity: approved, automatic.** All tied couples advance (F-CT-02, `cap ≥ 5`). Final has more than `T` couples. No new rule.
* **2b. Tie, count > capacity: no approved rule.** Options:

| Option | What happens | Consequence for SCN-11.4b | Verdict |
|---|---|---|---|
| A. All tied advance anyway | Final heat holds `> capacity` couples | Contradicts D-CT-4 ("if that would exceed the approved floor capacity…"); the single-heat Final then breaks F-6 (`COMP_ORDINAL_MULTI_HEAT`) or needs a bigger floor than approved | **Not permitted** by D-CT-4 |
| B. None of the tied advance (only couples strictly above the cut) | Final has `< T` couples | Penalizes every tied couple equally but silently under-fills; it is an invented rule (no source, not in D-CT-4), and shrinks the Final below the organizer's `T` | Needs owner approval; not recommended |
| C. Runoff among tied couples | Judges rank/recall only the tied set in an extra step, then advance by the runoff result | Possible, but requires a new ballot format, a new tie-break engine step or version (`callback_tally@2`), panel/judge availability rules, a rule for a tie *inside* the runoff, and a place in the round sequence (frozen after lock, F-7). Needs its own spec, K1 verification and owner approval | **Candidate only**; a separate slice (CF2) after approval |
| D. Fail closed (current behavior, kept) | Calculation completes with no `advanced` flags; the round **cannot be approved**, nothing advances; the manager sees `tie_over_capacity` and the tied entries | SCN-11.4b becomes a **negative acceptance test**: the system refuses and no manager pick exists. SCN-11.4a (within capacity) is a positive test | **Recommended for CF1**, because it is exactly the approved state ("advancement remains blocked") |

**Recommendation:** ship CF1 with option **D**, and open **OD-1** (owner chooses the over-capacity process; the doc recommends commissioning a runoff spec C only if the owner wants a path forward). CF1 must make "blocked" actually blocking:

* **2.4 Approval gate.** Today a calculated callback result with every `advanced` null can still be approved (and then completed, since F2's completion check looks only for `advanced is true`). That would let a round "finish" with nobody advancing. CF1 adds a BEFORE UPDATE OF `status` trigger on `event_competition_result_versions` (calculated → approved): for a round with `round_type='preliminary'` and program `advancement_method='promote_callback'`, refuse with `COMP_ADVANCEMENT_BLOCKED` when any row has `advanced is null`. Additive trigger; no redefinition of F2 `approve_competition_round_result`.
* **Ways out of a blocked tie that already exist and are *not* manager picks:** a corrected ballot version through the correction path (CX1/K0 P1) if a judge made an error, or changing the Final capacity before recalculation. **The second is a risk:** raising `max_entries_per_heat` after ballots exist makes the tie "fit" and so lets a manager route around D-CT-4's "approved floor capacity". OD-3 asks whether capacity edits after callback ballots exist must be blocked or reason-audited. Recommendation: audited reason required (the 10D setter has no reason today), and the apply/calc both use the capacity value recorded at calculation, flagging a change.

Mapping: SCN-11.4 splits into **11.4a** (tie within capacity → all advance, Final holds `T+k` couples) and **11.4b** (tie over capacity → `tie_over_capacity`, approve refused, `apply` refused, no manager override control exists in UI or RPC).

## 3. Building the Final's heat (SCN-11.5)

### 3.1 What can be reused

| Component | Reuse? | Why |
|---|---|---|
| `heatPlanner.ts` / `floorPlanner.ts` (pure planners) | Capacity and dance logic only | They plan a whole draft schedule from first rounds; they do not model a single late heat. The Final is one heat (F-6), so no packing is needed: one scoring heat, `floor_order` = ascending `entry_id` (deterministic; see OD-7 for display order). |
| `apply_competition_floor_plan` | **No** | Draft-only, whole-version, refuses when heats exist (F-5b). |
| `_comp10d_copy_floor_plan` | **No** | Resets to `scheduled`, needs a draft version, refuses during a run (F-5d). |
| 10D integrity triggers (`comp10d_heat_*_floor_integrity`: competitor conflict, incompatible music) and `_comp10d_scoring_heat_duplicate` | **Yes, unchanged** | They fire on the rows CF1 inserts and remain the authority. |
| 10D capacity rule | Yes | Same `max_entries_per_heat` source as F2's `finalCapacity`. |

### 3.2 The running-order problem and the proposed controlled exception (OD-3a / OD-8)

Because of F-5(c)(d), the only ways to give the Final a heat in the live published version are (i) a new CF1 definer path that inserts into the live version under an explicit audited authorization, or (ii) relaxing the 10D freeze or the O1 run guard generally. (ii) is rejected: it weakens guards that protect every other round. Option (iii), pre-creating empty "shell" Final heats at planning time, does not work either because assigning entries to a heat of a published version is also frozen (F-5c) and the planner would have to be redesigned.

**Proposal (i):** `apply_competition_round_advancement` inserts, in one transaction: one `event_competition_floor_heats` row appended at `max(heat_number)+1` of the live version, one `event_competition_heats` row (`round_id` = Final, `status 'scheduled'`, `schedule_version_id` = live version, `floor_heat_id` = the new floor heat, `heat_number` = `max(heat_number over the round, including cancelled)+1`), the `event_competition_heat_dances` copied from the callback round's heats (X-6: one dance per result, so a multi-dance callback round fails closed `COMP_ADVANCEMENT_MULTI_DANCE`, OD-9), and `event_competition_heat_entries` for each advanced entry. The three 10D freeze guards need a **narrow authorization**, using the codebase's existing pattern: the guard allows the write only if an `event_competition_round_advancements` row with `transaction_id = txid_current()` for that heat's round exists (same idea as `event_competition_heat_lock_events` and NS1/`result_events` `transaction_id` checks). The guards are additively redefined (they are small; implementation pins the installed md5s) or extended by a second BEFORE trigger. Then the 10D deferred integrity triggers run at commit.

Consequences that need acceptance:

* The published **snapshot** (`event_competition_schedule_publications.snapshot`, checksummed) is point-in-time and will not contain the Final heat. Public/entrant schedule readers that render from the snapshot will not show it; those that read live heats will. OD-3b: add a supplemental publication record, or document that the Final is a day-of addition shown by the live floor/day-of views only.
* Appending at the end of the order is the only option without renumbering a published version. OD-3a: the owner may want the Final placed after the callback heat; that needs renumbering and is not proposed.
* The heat is a normal `scheduled` heat after creation; `schedule_competition_round` (draft → scheduled) and `start_competition_round` remain the only writers of the Final round's status, unchanged. CF1 does not add an edge.

### 3.3 Scratches and no-shows (NS1/SC1)

* Callback scratches/no-shows (X-5) never advanced: they are excluded from the engine input, so `advanced` is not true for them. Not re-checked.
* Between approval and apply, an advanced entry may become `ineligible`/refunded: apply refuses with the list (precondition 7). Resolution is the existing audited official/refund-exception process (K0 §4.1), then retry; no silent shrink, no backfill. OD-5 asks whether the owner prefers "build the Final without them and list them".
* After apply, scratch and no-show on the Final heat use the existing SC1/NS1 flows; the Final calculation excludes them (X-5). There is **no alternate list** (D-CT-10).

### 3.4 Capacity

Re-read at apply (precondition 6). The Final must be one heat; if `count > capacity` apply refuses. Revalidated live because capacity can be edited after calculation (OD-3).

### 3.5 Locking of the Final heat

Created `open`. HL1 early lock and reopen rules apply as they do to every heat. CF1 adds nothing for locks except the revoke guard (§4).

### 3.6 Visibility (P5) — OD-6

Entrant, public and studio readers must not learn the advanced list before the callback result is published (K0 P5, P10). Verified so far: nothing in CF1's tables is granted to any role (managers read through the preview RPC only). **Not yet verified** (implementation preflight must list every reader of `event_competition_heat_entries`/running order: portal, public schedule, day-of boards, ARIA, exports): whether any of them would show the Final heat's entries before publication. Recommendation: until F3 exists, the Final heat's entries are shown only to managers/officials/day-of desk; enforcement belongs in the readers CF1 identifies, and F3 later opens it on publication. If a reader cannot be gated cheaply, apply should not run before publication, which means waiting for F3 (then OD-4 becomes "apply at publish").

## 4. Corrections after advancement (CX1, K0 O5)

K0 O5 (approved): correcting an earlier round once the **next round has ballots** is blocked (F2 `COMP_CORRECTION_LATER_ROUND_BALLOTS`). CX1 ballot corrections (new version, reason, `correction_open`) follow F2.

| Situation | Behavior |
|---|---|
| Callback correction opened **after** the Final has any ballot | Refused by existing F2/O5. Nothing in CF1. Final stands. |
| Correction opened, Final has **no** ballots, no Final heat started, Final round `draft`/`scheduled`, Final heats `open` | **Allowed.** A new AFTER UPDATE OF `status` trigger on `event_competition_rounds` (edges `approved → ballots_locked` and `published → ballots_locked` with `correction_open`) calls `_cf1_revoke_advancement` in the same transaction: writes the revocation row (`cause = 'source_correction_opened'`, reason = the correction reason), sets the Final's CF1-created heats to `cancelled` (not deleted; history kept), writes `advancement_revoked` audit. The callback result is re-calculated, re-approved, and `apply` runs again as **generation 2** (new heat with the next heat number; the cancelled heat stays). |
| Final started (`staging/active/complete` heat, or Final round `active` or later) but no Final ballots | **Refused**: `COMP_ADVANCEMENT_FINAL_STARTED`, which aborts the whole correction transaction. Fail closed; a manager must first cancel the Final round via O1 (existing, audited) before the callback can be corrected. |
| Final heat locked or certified | Refused: `COMP_ADVANCEMENT_FINAL_LOCKED`; reopen first (HL1) or it is certified and the O5 block applies anyway. |
| Correction opened but `calculated` (not yet applied) | Nothing to revoke; the normal F2 path. |
| Correction produces a **different** advanced set | Generation 2 builds a fresh roster from the new approved version; generation 1's list remains as immutable history. |

Why a trigger and not a redefinition of `open_competition_round_correction`: the F2 RPC is pinned and already patched by later slices; a status-edge trigger gives one point of enforcement for *every* path to those edges, and the revoke runs inside the same statement transaction, so a refused revoke rolls back the correction atomically.

Cosmetic side effects of cancelling the Final heat in a published running order: a floor heat with no non-cancelled scoring heat (a "tombstone" of the old generation). `COMP10D_EMPTY_FLOOR_HEAT` is checked only at publish; CF1 keeps the tombstone (cannot delete from a published version) and the day-of readers must ignore floor heats with no live scoring heat. To be verified in implementation preflight.

## 5. Guards that make the Final consistent with advancement (additive triggers)

* `cf1_guard_final_heat_entry` (BEFORE INSERT on `event_competition_heat_entries`): if the heat's round is the target of a program with `advancement_method = 'promote_callback'` and the round is the successor of a `preliminary` round, the entry must be in an **active advancement's** entries for that round. This stops a manager from hand-assembling a Final roster by any other route.
* `cf1_guard_final_start` (BEFORE UPDATE OF `status` on rounds, `scheduled → active`): such a Final cannot start without an active advancement.
* `cf1_guard_advancement_approval` (§2.4).
* `cf1_guard_advancement_correction` (§4).

All are no-ops for programs that are not callback programs (e.g. "Final only").

## 6. Migration `20270120090000_competition_cf1_callback_final_advancement.sql` (proposed, not written)

**Slot.** `20270120090000`, stacked after HL1 `20270119090000`. Rollback `rollback/20270120090000_…_rollback.sql`.

**Objects.** Four tables (§1.2, RLS on, **no policies**, no direct grants to `anon`/`authenticated`), history-protection triggers, the preview and apply RPCs, one internal revoke function, the guard triggers of §5, the result-events kind check replacement, and the `complete_competition_round` advancement-check change.

**Redefinitions (pin plan).** Minimize: only `complete_competition_round` (swap the single `advanced is true` block for "or an active advancement exists for this version") and the three 10D freeze guards if the authorization is added by redefinition rather than by a second trigger (preferred: a second BEFORE trigger, which needs no pin but must be proven to be the only authorizer). Every redefinition follows the HL1 pattern: read `pg_get_functiondef` of the installed function, remove `\r`, assert `md5(def) = <pin>` and that the anchor text occurs exactly once, otherwise raise. The pins are computed from the installed text of the migration chain (REG → F2 → NS1 → SS1 → CX1 → HL1) at implementation time. **They are not recorded here** and must be derived from an applied chain, never from DEV (DEV/PROD drift note).

**SECURITY DEFINER boundary.** The apply RPC is the only writer to the four tables and the only creator of the Final's heat. It derives tenant (`event_id`, `program_id`, `division_id`) from the round rows, never from the caller; it takes `p_round_id`, `p_result_version_id`, `p_request_id` only. `search_path = public, pg_temp`; `revoke all … from public, anon`; `grant execute … to authenticated` for preview and apply; the revoke function has **no** grants (`revoke all from public, anon, authenticated, service_role`). Authorization: `_compe2_round_role(p_round_id) = 'manager'` (this includes the verified-email rule for non-managers only; managers pass through `can_manage_event_competition`, so CF1 adds the LAUNCH-SEC-1C `verified_email_for_user` check as NS1 does).

**Lock order (apply).** (1) `_compo1_lock_event(event)` (O1's per-event lock; serializes with day-of writers and schedule publish); (2) source round `FOR UPDATE`; (3) target round `FOR UPDATE`; (4) the approved result version row `FOR UPDATE`; (5) live schedule version row `FOR SHARE`; then inserts. Rounds are locked in ascending `sequence_number`, the same order F2 `open_competition_round_correction` uses for later rounds, and correction does not take the event lock, so there is no cycle. The deadlock-retry message from HL1 is reused for `40P01`. The correction trigger runs after the correction RPC already holds both rounds locked.

**Rollback.** App first, then SQL. The rollback file **refuses while any advancement row exists** (it is evidence), restores the F2 `complete_competition_round` text (verifies the restored pin), restores the kind check, drops triggers, then tables. Hosted DEV/PROD: none authorized by this document.

**Grants summary.** Preview and apply: `authenticated`. Tables: none. Revoke function: none. Guard functions: none.

## 7. QA plan

### 7.1 SQL suite (`scripts/…cf1…sql`, run on the dedicated QA Postgres, never hosted, never shared DB)

1. Happy path: approved callback → apply creates one advancement, `n` entries equal the `advanced = true` rows, one Final floor heat + scoring heat + dances + heat entries, one `advancement_applied` audit row, callback round status unchanged.
2. Replay with the same request id → `replayed: true`, no duplicate rows; same id with other args → `COMP_REQUEST_REUSED`.
3. Second apply with a new request id while active → `COMP_ADVANCEMENT_ALREADY_APPLIED`.
4. Refusals: not manager / chair / scorer / judge / other studio / anon; round not approved; stale hash; version not latest approved; null `advanced` (blocked); wrong round type / `advancement_method`; target not `final`/has heats/not draft-or-scheduled; count 0; count > live capacity; entry unavailable; multi-dance.
5. Tie within capacity: F-CT-02 `cap = 8` → 5 entries advance. Tie over capacity: F-CT-02 `cap = 4` → calculate completes with null flags, `approve` refused `COMP_ADVANCEMENT_BLOCKED`, `apply` refused, nothing written.
6. Guards: hand-inserted Final heat entry not in the advancement refused; Final start without advancement refused; advancement tables immutable (UPDATE/DELETE/TRUNCATE refused).
7. Corrections: correction with no Final ballots revokes, cancels the Final heats, writes `advancement_revoked`, then re-approve + apply creates generation 2 with the next heat number; correction refused when Final has a ballot (O5), when the Final heat started, when the Final heat is locked or certified; correction of a not-yet-advanced round untouched.
8. `complete_competition_round`: refuses without an active advancement (still F3-gated), unaffected for non-callback rounds.
9. RLS/isolation: manager of studio A gets zero rows and `COMP_FORBIDDEN` for studio B; entrant/public cannot read advancement, nor the Final roster before publication (the reader inventory result from §3.6).
10. 10D integrity: the Final heat insert still fires the deferred competitor-conflict and music checks.
11. No-op for "Final only" programs.

### 7.2 Concurrency script (multi-session, real transactions)

apply ∥ apply (same id, different ids); apply ∥ `open_competition_round_correction`; apply ∥ `start_competition_round` (Final); apply ∥ `set_competition_round_heat_capacity`; apply ∥ scratch of an advanced entry (SC1); apply ∥ schedule publish; revoke-by-correction ∥ Final first ballot; apply ∥ `calculate`/`approve` of the same round. Assert: exactly one winner where exclusive, no deadlock exceeding the retry path, no partial roster, audit rows equal the winners.

### 7.3 Vitest

`advancement` pure module (mirrors §1.3 preconditions for the preview, error→message map, `contract.ts` kinds), results-review panel states (`ready / blocked tie / applied / revoked`), action wiring with request id, and a contract test that the doc and `contract.ts` kind list agree. No engine change (the engine already emits `advanced` and `tie_over_capacity`).

### 7.4 QA-A scenario mapping

| Scenario | Becomes | Assertion |
|---|---|---|
| SCN-11.3 | unchanged (PASS) | calculation advances exactly `T` |
| SCN-11.4a | NEW positive | tie inside capacity: all tied advance; Final roster `T+k`; audit row |
| SCN-11.4b | NEW negative | tie over capacity: manager sees `tie_over_capacity` + tied entries; Approve and Advance both refuse; no override control present |
| SCN-11.5 | RUN (was "no screen") | after apply, the Final has one heat of exactly the advanced couples; the Final starts, three judges rank, calculate, approve (second manager), Final heat certified; the heat is one heat (no `COMP_ORDINAL_MULTI_HEAT`) |
| SCN-11.5b | NEW | correct the callback before Final ballots → Final heat cancelled, regenerated at generation 2 |
| SCN-11.5c | NEW | correction refused once the Final has a ballot (O5) |

## 8. Slicing proposal

| Slice | Content | Notes |
|---|---|---|
| **CF1-0** | This doc, owner/coordinator review | Docs only; blocks the rest until OD-1…OD-9 are answered or defaulted |
| **CF1-A** | SQL migration `20270120090000` + rollback + SQL suite + concurrency script | One PR, Git-only, no app code, `SQL before app` |
| **CF1-B** | App: preview/apply server actions, results-review "Advance to Final" panel, blocked-tie display, error messages, vitest, `contract.ts` kinds | Separate PR on A; cannot deploy before A is applied |
| **CF1-C** | QA-A scenarios SCN-11.4a/b, 11.5, 11.5b/c in the acceptance harness | Separate PR (QA-A owns the harness) |
| **CF2 (separate, needs owner approval)** | Over-capacity tie process (runoff or other) | Its own K1 spec + verification + owner approval, a new engine version and probably a ballot format. Not started by this document |
| **Out of CF1** | F3 publication and reader gating of the Final roster; schedule snapshot supplement (OD-3b) | F3 is a different slice |

Stacking: CF1 sits on HL1 → CX1 → SS1 → F2 → REG; none of those are merged. No merge, hosted DB or deploy is proposed here.

## 9. OPEN owner decisions

| ID | Question | Recommendation |
|---|---|---|
| **OD-1** | Over-capacity tie (D-CT-4 2b): which process? (A all advance, B none of the tied, C runoff, D stay blocked) | Keep **D** (blocked, approve/apply refused) in CF1. If the owner wants a path, commission a runoff spec (CF2) with ballot, sub-tie and judge-availability rules |
| **OD-2** | `T` greater than Final capacity with **no** tie (D-CT-4 silent): block at apply (and ideally at setup)? | Block (`COMP_ADVANCEMENT_OVER_CAPACITY`); the Final is a single heat |
| **OD-3** | Final capacity edits after callback ballots exist: free, reason-audited, or blocked? Raising it can dissolve a "blocked" tie | Reason-audited, and flag in the preview when capacity differs from the calculation's |
| **OD-3a / 3b** | Final heat appended at end of the live order (no renumbering) or placed after the callback heat? Add a supplemental schedule publication record for the day-of addition? | Append; supplemental record so the snapshot stays truthful |
| **OD-4** | Trigger: explicit manager "Advance to Final" after approval (rec), automatic at approve, or at publish (waits for F3)? | Explicit, after approval |
| **OD-5** | An advanced couple is unavailable (ineligible, refunded) at apply: block (rec), build without them and list them, or backfill the next ranked? | Block with the list; never backfill (a backfill is a manager-style selection D-CT-4 rejected, and D-CT-10 carries nothing forward) |
| **OD-6** | Who may see the Final roster before the callback result is published (K0 P5)? | Managers/officials/day-of desk only until publication; reader inventory is a CF1-A preflight deliverable |
| **OD-7** | Final heat display order (`floor_order`): ascending entry id (deterministic, recommended), by entry number, or random with a stored seed? | Ascending entry id; owner may want entry number |
| **OD-8** | Accept an audited **narrow exception** that lets one definer path add a heat to the live, frozen running order (alternative: none exists; the Final cannot be built during a run) | Accept the narrow, transaction-authorized exception; reject any general relaxation of 10D/O1 |
| **OD-9** | Multi-dance callback round (X-6: one result per dance): fail closed for advancement in v1? | Fail closed (`COMP_ADVANCEMENT_MULTI_DANCE`) |
| **OD-10** | Correction after the Final started but before ballots: refuse (rec, requires cancelling the Final round first) or allow with a full audited reset? | Refuse |

## 10. Not in this document

No code, SQL or migration. No hosted DB, deploy or merge. No engine change (`callback_tally@1` already produces what CF1 needs). No governing-body rule (S10). No outreach to anyone outside the project.

## 11. Evidence

All facts in §0 were read from the HL1 tree at `ca6c0b8d`. PR #350 base is `competition-cx1-correction-ballots`; head `competition-hl1-heat-lock`. QA-A facts come from `docs/qa/competition-qa-sut6-prod-acceptance-2026-10-30.{md,json}` on `origin/competition-qa-acceptance`. Items marked "to be verified" (reader inventory for P5, tombstone floor-heat handling, installed-function md5 pins, whether the 10D freeze guards can be authorized by a second trigger rather than redefinition) are implementation preflight tasks of CF1-A, not facts.
