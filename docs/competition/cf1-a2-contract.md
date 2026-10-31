# CF1 package A2 — contract: pinned lock-ballots eligibility check

Migration `20270120092000_competition_cf1_a2_lock_check.sql` (rollback in `rollback/`, suite `sql-tests/test_T_competition_cf1_a2_lock.sql`, concurrency probe `sql-tests/concurrency/run_cf1_a2_lock_vs_lifecycle.sh`).
Design: `callback-to-final-advancement-design.md` §4.6 (OD-17 D at ballot locking), §4.6 b (OD-15 A minimum), A.3 (lock order), A.9.1–A.9.5.
Depends on A1 (`_cf1_require_roster_eligible`). **Global results-integrity change:** it affects `lock_competition_round_ballots` for every scored round of every program (design A.9.4).

## What changes

`lock_competition_round_ballots(uuid, uuid)` is redefined by **one pinned text-replace** of the installed post-HL1 body. Nothing else changes (same signature, owner, `SECURITY DEFINER`, `search_path = public, pg_temp`, grants — `create or replace` keeps them; no function-level `lock_timeout`).

One block is inserted immediately before the HL1/E2 statement `select coalesce(jsonb_agg(j.official_id), '[]'::jsonb) into v_absent`, i.e.

* **after** the auth checks, the round `FOR UPDATE`, the **replay branch** and the state check (`COMP_BALLOTS_BAD_STATE`),
* **after** the heat and heat-entry `FOR SHARE` and every readiness check (callback not danced, no heat, no judge, panel size, **stale**, **missing**, **heats not locked**, and HL1's **not danced**),
* **before** the audit insert and the status write.

```sql
  perform 1 from public.event_competition_entries ce where ce.id = any (public._compe2_round_entries(p_round_id)) order by ce.id for share;
  perform public._cf1_require_roster_eligible(p_round_id, 'lock');
```

* Statement 1 takes the ranking set's entry rows `FOR SHARE` **in id order** (entries last in the lock order, A.3).
* Statement 2 is a **separate statement** (fresh snapshot in READ COMMITTED) that reads P over the locked entries and the linked registrations and orders.

## Errors (A1's catalogue; both `P0001`, permanent)

| Code | When | `detail` |
|---|---|---|
| `COMP_ROSTER_ENTRY_UNAVAILABLE` | any entry of the round's ranking set (`_compe2_round_entries`) satisfies predicate P | `{"stage":"lock","round_id":…,"entries":[{"entry_id":…,"reason":…}]}`, entries ordered by id |
| `COMP_ROSTER_BELOW_MINIMUM` | callback Final only (`_cf1_is_callback_final`), fewer than 2 available couples | `{"stage":"lock","round_id":…,"eligible":n,"minimum":2}` |

A deadlock is the retryable `40P01` (see below). A2 raises nothing of its own.

## Behaviour contract

* **Replay (U69):** a lock request id that was already applied returns `{"replayed": true, …}` even if a couple became unavailable afterwards; the check never runs on a replay. A new request id on an already locked round still gets `COMP_BALLOTS_BAD_STATE`; a request id used for another round still gets `COMP_REQUEST_REUSED`.
* **Order of errors:** every existing error keeps its place and precedence. In particular stale ballots (`COMP_BALLOTS_STALE`) are reported **before** the roster check, which is what makes the NS1/E2 resolution route work: the roster changes (scratch / no-show), judges file corrected ballot versions, the manager re-locks (after `reopen_competition_round_ballots` if the round was already locked).
* **No false positives from missing links:** P reads only the entry's **own** `registration_id` / `order_id`. Manual or comped entries without registration or order are available (U82); a `partially_refunded` order excludes nobody; a refund of one entry inside a still-paid order is the accepted R2 false negative.
* **Refund inputs are not locked** (A1 caveat): locking entry rows does not serialize a registration or order refund (the sync skips entries on locked heats). A refund committing concurrently with lock can pass on an older snapshot; calculate and **approve** re-check later and approve is the last check.
* **Scope:** the check applies to every scored round (design A.9.4). The minimum applies **only** to callback Finals; Final-only divisions with one couple lock normally. RB1: the OD-17 cross-check is not to be enabled for live events until the release blockers of design A.9.5 are cleared.

## Lock order and deadlock (A.3)

`round FOR UPDATE` → heats `FOR SHARE` → heat entries `FOR SHARE` → **entries `FOR SHARE` (id order)** → separate check statement.
`change_competition_entry_lifecycle` locks the entry (`FOR NO KEY UPDATE`) and then its heat entries; this is the **inverse** order against Lock ballots. The pair can deadlock; Postgres chooses one victim with `40P01` (retryable) and the other session completes. The caller retries the lock (same request id). Probe: `run_cf1_a2_lock_vs_lifecycle.sh` (the writer is emulated with the same lock order, because the real RPC refuses entries on locked heats). No `lock_timeout` is set by A2, so waits are bounded only by the session's own settings and the deadlock detector.

## Pins (taken from an applied chain on the QA Postgres, CRs removed)

| Text | md5 |
|---|---|
| Installed before A2 (post-HL1) | `6e4175342d51ffe274d70ce413bae8c3` |
| After A2 | `c4ba327df7943d559ab52ccd07d20ea0` |

Preflight refuses unless the installed text has the pre-A2 md5, the anchor occurs exactly once and the A2 block is absent; it verifies the post-replace md5 before and after the `create or replace`. HL1's suite now asserts the post-A2 md5 (`test_T_competition_hl1_heat_guards.sql` l.254, owned exclusively by A2).

## Rollback

`rollback/20270120092000_…_rollback.sql` removes the single block (exactly once or refuses) and refuses unless the restored text has md5 `6e4175342d51ffe274d70ce413bae8c3`. **Order: A2 rollback BEFORE HL1's rollback** (HL1's rollback pins the pre-HL1 text and removes only its own insertion). After A2's rollback the HL1 suite's md5 line must be reverted to `6e41…` (or A2 re-applied) to pass.

## For the other packages

* A3's pinned functions (calculate, approve, E2 ranking set) and A0's guards are not touched. A4's integration suite composes A2 for the lock call-site.
* A5's exclusion action changes the ranking set; the lock check sees it automatically through `_compe2_round_entries`.

## Review notes (independent security review, no P0/P1)

* **Second inverse-order writer (P2).** The registration-sync trigger on `event_registrations` (20260620 generation operations, ~l.405-431) updates the entries of a registration (`FOR NO KEY UPDATE`, no id ordering) and can also be a deadlock counterpart of Lock ballots (a refund covering several entries vs. entries `FOR SHARE` in id order). Postgres picks one victim with `40P01`; if it is the refund transaction the caller (webhook) must retry. Not modelled by the concurrency probe (which emulates only the lifecycle writer). Ordering the sync's updates by id would remove the cycle with Lock ballots; that is a change outside A2's scope.
* **Refund inputs unlocked (P2).** Accepted race; **approve (A3) must remain the last check** — keep as an A3 acceptance item.
* **Chairs see per-entry payment reasons (P3)** in the error detail (A1 behaviour); coarsening is an owner decision.
* **CR note (P3):** pins hash CR-stripped text. If the installed body had CRs, the replace rewrites it as LF, and the rollback restores LF; "exact restore" holds modulo CR (post-HL1 was already LF: HL1 executed CR-free text).
* **Callers should set a statement timeout (P3):** no `lock_timeout` is set, so a long open entry-updating transaction makes the lock RPC wait.
* **Rollback round-trip** (apply, rollback, apply, rollback, apply, with the HL1 rollback in between) was run on the QA chain; see the PR matrix.
* The concurrency script must run on a fresh database and its `pg_locks` check is instance-global (run it alone).

## Concurrency probe is deterministic (update)
`run_cf1_a2_lock_vs_lifecycle.sh` no longer relies on sleeps. The writer takes the entry, then polls `pg_stat_activity` until the Lock-ballots backend is observed blocked (a 20 s barrier timeout fails loudly), and only then takes its second lock, so the cycle always forms. The victim is chosen by per-session `deadlock_timeout` (shorter runs the detector first): A1 writer victim, A2 lock victim; the victimised lock is retried once (reported). Earlier intermittent "no victim" came from the fixed 1 s / 3 s sleeps: when the lock session started late (docker exec latency) the writer had already finished its second update, so no cycle formed. No migration change was needed. Fixture ids carry a per-run prefix (`RUN`), so several runs share one database.

## Gate coverage (A.9.5)
| Gate | A2 check label(s) | Status |
|---|---|---|
| U38 (A2 half; A5's exclusion route is A5's) | suite: "U38: manager records an NS1 no-show … (real RPC)", "U38: after the real NS1 no-show the submitted ballots are stale and lock refuses COMP_BALLOTS_STALE FIRST", "U38 + U58: with corrected ballots (NS1 route) … the re-lock succeeds" | PASS |
| U54 (A2 half; the CF1 function's own lock_timeout and 10D triggers are A0's) | suite: "U54 (A2 half): … no function-level lock_timeout", "U54 (A2 half): the caller's lock_timeout is unchanged (7s) after a refused lock call" | PASS (A2 half) |
| U58 | "U58: …" labels (refusal, detail, reasons, re-lock) | PASS |
| U61 lock probe | `concurrency/run_cf1_a2_lock_vs_lifecycle.sh` | PASS |
| U68 | suite "U68: post-A2 pin …" (the same value HL1 suite l.254 asserts) + `concurrency/run_cf1_a2_rollback_chain.sh` (order A2 then HL1, pins 6e41… / a10f…, refusals) | PASS |
| U69 | "U69: …" labels | PASS |
