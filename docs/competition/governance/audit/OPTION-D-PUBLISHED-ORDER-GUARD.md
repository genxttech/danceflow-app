# Option D: published running-order write guard (draft, NOT APPLIED ANYWHERE)

Owner conditional approval 2026-11-26 (non-applied draft engineering and local tests only). No DEV / PROD apply, merge, deploy or activation is requested.

## The gap (executed evidence)

Local run of 2026-11-26 (PR 865, `R-11-PROBE-LOG.txt`, database role `authenticated`, one manager, composed chain without this change): on a **published, never-run** heat these direct writes were **accepted**: changing `round_id`, detaching it from its version, changing `heat_number`, setting status `cancelled`. Moving a published spare heat to a new round this way was one of the four executed routes to a self-approved replacement of a corrected result (route R). Already refused then: floor-heat, division, contest, time and label changes together (placement validator), delete and heat-entry changes (10D).

## What the migration does (`20270301170000`)

* Heats: a direct client write that changes a placement column (including floor label, dance offering, duration, status), inserts into, or deletes from a published or past order is refused; every referenced version must be a draft and is locked `FOR SHARE`.
* Versions: clients create only draft / review; cannot move a draft into another status; on a version that left draft / review only `name` and `updated_at` can change; no delete.
* Publication: `publish_competition_schedule_version` becomes **SECURITY DEFINER** (it already requires `can_manage_event_competition`; `anon` keeps its grant and is refused by that check) and locks the version `FOR UPDATE` before validating. Pinned text replacement: pre md5 `9a61cd9bcdbe8557d76cd6ec9e72c82c` (the 10D text, computed offline), post `abccc653c7c2380c7ec65c97a54526dd`.
* Rollback restores the pinned publication text and drops the two triggers and two functions.

## What it does NOT close

**The spare-round replacement routes (NC, CS, CA) stay open**: they use no direct write. That is Option B (separate decision write-up). Also unchanged: heat entry and heat dance status writes (U18 / U18-S own entry status), direct inserts of publication rows, round name or sequence changes, heat configuration, TRUNCATE grants, advanced-mode schedule items.

## Dependencies and interplay

Base `release/website-embeds`; independent of PR 865 (touches no approval object). Effectiveness against replacement also depends on **U18 (PR 867)**. S4 (PR 866) `r15_guard_*` triggers fire before these (`zz_` names). S3 (PR 864): none. **OD-26 (PR 854)** writes only floor-heat numbers through a definer function: unaffected; a later authorized change to published heats must be a definer function. OD-07 (PR 838) / OD-12 (PR 845): none. Legitimate writers were inventoried by code reading: all definer except create-version, heat-plan apply and entry lifecycle, which write drafts or entry status.

## Review

An independent reviewer of the first draft found one blocker (a manager could still unpublish or replace the live order by direct writes) and test / runner defects (suite could not pass; four suites silently skipped; vacuous gap checks; old floor-heat branch untested; columns missing; publication race). This revision changes the publication function, the version rule, the columns, the suite, the races and the runner in response. **The revision itself has not been re-reviewed.**

## Tests

`sql-tests/test_T_competition_d_published_order_write_guard.sql`, `sql-tests/concurrency/run_d_publish_race.sh`, runner `scripts/qa/comp-d/run-d-standalone.sh` (baseline, apply, existing suites, rollback, re-apply, races; F2 races with PR 865 as information only).

### Executed 2026-11-26 (local, disposable database; nothing hosted)

Head `60b4edd7e`, migration sha256 `1607747d…`, composed base (`release/website-embeds` competition files plus JC1 / U18 / U18-S), base fingerprint `d87e42858e6c…`. S3 to S6 are not in this chain. Runner verdict: **D STANDALONE: PASS** (22 expectations met, 0 failed), finished 20:37Z.

| Step | Result |
|---|---|
| Baseline (without D) | the D suite fails on its gap checks; races R1, R2, R3 are **not** refused (gap reproduced) |
| Forward | applies, including the pinned pre and post publication md5 checks; 2/2 triggers; D suite **PASS (45 checks)**; D races **PASS (11 checks)** |
| Existing suites, forward | O1, 10D, 10D.1, F2, A3, F3, A0 tie policy, A4, A5, A6, HL1, NS1: same passing verdicts as baseline (A3, A0 tie, A4, A5, A6 keep their own reported blocked checks) |
| **Not covered** | callback-Final advancement suite: **fails on the base chain too** (`COMP_U18S_SCRATCH_UNAUDITED` on a direct scratch), so D's effect on advancement is **not** shown by it |
| Rollback, replay, re-apply | no D object left; replay clean; re-apply 2/2 and D suite passes |
| Information only: F2 lifecycle races (PR 865 branch script, PV-1 verifier neutralized), **without** PR 865 | PASS (25 checks; its step Z skipped, no node modules) |
| Information only: the same **with** PR 865 (`d5c3bed52`) | **No verdict.** The log stops after step D; steps E and Z and the final check did not run, consistent with the runner's 600-second limit (the run without PR 865 took nearly as long). **Concurrency of the PR 865 approval change remains unverified.** |

D does not close the spare-round replacement routes, and this run does not change that.

## Re-review findings under P1: executed 2026-11-27

Run on head `41cecd3e9` (lock 13:40Z, finished 13:54Z), disposable local database. The P1 chain uses the composed run's own S / R package and restriction files (manifest checked; base fingerprint matched), with only D swapped: **before** = `db5c9b876`, **after** = this head. Verdict of the whole job: **FAIL** (28 expectations met, 5 not; causes below).

| Finding | Before, beside P1 (executed) | After, beside P1 (executed) | Reachable under P1? |
|---|---|---|---|
| Publication does not serialize other writers: **heat entry** | accepted; the entry is in the published order | waits, refused, nothing entered | **yes** |
| the same: **schedule session** | accepted into the published order | waits, refused | **yes** |
| the same: definer heat move | refused by the restrictions (`COMP_P1_BUSY`) | waits, refused | no (observed once) |
| Manager inserts a publication snapshot row | accepted; a forged row for a draft then **blocks its publication** (unique violation) | refused (row-level security) | **yes** |
| "keep" checks asserted no effect | test weakness | each asserts its effect; all of them passed | not a vulnerability |

Also passed in this run: publication races 25 checks (standalone and P1 chain), planted-heat probe (reproduced before its fix, not after), apply preflight, D rollback and re-apply beside the restrictions, rollback / replay / re-apply on the standalone chain.

**Not met, both from this change, fixed in `8e371bd56` (rerun pending):**
* one D suite check (forward, re-apply, P1 chain): "move to another round" had been changed to move the division too, so the existing placement validator refused it before D;
* the 10D.1 and NS1 suites assert which triggers heat entries may carry and rejected `aa_compd_lock_heat_entry`. The lock triggers are now `cf1_compd_lock_*`, the prefix those suites allow for later additions. Side effect: six CF1 suites disable every `cf1_%` trigger on heats, entries and rounds inside their own rolled-back transaction, so D's lock is off during those suites.

Callback-Final advancement suite: not covered (fails with and without D).

### Composed run beside the restrictions (`/c/dfr/s5int-out/p1run4`, D `db5c9b876`): D failures

| Failure | Defect or harness |
|---|---|
| D suite, chains C and E: no verdict (`compp1_one_round_per_division`) | harness: D's fixtures put several rounds in one division |
| D races, chain C: fixtures | harness: the same |
| D suite, chain B: two publication "keep" checks (`COMP_R15_PROVISIONAL_ASSIGNMENT`) | harness: fixtures not cleared through R-15 |
| D races, chain B: R2 "did not wait" | defect in D's **test**: after the planted-heat fix that write is refused at once; the earlier standalone pass depended on slow timing |

No D guard defect was found in that run. Both suite and races now pass or are corrected for that chain. Separately, on chain C the 10D.1 suite already failed on a restriction trigger on heat entries, which is not D's.

## Evaluation against pilot P1 (PR 795 section 21, `0d68b2f38`): by reading; run result in the next section

P1 disables running-order replacement and cancellation after a start, enforced at the database. D alone does **not** do that: it stops direct client writes; lifecycle functions (round cancel, publication, advancement) pass it, and are the P1 restriction work (slots `180000`-`189000`).

| D part | Needed by P1? | Why |
|---|---|---|
| Heat guard (placement columns, insert, delete) | **Yes** | without it a manager moves, detaches, renumbers or cancels **never-run published heats** by direct write, also while other heats have started (the writes were executed in the PR 865 probe; the start guard freezes only started heats). This includes the replacement route that re-points a spare heat |
| Planted-heat rule and publication check | **Yes** | a planted heat leaves a live numbered heat's entries and dances directly writable after start: a running-order change at the database, with publication's entry conflict checks bypassed and, by inference, S4's entry clearance. By reading it **cannot** receive ballots (ballot heats need a published version), so scoring is not affected. Reproduced and fixed by execution (next section) |
| Version guard | **Yes, mainly before a start** | after a start the existing `compo1_guard_publish_during_run` already refuses status inserts and updates for every writer (not deletes or other columns). Before a start, without D a manager can reopen a published order, edit it and re-publish by direct write, skipping publication's checks, and the heat guard relies on draft status |
| Publication as definer with row lock | **Yes, if the version guard is kept** | publication's own status writes must pass it |

**Smaller subset:** the heat guard with the planted-heat rule alone would cover the after-start window, but leaves direct publication before a start. It is **not recommended**: the saving is small and the trimmed text would need a new review and run.

**Overlap and conflict with the P1 restrictions:** complementary by design (D: direct writes; restrictions: lifecycle functions after a start). D exempts the owner role, so a restriction meant to bind definer functions needs its own check. Publication's text is pinned by D (post `0fbbbef9670082fbb3cb2484d966dfa3`, slot `170000`, before `180000`): a restriction that redefines publication must pin that text. D's triggers are named `zz_` and fire after others.

**Restriction plan, as reported by its session (later reported drafted and under review, not pushed; unverified here):** branch `claude/od31-p1-pilot-restrictions`, `20270301180000_competition_p1_pilot_restrictions.sql`. It redefines no function (not publication, round cancel or the publication guard), so D's pin chain is untouched. It adds only `zz_compp1_*` triggers (ENABLE ALWAYS, no role exemption) and unique indexes on heats, heat dances, schedule versions, rounds, divisions, programs, heat entries, entries, ballots and approvals, refusing heat and version replacement and cancellation after the event starts for every writer; direct writes before a start remain D's. Order D then restrictions; each applies without the other. By name order `zz_compd_*` fires before `zz_compp1_*`, so a direct write both refuse reports D's error code. A combined run of the two is **not done** and belongs in the P1 composed test.

**Open re-review findings seen against P1:** finding 2 (publication does not serialize other draft writers) is a before-start race past publication's checks, and so relevant to P1 requirement 4; findings 3 to 5 (definer tests and grants, insertable publication rows, weak "keep" checks) are hardening and test gaps. None is fixed; fixing them would expand D and is not done.

## Fix of blocker 1: hole REPRODUCED, fix verified by a local run (2026-11-27)

Run on head `5600ea301` (code `39ad748b9`, docs-only commits since), migration sha256 `ef9b868a…`, composed base fingerprint `d87e42858e6c…` (unchanged although `release/website-embeds` advanced to `57c331910`). Disposable local database; nothing hosted. Lock taken 04:09Z, finished 04:27Z. Verdict **D STANDALONE: PASS** (26 expectations met, 0 failed).

| Step | Result |
|---|---|
| **Before the fix** (`02cf1c73d`), as authenticated manager | **REPRODUCED.** Planting the heat and publishing were accepted; after publication an entry and a dance were added to the planted heat and the dance changed. Read-back: order published, 1 planted heat, 1 entry, dance Foxtrot; deleting the entry was also accepted. Control: the same entry write on a properly versioned published heat was refused (`COMP10D_SCHEDULE_PUBLISHED`) |
| Apply check | the fixed migration **refuses to apply** over an already planted published order |
| **With the fix** | **not reproduced**: the plant step is refused by D (`COMPD_PUBLISHED_ORDER_WRITE_REFUSED`) |
| D suite | **PASS (51 checks)**, also after rollback and re-apply |
| Twelve existing suites | same passing verdicts as without D |
| **Not covered** | callback-Final advancement suite fails with and without D (`COMP_U18S_SCRATCH_UNAUDITED`) |
| Rollback, replay, re-apply | clean |
| Publication races | without D the gap reproduces; with D **PASS (11 checks)** |

Not in this run: S3 to S6, the P1 restrictions, PR 865 concurrency.

### The fix

Within D's own files: a client heat that references a numbered floor heat or a schedule block must carry a schedule version; publication refuses an order holding a heat that is not its own (`COMPD_ORDER_HEAT_VERSION_MISMATCH`); the migration refuses to apply while such a heat sits in a published or past order. Publication post md5 is now `0fbbbef9670082fbb3cb2484d966dfa3` (pre unchanged), computed offline; the sections above that quote `abccc653…` describe the earlier revision. Findings 2 to 6 of the re-review below stay open.

`sql-tests/probe_D_planted_heat.sql` reproduces the finding with read-back; the runner executes it before the fix (`02cf1c73d`) and after.

**Independent review of the fix (`d2ee7e3f4`, by reading only): no blocker.** It recomputed the post md5. Applied: the runner now also requires the plant step itself to be refused after the fix. Not applied, recorded:
* a legacy planted row in a **draft** can be left unrepairable by clients (clearing the floor plan removes floor heats but not an unversioned heat, which then dangles); under a `review` version it blocks publication until the version returns to draft. Such rows are not in the apply check;
* the apply check takes no table lock, so a write between the check and trigger creation could plant a row;
* only the floor-heat branch of the publication and apply checks is tested (the schedule-block case is tested in the guard only).

## Independent re-review of the revision (`5a84cff9f`, by reading only): NOT READY

Written before the fix. **Blocker 1 has since been reproduced and fixed (section above).** Findings 2 to 6 remain open and are not reproduced by execution.

| # | Severity | Finding | Suggested correction |
|---|---|---|---|
| 1 | **BLOCKER** | A heat with **no `schedule_version_id`** but a `floor_heat_id` in a **draft** is accepted (D lines ~100-117; the composite foreign key skips a null column, `20261111090000:115-117`). Publication counts floor-heat members by `floor_heat_id`, so the heat goes live with the order. The 10D child guard judges only the heat's own version, so its **entries and dances stay directly writable in the published numbered heat** (insert, delete, re-point), and by inference S4's entry-clearance guard treats it as editable. The day-of screen filters by version, hiding it there. The existing race R2 tries this only against an order already being published | refuse a client row whose floor heat belongs to a version unless `schedule_version_id` equals it; make publication refuse existing mismatches; add tests; reproduce first |
| 2 | SHOULD-FIX | The publication lock does not serialize other writers: direct entry and dance writes check "draft" with no lock, and definer draft RPCs (`_comp10d_require_draft`, stable, unlocked) are exempt from D, so a change can land in the order being published after its checks | share-lock the version in the child guard and in `require_draft`; add races (R1-R4 cover only direct heat writes) |
| 3 | SHOULD-FIX | The publication function's switch to definer is untested (no anon, other-studio manager or service-role call) and PUBLIC / anon keep EXECUTE. No bypass found by reading | add tests; revoke |
| 4 | SHOULD-FIX | Publication snapshot rows stay directly insertable by managers (a forged later snapshot, or one blocking a draft's publication) | drop the insert policy and privilege |
| 5 | SHOULD-FIX | Several "keep" checks are vacuous (they count a SELECT's one row, so publication, supersede, create-version, cancel-round and lock-state pass with no effect asserted); advancement, event-deletion cascade, heat-plan apply and S6 lifecycle are not shown | assert effects |
| 6 | NOTE | Schedule blocks: the item check looks only at the new version, so contests or empty blocks can likely move from a published version to a draft (inference). A rare three-way deadlock is possible. Forward is not replayable; rollback is complete and replay-safe | |

**Closes (for client writes, versioned published or past heats, subject to blocker 1):** round change, renumber, detach, status removal, insert and delete; unpublish, reopen, re-date, direct publish and delete of versions.
**Does not close:** a spare round published in advance; a new replacement version published through the function before any heat has run; relabelled rounds or divisions; forged publication rows; definer actions such as round cancel and advancement.

**Slot and conflict check (2026-11-26, open pull requests):** no other open PR claims `20270301170000`, and no open migration scanned redefines the pinned publication function (file lists of four very large PRs were truncated; their branches show no `202703` migration). PR 866, 877 and 867 add guards on heats, versions or heat entries; by reading no writer of theirs is refused by D, but **they have not been run together**. PR 877 makes lifecycle writers definer, so this migration's header listing them as invoker would go stale. PR 865 touches none of D's objects. PR 863 and the OD-07 / 12 / 26 statements above were not rechecked.
