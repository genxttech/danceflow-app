# Appendix: security analysis (independent, read-only)

# Competition OS constrained Studio/Custom MVP: conditional security assessment (2026-11-26)

PROVISIONAL. Read-only. This analysis executed no SQL, test, build or hosted read. Labels:
**[R]** read from code by this analysis; **[R2]** another session's reading, not rechecked here;
**[X]** executed by another session (its log or document read, not re-run); **[N]** not determined.
No new restriction proposed here exists as code. Nothing was fetched, edited, pushed or applied.

Refs: base `origin/release/website-embeds` 49dbaee1b. 865 d5c3bed52; 899 60b4edd7e code, doc head 02cf1c73d (read from the local worktree commit; the fetched remote ref is 5a84cff9f); 877 8c738c4d8; 867 6dc6b2d4e; 866 3b65f63d1; 864 9d7477c09; 863 93583d01c; 844 b56ea086f; 878 22c27b505.
`M/` = `src/lib/supabase/migrations/`. Short names: E2 `20270102090000`, O1 `20270106090000`, F2 `20270114090000`, A1 `20270120085000`, F3 `20270122090000`, 10D `20261111090000`, SS1 `20270116090000`, REG `20270113090000`.
The earlier file `q9-bypass-verification.md` was not present.

## 0. Answer

* **B2 is not technically necessary for a first pilot** [R, PROVISIONAL]. Final-only, one round per division, structure frozen at first round start, no corrections, no paper ballots, enforced in the database, removes the four demonstrated routes (NC, CS, CA, R) and the corrected-result self-approval.
* **It does not remove every path.** A manager can still prepare, before any judging, a second contest with the same people (second division or program, any dance label), have the judges score both, and choose which to approve and publish. B2 as designed also leaves this open (design section 9: Q3 and the baseline spare). Under section 18.4 it needs an **explicit owner adjudication**; this analysis cannot call it closed.
* **The restriction set alone is not releasable.** Section 4 lists blockers that stay reachable, several unrelated to B2. Two look new: published results can be relabelled by direct writes, and the two-couple minimum does not cover a direct Final.
* **Option D (899) is INCOMPLETE** until its blocker is reproduced, fixed and re-reviewed.

## 1. Minimum restriction set and database-boundary feasibility

Base fact [R]: rounds, heats, heat entries, heat dances, entries, participants, divisions are writable by any event manager through the table API (policy `competition_manage` FOR ALL, `M/20260620_competition_foundation_v1.sql:355-368`; same on dances, division dances, schedule tables). "Manager" includes studio owner/admin, organizer owner/admin/staff, event creator, platform admin. So every restriction below needs a trigger; UI or app removal is not enough. New triggers should be ENABLE ALWAYS and apply to **all** writers (including definer functions and service_role) unless noted.

| # | Restriction | Current enforcement (base) | Existing PR | Smallest NEW work; size / risk | Safe to disable at DB? |
|---|---|---|---|---|---|
| M1 | Final only; ordinal only; no callback, no advancement | None. Advancement RPC `M/20270120090000:1236` | none | Refuse round start unless `round_type='final'` and scoring is Studio ordinal; refuse advancement insert; revoke advancement RPC; hide in app. S / low, but breaks callback suites and the CF1 app surface | **Yes** |
| M2 | One round per division, ever | None for insert after lock: key-less round insert accepted and pinned (`REG:228-241, 496`). Round delete refused only while locked (`SS1:87-112`); division/program of a locked round immutable (`SS1:50-116`) | none | (a) round may leave draft only if its program is profile-locked and the division has exactly one round row (cancelled counted); (b) refuse round insert and division insert/delete in a locked program. No tombstone table needed: ballots require start, and ballot history blocks later cascade deletion. S-M / medium (event advisory lock needed against races) | **Yes** |
| M3 | Contest set frozen at first judging | None. `start_competition_round` requires no program lock (`O1:361-419`). `add_competition_division` allows `configured` programs (`M/20270110090000:43+`). Calculation does need a locked, pinned program (`F2` ~928) | none | Refuse a new program lock once any round of the event has left draft or any ballot exists (with M2 this stops any new executable contest). S / low | **Yes** |
| M4 | One dance and one ordinal heat per round | Engines fail closed at calculation only (multi-dance, multi-heat) [R/R2] | none | Check at round start (otherwise a dead end once M6 applies). S / low. Operational, not a bypass closure. **Limits a contest to one heat of couples** | Yes |
| M5 | No running-order replacement once any ballot exists | Refused only once a heat is staging/active/complete (`O1:268-297`) | none (899 does not do this) | Refuse version to published/live when any ballot exists in the event; take the event lock. S / medium (ballot-versus-publish race) | **Yes** |
| M6 | Published order not writable | Partial: 10D guards entries, dances, heat delete, floor heats (`10D:337-391`); not heat round/version/status or version status | **899 (incomplete)** | Fix blocker (client heat row whose floor heat belongs to a version must carry that `schedule_version_id`; publication refuses mismatches); lock version in child guard and `_comp10d_require_draft`; drop manager insert on publication snapshots. S-M / medium | Yes, after fix [PROVISIONAL] |
| M7 | No round cancellation once the round has a ballot or result | Refused only if published or a heat is on the floor (`O1:421-479`) | none | Trigger on status to `cancelled`. S / low. With M2 this is anti-suppression and ballot-block support, not replacement closure | **Yes** |
| M8 | No corrections | Manager RPC open (`F2:1177`) | 865 only restricts approval | Refuse round edges calculated/approved/published to `ballots_locked`; revoke the RPC. Keep pre-calculation reopen (R-12.4) and withdraw. S / low. Consequence: a wrong calculated or published result can only be left or withdrawn | **Yes** |
| M9 | No paper ballots; judge's own digital ballot only | Manager or scorer may type any judge's ballot (`E2:1009-1041`) | none | Ballot insert trigger: `source='judge_web'` and `submitted_by` = the official's user; revoke paper RPC; hide forms. S / low. Every judge needs an account and working device | **Yes** |
| M10 | Ordinary scratch/withdraw and placement removal refused once ballots affected | None (877 does not read ballots) [R, R2] | 877 (participation only), 856 design | New predicate + backstop guard + RPC, refund and sync handling (section 6). M / **high** (locking) | Yes, with section 6 conditions |
| M11 | Published identity frozen | **None found**: payload reads round, division, program names and entry number and display name live (`F3:292-325`) | none | Once a round has a ballot: refuse change of entry display name, number, division; participant rows; division, program, round, dance names. S-M / medium (legitimate typo edits) | Yes |
| M12 | Two eligible couples for every Final (OD-21, R-11.5) | Callback Final only (`A1:241, 339`); no SQL or ordinal-engine check found for a direct Final | none | Extend roster check to all Finals. S / low | Yes |
| M13 | Declared body sanction blocked at DB (OD-01) | None at DB | 832 is app only | Trigger on round start, approval, publication when sanction is ucwdc/ndca/wsdc. S / low | Yes |

Not safely removable by disabling alone: ballot reading by managers (calculation reads ballots), No-show and two-person exclusion (needed for couples who do not dance), refund and registration sync (money must still settle), result withdrawal.

## 2. Bypass and integrity-gap table

"New" means closed only by unbuilt work above. All "closed" entries are PROVISIONAL.

| Gap | Base: who | With set | Evidence |
|---|---|---|---|
| NC spare round, corrected round left | manager | closed: M2, M8 (new). 865 alone does not close | reach [X: 865 probe, spare heat installed by fixture]; closure [R] |
| CS cancel then spare | manager | closed: M2, M7, M8 (new) | same |
| CA cancel approved corrected round, spare | manager | closed: M2, M7, M8 (new) | same |
| R move spare heat to new round | manager | direct move closed by 899 [X local]; new round closed by M2 | planted-heat variant: see next |
| 899 blocker: heat with floor heat in draft and no version goes live; its entries/dances writable | manager | **open** | [R2, confirmed by R: D guard skips null version; 10D child guard treats null as editable]; not reproduced. By reading it is not a ballot heat and an unplaced heat blocks scheduling of its round, so scoring effect appears limited [R, PROVISIONAL] |
| Self-approval of corrected result (RB-11.2) | calculator-manager | closed by 865 [X local, concurrency unverified]; M8 too | |
| One-character override reason (RB-11.1) | calculator-manager | closed by 865 | [X local] |
| Correct before approval, new ballots, self-approve | manager | closed by M8 | [R] |
| Other-dance spare created after judging starts | manager | closed by M2, M3 | [R] |
| **Spare in another division/program prepared before judging (any dance)** | manager | **open**; needs judges' own ballots (M9); one person still chooses and approves | [R] |
| Spare published first, other left unpublished; or publish then withdraw and publish spare | manager | **open** (same residual); withdraw itself is allowed | [R] |
| Another event | manager | open; separate event, cannot alter the first one's records | [R] |
| Controlled judge accounts (manager creates team members he controls), or manager sits on panel | studio owner | **open** (not addressed by B2 either) | [R] |
| Rounds: direct insert / delete / relabel / status | manager | insert, delete: M2; type/order/division when locked: base SS1; status: base O1; **name: M11** | [R] |
| Heats, floor heats, versions: direct writes | manager, service_role | published: 899 + 10D (blocker above); drafts free (hold no ballots) | [R] |
| New order after ballots, before first staging (old heat ballots drop out) | manager | M5 (new); **899 does not close** | [R] |
| Heat entries: status danced/disqualified/scratch | manager, service_role | 867 (applied on DEV/PROD per 2026-11-24 reads [X]; absent from shipping Git line) | [R] |
| Heat entries: move/delete | manager | published: 10D; started: 877 | [R] |
| Entry status direct write, delete/recreate | manager, service_role | 877 | [R]; suites [X partial] |
| Eligibility direct write | manager, service_role | 866 write guard | [R] |
| Entry/participant/name relabel after publication | manager | **open until M11** | [R] |
| Results, approvals, publications direct writes | none (revoked incl. service_role) | closed in base | [R] F2/F3 grants |
| Schedule publication snapshot direct insert | manager | open unless added to 899 | [R2; policy confirmed `M/20260620_competition_generation_operations_v1.sql:688`] |
| service_role | key holder | result and ballot tables revoked; approve needs `auth.uid()`; non-status writes to rounds/heats remain except where new guards refuse. A key holder is effectively trusted | [R] |
| Scratch with ballots: lifecycle RPC, repeat call | manager | **open until M10** | [R, R2] |
| Same: refund apply, registration sync (client edit of linked registration) | refund role; manager | **open until M10** | [R] `_r2_apply_participation` withdraws "open/unplaced" without reading ballots |
| No-show removes a ranked couple while heat active/complete | manager or chair | open by design; judges must resubmit their own ballots | [R/R2] owner confirmation advised |
| Exclusion | two people | allowed by design | [R2] |
| Judge deactivated or marked absent after ballots | manager | absence refused if ballots exist (base); inactive-with-ballots stays counted (JC1 in 867) | [R] |
| Single-couple direct Final | manager | **open until M12** | [R], not executed |
| Event deletion erases ballots | whoever may delete events | 844 | [R2]; suites [X] |
| Division/program cascade delete | manager | balloted rows protected by history triggers (base); unballoted deletable (suppression only) | [R]; full cascade behaviour [N] |
| Ballots readable before publication, no read audit | manager, assigned scorer | **open** (`E2:934-940`) | [R] |
| Under-18: team, alternate, staff-created, substitution, service_role | manager, service_role | 863 on every participant write; 866 fails closed for zero participants or unknown age | [R]; composed [X partial]. Residual: self-attested birth date; existing rows not rechecked at write (866 checks at execution); unlisted team members invisible |
| Sanctioned event scored by Studio method via direct RPC | manager | **open until M13** (832 app only) | [R] |
| Panel shows ready but cannot lock | manager | 864 | [X local, per verification doc] |

## 3. Can B2 be deferred?

Yes for the demonstrated routes, if M1-M3, M5-M9 and 865 plus a fixed 899 are applied and pass integrated tests. No claim beyond that. Residual (all manager-reachable, none newly created by deferring B2): baseline second contest with selective publication; another event; controlled judge accounts or manager as judge with single-person approval. B2 adds nothing for the pilot while multiple rounds are impossible; it is needed when replacement rounds, flights, re-dances or corrections come back.
Optional tighter choice (owner change to R-11.2): require a second person for every approval. It removes single-person approval but not selective publication or account control. Not recommended as a substitute for adjudication. Overlap heuristics are excluded by section 11.5.

## 4. Confirmed blockers still reachable under the restriction set as it stands in existing PRs

None of these was executed by this analysis.

1. M10 ballot block: no implementation. [R]
2. Option D blocker 1, plus unserialized publication (finding 2) and forgeable snapshots (finding 4). [R2; blocker 1 rechecked R; unreproduced]
3. Relabelling of published results (M11). [R]
4. Direct Final with one couple (M12). [R]
5. New running order after ballots (M5). [R]
6. OD-01 not enforced at database (M13). [R]
7. OD-10 ballot visibility and read audit. [R]
8. OD-05 baseline direct-conflict check: none found in officials/ballot SQL. [R, grep level]
9. 866 app work missing: `registrations/actions.ts` writes eligibility directly (refused after `131000`), and PR 846 (stacked on 837) writes `metadata.eligibility_determination` directly, which the guard also refuses. [R + 866 document]
10. M1-M3, M7-M9 do not exist yet, so NC/CS/CA stay reachable with every existing PR applied. [X reach, R]

## 5. Existing PRs: essential, dependency, deferrable

| Class | PRs |
|---|---|
| Essential | 867 (guards in shipping line), 865, 864, 866 (+ its app work), 863, 877, 899 (after fix), 844, 835/837/846 (age and eligibility app, reconciled with 866), 832 |
| Release dependency (policy/wording/verification) | 878 (app scratch, needs M10 messages), 848, 853, 855, 860 (labels and disclosures), 859, 861 (verification); R-13 and R-16 verification results [N]; recorded dance shown on results (Q9.1; 901 specification only) |
| Deferred | 901 B2, 908 Option C, advancement/callback work, OD-07, OD-26, body-profile designs |

Order (coordinator plan, section 10): 867, 865, 864, 866 core, 863, 866 gates and guard, 877, 878; then 899 and new MVP migrations last. 844 (`20270219090000`) is independent. DEV needs PV-1/OJ-1 before 865. [R2]

### Interacting guards: combined testing IS required

| Table | Triggers meeting there |
|---|---|
| `event_competition_heats` | base `protect_locked_competition_heat`, `validate_competition_heat_schedule_placement`, `compo1_guard_heat_status`, `comp10d_*`, `hl1_*`, `cf1_guard_final_heat_*`; 866 `r15_guard_heat_status`; 877 `cf1_s6_guard_started_heat_delete`; 899 `zz_compd_guard_published_heat` |
| `event_competition_heat_entries` | base `comp10d_guard_heat_entry`, CF1/OD-17 guards; 867 `cf1_u18_guard_heat_entry_status`, `cf1_u18s_guard_heat_entry_scratch`; 877 `cf1_s6_guard_participation`; 866 `r15_guard_heat_entry_clearance` (899 none) |
| `event_competition_schedule_versions` | base `compo1_guard_publish_during_run`, `cf1_guard_publish_final_heats`; 866 `r15_guard_version_publish`; 899 `zz_compd_guard_published_version` |
| `event_competition_entries` | 877 three `cf1_s6_guard_entry_*`; 866 `r15_guard_entry_eligibility_write` |
| `event_competition_rounds` | base O1/E2/F2/SS1/CF1 status guards; 866 `r15_guard_round_start`; 864 config guard; new M1-M3, M7, M8 |

Redefined functions: `publish_competition_schedule_version` (899, becomes definer), `change_competition_entry_lifecycle` (877, becomes definer; 899 header still calls it invoker), `_cf1_entry_unavailable_reason` (866, used by lock/calculate/approve/publish), `approve_competition_round_result` (865), panel status/attendance (864), `_comp10c_resolve_competitor` (863). 867/877 revoke TRIGGER privileges that 877 preflights read.

Composition status [X, from 866 package]: run5 composed 865, 864, 866, 863, 877, 867 at **older heads** (877 7341af1d, 866 cabc41b7); 8/8 apply/rollback/re-apply; several suites passed, U18/U18-S/JC1 only as adapted copies, others failed and were changed afterwards **without re-execution**. **899 has never been run with 866 or 877** (and 867 only as base for its own run, JC1/U18/U18-S). 899 by reading refuses no writer of theirs [R2]. A callback-Final suite fails on the base chain with U18-S [X].

## 6. Test of the PR 877 session's proposed ballot block

Proposal: refuse whole-entry scratch/withdrawal when any ballot exists in a round where the entry has an unscratched placement; one placement: any ballot in that round; heats-then-rounds `FOR NO KEY UPDATE NOWAIT` locking. All below [R], unexecuted.

* **Predicate: sound only with extra preconditions.** It reads current placements, so heat round reassignment, version unpublish and heat status writes must be blocked (that is 899, which the proposal's precondition list omits, and it is incomplete), plus M5, M7, M8 and no advancement. The "marks clause not needed" claim holds only under all of these; keeping it (one more EXISTS, scoped as in 856 design) is cheap defence and recommended.
* **Race design is consistent with the code.** Ballot insert takes the round `FOR SHARE` (E2), which conflicts with `NO KEY UPDATE`; a waiting ballot re-reads the roster afterwards. Needs race tests.
* **"Participation stays and is flagged, no error" is incomplete.** `_cf1_entry_unavailable_reason` (RB3, `M/20270120102000:148-171`) already makes a cancelled or refunded registration or order unavailable, so the round cannot lock, calculate, approve or publish; the only exit seen is two-person exclusion of a danced couple. Safe (fail closed) but a dead end for one person. For partial refunds, the allocation must remain `exception_open` (or outcome null): any other outcome appears to stop blocking, letting a refunded couple rank. So an exception record is needed (also R-12.3 audit); the "no exception hook" claim is not supported.
* **NOWAIT versus "no error":** a busy lock inside registration sync or webhook refund apply raises unless handled; that can fail a payment settlement. Define retry and test it.
* **Backstop required** for definer writers (refund, sync), as a trigger, not only an RPC check.
* **Event deletion is not an acceptable limit:** OD-04 decided block; use 844.
* **No-show** also removes a couple after ballots and is not covered; confirm as a controlled path.
* **Recovery:** section 15.6 asks for a designed exception workflow; omitting it needs an owner deferral.

## 7. Smallest remaining corrections and integration tests

Corrections, in order: (1) one "pilot restriction" migration: M1, M2, M3, M4, M7, M8, M9, M13 (S each, one reviewable file or two, with rollback); (2) fix 899 and add M5; (3) M10 ballot block (M, highest risk); (4) M11, M12; (5) 866 app wiring and 837/846 reconciliation; (6) app hiding and error messages.

Tests (one composed chain at final heads, role `authenticated` and `service_role`, state read-back):
1. Apply, rollback, re-apply of the whole set in release order; all existing suites, with callback suites run on the pre-restriction chain and the difference documented.
2. Negative replay of NC, CS, CA, R without superuser fixtures, plus: insert round/division after lock; lock a new program after first start; delete and recreate; second round in unlocked program.
3. Planted-heat reproduction before and after the fix; publication races with entry/dance/draft-RPC writers; ballot versus publication race.
4. Ballot block: every writer in section 2; scratch versus ballot submit both orders; refund and sync during a busy round; deadlock with heat reopen.
5. Full happy path for one single-manager and one multi-user studio: registration, eligibility, plan, publish, start, No-show, judge ballots, lock, calculate, approve, publish, withdraw.
6. Age and eligibility paths including zero-participant and team entries; one-couple Final; relabel attempts; sanction declared; paper RPC; concurrent approval (865 concurrency still unverified).
7. PostgREST-level and app tests, tsc, build, and tenant-isolation negatives (other studio manager, instructor, judge, anon).

## 8. Owner decisions (OD-01..OD-32, R-01..R-16)

| Treatment | Items |
|---|---|
| Must still be met by build | OD-01 (M13+832); OD-02, OD-03, OD-18, R-15 (863, 866, 835, 837, 846, app); OD-04 (844); OD-19, OD-20, OD-28, R-02, R-03, R-04, R-09 wording (848, 853, 855, 860); OD-13, OD-23, OD-24, R-01, R-07, R-14 disclosures and fail-closed checks (R-01.3 direct-creation profile risk [N]); OD-21 (M12); OD-31 (867, integrated sign-off); R-10 (864); R-11 (865); R-13, R-16 verification; section 15 ballot block (M10); Q9.1 dance shown on results |
| Satisfied by disabling | OD-11 and OD-12 (M9 + judge-own resubmission); OD-14 (no callback); OD-26 (no mid-event change); OD-07 (not built, no corrections); section 16 Q8, section 17 Q1, section 19 Q14 (no replacement, multi-round or revalidation case can arise) |
| Preserved as today | OD-17, OD-25, R-05 setup, R-06, R-08, R-12 exclusion/publication holds |
| Deferrable (body profiles) | OD-08, OD-09, OD-16 body minima, OD-27, OD-29, OD-30, body parts of OD-06/15/22/23 |
| **Unbuilt but worded as applying now: owner must defer or require** | OD-05(5) Studio direct-conflict protection; OD-10 least-privilege ballot access and audit "for ALL events"; OD-15 organizer attestation "now". Coordinator section 8.2 lists OD-05/10/11/12 under future-profile prerequisites, which conflicts with those decision texts |

**Needs an owner change or new recorded decision:**
1. R-11/B2 blocker status (sections 11-13, 18.4): declare it closed for the pilot by restriction, and adjudicate the baseline second-contest residual.
2. Section 13 and 20: B2 deferred.
3. Temporary pilot removal of preserved capabilities: callbacks (R-09.1), correction and recovery (R-12.2, OD-07, OD-22 hide-during-correction), multi-dance and multi-heat results (R-05, R-07.x), flights and standby rounds (section 17.1).
4. Paper-ballot entry off (a product restriction OD-12 permits but does not mandate).
5. Section 15.6 recovery workflow deferred; R-12.3 automatic refund withdrawal changes once ballots exist.
6. No-show after ballots accepted as controlled path (section 15.4).
7. Any deferral of OD-05, OD-10, OD-15 items.

Advanced B2 questions (Q2, Q7, Q10-Q13, Q15-Q22) are not needed for this pilot; Q3 is the one that survives, as item 1.

## 9. Not determined

* Any runtime behaviour of the proposed restrictions; none exists.
* Hosted DEV/PROD grants, policies, applied migrations, data (including existing rounds, minors, snapshots).
* Whether any trigger not located by search already guards names, entry number or participants after publication, or enforces two couples for a direct Final.
* App-layer enforcement of items in section 4 (only limited search); public readers other than the F3 payload; exports.
* Cascade behaviour on program/division delete; TRUNCATE reach; schedule blocks (899 finding 6).
* Ordinal single-heat capacity ceiling and whether it suits the pilot's field sizes.
* Verified-email requirement for approval (865 reports it missing; no decision found requiring it).
* Tenant isolation was not independently tested.
* R-06, R-13, R-14, R-16 implementation state; 835/837/846/848/853/855/860 CI and review state.
* Delivery estimates (not produced here).
