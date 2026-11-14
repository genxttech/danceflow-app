# CF1 U18 / U18-S release package (prepared 2026-11-14)

Status: PREPARED. Nothing in this package has been applied to DEV or PROD. Hosted SQL needs separate owner authorization (PROD) and is held for DEV by the 2026-11-14 instruction.
Scope: migrations 20270215093000 (P1, PR 483, merge baa01ce4) and 20270215094000 (P2, PR 487, merge c8b9a979), both merged on `release/competition-cf1-app-candidate`. SQL-only; no app change; independent of the app deploy order. Both are mandatory before PUBLIC Competition activation, not for the current dark state.

## Pins (sha256)
| File | sha256 |
|---|---|
| 20270215093000_competition_u18_heat_entry_status_guard.sql | 90a46801c052c92da76390e6c0c0d9c1cb45388e06dc0c9ed30a5e89e8d50776 |
| 20270215094000_competition_u18s_heat_entry_scratch_audit.sql | 5de8003f672b7dabf94ad653e58a60e96b5c6c76ddc39edf0d19c546517fc8ae |
| rollback/..._u18_..._rollback.sql | 90bcaa82584766525c827f461c9471bfaf6881eb34ce130e8f33a22e1b40410c |
| rollback/..._u18s_..._rollback.sql | 7df9b234fb2e401c9cc9c56d9e0d0e9268d583dc3055023188035f9ad93b5024 |

Apply order: P1 then P2 (P2 does not depend on P1's trigger, but P1 revokes client TRIGGER privilege, which P2 relies on for tamper resistance). Each migration is one transaction (create function, revoke, create trigger, enable always). No data changes. Run as the migration owner (postgres or supabase_admin), never a client role.

## Preflight and postflight (catalog-only, read-only via `sb.sh dev-read` / `prod-read`)
- `preflight.sql` -> `ok` must be true before applying. It pins the reviewed `change_competition_entry_lifecycle` (md5 3b4622d8...) and `audit_competition_entry_change` (md5 31caa224...) definitions, table owner, absence of the new objects, that every SECURITY DEFINER function touching heat entries is owned by postgres/supabase_admin, and that the five existing heat-entry guards are present.
- `postflight.sql` -> `ok` must be true after both migrations: both triggers AFTER/row/enabled ALWAYS, functions SECURITY INVOKER and not client-executable, TRIGGER privilege revoked from anon/authenticated/service_role, RPC and audit trigger unchanged, existing guards intact. Records the two function md5s.
- Validated locally on a disposable chain: preflight `ok` true before, false after (negative control); postflight `ok` true after.

Read-only results 2026-11-14 04:54Z (before any apply): **PROD ok = true, DEV ok = true**; both have 0 heat entries (0 danced / disqualified / scratched), no sessions locking the table, client TRIGGER privilege currently granted (expected), identical pins on PROD and DEV.

## Release sequence (needs owner authorization, one package)
1. DEV first (routine class, currently held): `sb.sh dev-read preflight.sql` -> `dev-apply` P1 with sha, P2 with sha -> `dev-read postflight.sql` -> run the two suites locally against the same migration text (already PASS: U18 21/21, U18-S 17/17) -> DEV observation.
2. PROD (owner gate): `prod-read preflight.sql` (ok true, 0 open locks) -> `prod-apply` P1, P2 with the pinned sha256 -> `prod-read postflight.sql` (ok true, md5s recorded) -> pages 200 and dark probes unchanged.
3. Cost/risk: AFTER row trigger on a table that is empty on PROD today; no table rewrite; brief ACCESS EXCLUSIVE-class lock for CREATE TRIGGER / REVOKE (empty table, sub-second). No app compatibility concern: the app never writes heat-entry status (verified by grep; only SECURITY DEFINER or lifecycle-RPC paths do).
4. Rollback: apply the two rollback files (P2 first, then P1: P1's rollback re-grants TRIGGER, drops trigger and function). No data to repair.

## Known residuals (owner-accepted 2026-11-13)
Draft-schedule heat-entry DELETE/re-INSERT and re-pointing (published schedules, locked heats and A6-withdrawn pairs are protected); direct `event_competition_entries.status` writes are audited with an optional reason; COPY/MERGE/pg_dump with TRIGGER revoked unverified in tooling; TRUNCATE remains grantable (not reachable via PostgREST).
