# CF1 RB4: hosted READ-ONLY catalog verification — approval request (2026-11-07)

Status: REQUEST ONLY. Nothing here has been executed against DEV or PROD. This supersedes Part A of `cf1-rb4-hosted-verification-plan-2026-11-07.md` with exact files. Approval requested: one read-only catalog check per target, described below.

## 1. Targets

| Target | Project ref | How it is reached |
|---|---|---|
| DEV | `epdrtzcydvnoidwrepqz` | the repository's existing Supabase link, `supabase db query --linked -f <file>` |
| PROD | `hvsujyfbftfffxpfmlpb` | a fresh scratch `--workdir` linked to that ref, removed afterwards; 7 s between CLI calls |

## 2. What is run

One file, run once per target: `docs/qa/cf1-rb4-int5/hosted/readonly_catalog_check.sql` (committed; no other SQL).

| Query | Purpose | Reads |
|---|---|---|
| Q1 | CF1 object existence: count of `cf1`-named functions, of the 17 CF1 tables, of `cf1_` triggers, existence of `event_competition_correction_causes` | `pg_proc`, `pg_class`, `pg_trigger` |
| Q2 | For the 19 existing functions CF1 redefines: current md5 of `pg_get_functiondef` (CR removed), owner, ACL, SECURITY DEFINER, config, compared with three expected md5 values and classified MATCH_PRE_BASE / MATCH_PRE_R2 / ALREADY_POST_CF1 / MISMATCH / ABSENT | `pg_proc` |
| Q3 | Presence of the three R2 ledger tables (decides the RB3 mode) and an informational md5 of `record_competition_checkin_payment` | `pg_class`, `pg_proc` |
| Q4 | Existence (boolean) of `supabase_migrations.schema_migrations`; rows are not read | `to_regclass` |

Why it is read-only: the file opens with `begin read only;` (Postgres rejects any write in the transaction), sets `statement_timeout` 10 s, selects only from catalog objects and `to_regclass` / `pg_get_functiondef`, selects from no application table and reads no row of any, touches no `auth.*` or `storage.*` object, and ends with `rollback;`. Output is catalog metadata and md5 values only; it contains no PII.

## 3. Expected results (from the local chain, not from a hosted database)

* Expected values: `docs/qa/cf1-rb4-int5/hosted/expected_redefined_functions.tsv` (19 functions: base md5, md5 after R2, md5 after the full CF1 chain) and `expected_new_functions.tsv` (130 functions CF1 adds; informational).
* Dry run of the same SQL on the local base image (`hosted/local_dry_run_base_image.txt`, not a hosted database): Q1 = `0|0|0|f`; Q2 = all 19 `MATCH_PRE_BASE`; Q3 = `f|f|f`; Q4 = `f`. This proves the file parses and classifies; it does not predict hosted drift.
* Hosted expectation per `hosted-state 2026-11-07 ~14:00Z`: Q1 all zero on both targets. Q2 MATCH_PRE_BASE for functions CF1 has not touched; a known DEV/PROD drift (memory note `dev-prod-drift-followups`) may show as MISMATCH and must be reported, not repaired. R2 is branch-only, so Q3 `f|f|f` is the expected hosted state and means the RB3 gate runs in mode `absent`.

## 4. Stop conditions

Stop and report without further queries if: the CLI link points to a ref other than the two above; the file differs from the committed one (compare `git hash-object`); any statement errors with anything other than a catalog-permission message; Q1 shows any non-zero CF1 count (CF1 already partly applied: do not proceed to any apply discussion until reviewed); Q2 shows any MISMATCH or ABSENT; or the CLI asks for a prompt. A MISMATCH is a release blocker for that function and is never auto-repaired.

## 5. Separate authorizations NOT requested here

| Operation | Why separate |
|---|---|
| Applying any CF1 or R2 migration to DEV or PROD | schema write; SQL before app, rollback app first then SQL |
| Running a rollback script on a hosted database | schema write; CF1 rollbacks refuse while evidence rows exist |
| Reading rows (including the DEV `schema_migrations` row) | row access |
| `pg_dump` / restore of DEV for data-present rehearsal | copies real rows |
| Writing a `competition_cf1_rb3_gate_overrides` row | financial gate override, owner decision only |
| Deployments, Stripe operations, OD-17 activation, publication | out of scope |

## 6. EXECUTED 2026-11-07 (owner approved "read-only" after the report; no other hosted operation)

Run through the CLI as four separate `begin read only ... rollback` transactions (the CLI returns only the last statement's result), identical text to the committed file split at the Q headings; DEV via the repo link (`epdrtzcydvnoidwrepqz` confirmed), PROD via a fresh scratch `--workdir` linked to `hvsujyfbftfffxpfmlpb` (deleted afterwards). Raw JSON: `cf1-rb4-int5/hosted/results_2026-11-07/`. No stop condition triggered.

| | DEV | PROD |
|---|---|---|
| Q1 CF1 functions / tables / triggers / A7 causes table | 0 / 0 / 0 / false | 0 / 0 / 0 / false |
| Q2 (19 functions CF1 redefines) | 5 MATCH_PRE_BASE, 14 ABSENT, 0 MISMATCH | identical: 5 MATCH_PRE_BASE, 14 ABSENT, 0 MISMATCH |
| Q3 R2 ledger tables (orders refunds / allocations / scopes) | all absent | all absent |
| Q3 `record_competition_checkin_payment` md5 (informational) | `70285eaf8c11f4cb34cb487fa1d3f47a` | same |
| Q4 `supabase_migrations.schema_migrations` exists | true | false |

Findings:
* Matches the expected pre-CF1 state: no CF1 object on either target; the five Phase 10D functions match the local pre-CF1 pins exactly (so the CF1 preflights on those would pass).
* **The 14 ABSENT functions are the competition ballot/results chain (E2, F2, NS1, HL1, CX1: `_compe2_*`, `_compf2_evidence`, `calculate/approve/complete_competition_round`, `lock_competition_round_ballots`, `competition_judge_ballot_sheet`, `competition_round_ballot_status`, `competition_round_results_review`, `competition_audit_log`).** Neither DEV nor PROD has those migrations. CF1's A2, A3 and A7 (and A0's `complete_competition_round`) pin and rewrite them, so CF1 cannot be applied to DEV or PROD until that earlier chain is applied. This is a new, material release prerequisite, not a CF1 defect; the chain is applied in the local base image. Dependency order, an owner decision on releasing the E2/F2/NS1/HL1/CX1 chain first, and its own pin/rollback evidence are needed before any CF1 hosted apply.
* R2 is absent on both, so RB3 would run in mode `absent` (gate refuses) until R2 or an owner override.
* DEV and PROD behave identically for every queried object; the informational check-in payment md5 equals on both, so this is not DEV/PROD drift in the queried set.
