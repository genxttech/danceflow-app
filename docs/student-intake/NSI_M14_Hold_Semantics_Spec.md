# NSI M14 specification: hold semantics and purge liveness (revision 1, for review before any migration)

Status: **specification only; the migration is not written.** Origin: the independent review of M13 (conditional GO, findings P2-A..D). The first finding is a **safety defect that predates M13** and also affects client erasure. **None of it is on PROD** (PROD has no NSI objects), so there is no live exposure; on shared DEV Gate A is closed and there is no data. It must be fixed before Gate A, before any purge cron and before I4 wiring, and it is scheduled **before** the I3-3 implementation (renumbered **M15**).

## 1. P2-A: a just-committed legal hold can be missed (root cause, pre-existing)
`intake_private.client_has_active_hold` and `intake_private.is_held` test `h.released_at is null and h.effective_at <= now()`. A hold's `effective_at` defaults to `now()` of the transaction that creates it (its start time); `now()` in a checking transaction is that transaction's start time. A destructive transaction (erase, purge) that **started before** the hold's transaction began, and that checks after the hold committed, sees a committed row whose `effective_at` is later than its own `now()` and treats it as not yet effective. Consequences:
- `intake_erase_client` / `erase_client_impl` can erase a client's whole intake record although a hold was committed before the erase reached its hold check. (The more serious instance.)
- The M13 purge, and the `delete_guard` backstop (M3), share the same predicate and the same blind spot.

**Fix (M14):** destructive-path hold checks ignore the effective time entirely: a hold protects from the moment it is committed (`released_at is null` and the row is visible). Implementation: new bodies for `client_has_active_hold` and `is_held` (markers `nsi-body:m14`) with no `effective_at` comparison; `effective_at` remains informational (when the owner says the hold applies from) and cannot postpone protection. The alternative `effective_at <= clock_timestamp()` still leaves a window (a hold timestamped later than the check) and is rejected. Every caller is destructive-side (erase, purge, delete guard, audit retention state), so tightening can only refuse more deletions, never fewer.

## 2. P2-B: isolation level
The destructive paths rely on READ COMMITTED semantics (each statement sees the newest committed holds). Under REPEATABLE READ or SERIALIZABLE a stale snapshot would reintroduce P2-A. M14: `intake_erase_client`, `erase_client_impl` and `purge_expired_impl` raise `55000` unless `current_setting('transaction_isolation') = 'read committed'`. Test: each refuses under REPEATABLE READ and works under READ COMMITTED.

## 3. P2-C: starvation of the purge by held clients
The candidate statement does not exclude held clients, so 50 held clients with old expired rows would occupy every call. M14 pre-filters holds in the candidate statement and orders candidates by oldest expiry (rotating through the backlog), so a held client is never counted against the 50-client bound and never blocks others. The hold check at delete time stays (race protection).

## 4. P2-D: discriminating tests (the review's list)
- A hold committed by a **separate session after the purge's lock statement**: the purge's later statements must skip that client (deterministic with held locks and a short sleep, the same technique as C5/C7).
- Erase variant: a long-lived transaction started before a hold commits, then runs the erase hold check: it must refuse (the regression test for P2-A).
- C7 strengthened: assert the first purge call **succeeded** (no error text) and `clients_locked < clients_candidate`.
- P04 probe with a **different non-null** actor (positive control and negative differ in the actor value only).
- Mutation probes: restore the `effective_at <= now()` predicate; drop the isolation guard; drop the candidate pre-filter.
- Privileges unchanged; the rollback restores the M13 bodies exactly and is **refused whenever any active hold exists** (the older predicate is weaker).

## 5. Nits folded in
- `session_revoked` audit row gets `client_ref`, so the client's records can be found and erased consistently.
- Dead m13 precondition branch in M13's header check: comment only; the M13 file is not edited, recorded in the notes.
- Summary label in the harness ("SUMMARY concurrency M12" is also printed for M13).

## 6. Sequence and blockers
M13 DEV apply (after the clean replay on its bytes) -> **M14 (this spec) implementation and review** -> I3-3 as **M15** (spec amended) -> I3-2 (M16) -> I1-local fixture port. **P2-A..D are blockers for any purge cron, I4 wiring and Gate A.**
