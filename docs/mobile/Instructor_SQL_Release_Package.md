# Instructor attendance SQL: package for the first instructor-use release (owner decision P5, 2026-11-26)

**Prepared, not applied.** Nothing here authorizes a hosted apply: each file needs the owner's approval by hash at that release. Analysis: `Instructor_RPC_Gap_Impact.md`.

## State checked read-only on PRODUCTION, 2026-11-26

`proposals/p5_instructor_preflight.sql` via `sb.sh prod-read`: none of the three functions exists; **0** active `instructor`-role rows; the tightened `clients` policy `studio staff manage clients` is present. So no current user is affected, and the first instructor would hit errors without this.

## Files, in apply order (SHA-256 of the file content at `main`, LF line endings)

| # | Migration | SHA-256 | Rollback SHA-256 | Gives the instructor |
| --- | --- | --- | --- | --- |
| 1 | `20260905160000_fc1b5d_teaching_client_access_rpc.sql` | `ef7ce593a4c5f4eae2835dd62fff4124a464a4a1900bb2cf96926f90c1e733f5` | `63a5e7ba3aea1337188511cc6b652523819ee05ab8e724e98c30f4d0cb8fe180` | their taught clients (dashboard, schedule, staff API) |
| 2 | `20260905160100_fc1b5d_booking_client_search_rpc.sql` | `5187770af39932b80115ea27b74329d7b725fd2aa8ad4a8b722ca82834bd554e` | `2fab9db225313fe9e8e2b7570385ecbca6eff41c6415256bab037ae89c358a76` | booking client search |
| 3 | `20270214120000_instructor_class_roster_names_rpc.sql` | `210ca4488c1e70125cccfada22527b6dd31277bef1b86fd312c91deb5658601c` | `a38fb809a475b0a59c220d73ccec7dd02c56bebd34bcc1b65a61f21056c179f2` | names on their own class roster |

Rollback files are under `src/lib/supabase/migrations/rollback/` with the same names plus `_rollback`. All three are additive (one function and its grants each; no table or policy change).

## Procedure at the release (each step an owner gate)

1. Preflight (read-only): expect `exists = false` for all three and `phase_b_clients_policy_present = true`. Re-compute the hashes from the release commit.
2. `sb.sh prod-apply <file> <sha256>` for 1, then 2, then 3, each approved in chat.
3. Postflight (the same read-only file): `exists`, `security_definer` and `authenticated_can_execute` true; `anon_can_execute` false.
4. Only then create the first `instructor` role (web invite or Business).
5. Rollback: the rollback files in reverse order; safe while no instructor exists.

## Before inviting instructors, know these limits of instructor attendance (verified on the disposable database)

- An instructor can mark their own one-to-one lessons attended or no-show, and the package deduction works under their session.
- An instructor **cannot write or read client activity notes** (their view of client rows is hidden), so an instructor's no-show leaves no note: a charge that failed cannot be retried by the instructor, and nobody can charge it later through the app (owner decision P8: unknown is never chargeable). The append-only decision record design removes this.
- Class roster enrollment by an instructor works only for a dancer with exactly one eligible package or membership.
