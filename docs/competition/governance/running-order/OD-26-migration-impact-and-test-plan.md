# OD-26 migration impact assessment, rollback requirements and targeted test plan

Status: **DRAFT, docs only.** Nothing here is a migration, and none of it was run. Companion to
[OD-26-running-order-changes-design.md](OD-26-running-order-changes-design.md) (section references below are to that document). Applies only to a
future implementation PR, which the owner has **not** authorized: no SQL guard implementation, no SQL apply, no merge, no deployment, no activation.

## 1. Exact existing guards, functions and tables the design depends on

Base inspected: `origin/release/website-embeds` at `49dbaee1b`, 2026-11-23.

### 1.1 Changed by the future implementation (one function, plus additive objects)

| Object | Defined in | Change | Pin |
|---|---|---|---|
| `public._comp10d_guard_floor_heat()` (trigger `comp10d_guard_floor_heat` on `event_competition_floor_heats`) | 10D `20261111090000`; **redefined by CF1-A0** inside `20270120090000_competition_cf1_callback_final_advancement.sql` (anchor replacement that adds `_cf1_auth_apply_floor_heat` to the INSERT branch) | Add an UPDATE-only, `heat_number`-only bypass backed by a same-transaction revision row (design 6.6). The INSERT bypass and the draft rule are left exactly as they are. | md5 of the **current** body, read from the repo-applied state at implementation time, not copied from this document. CF1 pins the *pre-CF1* 10D body as `bd20973caffce985813daadde8be947a`; the post-CF1 body has a different md5 that the implementation must compute and pin. The body has an old-side and a new-side version check and CF1-A0 patched only the new side, so patch two count-checked anchors or add one early-return block; a bypass on only one side never runs. |

### 1.2 Read or called only (must not change)

`_compo1_lock_event(uuid)`, `_compo1_live_version(uuid)`, `_compo1_record` pattern (O1 audit; **not** written by this path, which has its own revision
table), `_comp10d_floor_heat_problems(uuid)`, `_comp10d_scoring_heat_duplicate(uuid)`, `build_competition_schedule_snapshot(uuid)` (md5 pinned by 10D),
`can_manage_event_competition(uuid)` (read to confirm event membership only; **not** the authorization), `protect_competition_history_evidence()`
(pattern), `event_competition_entry_participants` (competitor identity), `event_competition_officials` / `event_competition_panel_assignments` (E1),
`event_competition_heat_entries.status`, `event_competition_ballots` and result tables (evidence lookups), `event_competition_round_transition_events`.

### 1.3 Explicitly NOT changed (the design depends on these staying as they are)

| Guard | Why it stays |
|---|---|
| `_compo1_guard_publish_during_run` / `COMPO1_RUN_IN_PROGRESS` | Still prevents publishing a new version over a running event (the reason mid-event reorder is **not** a publish). |
| `_compo1_guard_heat_status` / `COMPO1_HEAT_FROZEN` / `COMPO1_HEAT_STATUS_WRITER` | The reorder never updates scoring heats. |
| `_comp10d_guard_heat_child`, `_comp10d_guard_heat_delete` | Entry/dance assignment and heat deletion stay draft-only. |
| `move_competition_floor_heat` and the other 10D RPCs | Still draft-only; the new RPC is separate, not a loosening of them. |
| `_compo1_guard_round_status`, E1 panel freeze, E2 ballot guards | Untouched. |
| `event_competition_schedule_publications` | `unique (schedule_version_id)` kept; revisions live in their own table. |

### 1.4 New objects (additive)

Tables: `event_competition_running_order_heads`, `event_competition_running_order_revisions`, `event_competition_schedule_authorities` (design section 5);
functions: `preview_competition_running_order_change`, `apply_competition_running_order_change`, internal classifier/validator/diff helpers, the grant RPCs
(`grant_competition_schedule_authority`, `end_competition_schedule_authority`), a policy RPC (`set_competition_running_order_policy`); triggers: protect-history
(update/delete/truncate) on revisions and authorities, `BEFORE UPDATE OF heat_number` defence-in-depth trigger on `event_competition_floor_heats`.

RLS: enabled on all three tables; **no** direct DML grants to `anon`/`authenticated`/`service_role`; reads by event managers and by the event's
active grantees through column-restricted views or `SECURITY DEFINER` readers (the bare tables carry names and reasons). `anon` gets nothing.
RPCs: `revoke all ... from public, anon`, `grant execute ... to authenticated` only; helpers revoked from every API role (the O1 pattern).

## 2. Migration ordering and non-overlapping slots

Latest migration on the base is `20270218090000`. Slots seen in open PRs and design documents on 2026-11-23 (read-only; re-check at implementation):

| Slot(s) | Owner | State |
|---|---|---|
| `20270219090000` | OD-04 event delete guard (PR #844) | open implementation |
| `20270220089000`, `20270220090000`-`20270220099000`, `20270220100000` | OD-05/06/15/16/17 block (PR #834) | design |
| `20270220098000`, `20270221090000` | OD-10 ballot visibility (PR #842) | design |
| `20270221090000`, `20270221093000` | OD-07 corrections (PR #838) | design |
| `20270221090100` | TW-4F dispute hold (PR #800) | open |
| `20270222090000`-`20270222093000` | OD-11 ballot corrections (PR #843) | design |
| `20270222190000` | TW-4F inbound controls (PR #793) | open |
| `20270223090000` | TW-4F funding exposure (PR #797) **and** calendar feeds tokens (PR #820) | two PRs claim the same timestamp (not this slice's problem; flagged to the coordinator) |
| `20270221090000`, `20270222090000`, `20270222092000`, `20270222093000`, `20270223090000`-`20270223092000` | OD-12 paper verification (PR #845) | design |
| `20270223091000` | TW-4F test credit (PR #796) | open |
| `20270223130000`, `20270223140000` | integrations S0 (PRs #824, #831) | open |

**Proposed OD-26 block: `20270225090000` to `20270225099000`**, strictly after every slot found, one file per step, applied in this order:

| Timestamp | File (proposed) | Slice | Redefines an existing function? |
|---|---|---|---|
| `20270225090000` | `competition_od26_s0_running_order_data` | data + authority tables, RLS, history protection, grant RPCs | no |
| `20270225091000` | `competition_od26_s1_reorder_rpcs` | preview/apply RPCs, helpers, error vocabulary, `heat_number` defence trigger | no |
| `20270225092000` | `competition_od26_s2_floor_heat_guard_path` | the evidence-backed UPDATE bypass | **yes**: `_comp10d_guard_floor_heat` (md5-pinned, anchor replacement) |
| `20270225093000` | reserved `competition_od26_s3_cf1_system_append` (optional, Q8) | CF1 revision on Final append | **yes** (a CF1 apply function; needs the coordinator) |
| `20270225094000`-`20270225098000` | reserved: notification intents, UCWDC move-up, body-profile checks | future slices | decided per slice |

Dependency order: OD-05/06 s0 (designations) is **not** required by this block (separate grant table), so OD-26 can ship before or after PR #834's
block; if the coordinator chooses to share the table (Q7), s0 of OD-26 moves after `20270220090000`. CF1 (`20270120090000`) must be applied wherever
s2 is applied, because s2 pins the CF1-redefined body; the preflight raises if `_cf1_auth_apply_floor_heat` is missing or the body md5 differs.

Nothing was found at or above `20270224`.

**Hosted state is not assumed.** Per project rule the pin comes from the repo, and the apply status of CF1 and O1 per environment must be probed
read-only through the ops tooling before any apply; PROD apply is an owner gate. Each file's header must say "PROD apply needs separate owner approval;
not applied to any database", keep function bodies LF-only (Phase 10D CRLF lesson), and ship `rollback/<name>_rollback.sql`.

## 3. Rollback requirements

1. **Apply and roll back in reverse order**, each rollback in the same release as its apply. s2 rollback restores the pinned CF1-redefined body
   (stored in the rollback file, md5-verified), drops the `heat_number` defence trigger, then s1 drops RPCs and helpers, then s0 drops policies,
   triggers, tables (revisions last).
2. **Evidence tables are append-only**, so rollback **refuses to drop a table that holds rows** unless the operator exports them and sets an explicit
   acknowledgment setting (the PR #834 pattern). On a database where no reorder was ever applied (the state before activation) rollback is clean.
3. **A live order that was reordered is not reverted by the rollback.** `floor_heats.heat_number` keeps the last applied order (it is the live order, and
   frozen heats have run in it). The rollback runbook states this, and the revision table export is the record of how the order got there.
4. **Mechanical check**: apply all, run the suite, roll back in reverse, assert the schema fingerprint equals the pre-apply baseline (runner pattern
   `scripts/qa/cf1-db-settlement.mjs`), and assert the CF1 apply path still appends a Final (guard still permits the CF1 bypass after rollback).
5. **Application rollback first** (the console and server action ship dark behind a flag; the flag is turned off before SQL is rolled back).
6. **No data migration** is needed: heads are created lazily; nothing backfills existing events.

## 4. Pure helper module (app layer, no I/O)

`src/lib/competition/runningOrder.ts` (future): classification (section 4), permutation validation, diff, finding evaluation and checksum **mirroring** the
database, exactly like `dayOf.ts` mirrors the O1 functions: it decides what to show and which control to offer; **the database function is the authority**.
A parity test feeds the same fixtures to the module and to the RPC preview and asserts identical classification, findings and checksum.

## 5. Targeted negative test plan (negative-first)

Suites run on a local isolated Postgres under the heavy lock (patterns: `run_o1_suite.sh`, `test_T_competition_o1_concurrency.sh` with a real second
connection). **Nothing below was run for this docs PR.** Never exercise a revoked function as `anon`/`service_role` through PostgREST on the QA DB (known
segfault quirk); use direct SQL roles.

### 5.1 Authority and permissions (requirement 7)

| ID | Case | Expected |
|---|---|---|
| A1 | Studio owner with no grant calls apply | `COMPRO_NOT_AUTHORIZED` |
| A2 | Studio admin, organizer admin, organizer staff (each can manage the event today), no grant | refused |
| A3 | Platform admin, no grant | refused (no implicit right) |
| A4 | `reorder` grantee moves an in-window or checked-in heat | `COMPRO_NOT_MOVABLE`/`COMPRO_ACK_REQUIRED`, zero writes |
| A5 | Grant ended with reason, then apply | refused; ended grant row immutable (UPDATE/DELETE blocked) |
| A6 | Non-owner (studio admin) tries to grant or end a grant | refused |
| A7 | Grantee of event A acts on event B | refused; no existence leak (same message as not found) |
| A8 | Authenticated user from another studio/tenant | refused; RLS returns zero rows on all three tables |
| A9 | Anon / service_role direct DML on the three tables | denied |
| A10 | Declared-body event (`competition_sanctioning` = `ndca`/`ucwdc`/`wsdc`), valid grant | `COMPRO_BODY_AUTHORITY_UNAVAILABLE` |
| A11 | Missing reason, or reason under 3 or over 500 chars, or unknown reason code | `COMPRO_REASON_REQUIRED` |

### 5.2 Heat states and frozen records (requirements 1, 2)

| ID | Case | Expected |
|---|---|---|
| F1 | Include an `active` heat in `p_new_order` | `COMPRO_NOT_MOVABLE` |
| F2 | Same for `complete`, and for `staging` (called) | refused each |
| F3 | Floor heat with one `staging` and one `scheduled` scoring heat (mixed) | frozen |
| F4 | Never-called heat of an active round that holds a ballot | pinned, refused |
| F5 | Never-called heat with a mark/tally/result row | pinned, refused |
| F5b | Active callback round with a round-scope ballot or tally (`heat_id` null) and all heats `scheduled` | every heat of that round pinned, refused |
| F6 | Heat with `lock_state` `locked` / `certified` | pinned, refused |
| F7 | Heat whose round is `ballots_locked`, `calculated`, `approved`, `published`, `complete`, `cancelled` | pinned, refused |
| F8 | Heat entry `danced` or `disqualified` on an otherwise `scheduled` heat | frozen |
| F9 | Bypassed heat (number below the frontier, unstarted) included | refused; listed as `BYPASSED_PRESENT` |
| F10 | In-window heat or a heat with a `checked_in` entry: with level `reorder`; then with `reorder_in_window` but no acknowledgment | refused (`COMPRO_NOT_MOVABLE`); then `COMPRO_ACK_REQUIRED` |
| F11 | Acknowledgment token not equal to the preview checksum | `COMPRO_PREVIEW_MISMATCH` |
| F12 | After a successful apply: every scoring-heat row, entry, dance, panel assignment, ballot, result, round transition event and lock ledger row is byte-identical (row-hash comparison before/after) | identical |
| F13 | `staging`/`active`/`complete` heats keep their numbers and contiguity `1..n` holds after apply | holds |
| F14 | Cancelled-only floor heat reorders as an empty slot | allowed, flagged |
| PT1 | Any floor heat of the version has `planned_start_at` or `planned_duration_seconds` set | `COMPRO_PLANNED_TIMES_PRESENT`, zero writes |
| F15 | A `draft` scoring heat present in the live version | refused (not part of live order) |

### 5.3 Concurrency and transitions (requirement 5)

| ID | Case | Expected |
|---|---|---|
| C1 | Two applies from the same expected revision, real second connection | one succeeds, other `COMPRO_STALE_REVISION`; one new revision only |
| C2 | Heat call (`advance_competition_floor_heat`) commits between preview and apply | `COMPRO_STATE_CHANGED`, zero writes |
| C3 | Heat call and apply started together; either order | serialize on the per-event lock; no deadlock; final state consistent |
| C4 | Ballot insert for a candidate heat in flight when apply runs | ballot first: heat classified pinned; apply first: ballot waits then finds the heat moved but unchanged; no lost evidence, no deadlock |
| C5 | Apply while `publish_competition_schedule_version` is attempted | publish refused (`COMPO1_RUN_IN_PROGRESS` once heats ran) or serialized; no half state |
| C6 | Apply while CF1 appends a Final | serialize; Final stays last or revision records the append (Q8) |
| C7 | Scratch commits between preview and apply | fingerprint changed, refused |
| C8 | Replay of the same `request_id` | `replayed: true`, no second revision; reuse with another payload = `COMPRO_REQUEST_REUSE` |
| C9 | Lock-order check: apply vs O1 round start/cancel vs E2 lock ballots vs `set_competition_heat_lock_state` vs the CF1 revoke/correct path (`NOWAIT`) vs heat-entry check-in and scratch | no deadlock under repeated runs; NOWAIT paths fail fast, no corruption |

### 5.4 Conflicts and validation (requirements 5, 6)

| ID | Case | Expected |
|---|---|---|
| V1 | Non-permutation (missing, duplicate, extra, out-of-range number) | `COMPRO_NOT_A_PERMUTATION` |
| V2 | Reorder that would place a later round before an earlier round of a division | `ROUND_PRECEDENCE` BLOCK; a pre-existing violation does not block but a new one does |
| V3 | Final appended by CF1 moved ahead of its source round | blocked |
| V3b | Round R heat 2 moved before heat 1 of the same round | `ROUND_HEAT_ORDER` BLOCK |
| V4 | Official on two rounds' panels in one floor heat | BLOCK |
| V5 | Competitor back-to-back newly introduced | ACK required; acknowledged apply records it |
| V6 | Competitor with a different partner in adjacent heats (pro with two students) | detected via `competitor_id` |
| V7 | Quick-change gap below `quick_change_min_gap` | ACK |
| V8 | Names/emails equal but different `competitor_id` | **not** treated as the same person |
| V9 | Scratched entries | ignored for conflicts, present in the diff |
| V10 | More than one `floor_id` in the version | `COMPRO_MULTI_FLOOR_UNSUPPORTED` |
| V11 | Pull-forward below the threshold with `reorder`; at or above it with `reorder`, then with `reorder_in_window` | ACK; refused; then CONFIRM acknowledged |
| V12 | No-op proposal | `COMPRO_NO_CHANGE`, no revision |
| V13 | Any BLOCK finding | zero writes (row-hash comparison) |
| V14 | Atomicity: force a failure after the revision insert (fault injection) | whole transaction rolled back: no revision, no renumbering |

### 5.5 Audit, immutability and versioning (requirements 3, 4)

| ID | Case | Expected |
|---|---|---|
| U1 | UPDATE/DELETE/TRUNCATE on revisions and authorities as every role including the table owner path used by app roles | blocked |
| U2 | Revision numbers gapless, start at 1; baseline 0 is the publication snapshot | holds |
| U3 | `snapshot_checksum` recomputes from `order_snapshot`; revision rows contain no names, emails or phone numbers | equal |
| U4 | `diff` lists exactly the heats whose number changed, the affected non-scratched competitors, the affected panels, and the published entries changed against the announced revision | equal to an independently computed expectation |
| U5 | Each revision carries actor, grant id and level, reason code and text, timestamp, request id, transaction id | all present |
| U6 | Previous schedules preserved: revision N-1 `order_after` equals revision N `order_before` | holds; original publication row unchanged |
| U7 | A change to `heat_number` of a non-draft version **without** a same-transaction revision row, by any role or SQL path | raises (`COMP10D_SCHEDULE_PUBLISHED` or the defence trigger) |
| U8b | After the guard change: a DELETE of a published floor heat, and an UPDATE of any column other than `heat_number`/`updated_at`, still raise `COMP10D_SCHEDULE_PUBLISHED` (old-side and new-side checks both handled; each anchor patched exactly once) | holds |
| U8 | CF1 Final append still works after the guard change; draft-version edits still work; published-version delete/other-column update still refused | holds |
| U9 | Rollback revision restores an earlier order only if every moved heat is still movable | else refused |

### 5.6 Notifications (requirement 6)

| ID | Case | Expected |
|---|---|---|
| N1 | After apply, no outbound request is made and no provider/billing table or TW-4F table changes | verified by a spy on the Twilio/email adapters and a before/after row count on TW-4F tables |
| N2 | The stored audience contains ids and counts only (no phone numbers, no scoring data) | holds |
| N3 | A static test fails if the reorder RPC or its server action imports a messaging module | holds |

### 5.7 Profile fail-closed and rule tests (future slices; recorded here so they are not forgotten)

NDCA: a proposal starting an event more than 30 minutes before its published time, a first event of the day ahead of schedule, a final planned after 1:00 a.m.
each yield an acknowledgment-required finding; **an after-1:00-a.m. round is recorded as a fact with a couple count and no currency amount** (assert no
money column or value is ever written); authority basis recorded. UCWDC: a reorder separating one division's heats is blocked; a move-up record links to
the original randomization evidence. WSDC: a declared event is refused until the Chief Judge authority decision exists. Each is `unsupported` in the
register until built.

## 6. Regression set that must stay green

The existing `test_T_competition_o1_day_of.sql`, `test_T_competition_o1_concurrency.sh`, `test_T_phase10d_floor_schedule.sql`, the CF1 advancement suite
(Final append path and its guard pins), and `dayOf.o1.test.ts`. A schema-fingerprint test confirms none of the "not changed" objects in 1.3 differ.

## 7. What was verified in this docs PR

Verified: citations re-read in the pinned PDFs (hash prefixes matched the registry); existing guard names and behavior read from the repository at the
base commit; slot list from open PR file lists and design documents. **Not verified / not run:** every test above; the post-CF1 md5 of
`_comp10d_guard_floor_heat`; the hosted apply state of O1 and CF1 per environment; OD-25 register ids (that PR is in flight); the register integrity
vitest if `node_modules` is absent (see the PR body for what was run).
