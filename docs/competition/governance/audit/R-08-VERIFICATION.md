# R-08 verification: Scratch and No-show in scoring (Studio/Custom)

**Policy ratified (owner, 2026-11-23, DanceFlow Studio/Custom policy, not a body rule):** scratched and no-show entries are excluded from the
applicable scoring calculations and do **not** automatically receive last place; Scratch, No-show, Excluded and Disqualified stay distinct
statuses with their existing authorized workflows; a ballot containing marks for an entry later scratched or marked no-show is invalid/stale and
must be corrected through the authorized workflow before ballot lock; original ballots, status history and correction evidence are immutable
(OD-04 PR 844, OD-07 PR 838, OD-11 PR 843).

**Kept separate:** *Policy ratified* (above) vs *implementation verified* (this report). Base `origin/release/website-embeds` @ `49dbaee1b`.
Nothing here changes scoring, SQL or migrations. Evidence labels as in [R-07-VERIFICATION.md](R-07-VERIFICATION.md): INSPECTED = read, not run;
EXECUTED-TS = vitest run here; NOT RUN = not executed. **All SQL below is INSPECTED only; no SQL suite was run** (heavy-lock queue).

## 1. Exact scope of Scratch and No-show (INSPECTED)

Data model: a round has heats; a heat can carry one or more dances (`event_competition_heat_dances`); an entry has one heat entry per heat. The
evidence field `danceIds` is the distinct set of dances over the round's ballot heats (F2 `_compf2_evidence`).

| Status | Scope | Where |
|---|---|---|
| Scratch | **per heat entry, written for every heat of the entry.** `change_competition_entry_lifecycle` sets the parent entry to scratched/withdrawn, then scratches all of its heat entries that are `scheduled`/`checked_in` across every heat, dance and round; refused if any heat of the entry is `locked`/`certified`. The R2 cascade and A6 withdrawal (Final heat entry) are the other writers. No per-dance or per-round scratch RPC exists. | `20260620_competition_generation_operations_v1.sql` (`change_competition_entry_lifecycle`), `20270103090000` (`_r2_withdraw_entry`), `20270120095000` (A6) |
| No-show | **per heat entry**, append-only row keyed by `heat_entry_id`; window = round `active` AND heat `active`/`complete`; manager or chair with verified email; refused for scratched/danced/disqualified or already no-show; voiding writes a separate void row and allows a re-mark | `20270115090000_competition_ns1_heat_no_shows.sql` (`mark_competition_heat_no_show`, `void_competition_heat_no_show`) |
| Entry excluded from calculation | only when scratched or no-show in **every** heat entry it has in the round's heats (scratched wins over no-show) | `competition_heat_no_show_entries` (NS1), `_compf2_evidence` `excludedEntries` (F2), engine `splitEntries` (`engines/common.ts`) |

**Multi-Dance, one missed dance:** a scratch or no-show in one heat only leaves the entry calculated; it drops out of that heat's required ranking set
(`_compe2_heat_entries` as rewritten by NS1: `status <> 'scratched' and not is_no_show`) and out of that heat's ballots. **But the engines refuse any round
whose `danceIds.length != 1` (X-6, `COMP_ENGINE_UNSPECIFIED_CASE` / `multi_dance_unsupported`), so a round covering several dances produces no
result at all.** Valid results from the unaffected dances are therefore **not produced and not preserved by the engine**; whether Studio models
"multi-dance" as several rounds (one dance each) or one multi-dance round is an **open semantics question** — see release finding RF-8.1.

## 2. Stale ballots (INSPECTED + existing SQL tests)

- Detection: `_compe2_round_blockers` (E2) marks a current ballot stale when its mark count differs from `_compe2_heat_entries(heat)` or a mark's entry is
  outside that set; callback ballots must carry exactly T marks within `_compe2_round_entries`. NS1 rewrites the helpers so no-show entries leave the set.
- Lock: `lock_competition_round_ballots` raises `COMP_BALLOTS_STALE` while any stale ballot exists. A corrected ballot is a new version that
  supersedes the old; ballot rows are immutable (`_compe2_guard_mark_insert`, `COMP_BALLOT_IMMUTABLE`), and a mark for a scratched/no-show entry is refused
  (`COMP_BALLOT_UNKNOWN_ENTRY`).
- A heat whose entries are all scratched/no-show drops out of `_compe2_round_heats`; its ballots are void, not stale.
- Timing: a no-show can be marked only while the round is `active`; after `ballots_locked` the round must be reopened first. A scratch after round `ballots_locked` is limited only by the lifecycle RPC's heat `lock_state` (`locked`/`certified`) refusal; between round lock and heat lock a scratch appears allowed and then makes ballots stale, which `_compe2_round_blockers` catches at calculate.

## 3. Engine behavior (EXECUTED-TS, existing tests)

`studioOrdinalMajority.f1.test.ts`: "i: entry 14 scratched but ballots still rank it → mark_out_of_range (never renumbered)"; "i: entry 14 scratched with
corrected 1…3 ballots → ranked without 14, no row for 14" (the excluded entry gets no row and is **not** placed last); "i: a ballot that ranks the
excluded entry ... is still refused". These ran in the combined engines run recorded in the R-07 report, section 3. I wrote no duplicate test.

## 4. Unauthorized status changes

The U18 / U18-S guards are **not on this release line** (`release/website-embeds`); they are on `origin/release/competition-cf1-app-candidate`
(`20270215093000_competition_u18_heat_entry_status_guard.sql`, `20270215094000_competition_u18s_heat_entry_scratch_audit.sql`, and their tests
`test_T_competition_u18_heat_entry_status_guard.sql`, `test_T_competition_u18s_heat_entry_scratch_audit.sql`). Per the OD-31 guarded-baseline evidence
(PR 856, branch `claude/od31-guarded-baseline-7346b9`; not duplicated or edited here): trigger `cf1_u18_guard_heat_entry_status` refuses writes of
`danced`/`disqualified`/`scratched` by anon/authenticated/service_role (`COMP_U18_HEAT_ENTRY_STATUS_WRITER`); `cf1_u18s_guard_heat_entry_scratch` refuses unaudited
scratch (`COMP_U18S_SCRATCH_UNAUDITED`) and un-scratch (`COMP_U18S_UNSCRATCH_WRITER`). Its negative suite `test_T_od31_guarded_baseline_negative.sql` is
marked PENDING (not run) in PR 856. **On this line only the older 10D / A6 / OD-17 guards apply**; the client-role negative test for scratched/danced/disqualified
therefore belongs to PR 856's evidence and is **PENDING** here.

## 5. Tests: existing / added / executed / pending

| Case | Existing test | Executed here? |
|---|---|---|
| Scratched entry still on a ballot -> stale -> lock refused | `sql-tests/test_T_competition_e2_ballots.sql` L705-709 (`COMP_BALLOTS_STALE`); `test_T_competition_e2_p1fix.sql` A, C | NOT RUN (SQL) |
| Stale ballot after No-show; correction clears it; void makes it stale again | `test_T_competition_ns1_no_show.sql` section 7 (L406-458); TS `noShow.ns1.test.ts` | TS: EXECUTED; SQL: NOT RUN |
| No-show authority, window, reason refusals | `test_T_competition_ns1_no_show.sql` L274-300 | NOT RUN |
| Engine: excluded entry not placed last; stale marks fail closed | `studioOrdinalMajority.f1.test.ts` (3 cases above) | EXECUTED-TS |
| Multi-Dance round refused (X-6) | engine tests; R-07 file (zero, 2, 3, 10 dances) | EXECUTED-TS |
| **One missed dance, other dances completed** | **none exists** (only the whole-round X-6 refusal) | cannot be written until the semantics are decided (RF-8.1) |
| Client-role writes of danced/disqualified/scratched | PR 856 / candidate-branch suites | NOT RUN (PENDING) |

Added in this section: **none** (the TS behavior is already covered; the missing cases are SQL or depend on undecided semantics).

## 6. Studio/Custom RELEASE FINDINGS (none changes behavior here)

| ID | Finding | File / function |
|---|---|---|
| RF-8.1 | **Multi-Dance semantics unresolved.** Scratch/No-show are per heat entry; exclusion is whole-round only (excluded in *every* heat of the round); X-6 refuses any round with != 1 dance. An entry that misses one dance and completes the others cannot yield results for the completed dances in a multi-dance round. Whether this matters depends on whether Studio multi-dance programs are modelled as one round per dance. | `engines/common.ts` (X-6), `_compf2_evidence`, `competition_heat_no_show_entries` |
| RF-8.2 | **Scratch history is not append-only.** The lifecycle RPC updates heat-entry status in place; audit comes from the parent entry's change trigger and, on the candidate line, U18-S. Weaker than "status history immutable" until U18-S is on the release line. | `change_competition_entry_lifecycle` |
| RF-8.3 | **Parent entry `disqualified`** can be written directly by a manager (OD-31 finding F1, P2). | `event_competition_entries` writer |
| RF-8.4 | **No-show window is asymmetric** with scratch: a post-lock no-show requires reopening the round. Operational, not a bypass. | `mark_competition_heat_no_show` |
| RF-8.5 | **U18/U18-S not on this release line.** Client-role status guards cited by the owner exist only on the candidate branch. | see section 4 |

## 7. Future body profiles (NOT IMPLEMENTED; policy is **not** body compliance)

The rulebooks do **not** universally require scratched or no-show entries to be excluded without placement: that is DanceFlow Studio policy
([R08-DF-0001](../rule-register/rules/R08-DF-0001.json), [R08-SILENT-0001](../rule-register/rules/R08-SILENT-0001.json)). Studio No-show is **not** a
substitute for UCWDC compliance. Register entries: `R08-UCWDC-0001` (Couples II.P.3.a: a competitor who fails to report on time or answer the Floor
Coordinator's calls for a heat is disqualified from that dance category; PDF p.16, the coordinator cites printed p.39, which I could not confirm because the
extracted text carries no printed page numbers), `R08-UCWDC-0002` (Teams II.O.2.a: scratched (disqualified) from that dance category; PDF p.11), `R08-NDCA-0001`
(III.D.30 withdrawal: last place per dance not performed after a qualifying injury/illness withdrawal after a Final begins; **not applied universally**; see OD08-NDCA-0001
in PR 840, cross-referenced, not duplicated). NDCA V.B.2 (competitor attends at least one-half hour in advance; organizers need not delay for latecomers; PDF p.38)
is context only. All are NOT IMPLEMENTED blockers for the respective future profiles.

## 8. PENDING

SQL suites above (ns1, e2 ballots, e2_p1fix, f2 results); PR 856's OD-31 negative suite; any test of the one-missed-dance case (blocked on RF-8.1).
