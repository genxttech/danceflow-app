# TW-4F zero-cost acceptance: Z1 and Z2 results (2026-11-28)

**Everything here is SIMULATED.** Fake Twilio providers, a stand-in Stripe client, a throwaway local database, synthetic data. No Twilio or Stripe call, no SMS, no money, no hosted database, no deploy. A pass here says the app's own code can walk the step; it says nothing about real provider behaviour.

## What was tested
| Item | Value |
| --- | --- |
| Run | pass 10, 2026-11-28 09:50Z to 10:03Z |
| Release line | `32fd3da55` (includes PR 935 and PR 938) |
| Merged on top, in order | PR 934 `68b1077a0`, PR 949 `a675a89a1`, PR 951 `b31cd3343`, PR 954 `edbb96bca` (all unmerged drafts at test time) |
| Composition | built locally, never pushed (`fffe04bd2`, run commit `9f5e0dbb2`) |
| Test file | `src/lib/sms/__tests__/localStack.z1lifecycle.test.ts`, blob `ab729194b9a3` |
| Database | image `df-isoqa/base:20261205090000` plus 42 migrations above it, plus `20270219090000` |

### Limits of the database
The baseline image predates the Competition prerequisites, so 44 forward migrations were removed from the composition (rollback files kept): the Competition and Organizer Suite ones (`202701*`, `20270203090000`, `20270203100000`, `20270205100000`, `20270211090000`, `202702150*`) and the non-SMS ones the release line recorded since `6d45633ef` (`20270213080000`, `20270213090000`, `20270221090000`, `2027022209*`, `20270223150000`). This is not the production schema.

### Adjustments made to the throwaway environment
- API statement timeout raised to 90 s. In pass 5 a provider status check was lost to the normal timeout inside a timezone lookup on this 2-CPU host.
- Switches a deployment would set were set in the test process: usage billing, inbound recording, platform SMS status, monthly limits, recurring authorization, credit purchases, test credit, the cron switches, and invented secrets.

## Z1: one chained run, 30 steps
Pass 10: **30 PASS, 0 FAIL, 0 BLOCKED**, 0 requests to any non-local host.

| Lifecycle step | Result | How it was driven, and what was refused |
| --- | --- | --- |
| Pilot access | PASS | Platform action; owner refused |
| Owner registration and submit | PASS | Owner action, one-click submit; other owner and duplicate refused |
| Legal business | PASS | Platform action; owner, unticked verification, duplicate refused; budget, fee and subaccount refused before it |
| Additional location link | PASS | Owner attestation and platform decision; unrelated owner, duplicate request, owner approval, second decision, same business registered twice refused |
| Prices | PASS (fixture) | Dual-control database functions; **price screens not driven** |
| Setup budget, pilot limit | PASS | $130 each; pilot fee refused before either; over $150, missing evidence, owner, mismatched confirmation refused; resubmission replays |
| Per-fee approvals (brand, vetting, first month, number) | PASS | Platform action (first month needs PR 949); wrong path, wrong amount refused; repeat replays |
| Subaccount | PASS | Platform action; wrong phrase, owner refused; provider asked once |
| Profile, trust product, brand | PASS | Runner action; no window and no typed word refused; one brand |
| Messaging Service, campaign | PASS | One of each; campaign refused without confirmation and without approvals |
| Number | PASS | Offer, owner approval, fee approval, purchase, attach; front desk, second approval, unapproved number refused; bought once |
| Sender check | PASS | Activation actions; route pinned through the PR 951 action. The local activation fakes had to be told what provisioning created |
| Recurring fees | PASS | Pilot period covers (next month) through the platform action; current month refused as already covered; lifecycle scan ran; owner standing authorization refused for the pilot |
| Activation | PASS | Mark ready and activate; billed texting switched on through the PR 951 action; owner refused |
| Test credit grant | PASS | **Server module only (no screen)**; refused without switch and budget and over budget; repeat replays |
| Monthly limit | PASS | Billing route; front desk refused |
| Send | PASS | Send route; unconsented refused; resend replayed; one provider send |
| Status callbacks | PASS | Locally signed with the fake subaccount token; forged, wrong secret, unknown account, replay, late `sent` change nothing |
| Inbound | PASS | Signed; unsigned refused; charged once; replay not billed twice |
| STOP / HELP / START | PASS | STOP blocks sending, START restores it. Twilio Advanced Opt-Out itself not covered |
| Usage billing and reconciliation | PASS | Cron route: two sends settled (6 c), the uncertain send held; ledger verifies. Send times were shifted two hours and the fake evidence matched to them |
| Low balance | PASS | Owner overview reports low balance; sending refused for credit |
| Test credit exhaustion | PARTIAL | Sending stopped when available credit fell below the price (22 c unused, 21 c held for unsettled sends). **The `exhausted` state was not reached** |
| Credit purchase (stand-in Stripe) | PASS | Checkout route and signed webhook (PR 954); front desk, bad signature refused; credited once |
| Dispute hold | PASS | Webhook holds the account and sending stops; after the win the account stays held until released. **Release and both switches by database function (no screen).** The refusal text seen was the credit one (the balance was also short), so a hold-only refusal is not shown |
| Emergency stop (location suspend) | PASS | Platform action; next send refused |

### NOT COVERED
- Suspension controls of PR 875 (unmerged, not in the composition).
- Real Twilio payloads, signatures, brand and campaign review, carrier delivery, Advanced Opt-Out, a real invoice.
- Stripe sandbox purchase, refund and dispute (plan step Z3).
- Recurring-fee cancellation and provider release; non-pilot recurring credit charges.
- Price publication screens; the test credit `exhausted` state.

## Z2: signed-in browser pass
Production build of the same composition on the database pass 10 left behind, installed Microsoft Edge (nothing downloaded), build type check skipped in the throwaway copy (out of memory; CI type-checks).

| Set | Result |
| --- | --- |
| Screen tour (`sms-z1-screens.spec.ts`): owner (both locations), front desk, Platform Admin | PASS 3/3, no server error, no console error |
| `sms-onboarding-wizard.spec.ts` | PASS 8/8 |
| `sms-platform-runner.spec.ts` (10) | BLOCKED: the shared helper submitted while the draft save was still running (rerun below) |
| `sms-subaccount-panel.spec.ts` (9) | BLOCKED: same cause (rerun below) |
| `sms-subaccount-panel-fees.spec.ts` (5) | BLOCKED on the pass-10 database (one pilot per database); rerun below |
| `sms-owner-number-selection.spec.ts` | NOT COVERED: placeholder, its tests are skipped |
| WebAuthn price script | 27 checks passed, then the script crashed at the revoke step; the rest is BLOCKED |

The browser server is a separate process, so its fake provider starts empty: the tour reads screens and presses no provider action.

### Rerun of the blocked browser sets
Pending.

## Defects and gaps found
| # | Finding | Weight | State |
| --- | --- | --- | --- |
| 1 | The Platform Admin fee action could not record the campaign's monthly fee approval, which the database requires for a pilot campaign, so the pilot could not submit its campaign in the app (reproduced on release + PR 934 + PR 935) | Pilot blocker | Passes with PR 949; open until it merges |
| 2 | No send works until `SMS_PLATFORM_STATUS` or `DANCEFLOW_SMS_STATUS` is `approved`, even with every checklist item green | Activation setting | Already added to the settings sheet by the coordinator |
| 3 | Inbound texts are accepted but not charged unless `SMS_INBOUND_RECORDING=on`; the name is in neither the 11-27 settings sheet nor the release approvals document | Activation setting | Open |
| 4 | No screen for: test credit switch, budget and grant; dispute record and hold switches; **releasing a dispute hold** (a won dispute leaves texting held until a database call) | Operations gap | Open (test credit has no screen by design) |
| 5 | Platform Admin SMS page showed 0 opted-in clients, 0 STOP/START/HELP messages and "No SMS activity yet" after a run that recorded consent, sent texts and processed STOP, START and HELP. The page reads the consent and message tables as the signed-in administrator, and the row policies found in the repository admit studio and organizer members only | Likely defect | Seen locally; **not checked on production** |
| 6 | A pilot cover for an already covered period is refused with a combined text that starts "the evidence digest must be 64 lowercase hex characters" (`recurringFeeActions.ts`, code TW043) | Minor | Open |
| 7 | One reconciliation run that settles none of its due sends (all to review) pauses billed texting for every business until a later run proves evidence, up to 30 minutes (seen in pass 8 with mismatched fake evidence). Designed behaviour; at pilot volume one bad send can pause all | Observation | For the coordinator |
| 8 | Timezone validation scans `pg_timezone_names` inside several billing functions (0.3 to 0.4 s per scan here, seconds under load) | Observation | Not measured on production |
| 9 | Ticking the four statements while "Save draft" is still running loses the ticks; Submit then answers that every statement must be confirmed | Minor | Seen in two browser specs on a slow host |
| 10 | Platform Admin card of the registered, then suspended, location still says "Next: Run the next registration steps in the runner below" | Minor | Observed text |
| 11 | Local fake mode gives the two activation reads their own fakes that never see what provisioning created, so activation cannot be completed by hand on a local stack | QA tooling | Open |
| 12 | Stale browser tooling: the fee-panel spec publishes prices with `tw4_price_set`, which now refuses every call; the WebAuthn script crashes on the current schema; the subaccount helper did not wait for the draft save (fixed here) | QA tooling | Helper fixed in this branch |

## How the result was reached
Passes 1 to 9 stopped on faults in the new test (sign-in stand-in, expected states, direct consent write, missing switches, shifted evidence times, a step time limit) and on finding 1. Each was corrected and the whole chain rerun from an empty database; only pass 10 is quoted above.

## Rerun
Build the composition, then:

```bash
node scripts/qa/tw4f/run-chain.mjs suites --base <composition> --tests-ref <composition> --marker --env ISO_QA_MARKER=1 \
  --auth --suite localStack.z1lifecycle.test.ts [--hold]
```

Z2 needs `--hold`: build and start the app against the URL and secret in the run's `stack.json` with `TW4_ISV_FAKE=on`, run the specs with `E2E_*` pointed at it (the tour also needs `Z2_OUT` and `Z2_DB_CONTAINER`), then remove the containers named in `stack.json` (not `down`, which removes every run's). The local wrapper used here, with its evidence, is in `C:\dfr\qa-evidence\tw4f-z1\`.
