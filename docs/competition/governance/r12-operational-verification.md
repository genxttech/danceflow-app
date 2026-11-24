# R-12 operational behaviors: verification report (Studio/Custom policy)

Date: 2026-11-24 · Base: `origin/release/website-embeds` (49dbaee1b) · Status: **policy ratified; implementation verification OPEN (SQL execution PENDING)**

Owner ratification R-12 (2026-11-24) records seven operational behaviors as **DanceFlow Studio/Custom policy**. They are release
gates for Studio/Custom events only. None is presented as an NDCA, UCWDC or WSDC requirement; future governing-body profile
requirements stay separate and NOT IMPLEMENTED (see [Body distinctions](#body-distinctions)).

This report changes **no SQL, no application behavior, no financial state and activates nothing**. It adds one static test, nine
rule-register entries and this document.

## Method and what "inspected" and "executed" mean here

| Term | Meaning in this report |
|---|---|
| **Inspected** | The current migration text on the release line was read, including whether a later migration redefines or patches the function (a static test asserts each function is defined by exactly one migration; `_compe2_round_role` is additionally patched in place by OJ-1 `20270215091000`), every reachable caller role, grants/revokes, trigger guards and table grants. |
| **Executed (this session)** | `src/lib/competition/governance/__tests__/r12Operational.static.test.ts` (59 checks, text pins of the gates; passes) and the rule-register integrity suite (passes). |
| **Existing SQL suites** | Listed per behavior. They are **not executed by this session** (PENDING: see [PENDING](#pending)). Their previously recorded results are not re-claimed. |

A static pin proves the gate is written as ratified; it does not prove the database behaves as written.

## Per-behavior matrix

Callers considered: manager (owner/admin/organizer staff/platform admin via `can_manage_event_competition`), Studio chair, other
team member, judge, scorer, entrant/anon, `authenticated`/`service_role` over PostgREST, and direct table writes under RLS policy
`competition_manage` (managers) with default grants. Tables `round_exclusions`, `result_publications`, `refund_exception_scopes`,
`result_versions/rows`, `ballots/marks` have no INSERT/UPDATE/DELETE grant for client roles; `rounds`, `entries`, `heats`,
`heat_entries` are manager-writable under RLS but their status edges are trigger-guarded.

| # | Behavior | Inspected (current SQL) | Executed this session | Existing SQL suites covering the negatives (not run here) | Result |
|---|---|---|---|---|---|
| 1 | Organizer exclusion (A5) | request: manager only; co-sign: manager or chair, never the requester, never a replacement-ballot filer (and the reverse); verified email; window `active`/`ballots_locked`; refused once any publication row exists; couple must have danced and be currently ineligible/refunded; ballots/marks never written; table has no client grants; revoked from public/anon/service_role | static pins | `test_T_competition_cf1_a5_exclusion.sql` (chair cannot request, same-person co-sign, U63 filer conflict, window, publication exists, cross-studio), `..._a5_u38_composed.sql`, `..._a5_concurrency.sh` | Conforms by inspection |
| 2 | Correction recovery (A7, U66) | A7 trigger refuses exclusion rows while `correction_open` (ENABLE ALWAYS); U66 is the only clearing path: manager, same-transaction audit row, blockers = current publication (wrong shape fails closed), replacement ballot, co-sign, live calculated/approved version, active advancement; E2 reopen blocked until recalculation; nothing deleted | static pins | `..._u66_recovery.sql` (1e authorization matrix, blockers), `..._a7_od13.sql`, `..._u66_concurrency.sh` | Conforms by inspection |
| 3 | Refund-driven withdrawal (R2) | participation class gates auto-withdraw (`unplaced`/`open` only); danced/disqualified placement or heat on the floor or locked/certified heat is held: scope row with `competitive_effect` for that round only; financial-only parents write no scope; scopes append-only, no client grants; resolution needs owner/admin | static pins | `..._r2_entry_refunds.sql` (A/Q1 danced entry not withdrawn and exception raised; floor-heat entry; F/D6 financial-only), `..._f3_publication.sql` ("financial-only and resolved exceptions do not block; another round's exception does not either"), `..._rb3_*` | **Finding R12-F1 (low), note R12-F2** |
| 4 | Reopen ballots (E2) | manager only (chair refused), reason 1-500 chars, round must be `ballots_locked`, approved/published result versions and any publication row refuse, unknown shape fails closed; the `ballots_locked -> active` edge needs the audit row of the same transaction and client roles cannot write status; U66 adds `COMP_REOPEN_RECOVERY_PENDING`; no other writer of that edge found | static pins | `..._e2_ballots.sql` (section 11: chair/scorer/other studio refused, reason, only locked rounds, approved version refused), `..._hl1_*`, `concurrency/run_hl1_reopen_vs_lock_ballots.sh` | Conforms by inspection |
| 5 | Publication holds (F3) | manager only; no override parameter; refuses stale hash, undecided tie row, advancement from another version, round-scoped competitive refund exception, ineligible roster; wrong shape fails closed, deadlock/timeout propagate (retry); publication rows no client writes | static pins | `..._f3_publication.sql` (stale, unresolved tie, exception, unrelated exception, roles), `..._f3_concurrency.sh` | Conforms by inspection |
| 6 | Round cancellation (O1) | `can_manage_event_competition`; reason 3-500; refused for `cancelled`/`complete`, any publication, any `staging`/`active` heat; only open `draft`/`scheduled` heats cancelled, run heats kept; status trigger makes `cancelled`/`complete` terminal for every writer and bars client-role status writes | static pins | `..._o1_day_of.sql` (`COMPO1_HEAT_RUNNING`, `COMPO1_PUBLISHED`, `COMPO1_BAD_STATE` for re-cancel, `COMPO1_ROUND_STATUS_WRITER`, terminal), `..._o1_concurrency.sh` | Conforms by inspection |
| 7 | Studio chair authority (E1/E2/A5-A7, OJ-1) | chair: lock ballots, attendance, no-show mark/void, co-sign exclusion/withdrawal/correction; refused: initiate exclusion/reversal/recovery/withdrawal request, reopen, calculate (manager/scorer only), approve, publish, complete, open correction, cancel, schedule/start/advance, all 10D running-order writers (manager gate in `_comp10d_require_draft`); chair needs an active team member since OJ-1; designation is a manager action, one active chair per event | static pins | A5/E2/U66/A6/A7/NS1/E1 suites assert chair refusals for exclusion, reversal, recovery, reopen, withdrawal request; **no SQL assertion that a chair is refused calculate, approve, publish, complete, cancel or running-order writers** | Conforms by inspection; SQL negative matrix PENDING |

## Release findings (Studio/Custom). Design only; nothing was changed.

### R12-F1 (low): registration cascade skips an entry with a scratched placement in a locked heat and records no exception

- Where: `sync_competition_entries_from_registration` (R2 `20270103090000`, withdraw `where ... not exists (... h.lock_state in ('locked','certified'))`) versus `_r2_entry_participation_class`.
- Evidence (inspection): the trigger ignores `he.status`, so any placement in a locked/certified heat holds the entry; the class ignores a scratched placement in a locked heat, so an entry with that plus a scheduled placement in an open heat classifies `open`. The held-entry loop raises an exception only for `locked`/`certified`, so a cancelled registration or failed payment leaves such an entry confirmed and **silently** untouched. R2 test P2-3a pins that `_r2_withdraw_entry` (refund path) does withdraw this shape, so the two paths disagree.
- Severity: low. Needs a scratched placement in a locked heat plus an open placement; an unpaid entry stays eligible to compete.
- Bounded correction (design): make the trigger's "held" test use the same predicate as the class (call `_r2_entry_participation_class` and withdraw only `unplaced`/`open`), so both paths agree; add a SQL test for the shape. Alternative: raise an exception for the skipped entry. Needs an owner/engineering decision; not implemented.
- Status: **not reproduced by execution (PENDING).**

### R12-F2 (info, owner wording check): unattributed/reversed refunds hold "locked", not only "danced", entries

R-12 says an entry that "has danced" is held. R2 holds any entry in a locked/certified heat or a heat on the floor (conservative, same as SC1). An unattributed or reversed refund on an order with such an entry opens a competitive scope and blocks that entry's round until attributed or resolved by an owner/admin. Financial-only parents with no held entry write no scope and never block. Confirm the owner's wording; no change proposed.

### Notes that are not findings

- **Self-approval override.** `approve_competition_round_result` lets the calculator approve with a recorded reason (owner decision D3). It is not one of the five publication holds, and the stale-hash check runs before it. A static pin asserts that order.
- **service_role.** The 10D running-order writers accept `auth.role() = 'service_role'` and E2 functions are not revoked from `service_role` (they refuse because `auth.uid()` is null). Server-side trusted only; for OD-26.
- **Chair is not a manager.** A person who is both manager and chair acts as manager. `_compe2_round_role` tests manager first, then chair, then scorer (pinned).
- **Cancel from `ballots_locked`/`calculated`/`approved`.** Allowed (R-12 refuses only after publication or on the floor); result versions then stay as evidence.

## Body distinctions

Recorded as register entries; none is a Studio/Custom gate.

- The **Studio chair** (`R12-DF-0007`) is a DanceFlow database role. It is distinct from the NDCA Chairman and the WSDC Chief Judge; body official designations belong to OD-06 (PR 834). No body role is implemented.
- **NDCA III.D.3** (Rule Book June 2026, Master v1; the organizer must adhere to the categories, dances and levels in promotional material) is relevant to future NDCA round-cancellation controls: `R12-NDCA-0001`, **NOT IMPLEMENTED**. `cancel_competition_round` has no link to promotional material.
- **NDCA V.B.6** says only that an organizer need not accept future entries from a couple that fails to appear without notice: `R12-NDCA-0002`, NOT IMPLEMENTED. The pinned rulebooks tie no refund to participation or results, so refund-driven withdrawal and publication holds are **DanceFlow policy only**.
- UCWDC and WSDC requirements are not touched here and stay NOT IMPLEMENTED where they apply.

## Coordination

| With | Point |
|---|---|
| PR 859 (R-07/R-08/R-09/R-11, `r07-scoring-verify`) | Not duplicated; its RB-11.1/RB-11.2 notes are R-11 and unrelated to these seven. |
| PR 858 (R-10 panel defect) | Panel-size/odd-panel gating of `lock_competition_round_ballots` is its subject; chair lock authority here is only the role gate. |
| PR 856 (OD-31 guarded baseline, U18/U18-S) | U18 guards not re-verified. Shared SQL container/slot requested (see PENDING). |
| PR 853 (OD-20) | Exclusion label wording; SQL emits no "disqualification" string for exclusions (pinned). |
| PR 838 (OD-07) | Reopen of completed/approved/published results must go through the correction-case process; R-12 behavior 4 only proves there is no reopen-ballots path. |
| PR 843/845 (OD-11/12) | Ballot-correction design; correction recovery here is U66 only. |
| PR 854 (OD-26) | Running order is manager-only (`_comp10d_require_draft`); chair has no scheduling authority; service_role note above. |
| PR 834 (OD-06) | Body official designations and the NDCA Chairman / WSDC Chief Judge are separate from the Studio chair. |

## PENDING

1. **Execute the existing SQL suites** on the composed Competition chain: a5, a5_u38, u66, a7, e2, o1, r2, f3, ns1, hl1 (reopen-vs-lock) and the matching concurrency scripts. Needs the heavy-lock FIFO queue (`C:\dfr\heavy.queue`, one ticket, oldest and lock free). At the time of writing the queue had one earlier ticket (~50 min), so the run was not started; a request to share the `od31-guarded-baseline` session's slot was sent and unanswered. Until then these results are **not** claimed.
2. **Reproduce R12-F1** with a small test-only SQL file on that chain (registration cancel with a scratched placement in a locked heat plus a scheduled placement in an open heat; expect withdrawn or an exception).
3. **Add a SQL chair negative matrix** (chair refused: calculate, approve, publish, complete, open correction, cancel, schedule/start/advance, floor-plan writers). The static test already pins the gates in text.
4. Independent review of this report: see the PR description.

## Files added

- `src/lib/competition/governance/__tests__/r12Operational.static.test.ts`
- `docs/competition/governance/rule-register/rules/R12-DF-0001..0007.json`, `R12-NDCA-0001.json`, `R12-NDCA-0002.json`
- this document
