# CF1 RB4: hosted real-catalog pin check and data-present rollback — verification plan (2026-11-07)

Status: PLAN ONLY. Nothing in this document has been executed against DEV or PROD. Every step that touches a hosted database needs its own owner approval (named below). Local disposable-database work is already within the standing authorization and is marked LOCAL.

Context: RB4 evidence on the applied chain exists (`cf1-rb4-applied-chain-2026-11-05.md`, historical: integration-3, A7 then at slot 096000). Two RB4 rows remain NOT VERIFIED there: row 4e (rollback with CF1 data present) and row 5 (pins against the real DEV/PROD catalogs). Hosted state as of 2026-11-07 ~14:00Z (read-only catalog check, owner-authorized): DEV `epdrtzcydvnoidwrepqz` and PROD `hvsujyfbftfffxpfmlpb` carry no `cf1_*` function, no `event_competition_correction_causes` table and none of the four spot-checked CF1 functions. A pre-apply re-check is required again.

## Part A — hosted READ-ONLY operations (approval A required)

All run inside `begin read only; ... rollback;` through `supabase db query --linked -f <file>` (DEV: repo link; PROD: fresh scratch `--workdir` linked to the PROD ref, deleted afterwards; 7 s stagger between CLI calls). Catalog tables only (`pg_proc`, `pg_trigger`, `pg_class`, `pg_policy`, `pg_constraint`, `pg_depend`, `information_schema`); **no application table is selected from, no row is read, no PII is touched**.

| # | Operation | Output | Mutating? |
|---|---|---|---|
| A1 | Re-run the CF1-object existence query (A7 table/trigger fn, `cf1_*` count, spot-check functions) immediately before any CF1 apply | 6 scalars per database | No |
| A2 | For each of the 115 pin rows in `docs/qa/cf1-rb4-run/pin_coverage.tsv` that is a function the CF1 chain REDEFINES (pre-CF1 body): `md5(replace(prosrc, E'\r',''))`, `pg_get_function_identity_arguments`, owner, `proacl`, `prosecdef`, `proconfig`, compared to the pin from the final applied chain | pin vs catalog table: MATCH / MISMATCH / ABSENT | No |
| A3 | Triggers, constraints and policies on the tables CF1 alters (`event_competition_entries`, `_heats`, `_heat_entries`, `_rounds`, `_result_events`, `_ballots`): `pg_get_triggerdef`, `pg_get_constraintdef`, policy `qual` md5 | same | No |
| A4 | Dependency presence: R2 ledger tables (`event_order_refunds`, `event_order_refund_allocations`, `event_competition_refund_exception_scopes`) and the main-side objects CF1 reads (`record_competition_checkin_payment` body md5 at `20270205100000`, D24 / D7 tables used by RB3R) | present/absent + md5 | No |
| A5 | List of applied-migration evidence: `supabase_migrations.schema_migrations` EXISTENCE only (DEV has one, PROD does not). Rows are NOT read unless a separate decision asks for it (DEV row from the 2026-10-14 branching attempt). | boolean | No |

Expected outcome today: A2 reports every redefined function MATCH its pre-CF1 pin or a documented DEV/PROD drift (see memory `dev-prod-drift-followups`), A1/A4 as above. A MISMATCH is a release blocker for that function, never auto-repaired.

Not proposed: reading `pg_stat_statements`, `pg_dump`, any table data, any `auth.*` or `storage.*` object.

## Part B — operations that WOULD mutate or expose data (each needs its own approval; none requested now)

| # | Operation | Why it is not in Part A | Approval |
|---|---|---|---|
| B1 | `supabase db query` apply of any CF1 migration to DEV (including the 20270205100000 interplay) | schema write | Approval B (DEV apply, per migration batch) |
| B2 | Same on PROD | schema write, SQL before app | Approval C (PROD apply, with rollback order: app first, then SQL) |
| B3 | Rollback script run on a hosted DB | schema write; A3/A5/A6 rollbacks refuse while rows exist by design | Only after B1/B2, separate approval |
| B4 | Hosted `pg_dump` / restore of DEV to a disposable instance to get realistic data-present rollback evidence | copies real rows (PII) off the hosted DB | Approval D, only if synthetic data is judged insufficient |
| B5 | Writing a recorded `competition_cf1_rb3_gate_overrides` row to a hosted DB | financial gate override | Never as test evidence; owner decision only |

## Part C — LOCAL operations (no hosted approval needed; within the standing authorization)

| # | Operation | Closes |
|---|---|---|
| C1 | Regenerate the RB4 pins from the FINAL applied chain (integration-5 head, R2 included, A7 at 095500, F3 included): `docs/qa/cf1-rb4-run/pins.mjs` / `rb4*.sh` on a disposable container; commit the new pin files | RB4 pins stale after A7 slot rename and the A7 in-place correction |
| C2 | Data-present rollback with synthetic data: seed exclusions, withdrawals, advancements, results, causes, recon rows; run the reverse rollback chain; assert (a) the A3/A5/A6 (and RB3R / U66 / OD-17 / F3) rollbacks REFUSE with their documented messages while rows exist, (b) after the documented export-and-clear step they succeed, (c) the post-rollback fingerprint equals pre-CF1, (d) re-apply reproduces the composed fingerprint | RB4 row 4e |
| C3 | "App first" half of the rollback order: run the TypeScript/browser acceptance against the rolled-back schema to show the app degrades closed (CF1 surfaces off) rather than 500s | RB4 row 4f |
| C4 | Run the Part A queries against the local applied chain to produce the expected-value file before any hosted read, so the hosted comparison is mechanical | prepares A2/A3 |

Proposed order: C4 and C1 (needs the final chain; fits the slot after the current composed run) → C2 → C3 → request Approval A with the exact SQL files attached → Part B only on the owner's explicit, separate go-ahead.
