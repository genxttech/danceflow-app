# R-10 part 3 (S3): owner review package for draft PR 864

**DRAFT. NOT APPLIED to DEV or PROD. Hosted apply is NOT requested.** Studio/Custom policy only (DanceFlow policy, K1 X-3); governing-body panel rules (NDCA III.B.1, WSDC 3.4.7,
UCWDC Rule #3) stay in PR #834. Design history: PR #858. **This PR does not close the R-10 part 3 release blocker** (closing criteria: PR #858 section 12).

**Specific approval requested:** review, and merge if satisfied, of this draft as Git-only dark code into `release/website-embeds`. Nothing else.

## 1. Heads and evidence

| Item | State |
|---|---|
| Base | `release/website-embeds` at `49dbaee1b` (branch 0 behind) |
| Migration files (the three `20270301100000/101000/102000` files and rollbacks) | **byte-identical since `9d3dad169ebd6dd682ef762fcc886b6fce3b087f`**; later commits change only tests and this document |
| Composed run (run4, S5 runner, all 8 correction migrations, head `9d3dad16`) | **EXECUTED**: S3 suite PASS 88 checks forward and after re-apply; reverse rollback of all 8 OK; re-apply OK. **13 of 20 forward suites FAILED** (7 passed, S3 included; 10 of the failures passed before apply): see section 5. Hashes in `run4/migrations-new.sha256` match `9d3dad16` |
| STANDALONE run 1 (S3 as the only correction PR; chain in section 5) | **EXECUTED 2026-11-26 13:22-13:26Z**: S3 applies, passes (88), rolls back and re-applies. The rollback schema comparison was **incomplete**. Run 2 is queued; **tests changed after run 1 have not been executed** |
| CI | three Vercel checks passed on `cdac85fb0`; not rechecked on later commits. **No GitHub Actions workflow runs for this PR** (the only workflow's path filter matches neither migrations nor docs): CI verifies none of the SQL |
| Hosted counts (read-only 2026-11-24) | DEV 73 rounds, PROD 8, all draft, no assigned panel, 0 misleading-ready, 0 stuck, 0 `min_panel_judges`, 0 absences. The apply gate must re-run them (and add `minimum_panel_size`) |

## 2. What changed since the first review (head `5eea51ff`)

| Failing assert (composed run3) | Root cause | Did a guard change? |
|---|---|---|
| `unrelated configuration key still editable` raised `COMP_CAPACITY_DIRECT_WRITE` | Fixture error: the test wrote `max_entries_per_heat`, which the CF1 guard `cf1_guard_round_capacity` reserves for its RPC | **No.** The suite uses a neutral key and now asserts the capacity guard still refuses |
| `r9 reports panel_member_ineligible and is not ready` | Wrong expectation: JC1 (`20270215092000`, live on DEV/PROD, not on this base branch) counts a deactivated judge without a ballot as absent, so readiness correctly says `panel_even`. This exposed a real gap: deactivation after start broke a panel with no recovery case | No existing guard changed. **S3 itself changed** (below) |

S3 changes in `102000` since `5eea51ff`: new trigger `compr10_official_status_panel` (ENABLE ALWAYS; never blocks deactivation or reactivation; locks the round FOR SHARE and re-checks it is active; opens or closes the recovery case);
attendance now inserts first and evaluates the real resulting panel (a refusal rolls back); confirmation is required for the change that turns a valid panel invalid, for `present` as well as `absent`, and not again for later changes on an already
invalid panel; audit refs now separate `panel_break_confirmed` and `recovery_case_opened`. `101000`: comment only. `100000`: unchanged. Tests: S3 suite updated; E1 and E2 suites adjusted (section 6).

At S4 (R-15) request, the E2 suite later gained a clearance call that does nothing unless S4's test fixture is loaded. **Not executed** by any run recorded here (run 2 pins `cde6b1225`, before it).

## 3. What ships

| File | Behavior |
|---|---|
| `100000` | `_comp_r10_panel_check` and readiness v2 (`competition_round_panel_status` redefined; same signature, grants and old keys). Default minimum = the method rule (3, odd); configured values only raise it before start; malformed config fails closed; only `ordinal_majority` and `callback_tally` can be ready; an absent judge does not count, so absence blocks when it leaves the panel too small or even; an even panel, or (before and after start) an ineligible present judge, makes it not ready; `meets_configured_minimum` reported separately. `competition_round_panel_ready`, O1 start, the lock, `_compe2_panel_rule`, blockers and engines are unchanged |
| `101000` | Trigger validating `min_panel_judges` (1-99; ordinal/callback at least 3 and odd), re-validating on a scoring-method change, freezing the key after start. `minimum_panel_size` is listed in the trigger columns but is neither validated nor frozen |
| `102000` | Case table (managers read, no direct writes, immutable); six-argument attendance function (five-argument dropped) with per-round lock and confirmation; official-status trigger. A case closes automatically when an attendance or official-status change makes the panel valid |
| Rollbacks | Restore the E1 status and E2 attendance bodies byte for byte; drop triggers and helper; **102000 refuses once any case exists, and 100000's rollback requires 102000 rolled back first**, so after the first case readiness v2 is forward-fix only. App first, then SQL |

Authority (unchanged): assign/unassign = event manager, draft/scheduled only; attendance = manager or the event chair (OJ-1 team condition); readiness and cases = managers; `min_panel_judges` = manager, draft/scheduled only.

## 4. Dependencies and merge safety

- **Merge alone:** yes, mechanically, as Git-only dark code. Nothing in CI applies or executes these files.
- **Apply order (later, separate approval):** requires CF1 and **JC1 in the database** (hosted DBs have both; PR #867 lands JC1 in Git). Without JC1 the official-status trigger never opens a case. The apply is not preflighted for JC1.
- **App change is a PREREQUISITE of hosted apply** (correction of an earlier "SQL-before-app is safe" claim): `ballots/actions.ts:169` sends five arguments, so after apply any change that turns a valid panel invalid is refused with a generic error.
  Example: 5 judges, 2 absent after start: the first absence (4, even) cannot be recorded without the flag, so the valid 3-judge panel is never reached and the lock stays blocked. Ship the confirm dialog and copy with the SQL.
  Also needed: `officials/contract.ts` copy (with absences `judge_count` includes absent judges, so "Panel ready (5 judges)" can show with 3 present), copy for the new `missing` codes and `COMP_PANEL_MIN_*`, and a distinct message for the reused `COMP_ROUND_CONFIG_FROZEN`.
- **Shared files:** only `test_T_competition_e1_officials.sql` and `test_T_competition_e2_ballots.sql` are modified; no open PR on this base touches them. Related, no same-file conflict: #866 (S4, `fixtures/competition_round_ready.sql`) and #863 (S5, o1 suite) may need S3 fixtures later; #858 and #834 add files in the same docs folder.
- Behavior change needing confirmation (Q-R10-1): rounds with any other scoring method can no longer start (DEV 17 draft rounds, PROD 8).

## 5. Tests: executed vs PENDING

**Standalone run 1** (local disposable Postgres from image `cf1host:found`, no network, never a hosted database). Chain: 23 migrations applied on the image, being the Competition migrations of base `49dbaee1b` **plus JC1, U18 and U18-S taken from `92a8c17c0`, which are not on the base branch**, then the three S3 files from `9d3dad169`. Suites and fixtures also came from `92a8c17c0`, except the S3 suite (`9d3dad169`) and, with S3 applied, E1/E2 (`cdac85fb0`). The S3 suite depends on JC1, so its pass is not evidence for the base branch as it stands.

| Item | Status |
|---|---|
| Apply (3), rollback (3), re-apply (3) | EXECUTED, all OK |
| S3 suite after apply and after re-apply | EXECUTED, PASS (88) both times |
| With S3 applied: E2 (211), JC1 (15), O1 (95), NS1 (152), PV-1 (30), CF1 A2 (35, 1 blocked), A3 (119, 5 blocked), OD17 (59), F3 (191), U18 (21), U18S (17), R2 write gate (21), phase 10D (79) | EXECUTED, PASS; same counts before apply and after rollback (before apply and after rollback E2 ran the base-branch copy) |
| E1 suite and R2 entry-refunds suite | **FAIL in all three phases with the same first error, with and without S3** (`COMPO1_ROUND_EDGE`; `COMPO1_HEAT_STATUS_WRITER`): the fixtures predate the O1 guards. E1 stops before reaching any S3-related step |
| Schema comparison after rollback | **INCOMPLETE**: a harness query error stopped the comparison after `public` functions, and for those only the definition hash and grants were captured. One difference: the grants of the restored five-argument function name a different grantor (owner inferred, not captured; the harness applied as `supabase_admin`; body hash and API-role grants equal). Triggers, relations, constraints, policies and columns were **not** compared |
| Races R1 (two absences) and R3 (deactivation then attendance) | EXECUTED: the second session finished only after the first's hold ended (commit time inferred, not logged); no deadlock; no round had more than one open case |
| Race R4 (attendance then deactivation) | **Confounded in run 1**: R3 had already opened a case on that round, so it shows only that the second session waited. Run 2 uses a round and judge the other races never touch |
| Race R2 (attendance then ballot lock) | EXECUTED, partial: the lock saw the committed attendance (4 judges present) and then refused because the fixture round has no heat. A successful lock racing attendance is not exercised |
| Rollback with open cases | EXECUTED: refused as designed |
| Composed run4 on `9d3dad169` (all 8 correction migrations) | EXECUTED: S3 PASS (88); reverse rollback and re-apply of all 8 OK. FAIL with the 8 applied: E1, JC1, U18, U18-S, F3, O1, NS1, OD-31 negative, R2 refunds, R2 write gate, phase 10D, phase 10C, R15 (E1 and R2 refunds also failed before apply; R15 is a new suite and also failed after re-apply). The first errors are R15 and S5 gates, an R15 fixture helper, and the O1 edge (E1); none names an S3 object. Those suites stopped early, so **run4 gives no S3 compatibility evidence for them**, and E2 is not in run4 |
| **Run 2** (head `cde6b1225`): S3 suite including the new raised-minimum checks; schema comparison of `public` functions, triggers, relations, constraints, policies, columns, indexes, views and types with S3 applied and rolled back as `postgres`; E2 five-argument fallback; E1 with a QA-only, uncommitted edit that gets past the O1 edge; corrected R4 | **PENDING**: one FIFO ticket queued 2026-11-26T14:39Z (`comp-r10s3-rerun`). Not covered even then: comments, sequence settings, other schemas, non-function routines. An E1 pass with the QA edit is not a pass of the committed suite |
| Start-vs-attendance and start-vs-deactivation races; ballot-lock-first ordering | PENDING, in no script |

## 6. Independent review of head `9d3dad16` (subagent, read-only, waited for)

Verdict: **acceptable for owner review of a draft: yes; not ready for hosted apply.** No blocker. Verified by reading: rollback bodies byte-identical; `ready = true` implies the lock's panel check at that instant; privileges, search paths, RLS and immutable triggers; no deadlock cycle traced; merge-alone safety.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | major | "SQL-before-app is safe" is wrong (see section 4) | Document corrected; app change is an apply prerequisite. OPEN until built |
| 2 | major | E1 suite changed `min_panel_judges` on an active round and would abort under S3 | FIXED in tests (asserts the freeze; the original check still applies without S3). **Not yet executed**: the suite stops earlier on an O1 guard (section 5) |
| 3 | major | E2 suite's six-argument call fails on older runner chains | FIXED in tests (conditional on the function existing). Six-argument path executed; five-argument fallback PENDING (run 2) |
| 4 | major | Package and some SQL comments stale | Document rewritten. SQL comments left unchanged to keep the tested files byte-identical: `100000` header says after start ready follows the rule only (ineligible judges and unsupported methods also block); `102000` header omits the status trigger; a comment says an invalid started panel always has an open case (not true, see gaps); table comment says cases come from a confirmed absence only |
| 5 | minor | Cancelling a round leaves its case open forever (no `closed_cancelled` status) | OPEN |
| 6 | minor | Team removal or credential loss after start: readiness blocks, lock still counts the judge, no case | OPEN |
| 7 | minor | 102000 rollback checks emptiness without locking, so a concurrent case could be dropped | OPEN; roll back only with writers stopped |
| 8 | minor | Rollback unavailable after the first case | Stated in section 3 |
| 9 | minor | Replaced bodies not md5-pinned; JC1 not preflighted | OPEN before apply |
| 10 | minor | `minimum_panel_size` unvalidated; error code reused | OPEN |
| 11 | minor | Unused parameter; lock-order comment inaccurate (safe only because both round locks are FOR SHARE) | OPEN |

### Second independent review: tests and this package at `902c1bb49` (subagent, read-only, waited for)

Verdict: **not accurate enough as written until its four majors were corrected; headline run 1 numbers hold.** No blocker. It found the E1/E2 changes valid by reading. It did not execute anything or re-review the migrations.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| M1 | major | Race R4 confounded by R3 | Stated in section 5; race script corrected for run 2 (not yet run) |
| M2 | major | run4 rows omitted the failed suites | Stated in sections 1 and 5 |
| M3 | major | "Base chain + this PR only" omitted JC1/U18 from another commit | Stated in section 5 |
| M4 | major | No assertion that a raised minimum blocks a valid draft panel | Assertions for `min_panel_judges`, `minimum_panel_size` and `meets_configured_minimum` added to the S3 suite (not yet executed) |
| m1-m2 | minor | Schema caveat and absence wording | Corrected |
| m3, m5 | minor | Stale S3 suite header; loose E1 error match | Fixed in tests |
| m4 | minor | The saved run 1 script alone does not reproduce run 1 (E1/E2 copies replaced afterwards) | Recorded here; run 2 pins one commit |

The changes made after this review have not been independently re-reviewed.

## 7. Recovery design gaps (why the blocker stays open)

1. No repair actions: return-to-scheduled (class A) needs an amendment of the O1 status guard; withdraw-after-ballots (B1) needs ballot-reader changes; retire-and-re-dance (B2) is an owner decision (Q-R10-4). A stranded round can only be cancelled unless the judge returns.
2. No case or wrong case after ballot reopen, a ballot racing a deactivation, a partly balloted judge becoming inactive, or eligibility loss; cancelled rounds keep open cases.
3. Deactivation strands without confirmation (by design: revoking access is never blocked); trigger-opened cases write no audit event and attribute to the official when there is no signed-in actor.
4. Differences from the PR #858 case design: no ballot snapshot, no chair read, no cancelled status.
5. Owner questions open: Q-R10-1 (unsupported methods cannot start), Q-R10-3 (dual control), Q-R10-4 (B2), Q-R10-5 (chair counts as a voting judge). Q-R10-2 is implemented as advisory after start.
