# NSI M14 test plan and harness skeleton (hold semantics and purge liveness)

Status: **test plan only; no migration bytes exist.** Companion to `NSI_M14_Hold_Semantics_Spec.md`. The harness skeleton is `src/lib/supabase/migrations/sql-tests/concurrency/nsi_m14_race_local.sh` (test code; it contains no migration SQL). It is written so the **same scenarios run on an M13 database, where they must REPRODUCE the defects (proof the tests discriminate), and on an M14 database, where they must pass.** Run order when M14 exists: M13 database first (`EXPECT=bug`), then M14 (`EXPECT=fixed`).

## 1. One additional design point for the spec review (found while designing the race proofs)
`client_has_active_hold` and `is_held` are declared **STABLE**. In PostgreSQL a STABLE or IMMUTABLE function does not take a fresh snapshot: it runs under the snapshot of the **calling statement**. So even after the `effective_at` predicate is removed, a hold committed *after a purge `DELETE` statement started* is invisible to the `delete_guard` trigger that fires inside that same statement (the guard calls the STABLE function). A VOLATILE function takes a new snapshot per statement inside it under READ COMMITTED. **Proposal for M14: declare both hold-check functions VOLATILE** (inventory flag changes, recorded in the catalog self-check). Consequence to document: in the race window the purge raises 42501 from the guard instead of skipping (it never deletes a held row; the cron retries). Whether to also make `delete_guard` re-read holds explicitly is for the reviewer.

## 2. Deterministic scenarios (no timing luck: held locks, explicit sleeps inside the TEST session, never in production code)
| # | Scenario | Mechanism | M13 expected (`EXPECT=bug`) | M14 expected (`EXPECT=fixed`) |
|---|---|---|---|---|
| R1 | **Erase vs a hold committed after the erase transaction began (P2-A)** | Session E: `begin;` then `pg_sleep(6)` (transaction start time is now fixed), then calls `intake_erase_client` for the client. During the sleep session H creates and **commits** a legal hold on that client (its effective time is later than E's transaction start). | Erase **succeeds**: the client's invitations, sessions, requests are gone although the hold was committed before the erase checked (the defect, reproduced) | Erase returns `refused` / `legal_hold`; every row remains |
| R2 | **Purge `DELETE` racing a hold commit (snapshot of the calling statement)** | Blocker session B holds a row lock (`SELECT ... FOR UPDATE`) on the target expired session. The purge starts, its candidate and lock statements run, its `DELETE` blocks on B's row lock. Meanwhile H creates and commits a hold. B commits (releasing the row). | The purge **deletes** the session (the STABLE guard uses the delete statement's older snapshot) | The purge **does not delete** it: it either skips the client or raises 42501 from the guard (both accepted; the session row must remain) |
| R3 | **Isolation level (P2-B)** | The same R1 and purge calls started in `BEGIN ISOLATION LEVEL REPEATABLE READ` | The calls run (no guard) | Both refuse with SQLSTATE 55000; under READ COMMITTED they run |
| R4 | **Starvation (P2-C)** | 55 held clients with the oldest expired sessions, 5 unheld clients with newer expired sessions; call the purge once | `clients_locked` fills with held clients, the 5 unheld clients are **not** cleared on the first call | The held clients are excluded from the candidate set; the first call clears all 5 unheld clients and reports `clients_candidate = 5` |
| R5 | **C7 (strengthened)** | A session holds a client lock; purge returns quickly | existing check plus: the purge **call succeeded** (no error text) and `clients_locked < clients_candidate` | same |
| R6 | **P04 probe** | Positive control and negative control differ **only** in the actor value (both non-null) | the old probe passes with a null actor | the discriminating pair passes |

## 3. Mutation probes (each must make a scenario fail; run on the M14 database)
1. Restore the `effective_at <= now()` predicate in either function (R1 must fail).
2. Declare the hold-check functions STABLE again (R2 must fail).
3. Drop the isolation guard from the purge, from `erase_client_impl`, from `intake_erase_client` (R3 must fail, one probe each).
4. Drop the candidate pre-filter (R4 must fail).
5. Drop the delete-time hold check (R2 must fail).
6. Drop `lock_client` / `try_lock_client` (existing C5 / C7 must fail).

## 4. Catalog, rollback, DEV-safe, replay
- `assert_catalog` inventory: the two functions' volatility flags and the `nsi-body:m14` markers; a replay of the M13 file on an M14 database is documented (silent downgrade) and covered by the runbook rule.
- Rollback restores the exact M13 fingerprint and is **refused while any active hold exists** (the old predicate is weaker); test with and without a hold.
- Level-12 DEV-safe suite (no fixtures): privileges unchanged, markers present, the isolation guard refuses under REPEATABLE READ (callable without data), nothing written.
- Full-chain replay on the M14 bytes before the DEV apply; DEV apply under the standing conditions (preflight fingerprint `97e13781…|768`, postflight the new one, DEV-safe suites only).

## 5. What the skeleton does today
`nsi_m14_race_local.sh <container> [EXPECT=bug|fixed]` seeds committed fixtures in a disposable container (same method as the M12 concurrency harness), implements R1 and R2 as runnable scenarios with the expected outcome selected by `EXPECT`, and has clearly marked stubs for R3 to R6 until the migration exists. It refuses any container that is not `nsi-i2-*`. It has **not been run yet** (the heavy lock is in use by the M13 replay); the first run is on a fresh M13 container to confirm the defects reproduce.

## 6. First run (2026-11-23): both defects reproduce on an M13 database (`EXPECT=bug`, throwaway container, fingerprint `97e13781…|768`)
Evidence: `rehearsal/m14_baseline/race_harness_on_m13_bug_2026-11-23.txt`.
- **R1 (P2-A, erase):** an erase transaction that began before a hold committed **deleted every row of the held client** (`left=0`) although the hold was committed before the erase reached its check. The pre-existing, more serious defect is real, not theoretical.
- **R2 (purge snapshot):** a purge `DELETE` that started before a hold committed **deleted the held client's expired session** (`sessions left=0`; the purge reported `clients_locked=1`).
- R3 to R6 are still stubs. Nothing was applied anywhere; the container was discarded; the lock was released by the run.
- When M14 exists the same two scenarios run with `EXPECT=fixed` and must show the rows intact (R1 refused, R2 skipped or raised without deleting).
