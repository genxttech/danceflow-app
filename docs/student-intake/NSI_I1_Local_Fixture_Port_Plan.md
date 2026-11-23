# NSI I1-local fixture port: plan (docs only; no suite edited because no container was allowed to run it)

Status: plan for a follow-up slice that needs the heavy lock. `test_T_nsi_i1_local.sql` (1019 lines, 303 checks) is valid for M1 to M9 only (see `NSI_I2_M10_Notes.md`): its obligation fixtures call `intake_ensure_request` with an appointment created "now" and no pilot grant, which the M10+ evaluator answers with NULL. It must not be edited blind: every edit needs a container run, and the lifecycle harnesses currently run it only as part of the M9-era checks.

## 1. What fails on M10+ and why
`intake_ensure_request(studio, client, appointment)` now returns NULL unless the evaluator says the appointment creates an obligation: the studio holds an active `live_collection` grant, `intake_settings.enabled_at` precedes the appointment's `created_at`, the appointment is aged past the evaluator's creation window, the client is not an existing student, and the type is selected. The suite builds fixtures without those preconditions.

## 2. The 14 call sites (line numbers in the current file)
| Lines | What the check does | Needs |
|---|---|---|
| 386 | `retention_policy_incomplete` refusal with Gate A closed | none (refusal comes before evaluation); keep |
| 484 | `new_obligation_not_allowed` while Gate B closed | none; keep |
| 488, 491 | first creation, then idempotent return of the same id (`req1`) | eligible fixture for `appt_future` |
| 499 | cross-studio client/appointment refused 42501 | none |
| 501 | cancelled appointment refused 22023 | none |
| 502 | `o04b` foreign appointment | eligible fixture for `appt_b1` |
| 597, 631 | `o13a`, `o13e` creations used by later checks | eligible fixture for `appt_future` |
| 744 | `appt_far` creation (window edge) | eligible fixture; the check asserts the far appointment is created: confirm against the evaluator's window |
| 821, 836 | `client_a3` / `appt_a3` creations | eligible fixture |
| 970 | `erasure_barrier_active` refusal | none |

## 3. Port recipe (the helpers already exist in `nsi_i2_fixtures_local.sql`)
1. Run the suite through `run_i2_m7_m9_local.sh` (it prepends the fixtures file) rather than the bare psql pipe used by the legacy loop; or add the fixtures prelude to the legacy runner.
2. At the top of section 3 (gate-open) call `pg_temp.fx_grant('studio_a', 'live_collection')` and set `enabled_at` earlier than the fixtures (the fixtures file already inserts `intake_settings` rows with `enabled_at = now() - interval '5 days'`; reuse that pattern).
3. Replace the appointment inserts for the eight "needs eligible fixture" rows with `pg_temp.mk_appt(studio, client, type, status, start, created)` using a `created` interval old enough for the evaluator (the M10 suite shows the accepted value), and a lesson type that is selected for the studio.
4. Where a check asserts a specific refusal that precedes evaluation (386, 484, 499, 501, 970), leave it as is.
5. Re-count: the M9-era total stays 303 checks; none is removed. The expected suite line is the same text.
6. Mutation probe: remove the grant line and confirm the suite fails on the creation checks (proves the fixture is what makes them pass).

## 4. Validation (needs the heavy lock; not done here)
Run on M9 (must still pass), on M10..M14 (must now pass), then include it in the lifecycle harnesses' legacy loop for M14 and later, replacing the "valid for M1-M9 only" caveat. Record the evidence under `rehearsal/`.

## 5. Why not now
The task allowed docs and tests only where no docker is needed; this port cannot be verified without a container, and an unverified edit to a 303-check suite is worse than the documented limitation. I3-3 (M15) is not blocked by it: the M10 to M14 suites and the I2/I1-foundation suites cover the shipped behavior.
