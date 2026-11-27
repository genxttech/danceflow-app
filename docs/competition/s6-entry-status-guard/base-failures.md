# Base-chain failures: diagnoses and labelled copies (2026-11-27)

Items assigned by the Competition coordinator from `docs/competition/p1-disposition.md` (PR 863, `268cdd58e`). From reading the p1run6 / p1run7 logs, the composed scripts and the migrations. **Nothing here was executed.** No product defect was found.

| Item | Class | Cause | Copy or fix |
|---|---|---|---|
| Phase 10A and 10B "Competition template not found" and related template checks | Test environment | The baseline is restored from a schema-only dump (`build_baseline.sh` of the CF1 foundation work), and the two migrations that insert the starter templates are not replayed, so the tables exist and are empty | `sql-tests/fixtures/seed_competition_starter_templates.sql`: verbatim inserts of all three starters (`20260620_competition_contests_and_templates_v1.sql:114-221` ballroom and country; `20260622_west_coast_swing_foundation_v1.sql:274-323`). The PR 863 runner loads it before the first phase; suites unchanged |
| `cf1_a3_locks` | Harness | Prints every expected result and no PASS or FAIL line, so the runner reports a failure | `run_cf1_a3_locks_verdict.sh` (0 to 15 checks) |
| `e2_submit_vs_lock` | Stale test | HL1 (`20270119090000`): ballot lock needs danced heats; the script leaves them scheduled (`COMP_HL1_HEAT_NOT_DANCED`) | `run_e2_submit_vs_lock_danced.sh` (8 to 10) |
| `f2_races` | Stale test | HL1, then the PV-1 recompute check (`20270215090000`), which needs one dance per heat and per-row output | `run_f2_races_pv1.sh` (26 to 33; one conditional) |
| `ns1_races` | Stale test | HL1: a heat on the floor cannot be locked (`COMP_HL1_LOCK_ACTIVE`) | `run_ns1_races_danced.sh` (12 to 18) |

The copies are not released scripts and never count as passes of them. Each header names its source blob and changes; no source check or timing was changed. The added checks make the in-flight calls prove they succeeded (or failed with the expected code), because the old waiting-time checks could pass while both calls errored (F2 log, `p1run6`).

## Review (2026-11-27, one independent read-only review; its fixes are not re-reviewed)

It found no source assertion removed. Changed afterwards: the A3 verdict copy now prints the session errors on failure (so a clearance refusal is visible and triggers the seeded rerun); NS1 scenario B must now observe a real lock waiter; the baseline copy sets the parent status by an owner write before C1c, which had become vacuous; the third starter template was added to the fixture. Run notes: the copies run only where their pull request is composed, so not on the base chain without a runner step; the runner labels adapted suites but not these races or suites, so read the file names; the F2 parity check Z is skipped by that runner, so expect 32 of 33. The older waiting-time checks can still pass on client latency alone; apart from the added NS1 check that limitation is inherited.

## What stays untested

- Until the copies run, nothing passes behind these four races on any chain.
- Chain B needs eligibility clearance seeding for the renamed copies; `cf1_a3_locks` never loads the clearance helper, so its first run there is expected to fail; the printed refusal should trigger the runner's seeded rerun (not verified).
- On the P1 restriction chain `f2`, `ns1` and `cf1_a3_locks` cannot run: their fixtures need things the pilot forbids (ballots before a start, corrections, a second heat after a start, non-final rounds). `e2_submit_vs_lock` appears compatible. So the F2, NS1 and A3 race guarantees are **untested** with the restriction.

## Live product and the starter template

The one caller is the advanced competition page's "Apply Ballroom Starter" action. Its buttons are drawn only from active template rows, the same filter the database function uses, so a missing row shows no button rather than this error. A production data dump of 2026-07-15 holds the three starters, active. The Competition coordinator reports having verified, read-only on 2026-11-27, that **the three starter templates are active on DEV and PROD** (not re-checked by this PR's author, who ran no hosted query). The check, per hosted database:

```sql
select template_key, version, status, discipline_family,
       jsonb_array_length(blueprint->'dances') dances, jsonb_array_length(blueprint->'contests') contests, updated_at
from public.competition_configuration_templates order by 1, 2;
```

An environment rebuilt from a schema-only dump would lack these rows (inferred).
