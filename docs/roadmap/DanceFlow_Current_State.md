# DanceFlow Current State

Short, operational snapshot. Update this file whenever main, the PROD deployment, pending migrations, release holds or the active slice change.

**Authority split (v2.22):** this file is authoritative only for **operational facts** — current main, current production deployment and rollback target, pending PROD migrations, which holds are open, and the next gate. The [Master Roadmap](DanceFlow_Master_Roadmap.md) is authoritative for **everything else** — scope, status of phases and slices, decisions, priorities, gate definitions and release history. This file does not restate those; it links to them. Release histories formerly kept here are archived, verbatim and non-authoritative, in [`archive/DanceFlow_Current_State_v2.21.md`](archive/DanceFlow_Current_State_v2.21.md).

**Last updated:** 2026-10-13 (roadmap v2.23; Next gate refreshed. Release state unchanged).

> **Roadmap-affecting phase closeout requires canonical roadmap/current-state update before the phase is considered closed.**

## Release state

| | |
|---|---|
| **CURRENT MAIN** | `24a37a15bb0daf6f2b2de48745e84bd862ad29d1` (PAY-WH-1B, PR #216) |
| **CURRENT PROD DEPLOYMENT** | `dpl_5BjsJaSPqn1qA3D4fCDijZbRNqqK` (source `24a37a15`; promoted 2026-10-13 11:58Z; `www.idanceflow.com` and apex) |
| **APPLICATION ROLLBACK** | App-only to `dpl_9GRhgfVhT6eDHyQooiqjXnEvpbj3` (PAY-WH-1, `21ec7b6d`); PAY-WH-1 SQL stays in place. Deeper rollbacks need review (never below 9C; never to the Phase 8C deployment) |
| **SUPABASE DEV / PROD** | `epdrtzcydvnoidwrepqz` / `hvsujyfbftfffxpfmlpb`; primary repo linked to DEV; PROD only through a fresh scratch workdir with authorization |
| **PENDING PROD MIGRATIONS** | None. Latest applied: PAY-WH-1 M1–M5 (`20261116090000`–`20261116094000`, 2026-10-13 10:30–10:31Z) |
| **PUBLIC COMPETITION REGISTRATION** | OFF |
| **PACKAGE REFUND HOLD** | Released / `false` |
| **SMS** | No `studio_sms_registrations` row in PROD; every studio fail-closed; global status unchanged |

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
