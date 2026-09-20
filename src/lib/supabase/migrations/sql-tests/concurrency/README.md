# Slice 7 concurrency tooling (DEV only)

Real-concurrency verification for Landmark 1A Slice 7: `slice7_race_harness.mjs`
drives two genuinely concurrent database sessions through
`slice7_race_helper.sql` and checks that a revocation and a competing writer
always resolve to one of the two allowed outcomes.

## Rules

- **DEV only.** The harness reads `.env.local` and refuses to run unless the
  linked project and the API URL both resolve to the DEV project
  `epdrtzcydvnoidwrepqz`. The PROD project `hvsujyfbftfffxpfmlpb` must never be
  used by this harness.
- **`slice7_race_helper.sql` is not a migration.** Never copy it into the
  migrations directory and never apply it to PROD. It defines a
  `SECURITY DEFINER` test function granted to `service_role`. It is created by
  `setup` for the race run only and dropped by `cleanup`.
- **`SLICE7_BAND`** selects a fresh block of synthetic instructor/user ids
  (band `b` uses indexes `b*100+1` to `b*100+90`) so a new run never collides
  with fixtures left by an earlier one. Use a new band for every run.
- **Residue is expected.** Instructors revoked during a run have immutable
  audit rows, so they cannot be deleted; `cleanup` deactivates them and leaves
  them. Never remove this residue by weakening audit immutability, FK
  protections, RLS, or triggers. Synthetic data is identifiable by the
  `t-landmark1a-s7%` studio slug and `t-landmark1a-s7-%` email prefixes.

## Usage

`node slice7_race_harness.mjs setup`, then `run`, then `cleanup`, with
`SLICE7_BAND` set to an unused number.

## Slice 8 tooling (same rules)

`slice8_race_harness.mjs` + `slice8_race_helper.sql` verify the Slice 8 seat
authority under real concurrency: a downgrade racing a grant / reactivation /
hybrid promotion / direct instructor write, owner demotion vs grant, two seat
transitions at the limit, and cross-studio independence. All the rules above
apply unchanged: DEV only (the harness refuses any other project),
`slice8_race_helper.sql` is never a migration and is dropped by `cleanup`, and
the residue it leaves (instructors kept alive by immutable audit rows) must
never be removed by weakening audit protections. Use `SLICE8_BAND` (a new
number per run) instead of `SLICE7_BAND`. Synthetic data is identifiable by the
`t-s8-race-%` studio slug and `t-s8-race-%` email prefixes.

## Slice 9 tooling (same rules)

`slice9_race_harness.mjs` + `slice9_race_helper.sql` verify the capability-authority
boundary under real concurrency: hybrid promotion vs a renter edit, payroll
deactivation, a classification edit, a competing promotion, and a grant at the
seat limit; the revoke RPC vs a tenant direct capability write (which the
capability guard must reject either way); and one lock-order probe (P7). All the
rules above apply unchanged: DEV only (the harness refuses any other project),
`slice9_race_helper.sql` is never a migration and is dropped by `cleanup`, and
the residue it leaves (instructors kept alive by immutable audit rows) must never
be removed by weakening audit protections. Use `SLICE9_BAND` (a new number per
run). Synthetic data is identifiable by the `t-s9-race-%` studio slug and
`t-s9-race-%` email prefixes. A definer function cannot switch roles, so tenant-
role writes run through the SECURITY INVOKER `_s9_race_tenant_op`, called by
service_role.

P7 documents the known Slice 8 same-row lock-order residual: the canonical RPC
order (seat lock, then instructor row) against a tenant direct `active` update of
a capable row (row lock, then the Slice 8 seat trigger's seat lock). PostgreSQL
aborts exactly one side with 40P01 (`deadlock detected`); nothing partial is
written. After Slice 9 this is the only tenant-reachable path to it: capability,
account and studio changes on capable rows are rejected by the capability guard
before the seat trigger, and non-capable rows never take the seat lock.
