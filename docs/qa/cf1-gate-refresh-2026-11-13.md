# CF1 gate refresh, 2026-11-13

Supersedes the stale BLOCKED entries for U7, U46 and U66 in `cf1-c-db-acceptance-2026-10-31c.md`. Nothing here was applied to a hosted database (the PROD probe was read-only) and no flag changed.

| Gate | Result | Evidence |
|---|---|---|
| U7 / U46 hosted permissions | **Confirmed as designed (residual documented)** | Read-only PROD catalog query (read-only transaction, guarded runner): `authenticated` and `anon` hold INSERT, UPDATE, DELETE and TRUNCATE on `event_competition_heats`, `_heat_entries`, `_heat_dances`, `_rounds`, `_entries`; RLS on for all; `_ballots` and `_result_publications` have no direct grants. TRUNCATE bypasses RLS and row triggers, but PostgREST cannot issue it, so there is no API path. Matches the design presumption (Supabase default grants). Optional hardening (revoke TRUNCATE / anon DML on these tables) would be PROD SQL and is not requested. |
| U66 F3 exit | **PASS** | `run_cf1_f3.sh` on release tip 820486c5 (includes JC1), disposable container: F3 apply and rollback/re-apply PASS; F3 suite 191; U66 pre-F3 56 and post-F3 57 (1 blocked: races in the .sh script, which ran: U66 concurrency PASS, F3 concurrency PASS); post-F3 F2 198, O1 95, A5 186, HL1 42, E2 211, SS1 36, A1 136, A0 199, A2 35, A3 117, A6 247, A7 81; gate line: 0 suites without PASS. |

Still open (unchanged): U18 and U28 (browser/PostgREST), U24 (owner decision), U73 and U77 (blocked in suite), Stripe-TEST suites (registration flag only).

## Addendum (2026-11-13, later): U73, U77, U18, U28, U24

| Gate | Result | Evidence |
|---|---|---|
| U73 | **PASS** | PR 480: both registered engines accept `reason: "excluded"` and behave exactly like `no_show` (2 vitest tests; results suite 263 passed / 1 skipped). |
| U77 | **Covered by U85 (not a defect)** | The suite check is a pointer to run the other fixture suites with the OD-21 guard; those ran on the composed chain (13-suite U85 pass; O1, SS1, E2, A0 re-run post-guard in the F3 chain run). |
| U18 | **PASS for supported paths; residual documented** | Local cf1c-qa, rolled-back block-mode fixture, as studio owner: start/advance-floor/complete heat, round lock, calculate, approve, publish are all refused or impossible (`COMPO1_NOT_FOUND`, `COMPO1_HEAT_STATUS_WRITER`, `COMP_HL1_HEAT_NOT_DANCED`, `COMP_RESULT_INVALID_TRANSITION`); a block-mode round can still be started (round becomes active, heat stays scheduled). PROD read-only: 0 danced/disqualified heat entries. No app or migration writer sets `danced`/`disqualified`. **Residual:** a studio manager can write `danced`/`disqualified` on an OPEN heat's entries through the table API (`competition_manage` RLS and default grants) and then lock a block-mode round. Already admitted in the design; insider only; not closed. |
| U28 | **FAIL as worded; design implication** | Real deadlock through local PostgREST 14.8 (HTTP and supabase-js): the database raises 40P01, but PostgREST retries the transaction itself and the client receives 200. A 40P01 is therefore not surfaced to the client; only an exceeded statement timeout surfaces (`57014`). The `/deadlock|40P01/` message mapping works (verified) but is effectively unreachable locally; the app-side single retry will rarely fire; retried RPCs must stay idempotent (apply is, on `p_request_id`). Confirm the hosted PostgREST version behaves the same before relying on this. |
| U24 | **BLOCKED pending owner decision** | In-transaction second floor-heat insert is admitted; accepted residual (no external path). |
