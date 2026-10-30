# CF1 package A3 — contract for downstream packages

Migration `20270120093000_competition_cf1_a3_results_integrity.sql` (rollback in `rollback/`, suite `sql-tests/test_T_competition_cf1_a3_results.sql`, vitest `src/lib/competition/results/__tests__/evidence.cf1a3.test.ts`).
Design: `callback-to-final-advancement-design.md` §4.6 (a), §4.7, A.3, A.9.1–A.9.5. A3 creates no new object: it redefines ten existing functions by pinned text-replace.
**Global results-integrity change** (every scored round of every program and discipline). The OD-17 cross-checks stay disabled for live events until release blocker RB1.

## What changes (pins from an applied QA chain through A1, CRs removed)

| Function | md5 before | md5 after | Change |
|---|---|---|---|
| `_compe2_round_heats(uuid)` | `1e75e888142ed1727eb6b2d6c8c0a906` | `7a5a1563a9450e2ec3b807a69737f9f4` | `and not public._cf1_heat_entry_is_excluded(he.id)` after NS1's no-show condition |
| `_compe2_heat_entries(uuid)` | `f275ced91a3b319aaf0835f67bfe174d` | `fdcb8728dde030c8d9772fdaf2963524` | same |
| `_compe2_round_entries(uuid)` | `f0da6935a3dcc04320f7636da6655a3b` | `64859bac497c22fd7472b9e7ae6fc986` | same |
| `_compe2_guard_mark_insert()` | `786bdf3604fa36e5f8328ecc0d5385ad` | `055adcc12d8f903a7570c93008f303a9` | same |
| `competition_round_ballot_status(uuid)` | `a3f5226acc9a40cdedd83d9c0a0fee24` | `7d3bebe922fed33604666009d3a593a5` | same (this and the next carry CX1's `correction_open`) |
| `competition_judge_ballot_sheet(uuid)` | `21cd3df42b8789e3b1baade47a0231d0` | `2506cb2f466d1738fb1a8f298e805b5f` | same |
| `_compf2_evidence(uuid,text,text)` | `2b1c9a22be4a4c4a4e5ba43adee37306` | `415a823b4a689cae26b8a20187af58e7` | `heats[].entryIds` filter + third `excludedEntries` branch `'excluded'` |
| `competition_round_results_review(uuid)` | `c842be1dafce548cd279f1d2d6f6f1d0` | `c9d747907caad0a88b75da1c53862f43` | additive `excluded` section |
| `calculate_competition_round(...)` | `ddaa45cbb518f7592f5ca6dd0ba00176` | `bc3cc4397e740444a4d4a53d93b499cc` | entry lock + `_cf1_require_roster_eligible(round, 'calculate')` |
| `approve_competition_round_result(...)` | `0650367be64e3d1b4387a3dbceba3d4a` | `ac33e456925e64665db1ea0547bae18b` | entry lock + `_cf1_require_roster_eligible(round, 'approve')` |

Not touched: `lock_competition_round_ballots` (A2; still `6e4175342d51ffe274d70ce413bae8c3` when A3 is applied alone), `_compe2_round_blockers`, `_compf2_no_show_entries`, `_compf2_heat_entry_no_show`, `competition_heat_entry_is_no_show`, `competition_round_calculation_input`, `open_competition_round_correction`, `competition_audit_log` (A0).
The migration refuses (and the transaction rolls back) unless the installed text matches the pre pin, each anchor occurs exactly once, and the result matches the post pin; the rollback verifies the reverse and refuses while any exclusion row exists.

Each function keeps `SECURITY DEFINER`, `search_path = public, pg_temp` and its grants (`create or replace`).

## Behaviour

* **Exclusion leaves the ranking inputs, consistently.** An excluded couple (helper `_cf1_heat_entry_is_excluded`, true for every heat entry of the entry in that round) is absent from `_compe2_round_heats` (a heat with only excluded couples drops out), `_compe2_heat_entries`, `_compe2_round_entries`, the judge sheet, the ballot status, the mark-insert guard (a mark for an excluded couple is refused), calculate's expected rows (derived from `_compe2_round_entries`), the evidence `heats[].entryIds` and the stale-ballot rule. Retained: the heat entry with its recorded status (not scratched, not a no-show row), every ballot, mark and ballot event, `entries` (every participant).
* **Evidence.** `excludedEntries` has one row per entry with precedence `scratched`, then `no_show`, then `excluded`. A round with no exclusion produces byte-identical canonical JSON and hash (suite U83 compares with the reconstructed pre-A3 builder; the pre-A3 md5 is reproduced by reversing the two replacements).
* **TypeScript mirror.** `EvidenceExclusionReason = "scratched" | "no_show" | "excluded"` (`evidence.ts`); the same type in `engineAdapter.ts` (`StudioEngineInputShape.context.excludedEntries`). `normalizeEvidence`'s ordering is unchanged. `reviewTypes.ts` exports `ReviewExcludedCouple`, `parseReviewExcluded`, `excludedCoupleLabel` for the results page (B).
* **Calculate / approve.** After the replay branch, the state check and the round `FOR UPDATE`: `perform 1 from event_competition_entries en where en.id in (ranking set) order by en.id for share;` then, as a separate statement (fresh READ COMMITTED snapshot), `perform _cf1_require_roster_eligible(round, stage)`. It raises `COMP_ROSTER_ENTRY_UNAVAILABLE` (entries and reasons in `detail`) or, for a callback Final only, `COMP_ROSTER_BELOW_MINIMUM`; both `P0001`, permanent. Calculate: the pair sits before the engine pin check. Approve: the pair sits **after the certification loop and immediately before the `set status = 'approved'` update of the round** (A.9.2); raising rolls the whole approval back (version, approval row, event, heat certification). A replayed request id returns before either statement, so a later eligibility change never refuses a replay (U69).
* **Lock order (A.3).** calculate: round `FOR UPDATE`, then entries `FOR SHARE` (id order). approve: round `FOR UPDATE`, version `FOR UPDATE`, heat locks inside the certification loop, then entries `FOR SHARE` (id order). No function-level `lock_timeout` was added to either pinned function; a deadlock victim gets the retryable `40P01`, a lock wait is bounded only by the caller's own `lock_timeout`.
* **Review.** `excluded`: one object per couple currently excluded: `entry_id`, `entry_number`, `display_name`, `exclusion_id`, `decision_id`, `seq`, `state: "excluded"`, `reason_kind`, `reason`, `requested_by`/`_role`/`_at`/`_name`, `cosigned_by`/`_role`/`_at`/`_name`. `[]` when none.

## Facts downstream must know

* **A1 test line to update.** `sql-tests/test_T_competition_cf1_a1_helpers.sql` l.272 (“`_compe2_round_entries` is still the NS1 text (A1 redefines nothing)”) pins NS1's `_compe2_round_entries` md5 and fails once A3 is applied. It belongs to A1; A3 leaves it untouched. Run the A1 suite before A3 (it passes unchanged) or relax that one line when composing.
* **Refund inputs are not row-locked.** The entry `FOR SHARE` does not serialize against a registration/order refund (the sync skips locked heats and never writes the entry row), so approve is the last check against a refund that commits between the check and the commit (accepted race of the A1 caveat; RB3/R2 supplies per-entry refund evidence).
* **Replacement is by exact text.** Any later migration that touches one of these ten functions must pin the post-A3 md5 above. The two readers (`ballot_status`, `judge_sheet`) already carry CX1's replacement; both were pinned after NS1 and CX1.
* **Owner of the F2 functions in a QA snapshot.** In the local `ns1-base:snap` image the F2 functions are owned by `supabase_admin`, the E2/NS1 ones by `postgres`; the migration must run as a role that can replace both (superuser locally; hosted projects run it as `postgres`, the owner of all of them).

## Rollback

`rollback/20270120093000_competition_cf1_a3_results_integrity_rollback.sql` is CF1 rollback position 3 (after A6 and A5, before A2). It restores the exact pre-A3 texts (md5 checked per function), refuses if any function no longer holds the post-A3 text, and refuses while any `event_competition_round_exclusions` row exists (roll forward only).
