# R-10 part 3 (S3): draft correction PR, owner review package

**DRAFT. NOT APPLIED to DEV or PROD. No merge, deploy or activation requested.** Studio/Custom policy only (DanceFlow policy, K1 X-3). Governing-body panel rules
(NDCA III.B.1, WSDC 3.4.7, UCWDC Rule #3) are out of scope and stay in PR #834. Design and review history: PR #858
(`docs/competition/governance/judging-integrity/R10-studio-panel-readiness-correction.md`, sections 5, 6, 14).

## What the draft contains (migration block 20270301100000-102000; S1/S2 use 090000, S4 110000+, S5 120000+)

| File | Purpose |
|---|---|
| `20270301100000_competition_r10_s3_panel_readiness.sql` | Helper `_comp_r10_panel_check` (the panel as the lock and engines see it) and readiness v2: `competition_round_panel_status` redefined (same signature/grants/old keys, new keys). Default minimum = the method's rule (3, odd) instead of 1; configured values only raise; malformed config fails closed; unsupported methods (`none`, `relative_placement`, `skating`, `proficiency_rating`...) are not ready; absence read; even panel refused; ineligible lettered judge refused; after start `ready` follows the rule only and `meets_configured_minimum` is reported separately. `competition_round_panel_ready` and O1 `start_competition_round` are unchanged. |
| `20270301101000_competition_r10_s3_round_panel_config_guard.sql` | SECURITY DEFINER, ENABLE ALWAYS trigger on `event_competition_rounds`: validates `min_panel_judges` (whole number 1-99; for ordinal/callback at least 3 and odd), re-validates on `scoring_method` change, freezes the key after start, validates only when the key or method changed (unrelated config edits never blocked). Never looks at assignments, so a draft panel stays freely editable. |
| `20270301102000_competition_r10_s3_attendance_panel_break.sql` | `record_competition_judge_attendance` gets `p_confirm_panel_break boolean default false` (5-arg function dropped). Per-round advisory lock; an absence after start that leaves a panel the lock cannot accept is refused with `COMP_PANEL_BREAK_CONFIRM_REQUIRED` unless confirmed, and a confirmed one opens an immutable `event_competition_panel_recovery_cases` row (snapshot, reason, request id); a case closes automatically when any attendance change makes the panel valid again. Absence before start is accepted and simply makes readiness false. |
| `rollback/*_r10_s3_*_rollback.sql` | Restore the E1 status text and the E2 attendance text byte for byte (extracted from the original migrations; no CR), drop the helper/trigger; the case table is dropped only if empty (evidence is never destroyed). Roll back 102000, then 101000, then 100000. |
| `sql-tests/test_T_competition_r10_s3_panel_readiness.sql` | New suite (negative + regression, see below). `sql-tests/test_T_competition_e1_officials.sql` fixture rounds now carry `scoring_method = 'ordinal_majority'` (the suite relied on the default `none` being startable). |

NOT changed: `_compe2_panel_rule`, `_compe2_round_blockers`, `lock_competition_round_ballots`, the engines, `registry.ts`, O1 `start_competition_round`. No guard is weakened; readiness is strictly stricter or equal.

## Who may do what (unchanged authority, now explicit)

| Action | Authority |
|---|---|
| Assign / unassign panel members | manager of the event (E1 RPCs, unchanged), only while the round is draft/scheduled; frozen afterwards (`COMP_PANEL_FROZEN`) |
| Record attendance | manager or the round's chair (E2 `_compe2_round_role`, unchanged); confirmation flag needs the same authority |
| Read readiness / recovery cases | managers of the event; judges, other studios and anon get nothing (RLS; no direct writes, `revoke all` + definer-only writes) |
| Change `min_panel_judges` | manager, draft/scheduled only, validated by the trigger |
| Recovery ACTIONS (return to scheduled, withdraw after ballots) | NOT in this draft (design-only, PR #858 section 6): they need amendments to the O1 status guard and the ballot readers |

## Recovery: what ships and what does not

Ships: detection, an explicit confirmation before a round is stranded, and an auditable, immutable case with a snapshot of the panel at the time; automatic closure when the panel is valid again. Does NOT ship: the actions that repair a stranded round (class A return-to-scheduled, class B1 withdraw after ballots, class B2 re-dance). Until those slices ship, a confirmed break still leaves cancellation as the only repair for that round (restoring presence also works when the judge returns). This is a stated remaining gap, so the R-10 part 3 blocker is **not closed** by this PR; closing criteria remain as in PR #858 section 12.

## Compatibility and existing rows

Hosted counts (read-only 2026-11-24): DEV 73 rounds and PROD 8 rounds, all draft, none with an assigned panel, 0 misleading-ready, 0 stuck, 0 `min_panel_judges`, 0 absences. The migrations edit no row. Preflight of each file refuses a partial/duplicate apply; **the apply gate (outside this PR) must re-run the PR #858 section 4 counts query and stop if any misleading/stuck row exists.** Behavior changes that need owner confirmation (Q-R10-1): rounds whose method has no Studio panel rule can no longer start (they could never lock); DEV holds 17 such draft rounds (8 `none`, 9 `relative_placement`), PROD 8 (`skating`).

## App/UI dependencies (NOT changed in this PR)

- `src/lib/competition/officials/contract.ts` `PanelStatus`/`panelStatusLabel` keep working with the old keys (`ready`, `judge_count`, `min_judges`, `missing`); new keys (`present_judge_count`, `rule_known`, `odd_required`, `scoring_method`, `meets_configured_minimum`) and the new `missing` codes (`scoring_method_unsupported`, `panel_even`, `panel_member_ineligible`, `configured_minimum_invalid`) need copy via the relabelling stack: until then an even panel shows "Panel not ready" without the reason.
- `src/app/app/events/[id]/competition/ballots/actions.ts` (attendance call): must pass `p_confirm_panel_break` and show the confirmation; until then a break after start returns the error `COMP_PANEL_BREAK_CONFIRM_REQUIRED` as a generic failure (SQL-before-app is safe: the default is false).
- `e2e/helpers/competitionScheduleHeats.ts:244` reads `ready`; e2e fixtures that start rounds must use a supported method and a 3-judge panel.
- Known impacted existing fixtures (to be updated at apply time, not yet run): `sql-tests/fixtures/competition_round_ready.sql` users, `test_T_competition_o1_day_of.sql` (stand-in function, unaffected until removed), `test_T_competition_e2_*` (round activation path), any F2/CF1/HL1 suite that starts a round through real readiness with a default-method or 1-judge panel.

## Tests: executed vs PENDING

| Item | Status |
|---|---|
| Read-only hosted counts and the lifecycle trace | EXECUTED (PR #858) |
| Register integrity test | EXECUTED (25/25) at PR #858; re-run in CI for this PR |
| New SQL suite (default minimum, parity sweep 1-6 judges, unsupported methods, config guard negatives, fail-closed bad value, attendance before/after start, confirmation, case open/auto-close, idempotent replay, authorization, direct writes, immutability, frozen panel, ineligible judge, lock agreement) | WRITTEN, **PENDING execution** (heavy-lock queue; no ticket taken, queue not displaced) |
| Concurrency: two sessions racing attendance / assignment / lock | **PENDING** (needs two connections; specified in PR #858 section 10 N-RACE-1..4; the advisory lock and the existing round `FOR UPDATE`/`FOR SHARE` serialization are reviewed but not executed) |
| Regression of E1/E2/O1/F2 suites after the change | **PENDING** (see impacted fixtures) |
| Current-behavior reproduction (PR #858 section 11) | **PENDING** |
| Independent security review (subagent, waited for) | DONE: findings below; fixes applied in this PR |

## Specific approval requested

Review (and, if satisfied, merge) of this DRAFT as Git-only, dark code. **Hosted apply to DEV or PROD is NOT requested.** Apply needs a later, separate approval with the apply-gate counts re-run and the PENDING tests executed.

## Remaining gaps

1. Recovery actions (class A/B1/B2) not built; B2 policy is an owner decision (Q-R10-4).
2. Executed verification and concurrency tests (PENDING above).
3. UI copy and confirmation dialog (relabelling stack).
4. Possible predicate sharing with the S4 eligibility-clearance function: not needed by this readiness (it reuses the E1 eligibility filter verbatim); no contract was agreed with S4.

## Independent security review (read-only subagent; nothing executed)

Overall: migrations compile on reading, security posture sound, readiness implies the lock rule for the two supported methods, rollbacks textually identical to the E1/E2 originals (no CR), no deadlock in the lock order (pair advisory, round FOR SHARE, r10 advisory vs start/lock FOR UPDATE), advisory lock serializes two absences (READ COMMITTED fresh snapshots), no new oracle for non-managers, PostgREST ambiguity removed.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | blocker (suite) | Section 5 updated round status to scheduled without replica mode; O1 status guard would abort the suite | FIXED (replica wrapper) |
| 2 | major | A `present` record that makes the panel invalid (3 + 1 restored = 4, even) was never gated and opened no case | FIXED: the after-state is evaluated for both statuses; test added |
| 3 | minor/major | With a case open, a worse absence (3 to 1) needed no confirmation | ACCEPTED AS DESIGNED (first fix reverted after the composed run): confirmation is required only for the change that turns a valid panel invalid; later changes are audited events and the case stays open. A "worse than the case" rule would also have failed the released JC1 suite. Coordinator may overrule. |
| 4 | minor | Snapshot `judges[].absent` showed the judge as present | FIXED |
| 5 | minor | Confirm flag in the fingerprint only when true; replay of a different flag is `COMP_REQUEST_REUSED` | INTENTIONAL, asserted by a test; pre-existing request ids keep their fingerprint |
| 6 | major (rollout) | `ballots/actions.ts:169` sends five args so a break after start fails with the confirm error until the UI passes the flag | KNOWN dependency (listed); safe failure; rollback order app first, then SQL |
| 7 | minor | Replaced bodies not md5-pinned (status function checked by substring only) | OPEN: pin the installed md5 values from an applied QA chain before apply (cannot be computed without a database run) |
| 8 | minor | Rollback preflight could fail with relation-does-not-exist on re-run | FIXED (guarded `if`) |
| 9 | minor | Truncate trigger of the case table not ENABLE ALWAYS | FIXED |
| 10 | minor | Methods other than ordinal/callback can no longer start; a legacy even/low stored minimum blocks a method switch until fixed | Owner Q-R10-1; UI copy needed |
| 11 | minor | After start `ready` goes false if a judge with ballots becomes inactive although the lock would accept; informational (only O1 start reads `ready`) | ACCEPTED; UI should read `missing` codes |
| suite | minor | The section 7/8 readiness probe used a round that had lost its panel (vacuous) | FIXED (probe r5); direct UPDATEs as `authenticated` rely on the competition_manage RLS plus default grants: verify when the suite runs |

Re-review of the fixes after this PR was opened: NOT done (the fixes are small and covered by the new suite once it runs; recorded here as a remaining gap).

## Composed-run triage (integrated run3, S3 on top of the other draft slices; runner owned by the S5 session)

| Failing assert / suite | Classification | Evidence | Action |
|---|---|---|---|
| `unrelated configuration key still editable` raised `COMP_CAPACITY_DIRECT_WRITE` | **Suite fixture error.** The "unrelated" key was `max_entries_per_heat`, which the existing CF1 guard `cf1_guard_round_capacity` (20270120090000) reserves for its RPC | run3 `suite-forward-..._r10_s3_...log` | Suite uses a neutral key and now also asserts the capacity guard still refuses. Neither guard changed |
| `r9 reports panel_member_ineligible and is not ready` | **Suite expectation error plus a real S3 gap.** JC1 (20270215092000, live on DEV/PROD, not on this base branch) redefines `_compe2_is_absent`: a deactivated judge without a ballot is absent, so readiness correctly reports `panel_even`, not `panel_member_ineligible`. It also showed deactivation after start breaks a panel with no confirmation or case | JC1 migration text | New trigger `compr10_official_status_panel` (102000; never blocks deactivation, opens/closes the recovery case); attendance evaluates the real post-insert panel instead of predicting it; suite split into the JC1 path and the membership-removal path |

Dependencies: the R10-S3 suite needs CF1 and JC1 in the chain. `test_T_competition_e2_ballots.sql` changes one call (restoring a judge that makes the panel even now passes the confirm flag), so that suite needs S3 applied.

Not attributable to S3 (first error in run3 forward logs): `COMP_R15_ENTRY_NOT_CLEARED` (S4) and `COMP_S5_AGE_BLOCKED` (S5) abort the other suites, which therefore also **mask** any S3 effect on them; `e1_officials`, `o1_day_of` and others already fail on the baseline (`e1_officials`: `COMPO1_ROUND_EDGE`, so the E1 fixture edit here is unverified). No forward log other than the S3 suite mentions an S3 object or error code.

**PENDING executed run:** the whole corrected S3 suite (every assert, since fixes changed the SQL), apply/rollback/re-apply of the changed 102000 pair, the E2 and JC1 suites composed with S3, and all concurrency races.

### Focused review of the triage changes (independent subagent, read-only; waited for)

No blocker or high finding; no new deadlock cycle; deactivation cannot be failed by the trigger apart from ordinary lock or statement timeouts (it can now wait on an in-flight lock); sections 6-8 of the suite trace as passing with JC1.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | medium | A round reopened after ballots_locked can have an invalid panel and no case (official reactivated while locked) | **OPEN gap**: needs a round-status trigger, which would overlap S4's round gates; coordinate before adding |
| 2 | medium-low | The status trigger did not serialize with lock / cancel and could open a case on a non-active round | FIXED: round FOR SHARE with an active re-check before the advisory lock |
| 3 | low | A ballot racing a deactivation can leave a stale open case | **OPEN gap** (same fix as 1) |
| 4 | low | Audit flag `panel_break_confirmed` meant "case opened" | FIXED: two separate keys |
| 5 | low | The E2 suite's six-argument call fails on runner chains that stop before 102000 (`run_cf1_integration.sh`, `run_cf1_od17.sh`, `run_cf1_f3.sh`, `concurrency/run_e2_*`) | **OPEN dependency** for the runner owner: those chains must include this block, or the call be made conditional |
| 6 | low | A partly balloted judge who becomes inactive stays counted and gets no case | **OPEN gap** (recovery class B); comment narrowed |
| 7 | info | Attribution falls back to the official when there is no `auth.uid()`; no audit event for trigger-opened cases | Trigger now ENABLE ALWAYS and privilege assert added; attribution and audit event remain open |

The fixes for 2, 4 and 7 were not re-reviewed and nothing here has been executed.
