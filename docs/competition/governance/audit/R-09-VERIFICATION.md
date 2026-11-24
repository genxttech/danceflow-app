# R-09 verification: Studio callback structure and SQL recomputation safeguards

**Policy ratified (owner, 2026-11-23, DanceFlow policy):** the Studio callback structure and the SQL recomputation safeguards (PV-1) are retained.
The display label change for the not-called-back label is a separate workstream (`od19-relabel-custom`); this report does not touch it.
**Policy ratified vs implementation verified are kept separate.** Base `origin/release/website-embeds` @ `49dbaee1b`. Evidence labels as in
[R-07-VERIFICATION.md](R-07-VERIFICATION.md). **All SQL claims are INSPECTED; no SQL suite was run** (heavy-lock queue). The only executed evidence is the
static test `src/lib/competition/results/__tests__/r09.label.static.test.ts` (reads migration text; 3 tests pass).

## 1. calculate_competition_round and PV-1 (INSPECTED)

Definition chain: F2 (`20270114090000`) -> A3 patch (`20270120093000`, adds `_cf1_require_roster_eligible`) -> PV-1 patch (`20270215090000`, adds the
verifier). PV-1 is the current definition (md5-pinned exact-text replacements). Order inside the function: caller must be the event manager or a scorer assigned
to the round (`COMP_FORBIDDEN`) -> request replay -> round must be `ballots_locked` (`COMP_RESULT_INVALID_TRANSITION`) -> pinned engine key/version must match
(`COMP_ENGINE_NOT_AVAILABLE`) -> `_compe2_round_blockers` ready (`COMP_BALLOTS_INCOMPLETE`) -> input hash equals the current evidence (`COMP_RESULT_STALE`) ->
trace hash and row shape -> **`_comppv1_verify`** -> insert. Unlocked ballots never reach PV-1.

| Question | Behavior |
|---|---|
| What is compared | the database runs its own port of the engine over the evidence and compares, with `is distinct from`, the caller's rows rebuilt as `entry_id`, `placement`, `tie_group`, `advanced`, `rating_band` and the **whole `output` object**, plus the warnings. An extra key in `output` is a MISMATCH |
| `COMP_RESULT_RECOMPUTE_UNSUPPORTED` | engine is not `studio_callback_tally@1`/`studio_ordinal_majority@1`, or the SQL port itself refuses the round (input caps, profile outside the allow-list, `x3_option_unsupported`, even panel, `target_unset`, `target_invalid`, `callback_count`, `judge_without_ballot`, `mark_not_in_scheme`, callback `multi_dance_unsupported`, ordinal `multi_heat_combination_unspecified`) |
| `COMP_RESULT_RECOMPUTE_MISMATCH` | the port succeeds and rows or warnings differ |
| Tie at the cut over capacity | the port returns every row with `advanced = null`, `placement = null`, a tie status and the warning `advancement_unresolved_tie_over_capacity`; the unresolved result is storable (it equals the recompute); a forged resolution is a MISMATCH; approval is then blocked by trigger `cf1_guard_advancement_approval` with `COMP_ADVANCEMENT_BLOCKED` (even for a superuser), and the advancement preview/apply RPCs refuse it. `blocked_tie_over_capacity` is only a trace outcome in `studioCallbackTally.ts`, not a SQL error code (OD-14 hard block preserved) |
| Who may call | `calculate_competition_round`: SECURITY DEFINER, `authenticated` only, manager or assigned scorer inside. `_comppv1_*`: revoked from public, anon, authenticated and service_role |
| Approval | `approve_competition_round_result` re-runs `_comppv1_verify` on the stored version, so versions stored before PV-1 are re-verified |

## 2. The "Semi-final" label (INSPECTED + executed static test)

**Yes, the label is part of the compared payload.** The not-called-back label lives inside each row's `output`, and `output` is compared whole. It is hardcoded
three times: `NOT_CALLED_BACK_LABEL = "Semi-final"` (`engines/studioCallbackTally.ts`) and `jsonb_build_object('label', 'Semi-final')` at two places in the PV-1 SQL port
(`20270215090000`, lines 313 and 322). A display-only relabel must change none of the three; changing any one would make every callback round fail with
`COMP_RESULT_RECOMPUTE_MISMATCH`. **Executed:** `r09.label.static.test.ts` confirms the SQL contains exactly two label sites and that both equal the TypeScript constant.
**Not executed:** a database test that submits a tampered label and observes MISMATCH (no existing test tampers the label; C9 only asserts it is present;
C5/C8 exercise the same whole-`output` path with a changed tally and an extra key). Writing that test needs a scratch database (PENDING).

## 3. A4a callback-target guard (INSPECTED)

`_cf1_callback_target_check(T, capacity)`: T null -> no refusal; T < 2 -> `COMP_CALLBACK_TARGET_BELOW_MINIMUM` (checked first); T > capacity ->
`COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY`. Called from trigger `cf1_guard_callback_target_capacity` (BEFORE INSERT/UPDATE on rounds, ENABLE ALWAYS, SECURITY DEFINER, all roles),
the program-lock trigger, and the reasoned capacity RPC `set_competition_round_heat_capacity`. Scope: a `preliminary` round of a `promote_callback` program with a successor Final;
Final-only divisions, non-callback programs and rounds without a successor Final are not guarded; existing rows are not retro-failed.

| Case | Enforcement |
|---|---|
| T < 2 | refused by the trigger in guarded scope; the UI parser accepts T = 1 (its own comment says so) |
| T above Final capacity | `COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY` (trigger, lock, capacity RPC) |
| T unset | `COMPO1_CALLBACK_TARGET_UNSET` raised only at `start_competition_round`; readiness blocks earlier in the app; in calculate the engine returns `target_unset` -> UNSUPPORTED |
| T changed after ballots | `_compe2_guard_round_config` raises `COMP_ROUND_CONFIG_FROZEN` once the round is not draft/scheduled (T is deliberately not frozen by program lock, SS1) |
| T >= eligible entries | **not refused by the database**: the port returns every row `advanced = true` with `output.not_danced = true` (and warning `marks_ignored_round_not_danced` if marks exist); the UI parser rejects it once confirmed entries exist; readiness warns only |
| Organizer vs non-manager | the set-T server action is `requireEventManager` (RLS applies); the triggers apply to every role |

## 4. Negative-test coverage: existing / added / executed / pending

| Case | Existing test | Executed here? |
|---|---|---|
| (a) flipped `advanced` -> MISMATCH | `test_T_competition_pv1_recompute.sql` C4 | NOT RUN |
| (b) tampered tally / warning / missing row / extra output key / placement / tie_group | same file C5-C8, O3, O5 | NOT RUN |
| (b) tampered **label** | **none** | PENDING (needs scratch DB) |
| (c) unsupported method / engine version / dance count | F1-F5 (F4, F5 assert the port reason, not the error code) | NOT RUN |
| (c) UNSUPPORTED for `target_unset` / `target_invalid` | **none** | PENDING |
| (d) unlocked ballots | F2 suite L423 (`COMP_RESULT_INVALID_TRANSITION`), L619 (`COMP_BALLOTS_INCOMPLETE`); no PV-1 interaction case | NOT RUN |
| (e) tie over capacity | pv1 U1-U3; `test_T_competition_cf1_a0_tie_policy.sql` 11.4b(a)-(c) | NOT RUN |
| (f) client role direct call | pv1 W1-W6 (grants), F2 suite "anon cannot calculate", `COMP_FORBIDDEN` cases; no real client-path call with fabricated rows | NOT RUN |
| A4a cases | `test_T_competition_cf1_a4a_target_guard.sql` (T edit with 1/0/-1, T=9, insert, Final behind T=1, capacity edit/RPC, program lock, seeded T=1 readable); vitest `callbackTarget.a4a.test.ts`, `callbackTarget.k1.test.ts` | vitest: EXECUTED in the combined run (R-07 report section 3); SQL: NOT RUN |
| Label parity TS<->SQL and API-role revoke text | **added**: `r09.label.static.test.ts` (3 tests) | EXECUTED (static; no database) |

Added tests: 1 file, 3 tests. No SQL negative tests were written because they need the scratch database (PENDING below).

## 5. Release findings

| ID | Finding | File / function |
|---|---|---|
| RF-9.1 | Label is hardcoded three times with no shared constant; a one-sided change breaks every callback round (MISMATCH). Mitigated now by the executed static test. | `studioCallbackTally.ts`, `20270215090000` L313/L322 |
| RF-9.2 | T >= eligible entries is not refused in SQL; the round yields "everyone advances, not danced". Handled only by the UI parser and a readiness warning. | PV-1 port L262-265 |
| RF-9.3 | The UI parser accepts T = 1 while the database refuses T < 2 only for guarded rounds; Final-only and non-callback rounds are unguarded by design. | `callbackTarget.ts`, A4a |
| RF-9.4 | No test tampers the label, and F4/F5/UNSUPPORTED reasons are asserted via the port, not the error code. | pv1 suite |

## 6. PV-1 is a DanceFlow result-integrity safeguard, not body approval

Register entry [R09-DF-0001](../rule-register/rules/R09-DF-0001.json). It does **not** satisfy UCWDC Scoring Format's requirement of a vetted, authorized scoring
system (p.1) or WSDC 3.4.9.b's computerized-system requirement, and it must never be described as approval, certification or compliance. Future-profile requirements
are recorded NOT IMPLEMENTED: `R09-UCWDC-0001` (Rules #1-#2, #2.3), `R09-NDCA-0001` (IV.C.1.a-c recall count owned by the Chairman, 50% minimum, semi/quarter-finals;
III.D.11 Repechage not permitted), `R09-WSDC-0001` (3.4.9; Section 5; Chief Judge authority). PR 839's OD-09 entries are cross-referenced, not duplicated.

## 7. PENDING

All SQL suites listed in section 4; a scratch-database test that a tampered label produces MISMATCH; UNSUPPORTED tests for `target_unset`/`target_invalid`; a real client-path
`calculate_competition_round` call with fabricated rows. Not re-read in this slice: UCWDC Rule #2.3 text, NDCA IV.C.1.b-c and exceptions, the WSDC Definitions page number.
