# NSI M14 test plan and harness skeleton (hold semantics and purge liveness)

Status: **test plan only; no migration bytes exist.** Companion to `NSI_M14_Hold_Semantics_Spec.md`. The harness skeleton is `src/lib/supabase/migrations/sql-tests/concurrency/nsi_m14_race_local.sh` (test code; it contains no migration SQL). It is written so the **same scenarios run on an M13 database, where they must REPRODUCE the defects (proof the tests discriminate), and on an M14 database, where they must pass.** Run order when M14 exists: M13 database first (`EXPECT=bug`), then M14 (`EXPECT=fixed`).

## 1. RETRACTED design point (kept for the record)
Revision 1 of this plan claimed that the hold-check functions being STABLE left a window because a STABLE function reuses the calling statement's snapshot, and proposed making them VOLATILE. **That claim is wrong.** The micro-experiment `stable_snapshot_experiment_local.sh` (evidence `rehearsal/m14_baseline/stable_snapshot_experiment_2026-11-23.txt`) shows that both a STABLE and a VOLATILE security-definer function called from a volatile plpgsql BEFORE DELETE trigger see a row committed by another session during the DELETE's row-lock wait (both deletes were refused). The reproduction below (R2 on M13) is caused by the `effective_at <= now()` predicate with a direct-insert hold. The M14 spec (revision 2) states the real invariant (L1 before the check and until commit; every hold insert takes L1) and redesigns R2 as R2a (RPC path) and R2b (direct-insert bypass).

## 2. Deterministic scenarios (no timing luck: held locks, explicit sleeps inside the TEST session, never in production code)
| # | Scenario | Mechanism | M13 expected (`EXPECT=bug`) | M14 expected (`EXPECT=fixed`) |
|---|---|---|---|---|
| R1 | **Erase vs a hold committed after the erase transaction began (P2-A)** | Session E: `begin;` then `pg_sleep(6)` (transaction start time is now fixed), then calls `intake_erase_client` for the client. During the sleep session H creates and **commits** a legal hold on that client (its effective time is later than E's transaction start). | Erase **succeeds**: the client's invitations, sessions, requests are gone although the hold was committed before the erase checked (the defect, reproduced) | Erase returns `refused` / `legal_hold`; every row remains |
| R2-P2A | **A purge transaction that began before a hold committed** (replaces the withdrawn R2) | Purge in `begin; select now(); pg_sleep; purge; commit`; the hold is created and committed by the normal function during the sleep | The purge **deletes** the session (the hold looks "not yet effective") | The purge **skips** the client; the session remains |
| R2a | The purge holds L1 while blocked on a row lock | The hold creator waits on the advisory lock (observed in `pg_stat_activity`), the purge deletes, the hold exists afterwards | same (correct) | same (correct) |
| R2b | Direct hold insert bypassing the lock, from a transaction older than the purge | Guard backstop | row remains (the older `effective_at` is effective) | row remains (guard raises 42501) |
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

## 6. First run (2026-11-23) and its CORRECTION (reviewer addendum)
First run: `EXPECT=bug` on a throwaway M13 container (`97e13781…|768`); evidence `rehearsal/m14_baseline/race_harness_on_m13_bug_2026-11-23.txt`.
- **R1 (P2-A, erase): valid.** An erase transaction that began before a hold committed deleted every row of the held client (`left=0`). The pre-existing, more serious defect is real.
- **The original R2 was a FALSE POSITIVE as a defect proof and is withdrawn.** In that timeline the purge held the client lock and the hold creator waited on it until the purge committed, so the hold did not exist when the delete ran: the delete was correct and the lock serialized the two (the hold only looks older because its `created_at`/`effective_at` default to the creator's transaction start). It could never pass under `EXPECT=fixed`, and it does **not** support any STABLE or VOLATILE claim. Nothing in the D9 report or the M13 notes relies on it.
- **Replacements (in the harness now):** **R2-P2A** (a purge transaction that began before the hold committed: M13 deletes, M14 must skip; the same root cause as R1 and the real purge defect), **R2a** (the purge holds the client lock; the RPC hold creator waits on the advisory lock, the purge deletes, the hold exists afterwards: the CORRECT outcome in both modes, a probe removing every client lock from hold creation must fail it), **R2b** (a hold inserted directly bypassing the lock, from a transaction that began before the purge so `effective_at` is not the cause: the guard must refuse and the row remain; correct in both modes).
- Added: **R2c** (the delete guard locks before it checks) and **R2d** (every direct hold insert takes the client lock). R4 (starvation) is the M14 suite check T07; R5 (strengthened C7) and R6 (P04 pair) are in the concurrency harness and the M13 suite.
- `VOLATILE` is not part of the fix: the micro-experiment showed that a trigger sees a hold committed during the delete's lock wait for both STABLE and VOLATILE functions.
