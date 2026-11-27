# R-15 eligibility enforcement: path investigation, correction design (S4) and negative-test specification

Status: **DESIGN ONLY, draft.** No migration file, no SQL apply, no application behavior change, no merge, no deployment, no activation. Owner decision R-15 (2026-11-24) classifies the finding below as a **mandatory Studio/Custom release blocker, OPEN** until an integrated release candidate passes end-to-end verification (closing criteria in section 9).

Scope: Competition OS only. Evidence base: `origin/release/website-embeds` at `49dbaee1b` (fetched 2026-11-24), read-only DEV/PROD counts taken 2026-11-24, and the open draft PRs named in section 5. Governing-body wording is not asserted anywhere here: every rule in this document is **DanceFlow Studio/Custom policy** (R-15, OD-02, OD-03, OD-18), never an NDCA, UCWDC or WSDC requirement.

POLICY RATIFIED: yes (R-15 items 4 and 6). IMPLEMENTATION VERIFIED: **no, open.** OD-01, OD-02, OD-03 and OD-18 are preserved unchanged by this document.

## 1. The finding, verified by reading and one extra aggravating fact

`eligibility_status` has five values (`unverified`, `eligible`, `needs_review`, `ineligible`, `waived`; CHECK in `20260620_competition_foundation_v1.sql`). Only `ineligible` is treated as blocking by the database-side predicate `_cf1_entry_unavailable_reason` (`20270120085000_..._a1_eligibility_helpers.sql`, redefined unchanged for this arm by RB3 `20270120102000`), by the 10D/10D.1 placement checks, and by the planner (`floorPlanner.ts` `isSchedulableEntry`). Check-in session readiness and the readiness page count only `eligible`/`waived` as ready. The two disagree.

**Aggravating fact (new):** every entry is born `unverified`. All three generations of `start_competition_registration` (10C, 10C4, 10C5; the 10C5 body is current) insert `eligibility_status = 'unverified'`, and no other function inserts entries. So the gap is not an edge case reached by an organizer mistake: it is the **default path**. An organizer who never opens the registrations page gets confirmed, scheduled, called, scored and published entries that nobody cleared.

## 2. How `eligibility_status` is written today (task 8)

| Question | Answer (evidence) |
|---|---|
| Normal writer | `updateCompetitionEntryEligibilityAction` (`registrations/actions.ts` L34-43): `requireEventManager`, then a plain `update({ eligibility_status })` through the user's Supabase client. No reason, no basis, no category. PR 837/846 add a reason code and a `metadata.eligibility_determination` object, still through the same plain update. |
| Can a manager write `eligible`/`waived` directly through PostgREST without the audited determination? | **Yes.** Table `event_competition_entries` has RLS policy `competition_manage` (`for all`, `can_manage_event_competition(event_id)`, `20260620_competition_foundation_v1.sql` L355-370). No column grant or revoke on the table exists in any migration (searched). No guard trigger restricts `eligibility_status` or `metadata`. A manager can also INSERT an entry already `eligible`. OD-03/OD-18 determinations (PR 837/846) are application-layer only. |
| Is the determination audited at all today? | **Partly.** `audit_competition_entry_change` (10A, L748-800; trigger from `20260620_competition_generation_operations_v1.sql` L317) writes an append-only `event_competition_entry_changes` row on every `eligibility_status` change: `change_type = 'eligibility_change'`, `previous_state`/`resulting_state` (full row JSON), `performed_by = auth.uid()`, timestamp. So **who and when exist; why does not** (`reason` is read from a transaction GUC the action never sets, so NULL). A service-role or SQL-editor write has `performed_by` NULL. |
| Are `waived` and `eligible` distinguishable in audit? | Only by reading `resulting_state ->> 'eligibility_status'`. There is no recorded basis, category, criteria, actor role or fingerprint at the database level. |
| Is the PR 837/846 evidence tamper-resistant? | **No.** It lives in `event_competition_entries.metadata`. `metadata` is **not** among the columns that fire the audit trigger (status, division, program, eligibility, late_entry), so a manager can edit or delete the determination object through PostgREST with **no audit row at all**. The staleness fingerprint in 846 is a non-cryptographic 32-bit FNV-1a computed client-side; it detects drift, it is not an integrity control. |
| Who may decide? | `can_manage_event_competition` (any event/studio manager). OD-18 item 2 asks for "an authorized organizer or designated official"; no role distinction exists in SQL today. |

Consequence for the design: clearance evidence must move out of mutable `metadata` into an append-only table written only by a definer RPC, and direct client writes to the status must be refused (section 6).

## 3. Read-only counts (task 9, taken 2026-11-24 via `sb.sh dev-read` / `prod-read`, counts only)

| Measure | DEV | PROD |
|---|---|---|
| `event_competition_entries` rows (all statuses, all eligibility values) | **0** | **0** |
| `event_competition_heat_entries` | 0 | 0 |
| `event_competition_result_versions` | 0 | 0 |
| `eligibility_change` audit rows | 0 | 0 |
| Events with OD-17 enforcement ON | 0 | 0 |
| Rounds | 73 (all `draft`) | 8 (all `draft`) |

The requested breakdown (eligibility_status x entry status x placed/rostered/progressed) is therefore empty on both hosted databases today: **there is no historical row to migrate, no entry that has progressed, and no existing determination to preserve in hosted data.** Local QA fixtures and e2e specs do contain entries (e.g. `competition_round_ready.sql`, `competitionFullEvent.ts`); several seed `eligible`/`waived` directly. The migration design in section 6 is nevertheless written for non-empty data, because the counts can change before release and because the no-auto-conversion rule (R-15 item 11) must hold regardless. The query is kept in the scratchpad of the session and should be re-run, read-only, immediately before any apply.

## 4. Path table (task 7): which steps enforce clearance

"Accepts" lists the `eligibility_status` values the step lets through. **Executed** = the check runs in the database or server on every call (not UI only). Closed-by lists open draft PRs; a "Partly" means the PR narrows the gap in the application layer only.

| # | Step | File / function | Accepts | Inspected vs executed | Gap against R-15 | Closed by open PR? |
|---|---|---|---|---|---|---|
| 1 | Public/buyer registration, quote, checkout | `POST /api/events/[slug]/competition/checkout` -> `quote_competition_registration` / `_comp10c_quote` / `start_competition_registration` (service_role only) | Creates every entry `unverified` | Inspected | Not a gate; defines the default state. OD-02 under-18 gate is route-level | #835 adds OD-02 route gate (app layer, verified at that layer only) |
| 2 | Studio-side registration | same route, `mode = 'studio'` | `unverified` | Inspected | same | #835 |
| 3 | Staff-created entry | **no application route**; table API under `competition_manage` | any value incl. `eligible` | Inspected | Unprotected: a manager can INSERT an entry already `eligible` (the audit trigger is AFTER UPDATE/DELETE only, so an INSERT leaves **no** audit row). Participants need a NOT NULL same-event `competitor_id` and a manager cannot create competitors or edit DOB (10C L261-265), so the exposure is reuse of an existing competitor, not an invented person | None (needs SQL; S4 for status, S5 for age) |
| 4 | Identity resolution | `_comp10c_resolve_competitor` (10C L268, definer, service-role chain) | n/a (people, not status) | Inspected | Resolves/creates the competitor row and stores DOB; competitor rows are read-only to `authenticated` except `bib_number`, so a manager cannot rewrite DOB. Guests, "this is me" anchors and studio registration all converge on one event-scoped row. No eligibility semantics | n/a. R-15 item 2 ratifies the model. OD-02 per-person DOB is evaluated at the route (#835) and re-read by #837 |
| 5 | Team-member eligibility | one entry-level status for the whole team; per-member rows are `event_competition_entry_participants` (`team_member`, `alternate`) | entry status only | Inspected | A team has **no per-member eligibility**; one `eligible` covers every roster member. Roster add/replace/substitution is an unprotected table write (OD-28/R-04 gap); a determination made before a swap stays `eligible` after it | #837/#846 re-read every participant DOB at planning and fingerprint the competitor ids (app layer, advisory). #860 per-path table records the roster paths as an open **release blocker** needing SQL (S5) |
| 6 | Eligibility decision | `updateCompetitionEntryEligibilityAction` + RLS (section 2) | writes any of 5 | Executed | Direct write possible, no reason/basis at DB level, evidence in unaudited `metadata` | #837/#846 validate in the action (bypassable) |
| 7 | Check-in session | `checkin/actions.ts` `recalculateSession` L59-60; `checkin/page.tsx` | ready only `eligible`/`waived`; blocked only `ineligible`/disputed | Executed (app) | Strict, but it sets a **session** status (`ready`/`blocked`/...), not an entry or heat-entry state. Heat entries have no check-in RPC; `checked_in` is a table-API value. Nothing ties session readiness to floor participation | None |
| 8 | Readiness page | `readiness/page.tsx` L133-134; `readiness/actions.ts` L180 | ready `eligible`/`waived`; review counts the rest | Executed (app, display) | Display, plus the generation input at actions.ts L180, which filters `confirmed` **and** `eligible`/`waived` (already strict, unlike the 10D planner) | #837 routes the input through the operational gate; #846 widens it |
| 9 | Legacy generation run | `create_competition_generation_run` snapshot L511 and `apply_competition_heat_plan` L112 (`20260620/21`) | **only `eligible`/`waived`** | Executed | Already strict; shows the project intent. Not the path used by 10D planner | n/a |
| 10 | Draft heat planning (provisional) | `floorPlanner.ts` `isSchedulableEntry`; `floorScheduleServer.ts` | not `ineligible`, status `confirmed` | Executed (app) | Allowed by R-15 item 6 **if marked provisional**; today it is neither marked nor limited | #837 tightens the planner to cleared-only (stricter than R-15 permits for internal planning); #846 same |
| 11 | Apply floor plan | `apply_competition_floor_plan` (10D L594-603), `_comp10d_copy_floor_plan` (L838; CF1 L1604) | not `ineligible` | Executed (DB) | Allows `unverified`/`needs_review` placement; copy keeps them into a new version | None |
| 12 | Heat-entry placement | `_comp10d_check_floor_heat_integrity` (10D.1 `20261112090000` L52-64, only on insert or a change of entry/heat); `cf1_od17_guard_heat_entry` (OD-17 M2, **flag OFF everywhere**, also rechecks un-scratch) | not `ineligible` | Executed (DB) | Provisional placement is permitted by policy; the defect is that nothing later distinguishes it, and nothing stops a provisional entry being placed into a heat that is **already staging/active** or a round already running (so it would never pass the start/call gates). Un-scratch and A6 reinstatement (definer, A6 L595) are rechecked only by dark M2. Status-only updates are not rechecked | None |
| 13 | Publish running order | `publish_competition_schedule_version` (10D L866-950) and `build_competition_schedule_snapshot` (L953) | **any**; no eligibility check at all | Executed (DB) | A published/live snapshot lists uncleared entries by name: "presented as competition-ready". **Versions are also directly writable** (`competition_manage` + `grant all`, 10A L509-521): a manager can INSERT/UPDATE `status = 'published'/'live'` without the function, and `live` is reachable only that way. The only status triggers are `compo1_guard_publish_during_run` and `cf1_guard_publish_final_heats` | None |
| 14 | Round start | `start_competition_round` (O1 L361); OD-17 M1 start trigger (flag OFF) | **none** (M1 checks P only, and only if OD-17 ON) | Executed (DB) | A round with uncleared couples can go `active` | None |
| 15 | Floor call / heat start | `advance_competition_floor_heat` (O1 L484), `_compo1_guard_heat_status` | **none** | Executed (DB) | `staging`/`active` heats include uncleared entries | None |
| 16 | Callback Final start guard | `cf1_guard_final_start` (A0, callback migration L885) | P: not `ineligible` (plus registration/refund) | Executed (DB) | `unverified`/`needs_review` pass | None |
| 17 | Callback advancement | `apply_competition_round_advancement` (L1236), `competition_round_advancement_preview` (L1115), A4/A4a, `cf1_guard_advancement_approval` | P | Executed (DB) | An uncleared couple can be advanced; the "minimum of two eligible couples" counts P-available, not cleared | None |
| 18 | Ballot submission / draft | `submit_competition_ballot`, `save_competition_callback_draft`, `_compe2_guard_mark_insert` (E2) | **none**: membership in `_compe2_round_entries` (non-scratched heat entries) only | Executed (DB) | Judges can mark uncleared entries; caught only at lock | None |
| 19 | Ballot lock | `lock_competition_round_ballots` (E2 L1153) -> `_cf1_require_roster_eligible(round,'lock')`, `_compe2_round_blockers` | P | Executed (DB, unconditional) | Blocks `ineligible` only | None |
| 20 | Calculate / approve | `calculate_competition_round` (F2 L874; A3 wiring), `approve_competition_round_result` | P (`'calculate'`,`'approve'`) | Executed (DB, unconditional) | scores and approves `unverified` couples | None |
| 21 | PV1 recompute | `_comppv1_*` (`20270215090000`) | none (recomputes from stored evidence) | Inspected | Inherits whatever the calculate step admitted; no independent roster check | n/a (covered by 20) |
| 22 | Result publication | `publish_competition_round_result` (F3 L352, check at L453) -> `_cf1_require_roster_eligible(round,'approve')` | P | Executed (DB, unconditional) | publishes placements of uncleared couples. (The "ineligible, refunded or cancelled" wording is A1 `_cf1_require_roster_eligible` L336; the `COMP_PUBLICATION_UNRESOLVED` messages in F3 concern ties and result versions) | None |
| 23 | Exclusion / withdrawal / scratch | A5 `request_round_exclusion` (A5 L297-299), A6 withdrawal (L284), `change_competition_entry_lifecycle` | P | Executed (DB) | **A5 exclusion REQUIRES P to be true** (`COMP_EXCLUSION_NOT_UNAVAILABLE`): an `unverified`/`needs_review` couple that has danced cannot be excluded today, and once S4 makes it block lock/calculate/approve the organizer has no recovery except falsely marking it `ineligible`. S4 must give A5 a `not_cleared` reason kind (6.3). Withdrawal/scratch/no-show keep working on every state | Needs S4 |
| 24 | Exports / public results | no competition export route exists under `src/app` (searched); public results via F3 publish, `competition_event_results_public`, `competition_my_results` | via 22 | Inspected | The only egress of results is gated by step 22; the schedule snapshot (13) is the other egress | None |

**Precise answer to "which paths fail to enforce eligibility":** steps 10 to 22 (all but the legacy generation path 9 and the advisory check-in display 7). The single predicate P is shared by steps 16, 17, 19, 20 and 22, so a clearance predicate wired beside it closes those five. Steps 13, 14, 15, 18 and the placement of step 12 have **no eligibility check at all** (or only `ineligible`) and need their own gates; step 13 also has a direct-write path.

### 4.1 Verdicts on PR 837 (OD-03) and PR 846 (OD-18) against the whole path

- **What they do well.** One pure gate (`evaluateEntryOperationalGate`) separates OD-02 adult-only (never waivable), age division, status and level, and event-policy waivers; `waived` never clears a classified division; unknown labels fail closed; stored DOB only, no birthdate returned or logged; the 846 fingerprint invalidates a determination when the division, labels or participant set changes. These are the semantics the SQL design below mirrors. Nothing here conflicts with OD-01/OD-02.
- **What they cannot do.** They are **application-layer only** and apply to the planner/readiness loaders. They do not touch step 11-22 database paths, so a direct RPC or table call, the day-of functions, ballots, calculation and publication are unaffected. They store evidence in unaudited mutable `metadata`. They make the planner **stricter than R-15 item 6** (provisional internal scheduling may include entries awaiting review); the correction below reconciles this by separating "plannable provisionally" from "executable".
- **Conclusion.** #837 and #846 do **not** close the R-15 blocker on their own. They are a necessary application half of S4 and the SQL half below makes them enforceable.

## 5. Open PRs read (read-only) and relationship to this slice

| PR | Relevance | Interaction |
|---|---|---|
| #835 (OD-02 refusal at checkout) | OD-02 route gate | Defines "adult verified" at registration. S5 owns the database boundary |
| #836 (OD-02 Option A minors design) | Future minors path | None: S4 keeps OD-02 absolute and fail-closed |
| #837 (OD-03, stacked on #835) | Organizer age gate, app layer | S4 consumes its validation semantics; the write moves to a definer RPC (section 6.4) |
| #846 (OD-18, stacked on #837) | Status/level criteria, fingerprint | Same; S4 re-derives the fingerprint server-side (section 6.2) |
| #848/#853/#855/#860 (relabel stack) | `docs/competition/r03-r09-wording.md` OD-02 per-path table | Already records staff-created entries and roster changes as unprotected release blockers needing SQL: cross-referenced, not duplicated; belongs to S5 |
| #856 (OD-31 guarded baseline) | Hosted U18/U18-S state, negative SQL suite | S4's write guard copies the U18 allowlist pattern (below); S7/S6 own the hosted reconciliation |
| #859 (R-07..R-11) | Studio scoring fail-closed controls | No overlap with eligibility; S4 gates sit before calculate |
| R-12 verification session (PR pending) | Operational-policy SQL verification (withdrawal, correction, reopen) | S4 does **not** duplicate those tests; section 8 lists only the eligibility-specific cases and cross-references R-12 for withdrawal-vs-publication behavior |
| #844 (OD-04 delete guard, slot `20270219090000`) | Event-delete guard | No overlap |

Migration slots in use by open work (from file lists of branches and PRs read): `20270215092000` (JC1), `20270215093000` (U18), `20270215094000` (U18-S), `20270219090000` (OD-04), and the design-PR range 20270219-20270227 recorded by the owner decisions. The coordinator's allocation for this phase is S4 = `20270301110000` (+ `20270301111000` ... `20270301119000`), S5 = `20270301120000` (+...), S3 = `20270301100000` (+...), S1/S2 = `20270301090000`. This design uses only the S4 range. **No migration file is created by this PR.**

## 6. Bounded correction recommendation (S4), design only

### 6.1 Principle: three states derived from existing facts, nothing stored that can go stale

Introduce one derived classification of an entry, computed on read, never persisted:

- **blocked**: unavailable under existing predicate P (not `confirmed`, `ineligible`, registration/order cancelled or refunded, refund evidence) **or** a known minor (S5 predicate).
- **cleared** (executable): not blocked, **and** the S5 predicate says every participant has a stored adult date of birth (unknown age is not cleared), **and** the entry holds a valid clearance (6.2).
- **provisional**: not blocked, not cleared (`unverified`, `needs_review`, or `eligible`/`waived` whose determination is missing, invalid or stale).

Rejected alternative: a stored `is_provisional` flag on heat entries. It must be backfilled (conflicts with R-15 item 11), can drift from the entry's status, and adds a write path. The derived form cannot drift: a heat entry is "provisional" exactly while its entry is not cleared, so a roster change, a status downgrade or a stale determination automatically makes the placement provisional again.

Provisional assignments are **plannable** (draft schedule versions, 10D placement, copy) and **never executable**: they cannot be published as the live running order, started, called, balloted, advanced, scored, placed or published. `ineligible` stays blocked everywhere; withdrawal/exclusion/scratch stay available for every state.

### 6.2 Evidence: an append-only determination table instead of `metadata`

New table (file `20270301110000_..._r15_eligibility_clearance_core.sql`), sketch:

```sql
create table public.event_competition_eligibility_determinations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  entry_id uuid not null,                      -- plain value, survives entry deletion like entry_changes
  outcome text not null check (outcome in ('unverified','eligible','needs_review','ineligible','waived')),
  reason_code text not null,                   -- validated against the allowed list inside the RPC (mirrors #837/#846)
  waiver_category text null,                   -- required iff outcome = 'waived'; allowed list = the three event-policy categories of #846
  criteria text[] not null default '{}',       -- subset of {age_division,status,level}, as #846
  fingerprint text not null,                   -- sha256 hex of division id + age/skill/role labels + sorted (competitor_id, participant_role)
  decided_by uuid not null,
  decided_role text not null,
  decided_at timestamptz not null default now(),
  request_id uuid not null unique
);
-- append-only: reuse protect_competition_history_evidence (ENABLE ALWAYS, update/delete/truncate refused), RLS select for can_manage_event_competition.
```

Why server-side fingerprint: the SQL function recomputes it from live data every time clearance is read, so the 32-bit client FNV in #846 becomes an advisory duplicate, and a roster substitution, division move or label change makes any earlier determination **stale** with no trigger needed. This also gives per-member coverage for teams: the participant set is inside the fingerprint, so any added or replaced member invalidates the team's clearance until re-determined.

Clearance of an entry = the **latest** determination row for the entry such that:
`outcome = 'eligible'` and fingerprint matches; **or** `outcome = 'waived'` with a `waiver_category` in the permitted event-policy list, fingerprint matches, and the entry requires **no** classification criteria (age division, status, level), exactly the #846 rule that a waiver never clears a classified division; and in both cases the S5 adult predicate is true. A `waived` determination can never lift OD-02 or a mandatory body requirement because the adult predicate is evaluated independently of the outcome.

Legacy rows (status `eligible`/`waived` with no determination row): **provisional**, never auto-promoted, with no exception. (An earlier draft accepted `eligible` rows backed by an `eligibility_change` audit row; the independent review showed that would accept exactly the unaudited, basis-less direct writes this finding condemns, carries no fingerprint, and the audit trigger does not fire on INSERT. It is dropped; hosted data is empty so nothing is lost.) Clearance uses the **latest determination row overall** for the entry, and requires the entry's current `eligibility_status` to equal that row's outcome.

### 6.3 Predicates and gate wiring

New helpers (core file, additive, no behavior change by themselves):

- `_r15_entry_clearance_reason(p_entry_id uuid) returns text`: NULL when cleared, else one of `entry_provisional_unverified`, `entry_provisional_needs_review`, `entry_determination_missing`, `entry_determination_stale`, `entry_waiver_not_allowed`, `entry_age_not_established`. It never duplicates P.
- `_r15_entry_executable_reason(p_entry_id uuid) returns text` = `coalesce(_cf1_entry_unavailable_reason(p_entry_id), _r15_entry_clearance_reason(p_entry_id))`.
- `competition_entry_clearance_state(p_entry_id uuid) returns text` ('blocked'|'provisional'|'cleared') for readers (UI badge, readiness).
- S5 dependency: the adult predicate is S5's. Slot order puts S4 (`...110000`) before S5 (`...120000`), so S4 must call it through a guarded wrapper (`to_regprocedure` check; **absent means "not verified" = not cleared**, fail closed) or the coordinator must reorder. This is flagged as decision D-R15-1.

Gates (file `...111000_..._r15_executable_gates.sql`). The existing P wiring is kept and extended rather than replaced, because P is shared with exclusion, withdrawal and the placement guard, which **must stay lenient**:

| Stage | Existing | Change |
|---|---|---|
| `_cf1_round_roster_problems` (feeds `_cf1_require_roster_eligible` for lock, calculate, approve, F3 publish) | P over `_compe2_round_entries` | use `_r15_entry_executable_reason` (reason `entry_not_cleared` + sub-reason in the detail JSON) |
| Callback Final minimum of two (`_cf1_eligible_roster_count`, `_cf1_count_available_entries`) | P-available | count **cleared** only (A6/A0 callers pick up the change; verify no caller needs the P-only count: A6 withdrawal count of "remaining eligible couples" should be cleared) |
| `cf1_guard_final_start`, `apply_competition_round_advancement`, preview | P | add clearance via the same helper |
| Round start (`scheduled -> active`) | OD-17 M1 only, flag OFF | new **unconditional** BEFORE UPDATE OF status trigger on rounds, runs after O1's guard: every non-scratched ranking-set entry must be cleared |
| Floor call (`heats.status -> staging/active`) | none | new trigger: every non-scratched entry of the heat must be cleared |
| Heat-entry floor states (`scheduled -> checked_in/danced`) | `danced`/`disqualified` writer guard exists only on U18 branches, not at the evidence base; nothing else | transition into `checked_in` by a client requires cleared. Definer writers (A6 reinstatement, R2 cascades) are NOT exempt from the **placement** rule below even though exempt from this one |
| Publish running order and schedule-version status (`published`/`live`) | none; versions are directly writable | **trigger on INSERT and UPDATE of status** (not only the publish function, because direct writes reach `live`): no non-scratched placement may be provisional or blocked (`COMP_R15_PROVISIONAL_ASSIGNMENT`). A downgrade **after** publish is handled by a recovery rule: the version is not auto-unpublished; the organizer must scratch/withdraw the entry or re-determine, and the round start/floor-call/lock gates still stop execution |
| Ballot mark insert | membership only | optional early refusal for uncleared entries; lock-time refusal is mandatory and sufficient |
| Placement (`_comp10d_check_floor_heat_integrity`, `cf1_od17_guard_heat_entry`, `apply_competition_floor_plan`) | P | P stays the availability test, **plus a new placement-context rule for provisional entries**: a provisional entry may be placed only in a `draft` schedule version, a `scheduled` heat and a `draft`/`scheduled` round (also on un-scratch and A6 reinstatement, definer or not). Otherwise a provisional entry could join a heat that is already staging/active and never meet the start/call gates |
| A5 exclusion, A6 withdrawal availability, scratch/lifecycle | P (A5 additionally REQUIRES P true) | withdrawal/scratch/no-show unchanged. **A5 changes**: `request_round_exclusion` accepts a couple that is not cleared (new reason kind `not_cleared`, mapped in `_a5_cf1_require_reason_kind`), so a provisional couple that danced can be excluded instead of freezing lock/calculate/approve. Reinstatement symmetric |

Implementation technique: functions changed by exact-fragment replacement with md5 pins before and after, as A3/F3/HL1/PV-1/OJ-1 did (`oj1_pin_replace`), so a concurrent edit by another slice fails the preflight rather than silently overwriting. Triggers are used where possible so large O1/E2 bodies are not rewritten.

Additional rules from the independent review (all binding on the implementation):

- **Recovery, no mass-freeze.** Every route that makes an entry non-cleared must have an organizer recovery: re-determine through the RPC, withdraw/scratch, or A5 exclusion (above). Division label and participant edits are refused once any round of that division is `scheduled`/`active`/later, and the fingerprint covers structured criteria and participant (competitor, role) set rather than free-text labels where possible, so a label typo fix does not silently invalidate a running round.
- **Known minors.** The `_r15_*` reason list includes `entry_age_blocked` (S5 `blocked_under_18`) and `entry_age_not_established` (`unknown_age`). A known minor is never provisional: S5's participant guard refuses it at placement; S4 additionally treats it as blocked in `competition_entry_clearance_state`. Unknown age is provisional only.
- **Locking.** The RPC takes the entry row FOR UPDATE and checks `entry.event_id`. Start, floor-call and publish gates take the entries FOR SHARE in id order and then re-read (A3/M1 order). New triggers on `event_competition_rounds` are named to sort after `compo1_guard_round_status` (BEFORE triggers fire alphabetically).
- **Messages.** `COMP_ROSTER_ENTRY_UNAVAILABLE` text currently says couples are "ineligible, refunded or cancelled"; for S4 reasons the detail JSON carries the reason and the text is updated to say "not cleared, ineligible, refunded or cancelled".
- **Registration-cancel sync** withdraws entries without scratching placements (bridge L174-181); a blocked placement then refuses republishing until scratched. The publish trigger ignores placements of entries that are withdrawn/scratched-parent, and the error names them so the organizer can scratch.
- **Waivers.** Fee, documents and scheduling are event-policy matters, not eligibility criteria; a waiver is never accepted for a division with age, status or level criteria, for any entry with a non-'allowed' S5 result, or on a body-sanctioned declaration (OD-01) because no mandatory-body-requirement model exists in SQL: the RPC refuses `waived` whenever the event declares NDCA/UCWDC/WSDC.

Error contract (extends `_cf1_error_codes`): `COMP_R15_ENTRY_NOT_CLEARED` (P0001, detail JSON `{stage, entries:[{entry_id, reason}]}` like A1), `COMP_R15_PROVISIONAL_ASSIGNMENT` (publish of a running order), `COMP_R15_ELIGIBILITY_WRITE_REFUSED` (42501), `COMP_R15_DETERMINATION_INVALID` (23514). Existing `COMP_ROSTER_ENTRY_UNAVAILABLE` callers (UI mappers) keep working because the enlarged problem list is returned under the same code for the A1 stages; the new code is used for the new stages.

### 6.4 Write path: one audited RPC, direct client writes refused

RPC `set_competition_entry_eligibility(p_entry_id, p_outcome, p_reason_code, p_waiver_category, p_criteria, p_request_id)` (SECURITY DEFINER, `can_manage_event_competition`, replay by `request_id`): validates the combination exactly as #837/#846 do (`eligible`/`waived` refused unless the S5 adult predicate holds; no waiver for a classified division; waiver needs a permitted category; reason codes constrained), inserts the determination row, sets `app.competition_entry_change_type = 'eligibility_change'` and `app.competition_entry_change_reason` from the reason so the existing audit trigger records the **why**, then updates the entry. The actor role is stored in the row.

Guard (file `...112000_..._r15_eligibility_write_guard.sql`): **AFTER INSERT OR UPDATE** row trigger on entries (not BEFORE, and not column-listed), **SECURITY INVOKER**, comparing OLD and NEW so a change made by another trigger is also seen; same owner-role allowlist as the U18/U18-S guards (`current_user in ('postgres','supabase_admin')` passes, so SECURITY DEFINER writers - registration start, the sync trigger, this RPC - are unaffected). It refuses (a) any client change of `eligibility_status` or of the `eligibility_determination` key in `metadata`, and (b) a client INSERT with `eligibility_status <> 'unverified'`. The migration also revokes TRIGGER on `event_competition_entries` from `anon, authenticated` (as U18 did), because a client holding the default TRIGGER privilege could otherwise add a competing trigger. This closes staff-created `eligible` entries and the unaudited metadata edit. The RPC takes the entry row FOR UPDATE, checks `entry.event_id`, and sets the audit GUCs with `set_config(..., true)` (transaction-local).

### 6.5 Application dependencies

1. `registrations/actions.ts`: replace the direct update (and the #837/#846 metadata write) with a call to the RPC; map the new error codes. **Coordinate with #837/#846 owners; do not edit their files from this slice.**
2. Planner and readiness loaders: keep planning of provisional entries but label them (`provisional` badge via `competition_entry_clearance_state`); #837/#846 currently drop them entirely, which is stricter than R-15 item 6 and should be relaxed to "plannable, not publishable".
3. Day-of, ballot and results screens: surface `COMP_R15_*` errors with the entry names (never DOB).
4. Check-in: session readiness stays strict; add the heat-entry gate so session `ready` and floor state agree.
5. Release order (revised after review): **(1) core file `...110000` (table, predicates, RPC; additive, no behavior change), (2) app switch to the RPC, (3) gates `...111000`, (4) write guard `...112000`.** Gates before the app switch would leave nothing able to clear entries and the old app writing a status that no longer clears. Rollback in reverse.

### 6.6 Compatibility with existing rows, no automatic conversion

The migration contains **no DML on `event_competition_entries`, `event_competition_heat_entries` or `event_competition_entry_changes`.** It creates a table, functions and triggers only. Every existing `eligibility_status` value, every audit row and every determination in `metadata` is left exactly as is. Existing `eligible`/`waived` rows without evidence are classified provisional by the derived predicate rather than rewritten; existing `unverified`/`needs_review` rows are never promoted. Preflight in the migration refuses to continue if any round of any event is `ballots_locked`, `calculated`, `approved` or `published` and holds a non-cleared couple (so activation never silently strands a published result); on current hosted data the check is vacuous (section 3). Preflight (read-only, `raise notice` counts, no data change) reports: counts of `unverified`/`needs_review` entries and of provisional entries by round status (`scheduled`, `active`, `ballots_locked`, `calculated`, `approved`, `published`, `complete`) and by schedule-version status (`published`, `live`), because these strand once the gates apply; it **refuses** to continue only when a round of an event with OD-17 enforcement ON holds such an entry. Reopen/correction edges (published -> ballots_locked -> recalculate) are not gated, so legacy published rounds keep their recovery path (N36).

### 6.7 Rollback implications

`rollback/20270301112000_..._rollback.sql` drops the write guard; `...111000_..._rollback.sql` restores the pinned original bodies of the redefined A1/F3-wired helpers (md5-verified) and drops the new triggers; `...110000_..._rollback.sql` drops the RPC and helpers and **refuses while the determination table holds any row** (same posture as the OD-17 rollback that refuses while audit rows exist), because dropping it would erase clearance evidence. App rollback: redeploy the previous build; the direct-write path works again only after the guard is dropped, so roll back the guard first. No data repair is needed because nothing was converted.

### 6.8 Open decisions for the coordinator/owner

- **D-R15-1:** S5's adult predicate sorts after S4's slot: reorder, or accept the guarded fail-closed wrapper.
- **D-R15-2:** unknown (not stored) age: this design lets such an entry be **provisional** (plannable, never executable) and a **known minor** be **blocked** at every stage including planning. If the owner wants unknown-age entries blocked from planning as well, change one clause in `_r15_entry_clearance_reason`.
- **D-R15-3:** whether the early ballot-mark refusal ships in S4 or only the lock-time gate.
- **D-R15-4:** who counts as an "authorized organizer or designated official" (OD-18): today any event manager; a role table or the Suite owner/admin role would be a separate slice.
- **D-R15-5:** the permitted waiver categories (documents, fee, scheduling in #846) are an engineering proposal pending owner confirmation that these are the only "explicitly waivable" Studio policies.

## 7. What provisional scheduling looks like to a user (acceptance wording, not copy approval)

A draft running order may show uncleared couples with a "Provisional: awaiting eligibility review" marker and a count. The **Publish running order** and **Start round** actions are disabled with the reason "N entries have not been cleared by the organizer", naming the entries. Nothing says or implies DanceFlow verified age, status or level (OD-03/OD-18 disclosure stays).

## 8. Negative and regression test specification (NOT EXECUTED: status PENDING)

Execution status: **PENDING.** This slice authorizes specification only; no local isolated Postgres run was started and no heavy-lock ticket was filed. Tests are to be added to a future S4 implementation PR under `src/lib/supabase/migrations/sql-tests/` (suite name `test_T_competition_r15_eligibility_clearance.sql`), run on a dedicated local Postgres per the heavy-lock FIFO rules, sharing a fixture slot with the OD-31/R-12 sessions rather than opening a new ticket. Do not duplicate the R-12 withdrawal/correction/reopen SQL tests; reuse `fixtures/competition_round_ready.sql` and add clearance variants.

Common setup per case: a confirmed, paid couple entry in a ballot-ready scored round plus a second cleared couple (so the callback-Final minimum of two is controllable). Variants: individual, couple, **team (5 members)**, Pro/Am. Age variants: all adult DOB; one member without DOB (unknown); one member under 18; division with an age label; division without classifications.

| ID | Case | Action | Expected |
|---|---|---|---|
| N01 | entry `unverified` | publish a running order containing it | refused `COMP_R15_PROVISIONAL_ASSIGNMENT` |
| N02 | entry `needs_review` | start the round | refused `COMP_R15_ENTRY_NOT_CLEARED` stage `start` |
| N03 | entry `unverified` | advance heat to staging/active (floor call) | refused |
| N04 | entry `needs_review` | transition heat entry to `checked_in` as a client | refused |
| N05 | entry `unverified` | `lock_competition_round_ballots` | refused `COMP_ROSTER_ENTRY_UNAVAILABLE`/R15 with entry id and reason |
| N06 | entry `unverified` | `calculate_competition_round`, then `approve` | refused at each stage |
| N07 | entry `needs_review` in a callback round | `apply_competition_round_advancement` | refused; and the callback Final minimum counts only cleared couples (one cleared + one `needs_review` = below minimum, `COMP_ROSTER_BELOW_MINIMUM`) |
| N08 | entry `unverified` | `publish_competition_round_result` | refused; no publication row |
| N09 | entry `ineligible` | every stage above | still refused (regression of today's behavior) |
| N10 | `waived` without a determination row | any executable stage | refused `entry_determination_missing` |
| N11 | `waived` with a category not in the permitted list | RPC call | `COMP_R15_DETERMINATION_INVALID` |
| N12 | `waived` on an age-restricted/classified division | RPC and, via legacy row, executable stage | refused `entry_waiver_not_allowed` |
| N13 | `waived` or `eligible` on an entry with one under-18 participant | RPC and executable stage | refused; waiver cannot lift OD-02 |
| N14 | `eligible` where one participant (team member or alternate) has no stored DOB | executable stage | refused `entry_age_not_established` (fails closed) |
| N15 | team entry cleared, then a member is replaced/added by direct table write | executable stage | refused `entry_determination_stale` (fingerprint) until re-determined |
| N16 | client (authenticated manager) `update ... set eligibility_status = 'eligible'` | direct table API | `COMP_R15_ELIGIBILITY_WRITE_REFUSED` |
| N17 | client edits or deletes `metadata.eligibility_determination` | direct table API | refused |
| N18 | client inserts an entry with `eligibility_status = 'eligible'` | direct table API | refused |
| N19 | legacy `eligible` row with no determination and no `eligibility_change` audit row | executable stage | refused (never auto-promoted) |
| N20 | entry `eligible`, determination stale after division label change | executable stage | refused until re-determined |
| N21 | double submit of the RPC with the same `request_id` | RPC | replay, one determination row |
| N22 | determination rows | update/delete/truncate | refused (append-only) |
| N23 | rollback scripts | apply then roll back on a populated fixture | no status or audit row changed; the core rollback refuses while determination rows exist, the gate and guard rollbacks never refuse |
| N24 | A5 exclusion of an `unverified` couple that danced | exclusion request | accepted with reason kind `not_cleared` (today refused `COMP_EXCLUSION_NOT_UNAVAILABLE`) |
| N25 | `eligible` -> `needs_review` after round start | lock/calculate; then organizer recovery (re-determine or exclude) | blocked, then recoverable by both routes |
| N26 | division label edit or participant change mid-round | executable stage | stale determination, recoverable by re-determination |
| N27 | direct insert, un-scratch or A6 reinstate of a provisional entry into a heat that is staging/active, a round that is active, or a published/live version | direct write and RPC | refused (provisional placement only in `draft` versions, `scheduled` heats, `draft`/`scheduled` rounds) |
| N28 | direct INSERT or UPDATE of a schedule version to `published`/`live` containing a provisional placement | table API | refused by the status trigger (INSERT and UPDATE) |
| N29 | write-guard bypasses: client-created trigger, UPDATE that does not name the column, change made by another trigger | table API | refused / TRIGGER privilege revoked |
| N30 | participant DELETE, `competitor_id` UPDATE, `team_member`<->`alternate` role change, per-dance (`individual`/`choose_count`) entries | executable stage | stale (fingerprint covers set and role) |
| N31 | RPC validation: entry of another event, non-manager caller, withdrawn or `ineligible` entry, GUC leak across pooled connection | RPC | refused / no leak |
| N32 | append-only table under `session_replication_role = replica`; event delete with determination rows (OD-04 interaction) | table / delete | append-only holds; event delete not blocked (plain-value event/entry ids like `entry_changes`, no `on delete restrict`) |
| N33 | race: RPC vs lock/start; participant swap vs lock | concurrent sessions | serialized (FOR SHARE in id order then re-read, as A3/M1) |
| N34 | known minor (S5 `blocked_under_18`) in a draft schedule | placement | refused by S5's participant guard; a known minor can never be provisional |
| N35 | callback Final minimum with one provisional and one withdrawn couple | A6/A0 count | below minimum (counts cleared only) |
| N36 | published/complete round holding legacy uncleared entries after apply | reopen / correction path | still available (gates do not apply to reopen/correction edges); preflight reports them |

Legitimate flows that must keep working (regression set):

| ID | Flow | Expected |
|---|---|---|
| P01 | `eligible` entry with a valid determination, adult participants, unclassified division | passes every stage through publish |
| P02 | `waived` entry with a permitted category, unclassified division, adult participants | passes every stage |
| P03 | team entry cleared with all members adult-verified | passes; after re-determination following a substitution it passes again |
| P04 | provisional entries placed in a draft schedule version, moved, copied to a new draft | allowed (R-15 item 6) |
| P05 | withdrawal, scratch and no-show of an `unverified` entry; A5 exclusion of a **provisional** couple that danced (after S4 extends A5, see 6.3) | allowed (never gated by clearance) |
| P06 | registration creates `unverified` entries via the service-role RPC with the write guard installed | allowed (definer/owner path) |
| P07 | eligibility RPC from the app writes status + determination + audit row with reason | one entry_changes row with `reason` populated |
| P08 | existing A1-A6, F2, F3, OD-17, 10D/10D.1 suites | every existing suite seeds `eligible`/`waived` without determination rows and would fail the new gates; fixtures must insert determination rows as owner (shared `r15_clear_entries()` helper). U18/U18-S exist only on `origin/claude/cf1-u18-*` branches, not at the evidence base |

Application-layer vitest additions (light, single file each): planner keeps provisional entries but `ready === false` for execution; RPC action maps error codes; readiness page counts provisional separately.

## 9. Register and tracker entry; closing criteria (task 12)

Recorded OPEN as register entry `DFPOL-R15-ELIGIBILITY-ENFORCEMENT` (`verification_status: inconsistent`) and as a release-blocker row in `docs/competition/governance/audit/TRACKER.md`. Closing criteria: (1) S4 core, gates and write guard merged and applied through the owner-approved path; (2) the N and P suites above executed green on an integrated release candidate that also contains JC1, U18, U18-S, S5 and the OD-02/03/18 app layer; (3) the same candidate passes the end-to-end Competition acceptance run with an `unverified` and a `needs_review` entry present, proving they cannot reach floor, ballots, advancement, scoring or publication, while provisional planning works; (4) independent security review of the RPC and write guard; (5) the owner records acceptance. Until then the entry stays `inconsistent` and the blocker OPEN. Policy ratification (R-15) and implementation verification are tracked separately: the first is complete, the second is not.

## 10. Independent review

See the review note appended in the PR description; findings are not baked into this document so the reviewer's view stays independent.

An independent reviewer (fresh agent, investigated the code before reading this document) found eight factual discrepancies and nine design flaws, all addressed in this revision: A5 exclusion requires P (recovery route added), placement into running heats (placement-context rule), direct schedule-version writes (INSERT/UPDATE trigger), write-guard bypass (AFTER trigger plus TRIGGER revoke), `legacy_explicit` removed, release order and preflight, locking, known-minor consistency, and test gaps (N24-N36). Residual open items are D-R15-1..5 above.
