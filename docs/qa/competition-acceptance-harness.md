# Competition acceptance harness (QA-A) — reusable suite plan

Status: design. Stage 5 (Schedule & Heats) is implemented in this PR; stages 1–4 and 6 already have partial coverage in
the Q1 harness (PR #297); stages 7–10 are planned only and are **not** implemented here.

## 1. Principles

1. **UI-driven.** Every state change goes through the DanceFlow UI in a real browser. The service-role client only
   *reads* (database evidence after each user-visible step). Stripe TEST is used only to pay the hosted Checkout page
   the way `stripe trigger` does, never with live keys.
2. **Honest statuses.** Each scenario ends as PASS, FAIL, BLOCKED (names the dependency), NOT IMPLEMENTED (no UI —
   `test.fixme`) or NOT RUN. Skips and environment failures are never PASS. A SQL setup step is allowed only if labelled
   SETUP SHORTCUT in the report and never counted as a PASS.
3. **Isolated.** Local Supabase CLI stack (own project, own ports), synthetic accounts with random credentials, run-scoped
   ids, verified teardown that fails the run when anything is left behind. Hosted DEV/PROD and live providers are out of
   bounds; the config guards (`src/lib/e2e/guards.ts`) fail closed.
4. **Evidence is a deliverable.** Trace on, a screenshot per step, JSON + HTML reports, all stored outside the repo
   (`<scratchpad>/runs/<timestamp>/`); the repo carries only the human report and its JSON twin under `docs/qa/`.
5. **Reproducible system under test.** Runs name the exact SUT composition (branch + SHA per merged PR) and the database
   baseline (July schema-only baseline + migrations in version order, with every replay failure recorded).

## 2. Shared infrastructure (extends PR #297, no parallel framework)

| Piece | Location | Role |
|---|---|---|
| Base seed + teardown | `e2e/helpers/competitionFullEventFixture.ts` | studio with Stripe TEST account, owner, desk admin, other studio, 3 judges, 3 dancers; checked cleanup |
| Staff extension | `e2e/helpers/competitionScheduleHeats.ts` | adds `front_desk`, `instructor`, judge team roles; own cleanup wrapper |
| UI drivers | `competitionWizard.ts`, `competitionFullEvent.ts`, `competitionFullEventMoney.ts` | wizard, registration, Stripe TEST pay, refund and check-in drivers |
| Evidence readers | `readHeatEvidence`, `readOfficials`, `readScratchAudit`, `readOrderMoney`, … | read-only DB assertions |
| Step screenshots | `stepShots(testInfo)` | numbered full-page screenshot attached per step |
| Acceptance config | `e2e/playwright.acceptance.config.ts` | trace/screenshots on, 1 worker, no retries, JSON + HTML into `E2E_RUN_DIR` |
| Report builder | `e2e/tools/acceptance-report.mjs` | Playwright JSON → status table + machine-readable twin |

Conventions: test titles start with a stable scenario id (`SCN-<stage>.<n>`); `test.info().annotations` carry
`evidence` (JSON), `NOT IMPLEMENTED`, `BLOCKED`, `SETUP SHORTCUT`.

Machine rules: one Competition DB run at a time (coordinator-granted slot), two DB slots machine-wide, one `npm install`
at a time, 15 GB disk floor, nothing deleted by the harness outside its own run rows.

## 3. Lifecycle stages and the PRs they plug into

| # | Stage | Plugs into (PR / area) | Existing coverage | Status here |
|---|---|---|---|---|
| 1 | Setup and registration | 10C.5 wizard, K1/W4 setup fixes #322, CI-A early-bird | Q1 stages 1–2; `competition-setup-registration-isolation.spec.ts` | partial; setup/eligibility used by stage 5 spec |
| 2 | Fee and discount config | CI-A, R2 #292 fee rules | Q1 3 (seeded via service role — product gap: no fee/discount UI) | planned; must stay NOT IMPLEMENTED until a UI exists |
| 3 | Stripe TEST payments and refunds | R2 #292, SC1 #306, PAY-WH-1 | Q1 3a–3e | covered by Q1; re-run on qa-sut |
| 4 | Front-desk check-in | CI-B #295, desk balance #320, CB-2 #329 | Q1 4, 4b; role access in stage 5 spec | partial |
| 5 | Schedule and heats | 10D, K1 #322, E1 #327 (panels), O1 #328, SC1 #306 | **QA-A spec `competition-schedule-heats-acceptance.spec.ts`** | **implemented (this PR)** |
| 6 | Officials and ballot access | E1 #327, E2 #331 | panel build + judge view in stage 5 spec; paper ballots used only to lock heats | partial; judge-submitted ballots planned |
| 7 | Studio callback and ordinal-majority scoring | F1 #337, REG #338, K1 | none | planned, not implemented |
| 8 | Results calculation, corrections, approval, certification | F2 #339 | none | planned, not implemented |
| 9 | Publication and entrant visibility | F3 (not built) | none | placeholder: all scenarios NOT IMPLEMENTED |
| 10 | Closeout and reconciliation | W5/C1 closeout reads #321, W6 tracker #318, R2 ledger | Q1 stage 10 fixme | planned, not implemented |

Planned scenarios for the not-yet-implemented stages (each a `test.fixme` until its PR is in the SUT):

- **7:** judges submit callback ballots from their own accounts; a ballot violating exactly-T is refused; ordinal-majority
  final with tie; callback target `T` must be below entries (K1 D-CT-5); absent judge recorded, round locks; studio
  engine selection (F1) visible in setup.
- **8:** calculate → draft results; scorer correction creates a new ballot version with a reason; second staff member
  approves (four-eyes); certification freezes ballots and heats; results invisible to dancers/public before approval.
- **9 (F3 placeholder):** publish makes only the dancer's own entries and published placements visible; public results
  page shows the published version; another studio sees nothing; correction republishes as v2 with audit.
- **10:** exports downloaded and checksummed; settlement = entry revenue − refunds reconciled to Stripe; program marked
  complete; event deletion blocked while evidence exists.

## 4. Cross-cutting scenario classes (apply to every stage)

| Class | What each stage suite must include | Example already present |
|---|---|---|
| Negative | invalid input refused with a friendly message, nothing written | ineligible entry excluded; empty scratch reason refused |
| Permission | owner/admin/front_desk/instructor/judge/other studio/anon matrix; UI **and** DB (anon-key client) | SCN-8.1, SCN-8.2 |
| Concurrency | two sessions, same action at once → one winner, first stamp kept | Q1 4b (check-in); to add: two desks publish/edit the schedule |
| Replay | same request id twice → one effect | Q1 3c (refund idempotency); to add for official/panel actions |
| Failure recovery | webhook delayed/out-of-order, page reload mid-flow, stale form after another session's change | reload persistence in SCN-3.4/3.5/7.1; webhook-order case to add |
| Isolation | second studio never sees or changes anything | SCN-8.1/8.2 |
| Integrity | invariant queries after the run | SCN-9 |

## 5. Run protocol

1. Coordinator grants the Competition DB slot. Start `supabase` project `qa-acc` (ports 575xx); build schema from the
   July baseline then migrations in version order, recording each failure.
2. Build the SUT on a local, unpushed `qa-sut` branch; record merge order, SHAs and conflicts.
3. Start the app against the stack (Turbopack, `NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true`, Stripe TEST keys,
   `stripe listen --forward-connect-to …/api/payments/webhook`).
4. `E2E_RUN_DIR=<scratchpad>/runs/<ts> npx playwright test -c e2e/playwright.acceptance.config.ts`, twice back to back.
5. `node e2e/tools/acceptance-report.mjs <run>/results.json --out <stem>`; commit only the report + JSON twin.
6. `supabase stop` (backup kept); delete nothing.
7. Independent review of the run evidence by a separate session before the result is cited as acceptance.

## 6. How a new PR plugs in

1. Add the PR branch to the SUT merge list (record SHA).
2. Add scenarios under the stage's spec using the shared drivers; anything lacking UI is `test.fixme` + label.
3. Add evidence readers for new tables to the helper module (read-only).
4. Extend fixture cleanup for new tables that block deletion (append-only tables need `E2E_LOCAL_DB_CONTAINER`).
5. Update the stage table above and the report template.
