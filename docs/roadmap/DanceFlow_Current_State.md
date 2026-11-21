# DanceFlow Current State

Short, operational snapshot. Update this file whenever main, the PROD deployment, pending migrations, release holds or the active slice change.

**Authority split (v2.22):** this file is authoritative only for **operational facts** — current main, current production deployment and rollback target, pending PROD migrations, which holds are open, and the next gate. The [Master Roadmap](DanceFlow_Master_Roadmap.md) is authoritative for **everything else** — scope, status of phases and slices, decisions, priorities, gate definitions and release history. This file does not restate those; it links to them. Release histories formerly kept here are archived, verbatim and non-authoritative, in [`archive/DanceFlow_Current_State_v2.21.md`](archive/DanceFlow_Current_State_v2.21.md).

**Last updated:** 2026-10-24 (PRICING-P1 Founder pricing release: production deployment and rollback rows corrected; other rows were not re-verified in this update, see the note below the table).

> **Roadmap-affecting phase closeout requires canonical roadmap/current-state update before the phase is considered closed.**

## Release state

| | |
|---|---|
| **CURRENT MAIN** | `24a37a15bb0daf6f2b2de48745e84bd862ad29d1` (PAY-WH-1B, PR #216) |
| **CURRENT PROD DEPLOYMENT** | `dpl_HEvyvNbHzAiMBGT3yPVzeiGJk6Sj` (PRICING-P1; source branch `release/pricing-p1` `4bc938c6` = deployed base `release/web-2a-website` `8fd075f5` + PR #302 + PR #319; **not an ancestor of `main`**; promoted 2026-10-24; `www.idanceflow.com` and apex) |
| **APPLICATION ROLLBACK** | PRICING-P1: promote `dpl_87xgSBVM2MqXi9KeyJHFeH9rdsoh` (`8fd075f5`, website-only release of 2026-10-23), then restore the Production env (delete the four new Production-only Founder entries, re-tick Production on the three preserved Founder entries; see the PRICING-P1 runbook). No SQL in PRICING-P1. Older rollback guidance (never below 9C; never to the Phase 8C deployment) still applies |
| **SUPABASE DEV / PROD** | `epdrtzcydvnoidwrepqz` / `hvsujyfbftfffxpfmlpb`; primary repo linked to DEV; PROD only through a fresh scratch workdir with authorization |
| **PENDING PROD MIGRATIONS** | None. Latest applied: PAY-WH-1 M1–M5 (`20261116090000`–`20261116094000`, 2026-10-13 10:30–10:31Z) |
| **PUBLIC COMPETITION REGISTRATION** | OFF |
| **PACKAGE REFUND HOLD** | Released / `false` |
| **SMS** | No `studio_sms_registrations` row in PROD; every studio fail-closed; global status unchanged |

**Rows not updated 2026-10-24 (stale; need an owner-directed reconciliation):** CURRENT MAIN, PENDING PROD MIGRATIONS, the holds list and Next gate still describe 2026-10-13. Production now serves a release branch that diverged from `main` (85 commits behind at the time), so "production = main" no longer holds; never promote a `main` build without reconciling. **Pricing:** Founder studio pricing $59 / $99 / $159 is live; regular pricing ($89 / $149 / $249) is inactive and needs separate approval (Master Roadmap, Phase 22).

Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure. Authenticated behavior was instead validated in DEV/local before release.

## Open holds (definitions and clearing criteria: Master Roadmap → [Release holds and gates](DanceFlow_Master_Roadmap.md#release-holds-and-gates-v222))

- CI-B duplicate/concurrent check-in — holds public Competition registration.
- CI-D refund attribution — holds public Competition registration.
- 10C.1 launch gates — hold public Competition registration.
- NDCA Multi-Dance registration hold.
- Owner Schedule & Heats walkthrough — holds 10E.
- Twilio Q1–Q5 — hold TW-4 slices that create Twilio resources.

## Next gate

Roadmap v2.22 (PR #217) is merged. It is documentation-only and the production deployment above is unchanged.

**Priority 1, per the provisionally accepted [near-term priority order](DanceFlow_Master_Roadmap.md#near-term-priority-order-v222): Marketing M-0 compliance remediation (PR #218).**
- **Status:** OPEN — not merged, not released, live campaign behavior unchanged.
- **Next step:** completion of its review and QA, then separate owner authorization for merge and for any SQL or promotion under its own release gates.

**Parallel, documentation only:** roadmap v2.23, the Knowledgebase / Help Center track (PR #219). It awaits owner merge authorization. No KB implementation is authorized, and open questions D1–D7 remain undecided.

**Then:** CI-B → CI-D, per the priority order.
