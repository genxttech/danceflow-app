# CF1 gate refresh, 2026-11-13

Supersedes the stale BLOCKED entries for U7, U46 and U66 in `cf1-c-db-acceptance-2026-10-31c.md`. Nothing here was applied to a hosted database (the PROD probe was read-only) and no flag changed.

| Gate | Result | Evidence |
|---|---|---|
| U7 / U46 hosted permissions | **Confirmed as designed (residual documented)** | Read-only PROD catalog query (read-only transaction, guarded runner): `authenticated` and `anon` hold INSERT, UPDATE, DELETE and TRUNCATE on `event_competition_heats`, `_heat_entries`, `_heat_dances`, `_rounds`, `_entries`; RLS on for all; `_ballots` and `_result_publications` have no direct grants. TRUNCATE bypasses RLS and row triggers, but PostgREST cannot issue it, so there is no API path. Matches the design presumption (Supabase default grants). Optional hardening (revoke TRUNCATE / anon DML on these tables) would be PROD SQL and is not requested. |
| U66 F3 exit | **PASS** | `run_cf1_f3.sh` on release tip 820486c5 (includes JC1), disposable container: F3 apply and rollback/re-apply PASS; F3 suite 191; U66 pre-F3 56 and post-F3 57 (1 blocked: races in the .sh script, which ran: U66 concurrency PASS, F3 concurrency PASS); post-F3 F2 198, O1 95, A5 186, HL1 42, E2 211, SS1 36, A1 136, A0 199, A2 35, A3 117, A6 247, A7 81; gate line: 0 suites without PASS. |

Still open (unchanged): U18 and U28 (browser/PostgREST), U24 (owner decision), U73 and U77 (blocked in suite), Stripe-TEST suites (registration flag only).
