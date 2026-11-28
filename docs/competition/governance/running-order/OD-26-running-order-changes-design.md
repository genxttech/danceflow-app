# OD-26 design: controlled, audited mid-event running-order changes

Status: **DRAFT design, docs only, for owner confirmation of the design.** Date: 2026-11-23. Nothing here is built, applied, merged, deployed or
activated. Governed by [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md); sources pinned in
[governing-body-source-registry.md](../../governing-body-source-registry.md). Companion document:
[OD-26-migration-impact-and-test-plan.md](OD-26-migration-impact-and-test-plan.md).

**Owner decision (2026-11-23): OD-26 Option A** (decision text in the consolidated list, PR #795): controlled, audited mid-event running-order
changes, as a design-level draft for a future Studio/Custom capability. Authorized: design, migration impact assessment, targeted test plan,
independent review. **Not authorized:** SQL guard implementation, workflow activation, SQL apply, implementation merge, deployment, notification or
SMS activation, public activation, outreach. OD-01 (PR #832) and each governing body's authorization boundaries are preserved: **no body rule is
applied to a Studio/Custom event as if it were mandatory, and no body-specific authority is assumed.**

Rule citations use printed page numbers (registry convention). Quotes are short. Every passage cited below was re-read in the pinned PDF on
2026-11-23 (SHA-256 prefixes checked: NDCA `d1b73e1f`, UCWDC Couples `8a45ee58`, Scoring Format `44290a06`, WSDC `140caae7`).

## 1. Summary of the proposal

1. **Do not republish a schedule version mid-event.** Today the only way to change the running order is a new version, which copies scoring heats as
   *new rows* with status `scheduled`. That erases day-of progress and orphans ballots and results (they reference the scoring-heat row). The O1
   guard `COMPO1_RUN_IN_PROGRESS` refuses it, and that guard stays.
2. **Re-sequence in place.** A new single RPC changes only `event_competition_floor_heats.heat_number` of **unstarted** floor heats in the **live**
   version. Scoring-heat rows, entries, assignments, ballots, results and execution records are never touched, so their identity is stable.
3. **Version the order, not the schedule.** Each accepted change appends an immutable *running-order revision* (before/after order, full snapshot,
   exact diff, actor, reason, timestamp). The original publication snapshot stays untouched as revision 0.
4. **Validate everything atomically** in the same transaction that writes (one RPC, all-or-nothing, optimistic revision check plus row locks),
   with a read-only **preview** that returns the same findings and a checksum that the apply step must match.
5. **Authority is explicit and event-level.** A new grant table; managers do not get it by default; no grant means nobody can reorder (fail closed).
6. **Safe operational cutoff.** Called, active and completed heats are frozen; a configurable *commit window* after the frontier (and any heat with
   checked-in entries) needs a higher authority plus an acknowledgment bound to the preview.
7. **Notifications are designed only.** No code path sends anything; the design states the dependency on the Twilio/TW-4F gates and that delivery
   needs separate authorization.
8. **Body profiles are future work and are blockers**, not behavior: NDCA timetable/Chairman/30-minute/1:00 a.m. rules, UCWDC Contest Coordinator
   and heating rules, WSDC findings. They are recorded in the rule register as NOT IMPLEMENTED.

## 2. Current state (exact guards and dependencies)

How the running order works today (SIMPLE planning; verified at `origin/release/website-embeds` 49dbaee1b):

| Thing | Where | Behavior relevant to OD-26 |
|---|---|---|
| Numbered floor heat | `event_competition_floor_heats` (10D, `20261111090000`) | `heat_number` is the running order, contiguous `1..n` per version, `unique (schedule_version_id, heat_number) deferrable initially immediate`; `floor_id` null means one shared floor; `planned_start_at`/`planned_duration_seconds` exist but nothing in the app writes them yet (the planner and UI only read `planned_start_at`). |
| Scoring heat | `event_competition_heats` | Status check: `draft, scheduled, staging, active, complete, cancelled`; has `lock_state` `open/locked/certified` (10A). Placed in one floor heat via `floor_heat_id`. Ballots (E2) reference `heat_id`. |
| Running-order version | `event_competition_schedule_versions` | Status `draft, review, published, live, superseded, archived`. `publish_competition_schedule_version` supersedes the previous published/live version and writes one `event_competition_schedule_publications` row with a frozen `snapshot` (`unique (schedule_version_id)`, `unique (event_id, publication_number)`). No application code reads that snapshot today (grep of `src`, 2026-11-23). |
| Floor-heat frozen once published | `_comp10d_guard_floor_heat` (10D; redefined by CF1-A0 with an anchor replacement that adds `_cf1_auth_apply_floor_heat` for appending Final heats) | `COMP10D_SCHEDULE_PUBLISHED` on any update or delete of a floor heat whose version is not a draft. |
| Heat entries/dances frozen | `_comp10d_guard_heat_child` (also CF1-redefined), `_comp10d_guard_heat_delete` | Assignment changes only in a draft version; status updates (check-in, scratch, danced) stay allowed. |
| Move/insert RPCs | `move_competition_floor_heat`, `insert_competition_floor_heat`, `move_competition_scoring_heat` and friends | Draft versions only (`_comp10d_require_draft` raises `COMP10D_SCHEDULE_PUBLISHED`). |
| Publish during run | `_compo1_guard_publish_during_run` (O1, `20270106090000`) | Refuses publishing/reopening a version once any heat of the event is `staging`, `active` or `complete`: `COMPO1_RUN_IN_PROGRESS`. Takes the per-event day-of lock first. |
| Heat identity | `_compo1_guard_heat_status` (O1) | A heat in `staging/active/complete` cannot change round, division, floor heat or version (`COMPO1_HEAT_FROZEN`); status changes need an O1 audit row from the same transaction. |
| Day-of writer | `advance_competition_floor_heat` | `scheduled -> staging -> active -> complete`, forward only; per-event advisory lock `_compo1_lock_event`; scoring heats locked `ORDER BY id FOR UPDATE`; requires `lock_state = 'open'` and round `active`; at most one `active` heat per floor; **does not require heats to be called in number order.** |
| Execution record | `event_competition_round_transition_events` (append-only) | Written by every O1 transition with actor, request id and transaction id. This, not `heat_number`, is the authoritative record of what actually ran when. |
| Who may act | `can_manage_event_competition` | True for platform admins, studio owners/admins, and organizer owners/admins/**staff**. Too wide for a schedule change during an event (requirement 7). |
| Ballots | E2 `_compe2_guard_ballot_insert` | Gated on the **round** being `active`, not on the **heat** having run. A ballot for a never-called heat of an active round is technically accepted, so "unstarted" must also be proven by the absence of ballots/marks (section 5). |
| Finals appended mid-event | CF1 callback advancement (dark, flag-gated) | `apply` inserts a new floor heat at `max(heat_number)+1` in the **live** version through `_cf1_auth_apply_floor_heat`. The live order already changes after publication in that one case; the revision design must account for it (section 9). |

### 2.1 The open O1 decision (quoted) and its proposed resolution

[o1-day-of-operations.md](../../o1-day-of-operations.md), "Open owner decisions", item 3:

> 3. Mid-event running-order edits: currently blocked after the first heat is called (see guard above). Allow with status carry-over?

**Proposed resolution (pending owner confirmation of this design):**

- **Yes, allow controlled mid-event changes (OD-26 Option A), but not by "status carry-over".** Carrying heat status across a new version means
  copying heats into new rows and re-mapping statuses, which breaks the identity that ballots, results, recusals and the O1 audit trail rely on, and
  forces `COMPO1_RUN_IN_PROGRESS` to be loosened for every publish. Rejected.
- **Keep** `_compo1_guard_publish_during_run` and `_compo1_guard_heat_status` **unchanged.** The mid-event path never publishes a version and never
  updates a scoring heat row.
- **Change** exactly one guard path: `_comp10d_guard_floor_heat` gets a second, evidence-based bypass, narrower than CF1's, that allows only an update of
  `heat_number` backed by a revision row written in the same transaction (section 6.6).
- Round-level and structure-level changes (adding or removing heats, moving a scoring heat to another floor heat, splitting a heat) remain
  **out of scope**; items 4 and 5 of the O1 open list are untouched.

## 3. Rule evidence

Governance requires source, edition, effective date and section for each rule-dependent decision, a distinction between mandatory, recommended,
permitted and discretionary language, and no cross-body borrowing. Studio/Custom behavior below is **DanceFlow policy** and is labelled so.

### 3.1 NDCA (Rule Book June 2026, Master v1, effective 2026-06-01; SHA `d1b73e1f504d2f84...`)

| Ref | What it says (paraphrase unless quoted) | Class |
|---|---|---|
| III.D.1 (p.19) | The Organizer draws up a timetable and makes it available to all competitors before the competition, and is responsible for adhering to it so that individual events neither start more than 30 minutes early nor run more than 30 minutes late. Quoted: "The first event of the day shall not start ahead of the scheduled time." The same item also requires panels to be appointed before the event begins and to be strictly adhered to except in emergency (see OD-17). | mandatory (Organizer) |
| III.D.1.a (p.19) | Quoted: the last final of the evening "must take the floor before 1:00 a.m." | mandatory (Organizer) |
| III.D.1.a(1) (p.19) | The organizer is penalized for every round of every event taking the floor after 1:00 a.m., a per-couple amount that the organizer pays to the impacted couples on the day. | mandatory (a monetary matter **between organizer and couples**) |
| IV.C.3 (p.27) | The Chairman of Adjudicators is responsible for observance of the established timetable "or alterations to the established timetable if required". | mandatory (Chairman duty) |
| IV.C.7 (p.27) | Quoted: "changes in program scheduling, the Chairman's decision shall be final." | mandatory (Chairman decision) |
| V.B.2 (p.31) | Competitors must attend at least one-half hour before the advertised time of their events. Quoted: "Organizers are not required to delay the program for the benefit of latecomers." | mandatory (Competitor); informs the commit window |

**Findings.** (a) III.D.1 puts timetable authorship and adherence on the **Organizer**, IV.C.3 and IV.C.7 put observance, alteration and the final
word on schedule changes on the **Chairman**; who may *initiate* a change and whether Organizer concurrence is needed is not stated: **requires
interpretation** (Q1). (b) The text does not define "event" for the 30-minute limit (a DanceFlow division, round or floor heat?) or "evening"
for 1:00 a.m.: **requires interpretation** (Q2). (c) None of this can be evaluated without a **time model** (planned start and duration per floor
heat, event time zone, actual start timestamps). Planned times are not authored today. (d) Nothing read says the Organizer must notify
competitors of a changed timetable; "make it available ... prior to the competition" is a pre-event duty. Not found is not proof of absence.

### 3.2 UCWDC (Couples 2026 v1-26-2026, effective 2026-01-26, SHA `8a45ee58d189e65d...`; Scoring Format v16.9b, effective 2026-01-01, SHA `44290a06d14c3080...`)

| Ref | What it says | Class |
|---|---|---|
| Couples II.P.3 (p.14) | Contests post the heats for all divisions, but quoted: "the exact heat order is not guaranteed". A competitor who fails to report or answer the Floor Coordinator's calls for a specific heat is disqualified from that dance category (II.P.3.a). | permission; **the order may change** |
| Couples II.P.1 (p.14) | For heated divisions competitors "should" report to the Floor Coordinator 30 minutes before the division's first heat, earlier if the schedule says so. | recommended |
| Couples II.N.1 (p.13) | Decisions of the contest judges, the Contest Coordinator and the Event Director are final. | authority statement; scope for schedule decisions not stated |
| Scoring Format, Heating Rules item 3 (p.1) | A division that needs several heats must run them contiguously, one right after another. | mandatory ("must") |
| Scoring Format, Heating Rules item 4 (p.1) | Quoted: "Whenever possible", of a division's heats the smaller precedes the larger so that scratches let the **Contest Coordinator move up** contestants to re-balance. | recommended |
| Scoring Format, Heating Rules item 1, 2, 7 | Randomization by the scoring system; heat sizes within one of each other; contiguity restated for co-mingled divisions. (Coordinated with OD-25.) | item 1 mandatory language; item 2 and 7 "should" |

The Scoring Format Heating Rules items 3, 4 and 7 are on printed page 1 (confirmed by the independent re-read; consistent with the OD-25 PR #850). A keyword
search of the Couples rules and the Scoring Format for timetable, schedule, delay, late, running order, start time, midnight and curfew found no timetable
adherence, lateness, cut-off or change-notification rule beyond the rows above (NOT SPECIFIED IN PROVIDED SOURCE; a keyword search is not an end-to-end
read).

### 3.3 WSDC (Registry Event Rules Version 2026.1C, effective 2026-01-17, SHA `140caae75a8dd337...`)

Searched the full extracted text for timetable, schedule, heat, order, restart, start, begin, time, late, delay, ahead, behind, announce, post, publish,
notify, cancel and reschedule, then read every hit in context.

| Ref | What it says | Relevance |
|---|---|---|
| 1.1 item 9 (p.4) | A member's event must post event rules, code of conduct and a "Tentative Schedule" on its website 90 days before the event. | Pre-event posting duty. Not a mid-event rule. NOT IMPLEMENTED. |
| 3.1 item 8 (pp.11-12) | A contest "restart" (incorrect song, clothing malfunction, sound or lighting issue) may be initiated by the Chief Judge or the competitor but is "only approved by the Chief Judge", who may allow it immediately or later (for example at the end of the contest). | A restart is a **re-run of an executed heat**. Out of scope for this design (executed heats are never altered); recorded as a profile blocker. |
| Definitions, Raw Score Judge (p.3) | The Raw Score Judge "does not determine heats", the number of callbacks, cuts to finals or "any other contest structure decisions"; those duties are performed by the Chief Judge or Secondary Chief Judge. | Whether **running order** counts as a "contest structure decision" is not stated: **requires interpretation** (Q3). |
| 3.4.4 (p.19) | The Chief Judge must review all finalists before finals are posted or started. | Not affected by a reorder (nothing starts), noted for completeness. |
| 3.4.8 (p.20), Section 6 item 7 (p.23) | Partner rotation, pairing and music selection must stay random and fair; scoring systems should place paired competitors in random dance order. | Concerns within-contest randomization, not the order in which contests run. A reorder never changes within-heat order. |
| 1.4 (pp.6-7) | Changes needing Board approval are event-level (location, dates, hiatus). | Not about the daily timetable. |

**Source gap (recorded after reading):** in the pinned text, **no requirement was found** for daily timetable adherence, lateness limits, cut-off
times, schedule-change notification, or who may reorder contests during an event, other than the three rows above. Absence in the text read is not
proof of absence elsewhere in the WSDC governing documents.

### 3.4 What is DanceFlow policy

Everything in sections 4 through 11 that is not a row above is **DanceFlow policy** (`OD26-DF-*` register entries): unstarted-heats-only, the commit
window and its defaults, pull-forward thresholds, quick-change gaps, the authority grants, and the audit and revision model. None of it is presented
to users as a UCWDC, NDCA or WSDC requirement. The same applies to Studio/Custom events regardless of any body named in marketing.

### 3.5 Monitoring, preventable violations and event conduct (three different things)

Required distinction (owner requirement 8). The software must not blur them, and must never convert any of them into an automatic penalty:

| Layer | Meaning | Example (NDCA) | What the software does |
|---|---|---|---|
| **Monitoring / warnings** | Projections about the future, derived from planned and actual times | "Projected to run 22 minutes late"; "projected to put the last final after 1:00 a.m." | Shows a warning to the organizer and the Chairman. Never blocks conduct. Never a record of violation. |
| **Preventable scheduling violation** | A **proposed** change that would itself breach a rule in force for the event's profile | A reorder that would start an event more than 30 minutes before its published time, or would start the first event of the day early | At preview, shown as a finding. The applying actor may proceed **only with an explicit acknowledgment and reason**, recorded in the revision. The organizer remains responsible; the software does not forbid conduct decisions. |
| **Actual event conduct** | What happened on the floor | Rounds that actually took the floor after 1:00 a.m. | **Records facts** from execution timestamps (round, heat, count of non-scratched couples, local timestamp, rule reference). **Never computes or charges** any penalty. The per-couple payment is between organizer and couples. |

## 4. Heat status map and the safe operational cutoff

### 4.1 Vocabulary

A floor heat has no status of its own. Its run state is derived from its non-cancelled scoring heats (`dayOf.ts`: `scheduled | staging | active |
complete | mixed`). The console's "Call to floor" moves `scheduled -> staging`; there is no separate "called" and "staged": **both are `staging`**.
"Committed to the floor" additionally covers (a) competitors checked in to the heat (`event_competition_heat_entries.status = 'checked_in'`) and
(b) the next heats the floor coordinator is already preparing (the commit window).

Definitions used below. **Frontier N\*** = the highest `heat_number` of a floor heat that has any non-cancelled scoring heat in `staging`, `active` or
`complete` (0 if none). **Pinned** = frozen for a reason other than position.

### 4.2 Classification of every status and condition

| # | Condition on a floor heat | Class | Why |
|---|---|---|---|
| 1 | Any scoring heat `active` | **FROZEN** | On the floor; results will be produced. |
| 2 | Any scoring heat `complete` | **FROZEN** | Executed; its number and record are history. |
| 3 | Any scoring heat `staging` ("called"/"staged") | **FROZEN** | Competitors have been called. Un-calling would be a backwards status edge, which the O1 machine does not have (forward only) and this design does not add. |
| 4 | Any scoring heat `lock_state` `locked` or `certified` | **FROZEN (pinned)** | 10A evidence locks; a locked never-run heat must not move either. |
| 5 | Any ballot, mark, callback tally, result row or correction record for the scoring heat **or for its round** (round-scope ballots have `heat_id` null, so any round-level ballot, tally or result pins **every** heat of that round), even if the heat is `scheduled` | **FROZEN (pinned)** | E2 accepts ballots by round state, so a never-called heat can already hold evidence. Evidence is proven by lookup under row locks, not assumed. |
| 6 | A scoring heat's round is `ballots_locked`, `calculated`, `approved`, `published`, `complete` or `cancelled` | **FROZEN (pinned)** | Round past scoring; moving its heats would rewrite the story of a scored round. |
| 7 | Any heat entry `danced` or `disqualified` | **FROZEN** | Execution evidence. (`scratched` entries are ignored for placement and conflict checks, kept in the diff.) |
| 8 | Unstarted floor heat with `heat_number < N*` ("bypassed") | **NOT MOVABLE by reorder; reported** | Skipped over by the floor. It can still be called with the normal day-of control (O1 does not enforce numeric order). Re-sequencing it would renumber heats that have already run. The *actual* run order is the O1 transition events. |
| 9 | Unstarted, in the **commit window** (see 4.3), having any `checked_in` entry, or **moved earlier by at least `pull_forward_confirm` positions** relative to the last announced revision | **CONFIRM-REQUIRED** | Physically committed; moving it needs the higher authority and an acknowledgment bound to the preview. |
| 10 | Unstarted, `heat_number > N*`, outside the window, no checked-in entries, no evidence, lock `open`, round `draft/scheduled/active` | **MOVABLE** | The only class a standard grant may move. |
| 11 | Floor heat whose scoring heats are all `cancelled` (an empty slot) | **MOVABLE, flagged** | Keeps its number until removed; excluded from conflict analysis. |
| 12 | Scoring heat `draft` | **Not part of the live order** | Unplaced/unpublished; refused if it appears in the live version. |
| 13 | Mixed floor heat (scoring heats in different states) | **Most-advanced state wins** | One frozen scoring heat freezes the floor heat. |

Only floor heats in classes 9, 10 and 11 can *change number*. Frozen and pinned floor heats **keep their numbers**; a change is a permutation of the
movable floor heats among the numbers that movable floor heats currently hold. Contiguity `1..n` is therefore preserved by construction, and no frozen
record is ever renumbered.

### 4.3 The commit window (DanceFlow policy, defaults, event-configurable)

| Parameter | Default | Bounds | Meaning |
|---|---|---|---|
| `window_heats` | 2 | 0-6 | The next *unstarted, non-pinned* floor heats after N\* ("on deck" and "in the hole"). |
| `window_minutes` | 20 | 0-120 | If planned times exist: any heat whose planned start is within this many minutes of now. Ignored when times are absent. |
| `pull_forward_confirm` | 3 | 1-20 | Moving a heat earlier than its position in the **last announced** revision by this many positions or more is CONFIRM-REQUIRED anywhere in the order. |
| `quick_change_min_gap` | 1 | 0-6 | A competitor appearing again with fewer than this many heats between appearances is a quick-change finding. |

Parameters live with the head row (section 5), change only through an audited owner-level RPC, and are labelled "DanceFlow default, not a body rule" in
the UI. They are **not** body requirements. For declared NDCA/UCWDC profiles the time-based rules of section 12 supplement or replace them.

CONFIRM-REQUIRED needs: (a) the `reorder_in_window` grant (section 10), (b) an acknowledgment token equal to the preview checksum, (c) a reason code
from a closed set plus free text, and (d) listing, in the acknowledgment, the number of checked-in competitors affected. Moving a heat **earlier**
is treated as riskier than moving it later (competitors told to expect a later slot), which is what `pull_forward_confirm` captures.

## 5. Data model (proposed; nothing built)

All new tables are event-scoped, RLS-enabled, with the same conventions as O1/E1 (history protected by the
`protect_competition_history_evidence`-style trigger, truncate guarded, no deletes). Names are placeholders for the implementation PR.

1. `event_competition_running_order_heads` (mutable pointer, **the optimistic-lock row**): `schedule_version_id pk`, `event_id`, `revision_number int not
   null default 0`, `announced_revision_number int null`, `policy jsonb` (section 4.3 parameters, validated by CHECK), `updated_at`. Created inside the apply transaction under the per-event lock (`insert ... on conflict do nothing`) or by a separate `ensure_*` RPC; the preview is read-only, never creates it, and treats a missing head as revision 0.
2. `event_competition_running_order_revisions` (**immutable, append-only**): `id, event_id, schedule_version_id, revision_number, base_revision_number,
   kind ('reorder' | 'system_append' [CF1 Final appended; optional slice] | 'baseline'), order_before jsonb, order_after jsonb, diff jsonb, order_snapshot
   jsonb, snapshot_checksum text (sha-256), reason_code text, reason text (3-500), actor_user_id, authority_grant_id, authority_level, findings jsonb,
   acknowledgments jsonb, preview_checksum text, request_id uuid unique, transaction_id bigint, created_at`. `unique (schedule_version_id,
   revision_number)`. Revision 0 is the baseline = the publication snapshot (referenced, not copied).
3. `event_competition_schedule_authorities` (event-level grants, section 10): `id, event_id, user_id, level ('reorder' | 'reorder_in_window'),
   granted_by, granted_at, ended_at, ended_by, end_reason, request_id`. Rows are ended with a reason, never edited or deleted.
4. Optional later (notification slice, section 11): `event_competition_running_order_notifications` (intent rows, state `draft` only until a separate
   authorization). Not part of the first implementation slice.

Not changed: `event_competition_schedule_publications` (its `unique (schedule_version_id)` is the reason revisions get their own table),
`event_competition_heats`, entries, ballots, results, O1 transition events.

**Scope.** The RPC works on the live version at any time but exists for **mid-event** use, because before the first heat runs a republish is still allowed. A later republish starts a new version whose revision chain starts again at 0 (the old chain stays readable); republish stays refused once any heat ran. Revisions have their own reader and are **not** in `competition_audit_log` (a CF1-redefined union); adding a union branch edits a CF1 function and is a coordinator question like Q8.

## 6. The change operation

### 6.1 Two RPCs

- `preview_competition_running_order_change(p_version_id, p_new_order jsonb) -> jsonb`: read-only, `SECURITY DEFINER`, same authority as apply. Returns
  the classification of every floor heat, the diff, the findings, `base_revision_number`, `state_fingerprint` and `preview_checksum`.
- `apply_competition_running_order_change(p_version_id, p_expected_revision, p_expected_fingerprint, p_new_order jsonb, p_reason_code, p_reason,
  p_acknowledgments jsonb, p_preview_checksum, p_request_id) -> jsonb`: the only writer.

`p_new_order` is the complete list `[{floor_heat_id, heat_number}]` of the **movable** floor heats only. Anything else in it is refused.

### 6.2 Apply sequence (one transaction, all-or-nothing)

1. Authentication and authority: caller holds an active grant with the needed level for the event (section 10). Otherwise `COMPRO_NOT_AUTHORIZED`
   (same neutral message as `COMPO1_NOT_FOUND`, no existence leak).
2. Idempotency: a prior revision with the same `request_id` and same actor/version returns `replayed: true`; a different one is `COMPRO_REQUEST_REUSE`
   (the O1 pattern).
3. Locks, **in this order** (stable, so no deadlock with O1 writers, which take 3a first): (a) `_compo1_lock_event(event)` per-event advisory lock (the
   same lock `advance_competition_floor_heat` and `_compo1_guard_publish_during_run` take, so a heat call, a publish and a reorder serialize);
   (b) the head row `FOR UPDATE`; (c) the rounds of every scoring heat in the version `ORDER BY id FOR UPDATE` (E2's ballot insert takes the round
   `FOR SHARE`, so an in-flight ballot finishes first and a later one waits; this closes the window where a ballot appears for a heat we classified
   as evidence-free); (d) floor heats `ORDER BY id FOR UPDATE`; (e) scoring heats `ORDER BY id FOR UPDATE`.
4. Optimistic check: head `revision_number = p_expected_revision`, else `COMPRO_STALE_REVISION` with the current revision. Then recompute
   `state_fingerprint` (md5 over each floor heat's number, run state, lock state, evidence flag and counts of entries by status) and compare to `p_expected_fingerprint`, else
   `COMPRO_STATE_CHANGED` (a heat was called, a ballot arrived, a lock changed, a competitor scratched). The caller re-previews.
5. Recompute classification (section 4) and findings (section 7) **inside the lock**; recompute `preview_checksum` and require equality with the
   provided one (`COMPRO_PREVIEW_MISMATCH`): the actor applies exactly what they reviewed.
6. Refuse on any BLOCK finding; require an acknowledgment entry for each ACK finding and each CONFIRM-REQUIRED heat (`COMPRO_ACK_REQUIRED`).
7. Write the revision row **first** (so its `transaction_id = txid_current()` is the evidence the guard checks), then update
   `floor_heats.heat_number` for the movable set in **one statement** (the deferrable unique key is checked once, as in `move_competition_floor_heat`),
   then bump the head. Store an **order-only snapshot** (floor heat id, number, scoring heat ids) with its checksum, not the full publication snapshot: that snapshot carries entry display names, statuses and lock states, which would put personal data into an append-only table that can never be trimmed. Names are joined live, under RLS, by the preview and readers.
8. Return the revision number, the diff and the audience summary. **No notification is sent** (section 11).

Other writers outside O1 that the lock order must coexist with: `set_competition_heat_lock_state` takes **no** event or round lock and locks one heat `FOR UPDATE` (a lock-state change racing the apply is caught by the in-lock recomputation, which re-reads lock states after step 3e); CF1 paths that use `NOWAIT` on heats and rounds raise `55P03` instead of waiting, so a concurrent reorder can make them fail fast but not deadlock; heat-entry check-in and scratch take no locks, so under READ COMMITTED they are covered by the in-lock recomputation of the classification and the `preview_checksum` recheck, not by row locks. The implementation must either lock the affected heats' entries `FOR SHARE` or record this as the accepted guarantee. Test C9 covers all of them.

### 6.3 Why a single statement and no scoring-heat update

The deferred integrity triggers (`comp10d_heat_floor_integrity` and friends) fire on scoring-heat and heat-entry changes, not on `heat_number`, so the RPC
runs the same checks explicitly (`_comp10d_floor_heat_problems` per floor heat, plus the checks of section 7) before writing. Because no
`event_competition_heats` row is updated, `_compo1_guard_heat_status`, the status writers and the CF1 triggers on heats do not fire, and **nothing about
any heat's status, assignment, entries, dances, ballots or results can change through this path**.

### 6.4 Heat-state transitions during the edit

Transitions cannot interleave: heat calls and this RPC share the per-event lock. A transition that commits between preview and apply changes the
fingerprint, so apply refuses (`COMPRO_STATE_CHANGED`) rather than silently applying a stale classification. A heat called **after** apply is simply the
next heat in the new order.

### 6.5 Error vocabulary (shared prefix `COMPRO_`)

`COMPRO_NOT_AUTHORIZED`, `COMPRO_STALE_REVISION`, `COMPRO_STATE_CHANGED`, `COMPRO_PREVIEW_MISMATCH`, `COMPRO_NOT_MOVABLE` (names the heat and class),
`COMPRO_NOT_A_PERMUTATION`, `COMPRO_NO_CHANGE`, `COMPRO_BLOCKED` (finding codes in detail), `COMPRO_ACK_REQUIRED`, `COMPRO_REASON_REQUIRED`,
`COMPRO_REQUEST_REUSE`, `COMPRO_NOT_LIVE_VERSION`, `COMPRO_MULTI_FLOOR_UNSUPPORTED`, `COMPRO_BODY_AUTHORITY_UNAVAILABLE`.

### 6.6 Guard change (the only one)

**Planned times stay with the slot, so v1 refuses reorder when any floor heat of the version has `planned_start_at` or `planned_duration_seconds` set** (`COMPRO_PLANNED_TIMES_PRESENT`, BLOCK): the bypass below allows only `heat_number` and `updated_at` to differ, and a reorder under authored times would leave times out of order with the numbers. Planned times are not authored by any app path today, so this costs nothing now. Letting times follow the heat (widening the bypass to the two time columns, with the NDCA time model) belongs to the NDCA time-model slice (S7), not v1. Test PT1.

`_comp10d_guard_floor_heat` (current body is the CF1-redefined one; the implementation must read it and pin its md5). **The body has two version checks**: an old-side check (`tg_op in ('UPDATE','DELETE') and not _comp10d_version_editable(old...)`) that CF1-A0 did not touch, and a new-side check that CF1-A0 patched. A bypass patching only one never runs, because the other raises first. Specify either two anchors, each with an occurrence-count check of exactly 1, or an early `return new` block at the top of the function that tests the whole condition once. The change gains, on `UPDATE` only: allowed when `to_jsonb(new) - {heat_number, updated_at} = to_jsonb(old) - {heat_number, updated_at}`
**and** a revision row for this event/version with `transaction_id = txid_current()` exists whose `order_after` lists this floor heat at the new number.
Everything else keeps raising `COMP10D_SCHEDULE_PUBLISHED`. A defence-in-depth `BEFORE UPDATE OF heat_number` trigger refuses any other path that changes
`heat_number` of a non-draft version, so a future redefinition of the guard cannot silently reopen the order.

## 7. Validation (all inside the apply transaction; also returned by preview)

Severity: **BLOCK** (never applies), **ACK** (applies only with an acknowledgment recorded in the revision), **INFO**.

| Code | Severity | Check |
|---|---|---|
| `NOT_PERMUTATION` | BLOCK | The submitted numbers are exactly the numbers currently held by movable floor heats; every movable heat appears once. |
| `FROZEN_TOUCHED` | BLOCK | A frozen, pinned or bypassed floor heat appears in the order, or its number would change. |
| `ROUND_PRECEDENCE` | BLOCK | For each division, no later round's heats may be placed before an earlier round's heats **unless the pre-change order already had that violation** (never introduce a new one). A Final appended by CF1 stays after its source round. |
| `ROUND_HEAT_ORDER` | BLOCK | Within one round, scoring heats keep their per-round `heat_number` order (readers such as `_compe2_round_heats` order by it); a reorder may not invert it unless the pre-change order already had the inversion. |
| `SAME_FLOOR_HEAT_COMPETITOR` | BLOCK | The existing 10D rule (`_comp10d_floor_heat_problems`) holds for the new order. A reorder does not change membership, so this should never fire; it is a regression guard. |
| `OFFICIAL_ON_TWO_PANELS_SAME_HEAT` | BLOCK | An official who sits on two rounds' panels must not end up in a floor heat that contains both rounds. Panels are per round (E1); the RPC never edits panels. |
| `MULTI_FLOOR` | BLOCK (v1) | If more than one distinct `floor_id` is used in the version the RPC refuses (`COMPRO_MULTI_FLOOR_UNSUPPORTED`): concurrent-floor overlap needs a time model that does not exist. |
| `BACK_TO_BACK_COMPETITOR` | ACK | The same competitor (identity via entry participants, so partner swaps count) is in adjacent floor heats where it was not before. Common for a Pro dancing with several students; therefore warned, not blocked. |
| `QUICK_CHANGE` | ACK | Gap between two appearances is below `quick_change_min_gap` where it was not before. |
| `OFFICIAL_AS_COMPETITOR_ADJACENT` | ACK | An official who also competes (permitted only where OD-05 allows it) lands adjacent to a heat in a round they judge. Same floor heat is BLOCK. |
| `PULLED_FORWARD` | ACK below threshold, CONFIRM at or above | Earlier than its last-announced position. Any pull-forward needs an acknowledgment; at or above `pull_forward_confirm` positions it is CONFIRM-REQUIRED and needs the `reorder_in_window` grant even outside the window. A standard `reorder` grantee can therefore move heats later, or earlier by fewer positions than the threshold. |
| `IN_WINDOW` | CONFIRM | Section 4.3. |
| `CHECKED_IN_AFFECTED` | CONFIRM | Number of checked-in competitors in heats whose number changes. |
| `ANNOUNCED_CHANGED` | INFO | Heats whose number differs from the last announced revision. |
| `BYPASSED_PRESENT` | INFO | Unstarted heats below the frontier, listed so the organizer decides to call them. |
| `TIME_MODEL_ABSENT` | INFO | Time-based checks (section 12) could not run because planned times are missing. |
| `BODY_RULE_*` | per profile | Only when a body profile is attached to the event (section 12). Absent in v1. |

Competitor identity always comes from `event_competition_entry_participants.competitor_id` (never a name). Scratched entries are ignored for conflicts
and listed in the diff.

## 8. Organizer impact preview

The preview is a pure function of the proposal and is shown before apply in the existing console style (mobile first, one primary action):

1. **Heats that move**: from number, to number, delta, division and round, class (movable / confirm-required), run state, entry count, checked-in count.
2. **Heats that do not move but whose neighbours change**, so "up next" lists stay readable.
3. **Competitors affected**, grouped by heat: competitor name and entry number as shown to organizers, old and new number, pulled-forward or delayed,
   checked-in or not, scratched ignored. Counts first, names expandable (least-privilege: names appear only to actors who already see the roster).
4. **Staff affected**: officials on the affected rounds' panels (per round, E1), scrutineer/chair/scorer assignments of those rounds.
5. **Published timetable entries affected**: each floor heat entry in the last announced revision whose number or planned time changes, as a
   before/after list (this is the exact published-entry diff the requirement asks for). The RPC changes **numbers only**; see the planned-time rule in 6.6.
6. **Findings** (section 7) with severity, the acknowledgments the actor will sign, and the `preview_checksum`.
7. **What will not change**: statement that no entry, assignment, ballot, panel, result or execution record is touched, with live counts.
8. A **no-op** proposal (`COMPRO_NO_CHANGE`) is refused, so empty revisions cannot pad the history.

## 9. Versioning, diff and preserved schedules

- Revision numbers are per live version, gapless, starting at 1; revision 0 is the publication baseline. **Nothing is ever overwritten**: every
  `order_before`, `order_after` and `order_snapshot` is kept.
- `diff` is structured: `heats_moved[]` (floor_heat_id, from, to), `scoring_heats[]`, `competitors[]` (competitor id, old and new number, checked-in),
  `officials[]` (rounds affected), `published_entries[]` (against the head's `announced_revision_number`, or revision 0).
- "Announced" is an explicit operator action in the future console: marking a revision as announced (printed, posted, spoken, notified). Before any
  announcement is recorded, **revision 0 is treated as announced**, the conservative default, since printed sheets may exist.
- Consumers: today no application code reads the publication snapshot. Readers of the live order (console, readiness) read `floor_heats` and see the
  new numbers automatically. Any **future** reader of a published timetable (a participant heat sheet, an export) must read the head revision's
  order snapshot (names joined live), not `event_competition_schedule_publications`. That is a tested contract in the implementation slice.
- **CF1 interplay (optional slice).** CF1 appends a Final's floor heat to the live version. Without a revision row the head's snapshot would disagree
  with the live order. The optional slice writes a `system_append` revision from the CF1 apply path; this edits a CF1 function and needs the
  coordinator's decision (Q8). Until then a consistency check in the console flags "live order differs from head snapshot".
- **Rollback of a change** is a new revision (`kind = reorder` that restores a prior `order_after`), never a deletion. It is subject to the same
  frozen/window rules, so a rollback is impossible if a moved heat has since run.

## 10. Authority and permissions (Studio/Custom)

`can_manage_event_competition` is true for platform admins, studio owners and admins, and organizer owners, admins and staff. **It does not authorize
this operation.**

- **Grants** (table 3 in section 5), event-level, per person: `reorder` (move MOVABLE heats) and `reorder_in_window` (also CONFIRM-REQUIRED heats).
- **Who may grant or end a grant:** only a studio owner or organizer owner of the event (the event-owner level, not admins or staff), recorded with
  reason; a person may hold a grant on their own authority only as the event owner. Granting is audited like any designation.
- **Who may hold a grant:** a named person with an account who also satisfies `can_manage_event_competition` for the event, **or** an official designated for the event whose body-profile role maps to reorder authority (for example an NDCA Chairman who is not otherwise a manager). A grantee who is not a manager sees counts and order, and competitor names only where they already have roster access.
- **No grant = nobody can reorder.** Fail closed. Platform admins have **no implicit** reorder right: a platform operator needs an explicit grant like
  anyone else (a break-glass path is a separate decision, Q6).
- **Coordination with OD-06 (PR #834).** That design defines `event_competition_role_designations` with a closed set of WSDC-oriented kinds and
  fingerprinted attestations. Adding schedule kinds there would either amend its closed-set CHECK in its s0 migration or invalidate WSDC attestations.
  This design therefore **uses its own grant table with the same conventions** (ended with reason, immutable history, no deletes, named-person
  display) and leaves the OD-06 table untouched. When a body profile exists, the profile maps the body's role designations (NDCA Chairman and
  Organizer; UCWDC Contest Coordinator and Floor Coordinator; WSDC Chief Judge, per PR #834 sections 6A and 6D) to reorder authority (section 12).
  Whether to merge the two tables is Q7 for the coordinator.
- **Declared-body events** (`events.competition_sanctioning` is not `none`/`other`): until a body profile defines authority, the apply RPC returns
  `COMPRO_BODY_AUTHORITY_UNAVAILABLE`. This preserves OD-01 (those events cannot approve or publish Studio-scored results) and never lets a generic
  grant act as a body role.

## 11. Notification design (design only; nothing is sent)

**Current state.** There is no participant-facing heat sheet or running-order publication (O1 open decision 1 is unresolved), and no competition code
path sends email or SMS about schedules (grep of `src/lib/competition` and the competition app routes, 2026-11-23; one false hit on "sms" inside a
timing constant). This design therefore adds **no delivery code**.

**Audience computed at change time (stored in `diff`, ids only, no phone numbers):**

| Audience | Who | Why |
|---|---|---|
| Competitors in heats whose number changed | Entry participants of non-scratched entries | Their call time changed. Pulled-forward and checked-in are highlighted. |
| Competitors in adjacent heats | Optional ("heat before you moved") | Not required; off by default. |
| Officials | Panel members of affected rounds, chair, scorer | Their judging schedule changed. (NDCA IV.B.7 tells an engaged professional to ascertain the timetable: a duty of the judge, not a notification rule on the organizer; IV.B.7, p.26.) |
| Floor and desk staff | Floor coordinator, check-in desk, MC/announcer designees | Operational. |
| Organizer-side | The actor and the event owner | Confirmation. |

**Channels and gates.**

- **In-app / on-screen first.** A change banner and an updated "up next" list for staff at no provider cost, and a participant heat-sheet change notice
  only after O1 open decision 1 (visibility) is decided.
- **SMS and email are separate authorizations.** Competition SMS would ride the TW-4F pipeline, whose activation, spend, opt-out, sender-readiness,
  reconciler and price gates are documented in [TW-4F_Completion_Tracker.md](../../../twilio/TW-4F_Completion_Tracker.md) and are dark and unauthorized
  for activation. This design reads those gates only; it **does not call, configure or enable** any of them. Using SMS for schedule changes needs (a)
  the TW-4F activation authorization, (b) a consent/opt-in basis for competitors (not established by this design and not verified in the registration flow, so it must be checked first), (c) a per-event cost cap, and (d) a separate decision on what message is time-critical enough to justify a charge. **Provider
  charges are never incurred by this slice.**
- **Message content.** Heat number change, new "up next" position, link or QR to the live order. Never competitor-identifying data about others, never
  scoring information.
- **Delivery record** (future table): per audience member, channel, state `draft | approved | sent | failed | suppressed`, the revision, who approved,
  and suppression reason (opt-out, no consent). The first implementation slice ships **no** such table; it is specified here so the revision `diff`
  already carries the audience.
- **Human fallback is required regardless:** the console's change summary and the floor coordinator's announcement remain the primary path (UCWDC
  II.P.3 and II.P.1 describe a floor-call model; NDCA V.B.2 puts the burden on competitors to be present early).

## 12. Body profiles (future; each item is a profile blocker, NOT IMPLEMENTED)

Profiles activate only for events that declare the body (OD-01) and only after the owner approves the profile. They add checks (`BODY_RULE_*`), authority
mapping and records. They **never** charge or compute penalties.

### 12.1 NDCA (June 2026 edition; July edition differences UNVERIFIED and must be checked before activation)

- **Authority model.** Two roles: **Organizer** (III.D.1: draws up and adheres to the timetable) and **Chairman** (IV.C.3: observance or alteration; IV.C.7:
  final decision on changes in program scheduling). A change records its *authority basis* (organizer, chairman, or both). Whether both must concur is
  Q1. Event-level designation of the Chairman is the one PR #834 reserves with the NDCA profile (kind added then); the Organizer is the event owner
  level.
- **Time model required.** Published timetable per floor heat (planned start, duration), event time zone, actual start timestamps. Without it, only
  `TIME_MODEL_ABSENT` can be shown and the profile cannot activate.
- **30-minute constraint.** Evaluate each affected *event* (mapping to DanceFlow division/round/heat is Q2) against its published time: warn on projected
  lateness (monitoring); show as a preventable violation any proposed change that would start it more than 30 minutes early or more than 30 minutes
  after the published time; require acknowledgment and reason.
- **First event of the day.** A proposal that would make the first event start before its scheduled time is a preventable violation (acknowledge with
  reason); "first event of the day" per floor/day to be defined (Q2).
- **1:00 a.m. cutoff.** Monitoring projects whether the last final will finish before 1:00 a.m. event-local time; a proposal that plans a final to start
  after 1:00 a.m. is a preventable violation. Actual conduct: record each round that took the floor after 1:00 a.m. (round, heat, count of non-scratched
  couples, timestamp, rule reference). **No dollar amount is computed or stored, and nothing is charged.** The couple count is for the organizer's own record only.
- **Competitor lead time.** V.B.2's half-hour attendance expectation informs the default commit window; the profile may derive `window_minutes` from it.
- Mandatory NDCA items are recorded as `unsupported` (Chairman/Organizer authority as `requires_interpretation`), NOT IMPLEMENTED: `OD26-NDCA-0001` through `-0005`; the absence of a notification rule is `OD26-SILENT-0003`.

### 12.2 UCWDC (Couples v1-26-2026; Scoring Format v16.9b)

- **Authority.** Preserve the **Contest Coordinator** (the role supervising heating, with authority to move up contestants after scratches) and the
  **Floor Coordinator** (where competitors report). II.P.3 says the exact order is not guaranteed but says nothing about who may change it, so the
  profile maps both to reorder authority only after the owner decides the mapping (Q4).
- **Legitimate adjustments.** (a) Reordering floor heats (this design). (b) **Post-scratch move-up** (Heating Rule 4, recommended "Whenever possible"):
  moving an entry from a later heat of a division to an earlier heat of the same division. It changes *assignments*, which this design **does not do**;
  it is a separate slice (S6) with its own audit record (from heat, to heat, reason `scratch`, actor, that the original randomized order and its seed
  and algorithm version stay recorded, the new heat sizes against the "no more than 1" guidance).
- **OD-25 coordination.** The OD-25 decision (Studio keeps its current planner; future UCWDC profile requires reproducible randomization with seed,
  algorithm version and final order recorded, contiguous multi-heat scheduling, and treats balancing and smaller-heat-first by their modal language) is
  being documented by the OD-25 docs PR. This design adds the interplay: a reorder under a UCWDC profile is **BLOCK** if it would break a division's
  contiguity (Heating Rule 3, "must"; co-mingled exceptions per rule 5-7 are Q5); it never alters the recorded within-heat order; and a move-up must append
  a record linked to the original randomization evidence. Item 2 ("should be no more than 1") and Item 4 are findings, not blockers.
- **Competitor reporting.** II.P.1 ("should", 30 minutes before a division's first heat) feeds the commit window in time-based events; a division's
  first heat pulled earlier than that lead time from its announced time is an ACK finding.
- Recorded as `OD26-UCWDC-0001` through `-0005`; no body rule on lateness, cut-offs or change notification was found in the sources read (`OD26-SILENT-0002`).

### 12.3 WSDC (Registry Event Rules 2026.1C)

- Section 3.3 above is the record. Because the **Chief Judge** (or Secondary) is the stated holder of heat and contest-structure decisions and whether
  that covers running order is unresolved (Q3), a WSDC-declared event **fails closed** (`COMPRO_BODY_AUTHORITY_UNAVAILABLE`) until the owner decides.
  If the owner decides the Chief Judge must decide or approve a reorder, the profile requires the Chief Judge designation from PR #834 (WSDC role
  separation intact: the Chief Judge may not also be the scoring/tabulation operator, 3.4.3).
- **Restarts (3.1 item 8)** are re-runs of executed heats: blocked in this design (executed heats are never altered); a future *restart record* linked to
  the original heat, approved by the Chief Judge, is a separate design.
- **Tentative Schedule posting (1.1 item 9)** and any mid-event notification: pre-event posting is not modelled; no mid-event notification rule was found.
- Recorded as `OD26-WSDC-0001` through `-0003` and `OD26-SILENT-0001`.

### 12.4 Rule-register entries added by this PR

`OD26-DF-0001`..`0003` (DanceFlow policy, `unverified`, design only); `OD26-NDCA-0001`..`0005`; `OD26-UCWDC-0001`..`0005`; `OD26-WSDC-0001`..`0003`; `OD26-SILENT-0001`..`0003`. All body requirements are `unsupported` or `requires_interpretation` and **NOT IMPLEMENTED**; each is a blocker for the corresponding body profile. No entry claims `verified_compliant`. Id prefix `OD26-` avoids the ids used by the open register PRs (OD01, OD04-OD13, OD18, OD21 families, checked read-only on 2026-11-23; PR #850 uses `OD25-*` and cites `OD25-UCWDC-0004` for the same contiguity rule as `OD26-UCWDC-0004`).

## 13. Interaction with other decisions

| Decision | Interaction |
|---|---|
| OD-01 (PR #832) | Declared events cannot approve/publish Studio-scored results; reorder for declared events is refused until a body profile exists. Preserved. |
| OD-05 / OD-06 (PR #834) | Panels are per round and unchanged by a reorder; recusal declarations are keyed to `heat_id`, which a reorder never changes (a reason for in-place re-sequencing). Authority table shares conventions, not tables. |
| OD-07 (PR #838), OD-11 (PR #843) | Corrections and withdrawals concern rounds and ballots; frozen classes 5 and 6 mean a heat with correction evidence cannot move. A reopened round (`complete` is terminal today; OD-07 designs a correction state) keeps its heats frozen. |
| OD-17 (PR #834) | Panel assignment freezes when the round leaves `draft/scheduled`; the reorder never edits panels; panel changes are not a schedule change. |
| OD-21 (PR #847) | Withdrawals and finalist handling are untouched; scratched entries are ignored for conflicts and kept in the diff. |
| OD-25 | See 12.2. The reorder never alters heat membership, randomization or contiguity (outside UCWDC profile blocks). |

## 14. Open owner questions

1. **Q1 NDCA authority split.** May the Organizer, the Chairman, or only both together initiate an alteration? (III.D.1 vs IV.C.3 and IV.C.7.)
2. **Q2 NDCA scope terms.** What is an "event" for the 30-minute limit, and what is "the evening" for 1:00 a.m. in DanceFlow terms?
3. **Q3 WSDC.** Is the running order a "contest structure decision" that only the Chief Judge may make?
4. **Q4 UCWDC.** Does Contest Coordinator or Floor Coordinator authority cover reordering heats, or only move-up?
5. **Q5 UCWDC contiguity** for co-mingled divisions (Heating Rules 5-7): when a reorder may separate heats.
6. **Q6 Platform admin break-glass.** Should a platform operator ever be able to reorder without a grant (recommended: no in v1)?
7. **Q7 Authority table.** Separate grant table (recommended) or add schedule kinds to PR #834's designations?
8. **Q8 CF1 revisions.** Write a `system_append` revision when a Final is appended (touches a CF1 function)?
9. **Q9 Defaults.** Confirm the commit-window defaults (2 heats, 20 minutes, pull-forward 3, quick-change gap 1) and bounds.
10. **Q10 Announced marking.** Is an operator "mark as announced" action wanted before any participant heat sheet exists?
11. **Q11 Participant visibility** (O1 decision 1) before notification design continues.

## 15. Slices (for the implementation PR, not authorized now)

S0 data and authority tables (no behavior); S1 preview/apply RPCs and the guard path; S2 console UI; S3 profile-neutral tests and negative suite; S4
(optional) CF1 `system_append`; S5 notification intents (needs separate authorization and the gates in section 11); S6 UCWDC move-up (separate); S7
body-profile checks (NDCA time model, UCWDC contiguity, WSDC authority). Each is a bounded draft PR with an independent review.
