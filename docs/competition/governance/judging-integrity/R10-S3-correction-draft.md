# R-10 part 3 (S3): owner review package for draft PR 864

**DRAFT. NOT APPLIED to DEV or PROD. Hosted apply is NOT requested.** Studio/Custom policy only (DanceFlow policy, K1 X-3); governing-body panel rules (NDCA III.B.1, WSDC 3.4.7,
UCWDC Rule #3) stay in PR #834. Design history: PR #858. **This PR does not close the R-10 part 3 release blocker** (closing criteria: PR #858 section 12).

**Specific approval requested:** review, and merge if satisfied, of this draft as Git-only dark code into `release/website-embeds`. Nothing else.

## 1. Heads and evidence

| Item | State |
|---|---|
| Base | branched from `release/website-embeds` `49dbaee1b`. The base is now `57c331910` (PR #867 landed JC1, U18 and U18-S): this branch is 1 behind and merges cleanly. The 37 Competition migration files of the run 2 / run 3 chain are byte-identical to `57c331910` |
| Migration files | the three forward files and the `100000`/`101000` rollbacks are **byte-identical since `9d3dad169ebd6dd682ef762fcc886b6fce3b087f`**. The **`102000` rollback changed** in the P1 recovery update (owner and grants, section 3) |
| **P1 recovery run** (2026-11-27 11:08-11:15Z) | **EXECUTED**: E1 passes on the composed P1 chain; the `102000` rollback restores owner and grants when applied as `supabase_admin` or `postgres` (section 5) |
| Composed run (run4, S5 runner, all 8 correction migrations, head `9d3dad16`) | **EXECUTED**: S3 suite PASS 88 checks forward and after re-apply; reverse rollback of all 8 OK; re-apply OK. **13 of 20 forward suites FAILED** (7 passed, S3 included; 10 of the failures passed before apply): see section 5. Hashes in `run4/migrations-new.sha256` match `9d3dad16` |
| STANDALONE run 1 (S3 as the only correction PR; chain in section 5) | EXECUTED 2026-11-26 13:22-13:26Z, S3 head `9d3dad16`: apply, suite (88), rollback and re-apply OK; schema comparison incomplete and showed a rollback ownership difference (section 5). Superseded by run 2 |
| **STANDALONE run 2** (head `cde6b1225`) | **EXECUTED 2026-11-26 19:09-19:14Z**: S3 suite PASS 92 checks after apply and after re-apply; schema comparison after rollback IDENTICAL to before apply (object types in section 5); four races, no deadlock. Two committed suites still fail with and without S3 |
| **Run 3** (E1 and R2 refunds, test files of this update) | **EXECUTED 2026-11-27 03:56-03:58Z**: E1 as committed here PASS 109 without S3, 110 with S3, 109 after rollback; R2 refunds with the fix from #926 PASS 158 in all three (section 5) |
| CI | three Vercel checks passed on earlier heads; see the PR for the current head. **No GitHub Actions workflow runs for this PR** (the only workflow's path filter matches neither migrations nor docs): CI verifies none of the SQL |
| Hosted counts (read-only 2026-11-24) | DEV 73 rounds, PROD 8, all draft, no assigned panel, 0 misleading-ready, 0 stuck, 0 `min_panel_judges`, 0 absences. The apply gate must re-run them (and add `minimum_panel_size`) |

## 2. What changed since the first review (head `5eea51ff`)

| Failing assert (composed run3) | Root cause | Did a guard change? |
|---|---|---|
| `unrelated configuration key still editable` raised `COMP_CAPACITY_DIRECT_WRITE` | Fixture error: the test wrote `max_entries_per_heat`, which the CF1 guard `cf1_guard_round_capacity` reserves for its RPC | **No.** The suite uses a neutral key and now asserts the capacity guard still refuses |
| `r9 reports panel_member_ineligible and is not ready` | Wrong expectation: JC1 (`20270215092000`, live on DEV/PROD, not on this base branch) counts a deactivated judge without a ballot as absent, so readiness correctly says `panel_even`. This exposed a real gap: deactivation after start broke a panel with no recovery case | No existing guard changed. **S3 itself changed** (below) |

S3 changes in `102000` since `5eea51ff`: new trigger `compr10_official_status_panel` (ENABLE ALWAYS; never blocks deactivation or reactivation; locks the round FOR SHARE and re-checks it is active; opens or closes the recovery case);
attendance now inserts first and evaluates the real resulting panel (a refusal rolls back); confirmation is required for the change that turns a valid panel invalid, for `present` as well as `absent`, and not again for later changes on an already
invalid panel; audit refs now separate `panel_break_confirmed` and `recovery_case_opened`. `101000`: comment only. `100000`: unchanged. Tests: S3 suite updated; E1 and E2 suites adjusted (section 6).

At S4 (R-15) request, the E2 suite later gained a clearance call that does nothing unless S4's test fixture is loaded. Run 2 predates it. It was later **executed** in the S4/S5 combined run (run6, 2026-11-26, S3 head `a1b0eb9d5`, 8 correction migrations): E2 PASS (211) in its baseline, forward and S5-only phases (evidence `run6/suites-*.tsv`, read here; that run belongs to those sessions). Not independently reviewed.

## 3. What ships

| File | Behavior |
|---|---|
| `100000` | `_comp_r10_panel_check` and readiness v2 (`competition_round_panel_status` redefined; same signature, grants and old keys). Default minimum = the method rule (3, odd); configured values only raise it before start; malformed config fails closed; only `ordinal_majority` and `callback_tally` can be ready; an absent judge does not count, so absence blocks when it leaves the panel too small or even; an even panel, or (before and after start) an ineligible present judge, makes it not ready; `meets_configured_minimum` reported separately. `competition_round_panel_ready`, O1 start, the lock, `_compe2_panel_rule`, blockers and engines are unchanged |
| `101000` | Trigger validating `min_panel_judges` (1-99; ordinal/callback at least 3 and odd), re-validating on a scoring-method change, freezing the key after start. `minimum_panel_size` is listed in the trigger columns but is neither validated nor frozen |
| `102000` | Case table (managers read, no direct writes, immutable); six-argument attendance function (five-argument dropped) with per-round lock and confirmation; official-status trigger. A case closes automatically when an attendance or official-status change makes the panel valid |
| Rollbacks | Restore the E1 status and E2 attendance bodies byte for byte; drop triggers and helper; **102000 refuses once any case exists, and 100000's rollback requires 102000 rolled back first**, so after the first case readiness v2 is forward-fix only. The `102000` rollback **restores owner `postgres` and EXECUTE for the owner, `authenticated` and `service_role` only, whichever role applies it**, and otherwise fails changing nothing; apply it with `ON_ERROR_STOP=1` (psql exits 0 on a refusal without it). It restores that fixed state, not a captured one. App first, then SQL |

Authority (unchanged): assign/unassign = event manager, draft/scheduled only; attendance = manager or the event chair (OJ-1 team condition); readiness and cases = managers; `min_panel_judges` = manager, draft/scheduled only.

## 4. Dependencies and merge safety

- **Merge alone:** yes, mechanically, as Git-only dark code. Nothing in CI applies or executes these files.
- **Apply order (later, separate approval):** requires CF1 and **JC1 in the database** (hosted DBs have both; JC1 is on the base since PR #867). Apply the forward files as role `postgres` (as another superuser the new six-argument function would be owned by it, and a rollback run as `postgres` would be refused), and read the current owner and grants of the five-argument function first: the rollback assumes the state above. Without JC1 the official-status trigger never opens a case. The apply is not preflighted for JC1.
- **App change is a PREREQUISITE of hosted apply** (correction of an earlier "SQL-before-app is safe" claim): the current app sends five arguments, so after apply any change that turns a valid panel invalid is refused with a generic error. **Drafted separately in #925** (base `release/website-embeds`). Order per environment: merge and deploy #925 (safe on today's database), then apply this SQL; reload the PostgREST schema cache after apply (`notify pgrst, 'reload schema';`, which `102000` does not send); do not roll the app back while the SQL is applied.
  Example: 5 judges, 2 absent after start: the first absence (4, even) cannot be recorded without the flag, so the valid 3-judge panel is never reached and the lock stays blocked. The app change with the confirmation must be deployed first.
  Not in #925: `officials/contract.ts` copy (with absences `judge_count` includes absent judges, so "Panel ready (5 judges)" can show with 3 present), copy for the new `missing` codes and `COMP_PANEL_MIN_*`, and a distinct message for the reused `COMP_ROUND_CONFIG_FROZEN`.
- **Shared files:** this PR modifies only `test_T_competition_e1_officials.sql` and `test_T_competition_e2_ballots.sql` among existing files; no other open PR on this base edited them when checked 2026-11-26. E1 now needs `sql-tests/fixtures/competition_round_ready.sql` (already on the base branch) loaded first. #863 and #866 insert the same lines near line 223 of the R2 refunds suite (#866 adds more after them); #926 edits a different place (test merges of #926 with each: no conflict). Related: #866 (S4) also edits that fixture helper; #858 and #834 add files in the same docs folder.
- Behavior change needing confirmation (Q-R10-1): rounds with any other scoring method can no longer start (DEV 17 draft rounds, PROD 8).

## 5. Tests: executed vs PENDING

**Standalone run 1** (local disposable Postgres from image `cf1host:found`, no network, never a hosted database). Chain: 23 migrations applied on the image, being the Competition migrations of base `49dbaee1b` **plus JC1, U18 and U18-S taken from `92a8c17c6`, which were not on the base branch then** (PR #867 has since landed byte-identical migration files), then the three S3 files from `9d3dad169`. Suites and fixtures also came from `92a8c17c6`, except the S3 suite (`9d3dad169`) and, with S3 applied, E1/E2 (`cdac85fb0`). The S3 suite depends on JC1, so its pass is not evidence for the base branch as it stands.

| Item | Status |
|---|---|
| Apply (3), rollback (3), re-apply (3) | EXECUTED, all OK |
| S3 suite after apply and after re-apply | EXECUTED, PASS (88) both times |
| With S3 applied: E2 (211), JC1 (15), O1 (95), NS1 (152), PV-1 (30), CF1 A2 (35, 1 blocked), A3 (119, 5 blocked), OD17 (59), F3 (191), U18 (21), U18S (17), R2 write gate (21), phase 10D (79) | EXECUTED, PASS; same counts before apply and after rollback (before apply and after rollback E2 ran the base-branch copy) |
| E1 suite and R2 entry-refunds suite | **FAIL in all three phases with the same first error, with and without S3** (`COMPO1_ROUND_EDGE`; `COMPO1_HEAT_STATUS_WRITER`): the fixtures predate the O1 guards. E1 stops before reaching any S3-related step |
| Schema comparison after rollback | INCOMPLETE in run 1 (a harness query error stopped it after `public` functions). The part that ran **differed by 2 lines**: the rollback ran as `supabase_admin`, so the recreated five-argument attendance function was owned and granted by `supabase_admin` instead of `postgres` (body hash equal). **A rollback restores ownership only when run as `postgres`.** Completed, as `postgres`, by run 2 |
| Races R1 (two absences) and R3 (deactivation then attendance) | EXECUTED: the second session finished only after the first's hold ended (commit time inferred, not logged); no deadlock; no round had more than one open case |
| Race R4 (attendance then deactivation) | Confounded in run 1 (R3 had already opened a case on that round); redone in run 2 |
| Race R2 (attendance then ballot lock) | EXECUTED, partial: the lock saw the committed attendance (4 judges present) and then refused because the fixture round has no heat. A successful lock racing attendance is not exercised |
| Rollback with open cases | EXECUTED: refused as designed |
| Composed run4 on `9d3dad169` (all 8 correction migrations) | EXECUTED: S3 PASS (88); reverse rollback and re-apply of all 8 OK. FAIL with the 8 applied: E1, JC1, U18, U18-S, F3, O1, NS1, OD-31 negative, R2 refunds, R2 write gate, phase 10D, phase 10C, R15 (E1 and R2 refunds also failed before apply; R15 is a new suite and also failed after re-apply). First errors: R15 and S5 gates; for NS1 and R15 a **bug in the R15 migration** (`malformed array literal` in `_r15_required_criteria`; that pattern is gone at the PR 866 head `3b65f63d1`); an R15 fixture helper (OD-31 negative); and the O1 edge (E1). None names an S3 object. Those suites stopped early, so **run4 gives no S3 compatibility evidence for them**, and E2 is not in run4 |

**Standalone run 2** (same image, isolation and base chain composition as run 1, including JC1/U18/U18-S from `92a8c17c6`; S3 files from `cde6b1225`, applied, rolled back and re-applied as role `postgres`). The S3 suite (run only with S3 applied), E2 and the QA variant of E1 are the PR copies in every phase they run in; committed E1 is the PR copy with S3 applied. The other suites come from `92a8c17c6`.

| Item | Status |
|---|---|
| Apply (3), rollback (3), re-apply (3) | EXECUTED, all OK |
| S3 suite, including the raised-minimum checks | EXECUTED, PASS (92) after apply and after re-apply |
| E2 suite | EXECUTED, PASS (211) before apply, with S3 and after rollback: five-argument fallback and six-argument path both run |
| With and without S3: JC1 (15), O1 (95), NS1 (152), PV-1 (30), CF1 A2 (35, 1 blocked), A3 (119, 5 blocked), OD17 (59), F3 (191), U18 (21), U18S (17), R2 write gate (21), phase 10D (79) | EXECUTED, PASS in all three phases |
| E1 with a **QA-only, uncommitted** two-line setup edit (replica mode around one round activation, to get past the O1 edge) | EXECUTED, PASS (109) in all three phases, so both branches of the changed E1 check ran. **This is not a pass of the committed suite** |
| Committed E1 suite and R2 entry-refunds suite | **FAIL in all three phases** (`COMPO1_ROUND_EDGE`; `COMPO1_HEAT_STATUS_WRITER`), with and without S3: the fixtures predate the O1 guards |
| Schema comparison, `public`: functions (definition, owner, grants), triggers, relations, constraints, policies, columns, indexes, views, types | EXECUTED: 21,435 rows **identical** before apply and after rollback; re-apply identical to first apply. Not compared: comments, sequence settings, other schemas, non-function routines |
| Race R1 (two absences) | EXECUTED: first opened a case, second closed it as restored with 3 present; the second waited |
| Race R3 (deactivation then attendance) | EXECUTED: the second waited; one open case on each affected round |
| Race R4 (attendance then deactivation), on a round no other race touches | EXECUTED: no case and 3 present beforehand; attendance opened the case; deactivation waited; one open case |
| Race R2 (attendance then ballot lock) | EXECUTED, partial as in run 1: the fixture round has no heat, so a successful lock racing attendance is not exercised |
| All races | no deadlock in the server log; at most one open case per round |
| Rollback with open cases | EXECUTED: refused as designed |
| Start-vs-attendance and start-vs-deactivation races; ballot-lock-first ordering; `test_T_competition_e2_p1fix.sql` and `test_T_competition_o1_concurrency.sh` with S3 | PENDING, not run |
| E2 clearance call added after `cde6b1225`; composed compatibility with the other correction PRs | Not covered by run 2. The E2 call ran later in run6 (section 2); other composed compatibility stays PENDING |

**Run 3** (same image, isolation and base chain composition as run 2; S3 files unchanged). It covers the two suites that failed before.

| Item | Status |
|---|---|
| E1 suite **as committed**, with the fix ported from `176058570` (round 1 is activated through the O1 functions; the raised-minimum check is unconditional again, before activation; the S3 freeze check is kept) | EXECUTED: PASS without S3 (109), with S3 (110), after rollback (109) |
| R2 refunds suite with the one-statement fixture fix (#926, not part of this PR) | EXECUTED: PASS (158) without S3, with S3, after rollback |
| Apply (3) and rollback (3) as `postgres` | EXECUTED, all OK; schema comparison not repeated (run 2) |
| E1 on a chain with the other correction PRs | EXECUTED in the P1 recovery run (below). R2 on such a chain is not covered here |

**P1 recovery run** (same image and isolation; ticket `20261127T102146Z-comp-r10s3-p1fix`; two fresh databases). The earlier combined P1 run (`p1run4`, S3 head `4d6d692cb`) showed E1 stopped by the under-18 guard (`COMP_S5_AGE_BLOCKED`, unknown age) and the rolled-back attendance function owned by `supabase_admin`. E1 now seeds an adult date of birth and obtains clearance through S4's shared fixture `r15_clear_entries.sql` (inert when not loaded or without R-15). The composed chain used the `p1run4` files, with only the `102000` rollback replaced.

| Item | Status |
|---|---|
| Steps (apply, rollback, re-apply) | EXECUTED, 54 OK, 0 failed |
| E1, standalone chain | PASS without S3 (109), with S3 (110), after rollback (109) |
| E1, composed chain | PASS with the 12 correction migrations (110), with the P1 restrictions added (110), after full rollback and re-apply (110) |
| S3 suite, standalone | PASS (92) |
| S3 rollback applied as `supabase_admin` and, separately, as `postgres` | Schema fingerprint (functions with owner and grants, triggers, relations, constraints, policies) **identical** to before apply, both times |
| Composed rollback applied as `supabase_admin` | The attendance function matches the pre-apply state. **Two other differences remain, from no S3 file**: the definition of `change_competition_entry_lifecycle` and the grants on `event_competition_entries` (their owners' PRs) |
| Rollback by a role without rights | Refused, nothing changed (it stops at the first table read, before the new code) |
| QA-only copies of the rollback with one grant, or the owner statement, removed | Both refused by the end-state check, nothing changed; also unchanged without `ON_ERROR_STOP` |

**P1 pilot copy** (`sql-tests/test_T_competition_r10_s3_panel_readiness_p1pilot.sql`, added 2026-11-27). In the combined P1 run `p1run6` (head `b94183a32`) the original suite passed on the chain without the pilot restrictions and stopped with `COMP_P1_CALLBACKS_OFF` on the restriction chain, because one fixture round is callback-scored. The original is unchanged; **a pass of the copy is never a pass of the original.**

| Assertion | In the copy |
|---|---|
| `callback_tally with 3 judges is ready` | **DROPPED**: the restrictions refuse creating a callback round or switching to one |
| `default minimum is the rule (3), not 1` and the four raised-minimum assertions on round r2 | Kept, but measured on an ordinal round |
| Switching a draft round to callback scoring is refused | ADDED (only where the restrictions are installed) |
| Everything else | Unchanged |

Status: **NOT EXECUTED** at the time of writing (targeted rerun owned by the OD-02 session; expect 92 checks, 91 would mean the restrictions are absent). Not covered: a callback round that existed before the restrictions were applied. `20270301180000`'s preflight does not look for one and its guard acts only on insert or a method change; hosted counts on 2026-11-24 showed none.

## 6. Independent review of head `9d3dad16` (subagent, read-only, waited for)

Verdict: **acceptable for owner review of a draft: yes; not ready for hosted apply.** No blocker. Verified by reading: rollback bodies byte-identical; `ready = true` implies the lock's panel check at that instant; privileges, search paths, RLS and immutable triggers; no deadlock cycle traced; merge-alone safety.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | major | "SQL-before-app is safe" is wrong (see section 4) | Document corrected; app change drafted in #925. OPEN until merged and deployed before any apply |
| 2 | major | E1 suite changed `min_panel_judges` on an active round and would abort under S3 | FIXED in tests; the committed suite passes with and without S3 (run 3) |
| 3 | major | E2 suite's six-argument call fails on older runner chains | FIXED in tests (conditional on the function existing). Both paths passed in run 2 |
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
| M1 | major | Race R4 confounded by R3 | Stated in section 5; redone on an untouched round in run 2, passed |
| M2 | major | run4 rows omitted the failed suites | Stated in sections 1 and 5 |
| M3 | major | "Base chain + this PR only" omitted JC1/U18 from another commit | Stated in section 5 |
| M4 | major | No assertion that a raised minimum blocks a valid draft panel | Assertions for `min_panel_judges`, `minimum_panel_size` and `meets_configured_minimum` added to the S3 suite; passed in run 2 |
| m1-m2 | minor | Schema caveat and absence wording | Corrected |
| m3, m5 | minor | Stale S3 suite header; loose E1 error match | Fixed in tests |
| m4 | minor | The saved run 1 script alone does not reproduce run 1 (E1/E2 copies replaced afterwards) | Recorded here; run 2 pinned one commit |

The changes made after this review have not been independently re-reviewed.

### Third independent review: run 3 changes, #926 and #925 (subagent, read-only, 2026-11-27)

Verdict: **each acceptable as a draft; no blocker.** It did not run anything, check GitHub state or see the type check and test results.

| Finding | Disposition |
|---|---|
| Major: app files sat uncommitted in this worktree | Only the E1 suite and this document are committed here |
| Major: the package named the old base | Corrected in sections 1, 4 and 5 |
| Minor: the checkbox `required` test assertion was vacuous | Fixed in #925; fails when `required` is removed |
| Minor: schema cache is not reloaded by `102000` | Added to the apply order; not verified on a hosted project |
| Minor: the refused judge stays in the URL; the reason must be retyped | Message now says to retype; URL behavior stated in #925 |
| Minor: R2 comment overstated what replica mode skips | Comment corrected in #926 (the executed file differs only there) |
| Minor: two statements here about #863/#866 and deploy order | Corrected |
| Minor: the moved E1 minimum check has no "ready before raising" control, and tests a draft round | OPEN (same as the ported commit; on this chain activation then requires readiness) |

The fixes made after this review (listed above) have not been re-reviewed.

### Fourth independent review: P1 recovery changes (subagent, read-only, 2026-11-27, before the run)

Verdict: **no blocker, no major.** It predicted by reading that E1 would pass on the composed chain, and set the acceptance points for the run (all met above).

| Finding (minor) | Disposition |
|---|---|
| The rollback restores a fixed state, so a database that differed before apply would gain `service_role` EXECUTE or lose extra grants (the restored body still refuses callers without a signed-in user) | Pre-apply read added to the apply order |
| Without `ON_ERROR_STOP`, a refused rollback exits 0 | Stated in section 3 |
| A default grant option for `postgres` would cause a false refusal | OPEN; fails closed |
| Forward `102000` takes owner from the applying role | Added to the apply order |

## 7. Recovery design gaps (why the blocker stays open)

1. No repair actions: return-to-scheduled (class A) needs an amendment of the O1 status guard; withdraw-after-ballots (B1) needs ballot-reader changes; retire-and-re-dance (B2) is an owner decision (Q-R10-4). A stranded round can only be cancelled unless the judge returns.
2. No case or wrong case after ballot reopen, a ballot racing a deactivation, a partly balloted judge becoming inactive, or eligibility loss; cancelled rounds keep open cases.
3. Deactivation strands without confirmation (by design: revoking access is never blocked); trigger-opened cases write no audit event and attribute to the official when there is no signed-in actor.
4. Differences from the PR #858 case design: no ballot snapshot, no chair read, no cancelled status.
5. Owner questions open: Q-R10-1 (unsupported methods cannot start), Q-R10-3 (dual control), Q-R10-4 (B2), Q-R10-5 (chair counts as a voting judge). Q-R10-2 is implemented as advisory after start.
