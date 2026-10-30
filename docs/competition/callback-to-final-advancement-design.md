# Competition OS — Callback → Final advancement (CF1 design)

Status: **DESIGN ONLY, DRAFT for coordinator/owner review.** Docs, Git-only: no app code, no SQL, no migration. Baseline: branch `competition-hl1-heat-lock` @ `ca6c0b8d` (HL1, PR #350), which stacks REG #338 → F2 #339 → SS1 #344 → CX1 #347 → HL1. Migration slot proposed: `20270120090000` (verified free on every `origin/competition-*` / `claude/*` branch at authoring time; 0119 is HL1).

Nothing here changes an approved rule. Where an approved rule is silent this document says so, lays out options, recommends one, and lists it in §9 as an **OPEN owner decision**. Revision 2 (2026-10-30) records the owner's direction of that date (§0.1), the independent review's four corrections, a UCWDC-versus-DanceFlow source table (§0.2), and appends the implementation plan, acceptance matrix and dependency table (§12–§14). Competition OS is not discussed with outsiders.

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

### 0.1 Owner decisions recorded 2026-10-30 (relayed by the Competition coordinator)

| ID | Decision | Where applied |
|---|---|---|
| OD-1 / D-CT-4 | **Option D.** If tied couples at the cut-off exceed the Final's permitted capacity: approval and advancement are blocked. No arbitrary elimination, no manager override, no automatic over-capacity advancement. A runoff (CF2) remains a separate, unapproved candidate. | §2, §5, §9 |
| OD-6 | Before official publication the generated Final roster is visible **only to authorized competition officials and staff**; competitors and the public see it only after the applicable publication action. The reader inventory is a **hard CF1-A preflight deliverable**. | §3.6, §12 |
| OD-8 | Approved: a **narrowly scoped, audited exception** that lets *only* the CF1 advancement operation insert its generated Final heat into an otherwise published running order. All ordinary 10D and O1 restrictions are preserved. | §3.2 |
| OD-3 | Capacity changes require authorization, a recorded reason and audit history, and must **never invalidate an active, locked or already-balloted Final**. The event's applicable competition rules are enforced. The exact guard is specified in §3.4.1. | §3.4.1 |

### 0.2 UCWDC requirements versus DanceFlow product decisions

UCWDC Majority Rules stay **UNAVAILABLE** (S4-5); nothing in this document is a UCWDC compliance claim. The Studio `callback_tally@1` is a DanceFlow Studio method (S10). Pinned source: `2026-Scoring-Format-v16.9b-1.pdf`, sha256 `44290a06d14c…`, cited by section through `engine-spec-ucwdc-majority-rules.md` (§3.1–§3.4, §12).

| Item | Official UCWDC source (v16.9b, via the K1 UCWDC spec) | DanceFlow product / owner decision |
|---|---|---|
| Promote a designated number of couples **plus ties** at the dividing line | **R1.4** (spec §3.2): the most valued contestants, "based on a designated number … plus ties, if any occur", are promoted. Source-confirmed | DanceFlow adopts "ties at the cut advance" only through D-CT-4, with the capacity condition below |
| Finals field filled from the last callback values | **R2.3** (spec §3.3), stated in the Semi-Finals context; the supported UCWDC flow in the K1 spec is Prelims → Finals only and runs no Semi-Finals. Source-confirmed | DanceFlow does **not** carry callback values forward (D-CT-10: the tally is staff information only) |
| Finals capacity as a limit that blocks advancement | Not a UCWDC rule. R2.3's "nine for one heat, up to twelve for two heats of six" is **an example only** | Owner interpretation **I-2** (K1 UCWDC spec §12B, "not a verified UCWDC rule"); for Studio: D-CT-4 and "floor capacity = 10D final heat capacity" |
| Tie at the cut-off when promoted plus ties exceed capacity | **Silent.** Q1 in the UCWDC spec concerns the Semi-Finals retirement cut only; no Prelims → Finals over-capacity tie rule is confirmed | D-CT-4 / OD-1 Option D: blocked, no manager pick, no automatic over-capacity advance |
| Single-heat Final | Not a UCWDC rule | DanceFlow: the Studio ordinal-majority Final is single-heat (X-7; readiness `COMP_ORDINAL_MULTI_HEAT`) |
| Advancement records, immutability, revocation, audit | Not addressed by the source | DanceFlow: K0 §6 and this design |
| Corrections after advancement | Not addressed by the source | DanceFlow: K0 P1, O5, CX1 and this design |
| Withdrawn-couple handling and deterministic re-advancement | Not addressed by the source | DanceFlow: X-5 and §4.1 |

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
7. Every advanced entry is still `confirmed`, not `ineligible`, and has no unresolved competitive-affecting exception (K0 §4.1). Otherwise **apply refuses** with `COMP_ADVANCEMENT_ENTRY_UNAVAILABLE` listing the entries. It never drops the couple and never substitutes another. The **only** route is a correction and deterministic recalculation (§4.1), which is not a manager pick and not a backfill.

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

**Decision (owner, 2026-10-30, OD-1): option D.** CF1 ships with it. Options A and B are not permitted; C (runoff, CF2) is a separate, unapproved candidate that needs its own spec, K1 verification and approval. Nothing below adds a manager override, an elimination rule or an automatic over-capacity advance. CF1 must make "blocked" actually blocking:

* **2.4 Approval gate.** Today a calculated callback result with every `advanced` null can still be approved (and then completed, since F2's completion check looks only for `advanced is true`). That would let a round "finish" with nobody advancing. CF1 adds a BEFORE UPDATE OF `status` trigger on `event_competition_result_versions` (calculated → approved): for a round with `round_type='preliminary'` and program `advancement_method='promote_callback'`, refuse with `COMP_ADVANCEMENT_BLOCKED` when any row has `advanced is null`. Additive trigger; no redefinition of F2 `approve_competition_round_result`.
* **Ways out of a blocked tie that are not manager picks:** a corrected ballot version through the correction path (CX1/K0 P1) if a judge made an error. Changing the Final capacity is **not** a way out: §3.4.1 freezes it once the callback round has ballots or a result, so the approved capacity cannot be raised to dissolve a tie.

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

### 3.2 The running-order problem and the approved controlled exception (OD-8, decided 2026-10-30)

Because of F-5(c)(d), the only ways to give the Final a heat in the live published version are (i) a new CF1 definer path that inserts into the live version under an explicit audited authorization, or (ii) relaxing the 10D freeze or the O1 run guard generally. (ii) is rejected: it weakens guards that protect every other round. Option (iii), pre-creating empty "shell" Final heats at planning time, does not work either because assigning entries to a heat of a published version is also frozen (F-5c) and the planner would have to be redesigned.

**Approved approach (i)**, scoped as the owner stated: only the CF1 advancement operation may do this, and every ordinary 10D and O1 restriction stays in force for every other writer. `apply_competition_round_advancement` inserts, in one transaction: one `event_competition_floor_heats` row appended at `max(heat_number)+1` of the live version, one `event_competition_heats` row (`round_id` = Final, `status 'scheduled'`, `schedule_version_id` = live version, `floor_heat_id` = the new floor heat, `heat_number` = `max(heat_number over the round, including cancelled)+1`), the `event_competition_heat_dances` copied from the callback round's heats (X-6: one dance per result, so a multi-dance callback round fails closed `COMP_ADVANCEMENT_MULTI_DANCE`, OD-9), and `event_competition_heat_entries` for each advanced entry. The three 10D freeze guards need a **narrow authorization** (this is the exception OD-8 approves), using the codebase's existing pattern: the guard allows the write only if an `event_competition_round_advancements` row with `transaction_id = txid_current()` for that heat's round exists (same idea as `event_competition_heat_lock_events` and NS1/`result_events` `transaction_id` checks). The guards are additively redefined (they are small; implementation pins the installed md5s) or extended by a second BEFORE trigger. Then the 10D deferred integrity triggers run at commit.

Consequences that need acceptance:

* The published **snapshot** (`event_competition_schedule_publications.snapshot`, checksummed) is point-in-time and will not contain the Final heat. Public/entrant schedule readers that render from the snapshot will not show it; those that read live heats will. **OD-12:** add a supplemental publication record, or document that the Final is a day-of addition shown by the live floor/day-of views only. This interacts with OD-6: the roster must not appear to non-officials before publication.
* Appending at the end of the order is the only option without renumbering a published version. **OD-11:** the owner may want the Final placed after the callback heat; that needs renumbering and is not proposed.
* The heat is a normal `scheduled` heat after creation; `schedule_competition_round` (draft → scheduled) and `start_competition_round` remain the only writers of the Final round's status, unchanged. CF1 does not add an edge.

### 3.3 Scratches and no-shows (NS1/SC1)

* Callback scratches/no-shows (X-5) never advanced: they are excluded from the engine input, so `advanced` is not true for them. Not re-checked.
* Between approval and apply, an advanced entry may become `ineligible`/refunded or withdrawn: apply refuses with the list (precondition 7); no silent shrink, no backfill. Route: record the withdrawal through the audited official process (K0 §4.1), open a correction, and recalculate (worked example in §4.1).
* After apply, scratch and no-show on the Final heat use the existing SC1/NS1 flows; the Final calculation excludes them (X-5). There is **no alternate list** (D-CT-10).

### 3.4 Capacity

Re-read at apply (precondition 6). The Final must be one heat; if `count > capacity` apply refuses. Revalidated live as a second layer. The capacity value is part of the hashed calculation evidence (`_compf2_evidence` → `finalCapacity`), so a capacity change after calculation already makes the version stale (`COMP_RESULT_STALE` at approve) and forces recalculation; the §3.4.1 guard additionally restricts when it may change at all.

#### 3.4.1 Capacity guard (OD-3, decided 2026-10-30; exact rules)

Verified today: `set_competition_round_heat_capacity(p_round_id, p_capacity)` (10D, `20261111090000` l.775–795, used by `schedule/actions.ts`) lets any manager set `1..100` on **any round at any status**, with no reason, no audit row and no status guard. It writes `event_competition_rounds.configuration.max_entries_per_heat`. SS1 deliberately leaves `configuration` unfrozen. CF1-A adds:

* **Audit table** `event_competition_round_capacity_events` (insert-only): `round_id`, `old_capacity`, `new_capacity`, `reason` (1–500 chars, required), `actor`, `at`, `request_id`, `transaction_id`.
* **Authorization:** event manager (`can_manage_event_competition`) plus the verified-email credential (as NS1). Chair, scorer, judge, other studio, anon: refused.
* **Trigger** `cf1_guard_round_capacity`, BEFORE UPDATE OF `configuration` on rounds, fires only when `max_entries_per_heat` actually changes and allows it only if a capacity-event row for this round and `txid_current()` exists (the code base's usual transaction-bound authorization). So the only writer is the capacity RPC. The 2-argument 10D RPC is replaced by a pinned redefinition that requires a reason (new signature `(uuid, integer, text, uuid)`; the 2-argument form is dropped or raises `COMP_CAPACITY_REASON_REQUIRED`), and CF1-B switches the schedule action.

**What blocks** (first failure wins; each is a stable `COMP_CAPACITY_*` error):

| # | Condition on the round whose capacity changes | Result |
|---|---|---|
| B1 | Round status is not `draft` or `scheduled` (started, locked, calculated, approved, published, complete or cancelled) | blocked |
| B2 | Any non-cancelled heat of the round is `staging/active/complete`, or has `lock_state <> 'open'` | blocked |
| B3 | The round has any ballot | blocked |
| B4 | The round has an **active advancement** (the generated Final exists) | blocked; the only way back is the correction path of §4 |
| B5 | The round is the successor of a callback round that has any ballot, or any result version (including stale), or status `ballots_locked` or later | blocked. This stops capacity from being raised to dissolve a blocked tie (D-CT-4 / OD-1) |
| B6 | New capacity is below the callback round's `target_advancement_count` `T` | blocked (the `T` couples must fit; consistent with OD-2) |
| B7 | New capacity outside `1..100` (the existing 10D rule), or reason missing, blank or over 500 characters, or request id missing | blocked |

**What is allowed:** a capacity change by an authorized manager, with a reason and an audit row, while the round is `draft/scheduled`, has no ballots, has no active advancement and (for a callback Final) the callback round has no ballot, no result and is before `ballots_locked`. A non-callback round follows B1–B4 and B7 only. Because capacity is part of the hashed evidence, an allowed change in that window cannot silently alter an existing result. The unified audit read (`competition_audit_log`) gains the capacity events by a pinned redefinition; if that pin fails the events stay readable through the preview and the gap is reported. **Residual for the owner (OD-3 residual):** confirm that B5/B6 are the intended reading of "never invalidate an active, locked or already-balloted Final" and "the event's applicable competition rules".

### 3.5 Locking of the Final heat

Created `open`. HL1 early lock and reopen rules apply as they do to every heat. CF1 adds nothing for locks except the revoke guard (§4).

### 3.6 Visibility (P5) — OD-6, decided 2026-10-30

Before official publication the generated Final roster is visible **only to authorized competition officials and staff** (managers, assigned officials and the day-of desk as their existing roles allow). Competitors and the public see it only after the applicable publication action (F3). Verified so far: nothing in CF1's tables is granted to any role (managers read through the preview RPC only).

**Hard CF1-A preflight deliverable (P-1):** a written inventory, checked into the PR, of **every** reader of `event_competition_heat_entries` and of the live running order (portal, public schedule, entrant views, day-of boards, ARIA, exports, floor/schedule server code). For each: audience, whether it would show the Final heat or its entries before publication, and the gating added. CF1-A may not merge without it, and apply must not be reachable in any environment where an ungated reader exists. If a reader cannot be gated, the fallback is that apply waits for F3 (apply at publication).

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

**F3 dependency (publication wording and entrant notice).** Notifying entrants when a *published* advancement is revoked, and the publication / withdrawn-publication wording, are owned by **F3**, which is not built (F-2). Until F3 exists CF1 fails closed: the revocation trigger refuses a correction whose source round is `published` (`COMP_ADVANCEMENT_PUBLISHED_NEEDS_F3`), checked like F2's own `complete` check (F3 table absent → refuse). Today no round can be `published`, so this is unreachable now and becomes live work for F3: withdraw or supersede the callback publication (K0 §4, O4 generic "results under review"), withdraw the Final roster from entrants, and send the notice. CF1 does not write that wording. See the dependency table (§14).

### 4.1 Withdrawal, correction and deterministic recalculation (worked example)

If an advanced couple becomes unavailable between approval and apply, **apply refuses** (precondition 7). The only route is a correction and recalculation:

1. Record the withdrawal through the audited official process (K0 §4.1, R2 refund-exception resolution), so the entry is excluded under X-5 (scratched or no-show are excluded, never placed last).
2. Open a correction on the callback round (manager, reason). No advancement exists yet, so nothing is revoked.
3. Each judge who had selected the excluded couple no longer has exactly `T` eligible picks (V11 `callback_count`), so those judges submit a **corrected ballot version** (CX1) with a reason. The judges choose; no manager does.
4. Recalculate, second-person approve, then apply. The engine re-advances deterministically.

Example (F-CT-01 data, `T = 4`, entries 11–18, three judges): J1 {11, 12, 13, 14}, J2 {11, 12, 13, 15}, J3 {11, 12, 14, 16}. The approved result advanced 11, 12, 13, 14. Apply is attempted and entry 13 has withdrawn: apply refuses, listing 13. After steps 1–2 entry 13 is excluded. J1 and J2 each hold 3 eligible picks, so both file corrected ballots, say J1 {11, 12, 14, 15} and J2 {11, 12, 15, 16}; J3 never marked 13 and is unchanged. Tallies: 11 = 3, 12 = 3, 14 = 2 (J1, J3), 15 = 2 (J1, J2), 16 = 2 (J2, J3). The 4th-highest tally is 2, so five couples (11, 12, 14, 15, 16) sit at or above it: a tie at the cut. With capacity 8 all five advance (D-CT-4); with capacity 4 advancement is blocked (OD-1 Option D). Entries 15 and 16 advance because the judges' corrected ballots say so, **not** because a manager chose "the next couple". If a judge does not re-ballot, the round stays blocked (fail closed).

**Mechanism to verify (CF1-A preflight deliverable P-3).** Step 1 needs an existing writer that can mark a couple excluded on a **certified** callback heat. Heat scratch is refused on certified heats, and NS1 marks are allowed only while the round is `active` (NS1 header). If no existing writer can do it, that is a gap to raise with the coordinator, not something CF1 invents; until resolved, the withdrawn-couple case stays blocked, which fails closed.

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
| **Out of CF1** | F3 publication, entrant notification and publication/withdrawn wording when a published advancement is revoked, entrant/public visibility of the Final roster after publication; schedule snapshot supplement (OD-12) | F3 is a different slice and is not built (§14). CF1 fails closed until it exists |

Stacking: CF1 sits on HL1 → CX1 → SS1 → F2 → REG; none of those are merged. No merge, hosted DB or deploy is proposed here.

## 9. Owner decisions

IDs are unique and cross-referenced consistently (the earlier `OD-3a/3b` are now `OD-11/OD-12`).

**Decided 2026-10-30:**

| ID | Decision |
|---|---|
| OD-1 | D-CT-4 Option D: block approval and advancement when tied couples exceed the Final's permitted capacity; no override, no elimination, no automatic over-capacity advance. Runoff (CF2) stays unapproved |
| OD-3 | Capacity changes need authorization, reason and audit, and never invalidate an active, locked or already-balloted Final. Exact guard in §3.4.1; the B5/B6 reading is a residual to confirm |
| OD-6 | Final roster visible to officials and staff only until publication; the reader inventory (P-1) is a hard CF1-A preflight deliverable |
| OD-8 | Narrow, audited exception for the CF1 operation only, to insert its Final heat into the published running order (§3.2) |

**OPEN:**

| ID | Question | Recommendation |
|---|---|---|
| OD-2 | `T` greater than Final capacity with no tie (D-CT-4 silent): block at apply (and at capacity setup, B6)? | Block (`COMP_ADVANCEMENT_OVER_CAPACITY`); the Final is one heat |
| OD-3 (residual) | Confirm B5 (capacity frozen once the callback has ballots or a result) and B6 (capacity not below `T`) | Confirm |
| OD-4 | Trigger: explicit manager "Advance to Final" after approval, automatic at approve, or at publish (waits for F3)? | Explicit, after approval |
| OD-5 | Unavailable advanced couple at apply. Review fixed the mechanism: apply refuses; route is correction and deterministic recalculation (§4.1); no backfill, no silent shrink | Treated as settled by the review; owner to confirm, plus the P-3 mechanism gap |
| OD-7 | Final heat display order (`floor_order`): ascending entry id, by entry number, or seeded random | Ascending entry id |
| OD-9 | Multi-dance callback round (X-6): fail closed for advancement in v1? | Fail closed (`COMP_ADVANCEMENT_MULTI_DANCE`) |
| OD-10 | Correction after the Final started but before ballots: refuse (cancel the Final round first), or allow with a full audited reset? | Refuse |
| OD-11 | Final heat appended at the end of the live order (no renumbering) or placed after the callback heat? | Append |
| OD-12 | Add a supplemental schedule publication record for the day-of Final heat? | Yes, so the snapshot stays truthful |

## 10. Not in this document

No code, SQL or migration. No hosted DB, deploy or merge. No engine change (`callback_tally@1` already produces what CF1 needs). No governing-body rule (S10). No outreach to anyone outside the project.

## 11. Evidence

All facts in §0 were read from the HL1 tree at `ca6c0b8d`. PR #350 base is `competition-cx1-correction-ballots`; head `competition-hl1-heat-lock`. QA-A facts come from `docs/qa/competition-qa-sut6-prod-acceptance-2026-10-30.{md,json}` on `origin/competition-qa-acceptance`. Items marked "to be verified" (reader inventory for P5, tombstone floor-heat handling, installed-function md5 pins, whether the 10D freeze guards can be authorized by a second trigger rather than redefinition) are implementation preflight tasks of CF1-A, not facts.

## 12. Bounded CF1 implementation plan

All slices are Git-only and stacked on HL1 → CX1 → SS1 → NS1 → F2 → E2/O1/E1 → REG (§14). **Not authorized by this document:** merging anything, applying SQL to hosted DEV/PROD, deploying, promoting, pushing outside the draft PR chain. Migration slot for the whole of CF1: `20270120090000` (one file). Commits and PRs carry no attribution trailer or footer.

**Preflight deliverables (checked into CF1-A before any SQL is written):**

| ID | Deliverable | Why |
|---|---|---|
| P-1 | Reader inventory for heat entries and the live running order (§3.6) | OD-6 hard requirement |
| P-2 | `pg_get_functiondef` md5 pins, derived by replaying the applied migration chain on the dedicated QA Postgres (never from DEV/PROD, per the DEV/PROD drift note), for each function CF1 redefines | Pinned text-replace pattern (HL1) |
| P-3 | Which existing writer can exclude a withdrawn couple on a **certified** callback heat (§4.1); if none, the gap report | Worked example step 1 |
| P-4 | Where the Competition SQL suites live. The E2/F2/HL1 SQL suites are **not tracked** in this tree (verified: the only tracked competition tests are vitest files such as `heatLock.hl1.test.ts`, `results.f2.test.ts`, `noShow.ns1.test.ts`; no `.sql` suite for E2/F2/HL1) | CF1 must say where its SQL suite is committed |
| P-5 | The 10D freeze-guard authorization: prove a second BEFORE trigger can authorize CF1's inserts without redefining the three guards; otherwise pin and redefine them | OD-8 scope |
| P-6 | Tombstone floor heats: which day-of/schedule readers must ignore a floor heat with no live scoring heat | §4 |

### CF1-A — SQL (one PR, `competition-cf1-a-advancement-sql`, base HL1)

| Item | Content |
|---|---|
| Files | `src/lib/supabase/migrations/20270120090000_competition_cf1_callback_final_advancement.sql`; `src/lib/supabase/migrations/rollback/20270120090000_competition_cf1_callback_final_advancement_rollback.sql`; the SQL suite and concurrency script (location per P-4); reader-inventory note (P-1); `docs/competition/scoring-results-contract.md` §3/§6/§8 amendment and the matching `src/lib/competition/results/contract.ts` kinds (same PR, K0 rule) |
| Objects | Tables of §1.2 and `event_competition_round_capacity_events` (RLS on, no policies, no grants); history-protection triggers; `competition_round_advancement_preview`, `apply_competition_round_advancement`, capacity RPC `(uuid, integer, text, uuid)`; internal `_cf1_revoke_advancement`; guard triggers §2.4, §4, §5 and `cf1_guard_round_capacity` §3.4.1; result-events kind check replacement (`advancement_applied`, `advancement_revoked`); `complete_competition_round` advancement-check change; replaced 2-argument 10D capacity RPC; `competition_audit_log` extension |
| Order | **SQL before app.** CF1-B cannot deploy before CF1-A is applied |
| Pins | Pinned text-replace for `complete_competition_round`, the 2-argument capacity RPC and `competition_audit_log` (P-2); preflight asserts `md5(def)` and that each anchor occurs exactly once, else raises. 10D guards: second trigger preferred (P-5) |
| Lock order | `_compo1_lock_event` → source round `FOR UPDATE` → target round `FOR UPDATE` (ascending `sequence_number`) → approved result version row `FOR UPDATE` → live schedule version `FOR SHARE`; capacity RPC: event lock → round `FOR UPDATE`. Same round order as F2 correction (which takes no event lock), so no cycle. `40P01` maps to the HL1 retry message |
| SECURITY DEFINER / grants | `search_path = public, pg_temp`; preview, apply and capacity RPC `authenticated` only (manager + verified email), never `anon`; revoke function and guard functions have no grants; tenant derived from rows, never from the caller |
| Rollback | App first, then the rollback file. It **refuses while any advancement or capacity-event row exists** (evidence), restores the pinned F2/10D function texts and verifies the restored pins, restores the kind check, drops triggers and tables. Hosted application is not authorized here |
| Tests | §7.1 SQL suite, §7.2 concurrency script, plus: capacity guard B1–B7 cases (reason required, audit row, txn-bound trigger rejects a direct `UPDATE`), 2-argument RPC refusal, publish-needs-F3 refusal, no-op for "Final only" |
| Not in scope | Any UI or server action; any engine change; runoff/CF2; F3 publication; reader gating code beyond what P-1 requires to make apply safe; hosted anything |

### CF1-B — App (one PR, `competition-cf1-b-advancement-app`, base CF1-A)

| Item | Content |
|---|---|
| Files (expected) | `src/app/app/events/[id]/competition/results/actions.ts`, `results/[roundId]/…` (the "Advance to Final" panel and blocked-tie display), `schedule/actions.ts` (switch to the capacity RPC with a required reason), a pure `src/lib/competition/results/advancement.ts` (preview model, error→message map), `messages.ts`, `contract.ts` kinds, vitest files beside them |
| Behavior | Panel states `ready / blocked (tie over capacity, lists the tied entries) / applied / revoked`; server action passes a request id; **no override control exists** for a blocked tie; Final roster rendered only to managers/officials (P-1 gating); capacity form requires a reason and shows the B1–B7 refusals |
| Order | After CF1-A is applied to the target environment. App rollback first |
| Tests | §7.3 vitest; the contract test that this doc's kind list equals `contract.ts` |
| Not in scope | SQL; QA-A harness; runoff; F3 wording; hosted deploy |

### CF1-C — QA-A scenarios (one PR in the QA-A harness, base CF1-B)

| Item | Content |
|---|---|
| Files | The acceptance harness owned by QA-A (extends #341/#297): scenarios SCN-11.4a, 11.4b, 11.5, 11.5b, 11.5c; report and JSON twin |
| Behavior | Runs against the dedicated QA stack on a production build; evidence-backed (screenshots, DB probes, traces); a scenario that cannot run is **BLOCKED**, never PASSED |
| Not in scope | Product code; hosted runs; owner acceptance |

## 13. Acceptance-test matrix

DB type = what proves the DB result: **SQL** (dedicated QA Postgres), **E2E** (Playwright against the QA stack), **vitest** (pure/unit). Every row is **NOT RUN** (nothing is implemented).

| ID | Preconditions | Steps | Expected DB result | Expected UI result | DB type | Proves it | Status |
|---|---|---|---|---|---|---|---|
| **SCN-11.4a** tie within capacity | Callback + Final studio program published; `T = 4`, capacity 8; three judges; judge picks give tallies 11 = 3, 12 = 3, 14 = 2, 15 = 2, 16 = 2 (F-CT-02 shape: 5 couples at/above the 4th tally) | Judges submit; manager locks; calculate; second manager approves; manager runs Advance to Final | Result rows: five `advanced = true`; one active advancement with five entries, `advanced_count = 5`; one `advancement_applied` audit row; Final heat with exactly those five heat entries; callback round `approved`, status unchanged by apply | Panel shows "5 advance (tie at the cut)"; Final roster lists the five; no override control | SQL + E2 | SQL suite item 5; CF1-C SCN-11.4a | NOT RUN |
| **SCN-11.4b** tie over capacity | As above with capacity 4 (and `T = 4`, 5 couples at/above the cut) | Calculate; try Approve; try Advance | Calculation completes with **no** `advanced` flags (`tie_over_capacity` in the trace); Approve refused `COMP_ADVANCEMENT_BLOCKED`; Apply refused; **no** advancement, heat or entry rows; capacity cannot be raised (B5) | Desk states `tie_over_capacity` and lists entries 14, 15, 16; Approve and Advance disabled/refused; no manager-pick control | SQL + E2 | SQL suite item 5 and capacity B5; CF1-C SCN-11.4b | NOT RUN |
| **SCN-11.5** Final built from advanced couples, one heat | Approved callback result advancing exactly the `T` couples; Final round `draft`/`scheduled`, no heats; running order published | Advance to Final; schedule and start the Final; three judges rank; lock; calculate; second-manager approve | One floor heat appended at `max+1`; one scoring heat, dances copied, heat entries = advanced entries only; 10D integrity triggers pass; Final ballots accepted for those entries only; Final result calculated by the ordinal engine; heat certified at approval | Final shows one heat of exactly the advanced couples; no `COMP_ORDINAL_MULTI_HEAT`; officials see the roster, entrants/public do not before publication (P-1 check) | SQL + E2 | SQL items 1, 6, 10; CF1-C SCN-11.5 | NOT RUN |
| **SCN-11.5b** correct callback before Final ballots | SCN-11.5 up to apply (Final heat exists, no Final ballots, Final not started, heat `open`) | Manager opens a correction on the callback round with a reason; judge files a corrected ballot; recalculate; approve; apply again | One `advancement_revoked` row (`source_correction_opened`); the generation 1 Final heat `cancelled` (kept); generation 2 advancement with the new list and a new heat with the next heat number; audit rows for both | Banner shows the correction; Final roster replaced; old heat not shown as live | SQL + E2 | SQL item 7; CF1-C SCN-11.5b | NOT RUN |
| **SCN-11.5c** correction after Final ballots / started | SCN-11.5 with at least one Final ballot (variant: Final heat started, no ballot; variant: Final heat locked) | Manager tries to open a correction on the callback round | Refused: `COMP_CORRECTION_LATER_ROUND_BALLOTS` (O5) when ballots exist; `COMP_ADVANCEMENT_FINAL_STARTED` when started; `COMP_ADVANCEMENT_FINAL_LOCKED` when locked; no revocation, no status change, no new audit rows besides the refused attempt | Desk shows the exact refusal text; Final untouched | SQL + E2 | SQL item 7; CF1-C SCN-11.5c | NOT RUN |

Supporting SQL-only rows (not QA-A scenarios, same status): withdrawn advanced couple refuses apply and the §4.1 recalculation example (needs P-3), capacity guard B1–B7, concurrency matrix (§7.2), "Final only" no-op, advancement table immutability, cross-tenant isolation.

## 14. Dependency table

State verified with `gh pr view` on 2026-10-30. All five are open drafts; none is merged; the base chain is listed because merge order matters.

| Dependency | PR / head | Base | What CF1 needs from it | Current state | What blocks CF1 merge or deploy |
|---|---|---|---|---|---|
| **REG** scoring registry | #338 `8d94d068` (`competition-reg-scoring-registry`) | `main` | Method pins (`studio_callback_tally@1`, ordinal majority) read by F2 `_compf2_engine_pin`; the scoring-selection guards | Open, draft, CI success | Must merge/apply first; CF1 preflight checks the pin is `approved` |
| **F2** results lifecycle | #339 `03be5d6a` (`competition-f2-results-lifecycle`) | `competition-e2-ballots` | `result_versions/rows/approvals/events`, calculate/approve/correct RPCs, `correction_open`, evidence incl. `finalCapacity`, `complete_competition_round` (redefined by CF1), `competition_audit_log` (extended) | Open, draft, CI success | Must merge/apply first; `complete` stays fail-closed on F3 |
| **SS1** studio scoring setup | #344 `40fd227d` (`competition-ss1-scoring-setup`) | `competition-ns1-no-show` | `advancement_method` frozen at publish (`20270118`), round scoring lock (`20270116`), presets "Callbacks + Final" | Open, draft, CI success | Must merge/apply first; CF1's guards assume `sequence_number`, `round_type` and `advancement_method` are frozen |
| **CX1** correction ballot readers | #347 `bf7d5c7c` (`competition-cx1-correction-ballots`) | `competition-ss1-scoring-setup` | `correction_open` exposed to the judge sheet and ballot desk so corrected ballots (§4.1) can be entered | Open, draft, CI success | Must merge/apply first; CF1-C 11.5b needs it |
| **HL1** heat lock | #350 `ca6c0b8d` (`competition-hl1-heat-lock`) | `competition-cx1-correction-ballots` | Early lock/reopen guards, `lock_competition_round_ballots` blocker; CF1's revoke uses lock state; CF1 is stacked directly on it (slot 0119) | Open, draft, CI success | Must merge/apply first; its pinned `lock_competition_round_ballots` md5 must hold at CF1 preflight |
| **F3** publication | **not built** (no PR; migration slot `20270105090000` reserved by K0) | — | Publication state to gate the Final roster for entrants and the public (OD-6), publication / withdrawn-publication wording and entrant notification when a **published** advancement is revoked (§4), and `complete_competition_round` | Absent: `complete` fails closed (F2), no round can be `published` | Does **not** block CF1-A/B/C. It blocks: any entrant-visible roster, any revocation of a published callback result (CF1 refuses it fail-closed), round completion, and the public schedule treatment of the Final (OD-12) |

Also verified stacked below F2 (not in the brief, listed so merge order is complete): E2 ballots (#331) and O1 day-of (#328), E1 officials (#327), NS1 no-show (#342); R2 refunds (#292, unmerged) supplies the audited official-resolution process that §4.1 step 1 relies on.
