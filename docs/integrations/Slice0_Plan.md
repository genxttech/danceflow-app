# Integrations Slice 0 — Implementation Plan

Status: PLAN (docs only), 2026-11-23. No billing, pricing, plan gating or paid entitlement is introduced anywhere in this slice. No production, environment, flag or `vercel.json` change.

**Security-related fixes from this plan are pending.** Technical detail of the findings is held by the maintainers (text shortened 2026-11-26).

## 1. Pull request sequence

All changes: branch from main, unit tests included. Database changes are tested on a disposable local stack and need code-owner review; any hosted apply is a separate owner gate.

| PR | Area | Gate |
|---|---|---|
| S0-a | Google Calendar connection storage | database; code owner |
| S0-b / S0-e | Provider connect, disconnect and token-refresh behaviour | code owner |
| S0-c | Studio event time zones in calendar sync | code owner |
| S0-d | Calendar sync run budget and backoff | code owner |
| S0-f | Tests for both integrations, including database authorization suites | code owner |
| S0-g1 | Secret storage format with key rotation | code owner |
| S0-g2 | Integration audit events and hub status registry | database; code owner |

Order: S0-a, then S0-b/e; S0-c, S0-d and S0-g1 are independent; S0-f and S0-g2 follow the changes they cover.

## 2. Verification and review

Each pull request: typecheck, lint and tests for the touched areas. Database work runs on the disposable stack under the shared heavy-job lock. Independent read-only review for security and migration changes, with findings fixed in the same pull request. PASS is claimed only with captured evidence; anything not run is reported BLOCKED.

## 3. Decisions and holds (not changed by this slice)

- **D-S0-1 (owner/ops)**: whether and how the Wave automatic-posting job is scheduled. This slice does not edit `vercel.json`.
- **D-S0-2 (engineering)**: when secret writers switch to the new storage format; only after every running instance can read it.
- No hosted SQL, environment, flag or cron change is requested by this plan.
- Out of scope for this slice: items deferred to later integration phases.
