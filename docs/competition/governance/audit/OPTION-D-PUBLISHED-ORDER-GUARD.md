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

## Fix of blocker 1 (2026-11-26): written, execution PENDING

Within D's own files: a client heat that references a numbered floor heat or a schedule block must carry a schedule version; publication refuses an order holding a heat that is not its own (`COMPD_ORDER_HEAT_VERSION_MISMATCH`); the migration refuses to apply while such a heat sits in a published or past order. Publication post md5 is now `0fbbbef9670082fbb3cb2484d966dfa3` (pre unchanged), computed offline; the sections above that quote `abccc653…` describe the earlier revision. Findings 2 to 6 of the re-review below stay open.

`sql-tests/probe_D_planted_heat.sql` reproduces the finding with read-back; the runner executes it before the fix (`02cf1c73d`) and after.

**Independent review of the fix (`d2ee7e3f4`, by reading only): no blocker.** It recomputed the post md5. Applied: the runner now also requires the plant step itself to be refused after the fix. Not applied, recorded:
* a legacy planted row in a **draft** can be left unrepairable by clients (clearing the floor plan removes floor heats but not an unversioned heat, which then dangles); under a `review` version it blocks publication until the version returns to draft. Such rows are not in the apply check;
* the apply check takes no table lock, so a write between the check and trigger creation could plant a row;
* only the floor-heat branch of the publication and apply checks is tested (the schedule-block case is tested in the guard only).

## Independent re-review of the revision (`5a84cff9f`, by reading only): NOT READY

**The statements above about what D refuses are subject to blocker 1.** Nothing below is fixed. Blocker 1 was checked against the code by the author; it and findings 2 to 6 are **not reproduced by execution**.

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
