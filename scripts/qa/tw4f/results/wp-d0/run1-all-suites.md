### TW-4F Q1 run: wpd0-suites
- base origin/main @ 23ffbc43; tests origin/main @ 23ffbc43; image df-isoqa/base:20261119092100 (14e2a42e657c); order numeric
- applied: 20261120090000 20261121090000 20261122090000 20261123090000 20261124090000 20261125090000 20261126090000 20261127090000 20261128090000 20261129090000 20261130090000 20261201090000 20261202090000 20261202140000 20261202150000 20261203090000 20261204090000 20261205090000 20261206090000 20261207090000 20261208090000 20261209090000 20261210090000 20261211090000 20261212090000 20261213090000 20261214090000 20261215090000 20261216090000 20261217090000 20261218090000 20261219090000 20261221090000 20261222090000 20261223090000 20261224090000 20261225090000 20261226090000 20261227090000 20261228090000 20261229090000 20261230090000 20261231090000 20261231100000 (* = extra)

**Suites (each on a fresh clone of the applied chain)**: BLOCKED in 9845s
| Suite | Result | Tests | Seconds | Host start -> end (CPU %/free GB/containers) | Note |
|---|---|---|---|---|---|
| src/app/platform/sms/__tests__/localStack.aal2.test.ts | PASS | 4/4 | 131 | 85%/1.9/26 -> 73%/2.7/29 SATURATED |  |
| billing/__tests__/localStack.tw4f3bpay.test.ts | PASS | 18/18 | 269 | 79%/2.6/26 -> 87%/2.5/29 SATURATED |  |
| billing/__tests__/localStack.tw4f3bui.test.ts | PASS | 7/7 | 79 | 83%/2.7/26 -> 81%/2.3/29 |  |
| billing/__tests__/localStack.tw4monthly.test.ts | PASS | 28/28 | 795 | 88%/2.2/26 -> 83%/2.1/29 SATURATED |  |
| billing/__tests__/localStack.tw4payhardening.test.ts | KNOWN | 12/15 (+2 skipped) | 447 | 74%/2.1/26 -> 81%/1.6/29 SATURATED | property test pinned at 90 s times out under CPU saturation; passes on an idle host (PR #266 notes). Cascades to later assertions in the file; the match requires every failing test to be listed. failing: prepaid credit integrity: hold enforcement, refund/dispute accounting, replays (real schema, rea |
| billing/__tests__/localStack.tw4recexec.test.ts | KNOWN | 19/20 | 413 | 72%/1.7/26 -> 77%/1.7/29 SATURATED | wall-clock assertion (expected N > 900 ms) fails when the host CPU is saturated; passes 20/20 on an idle host (PR #266 notes). Observed 180 ms here under 100% CPU. failing: recurring-charge execution: spending cap, pilot business, scheduler lease and kill switch, sender suspension (real schema, real |
| billing/__tests__/localStack.tw4recurring.test.ts | PASS | 30/30 | 603 | 80%/1.5/26 -> 49%/1.7/29 SATURATED |  |
| sms/__tests__/localStack.f3recon.test.ts | FAIL | 9/10 | 133 | 79%/1.7/26 -> 54%/6.6/29 SATURATED | [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression] failing: TW-4F F3 usage-reconciler readiness gate (real schema) F3-09 (d) rollback: refused while billed texting is on or another function calls the helper; otherwise restores the |
| sms/__tests__/localStack.tw4inbound.test.ts | PASS | 28/28 | 207 | 71%/6.6/26 -> 38%/5.9/29 |  |
| sms/__tests__/localStack.tw4recon.test.ts | PASS | 37/37 | 309 | 52%/6.1/26 -> 51%/6.3/29 |  |
| sms/__tests__/localStack.tw4rv.test.ts | PASS | 28/28 | 263 | 61%/6.2/26 -> 58%/6.3/29 |  |
| sms/__tests__/localStack.tw4sender.test.ts | PASS | 18/18 | 174 | 86%/6.4/26 -> 76%/6.5/28 SATURATED |  |
| sms/__tests__/localStack.tw4usage.test.ts | PASS | 26/26 | 263 | 78%/6.5/25 -> 17%/6.6/28 |  |
| sms/onboarding/__tests__/localStack.tw4a.test.ts | KNOWN | 14/15 | 84 | 48%/6.6/26 -> 95%/6.4/29 SATURATED | pins that no pre-existing '%sms%' function references studio_sms_onboarding; a later TW-4F function legitimately does (PR #266). failing: TW-4A against the local QA stack (real schema, real JWTs) the schema under test is the TW-4A one, the tables are not reachable through the API, and TW-1/2 code is |
| sms/provisioning/__tests__/localStack.j2owner.test.ts | FAIL | 11/12 | 98 | 74%/6.4/26 -> 73%/5.9/29 |  failing: TW-4F J2: get_studio_sms_texting_status (real schema, real JWTs) activation checklist: owner areas only, ok reflecting the underlying checks |
| sms/provisioning/__tests__/localStack.j3owner.test.ts | PASS | 11/11 | 105 | 84%/5.5/26 -> 78%/5.4/28 |  |
| sms/provisioning/__tests__/localStack.r2ci1.test.ts | PASS | 10/10 | 76 | 86%/5.3/25 -> 58%/5.5/28 SATURATED |  |
| sms/provisioning/__tests__/localStack.r2ci2.test.ts | PASS | 15/15 | 71 | 86%/5.4/25 -> 42%/5.6/28 SATURATED |  |
| sms/twilioIsv/__tests__/isolatedQa.canary.test.ts | BLOCKED | 0/5 (+5 skipped) | 44 | 85%/5.6/25 -> 21%/5.5/28 SATURATED | 5 skipped / 0 todo |
| sms/twilioIsv/__tests__/localStack.f1funding.test.ts | PASS | 25/25 | 692 | 77%/5.6/25 -> 82%/2.9/29 |  |
| sms/twilioIsv/__tests__/localStack.f4recovery.test.ts | PASS | 31/31 | 688 | 79%/2.8/26 -> 50%/1.8/29 SATURATED |  |
| sms/twilioIsv/__tests__/localStack.f5canceltarget.test.ts | FAIL | 0/8 (+8 skipped) | 45 | 79%/1.7/26 -> 73%/1.8/29 SATURATED | [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression] |
| sms/twilioIsv/__tests__/localStack.feeres.test.ts | PASS | 46/46 | 374 | 85%/1.7/26 -> 27%/2.9/29 SATURATED |  |
| sms/twilioIsv/__tests__/localStack.j4activation.test.ts | FAIL | 0/10 (+10 skipped) | 52 | 80%/2.9/26 -> 70%/1.9/29 SATURATED | [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression] |
| sms/twilioIsv/__tests__/localStack.r2a.test.ts | FAIL | 28/30 (+1 skipped) | 852 | 86%/1.6/26 -> 78%/0.9/28 SATURATED | [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression] failing: TW-4F R2a: Messaging Service and campaign provisioning (real schema, fake provider) rollback discovery: every later rollback script is classified, none silently omitted |
| sms/twilioIsv/__tests__/localStack.r2b.test.ts | FAIL | 0/53 (+53 skipped) | 90 | 82%/0.9/25 -> 78%/1.1/28 SATURATED | [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression] |
| sms/twilioIsv/__tests__/localStack.r2bp2.rfl.test.ts | KNOWN | 2/3 | 98 | 89%/1.1/25 -> 80%/1.1/29 SATURATED | KI-3: run 2 (main 78bc699c) failed twice on an idle host with 'expected +0 to be 2'; probable cause (unconfirmed): tw4_rfl_alerts_claim returns nothing while the delivery kill switch is off (fail closed since migration 20261211) and the test does not turn delivery on. Reported as a known item, not a |
| sms/twilioIsv/__tests__/localStack.r2brfl.test.ts | FAIL | 0/28 (+28 skipped) | 74 | 84%/0.9/26 -> 72%/0.8/28 SATURATED | [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression] |
| sms/twilioIsv/__tests__/localStack.tw4a9.test.ts | PASS | 9/9 | 107 | 89%/0.8/25 -> 82%/4.9/28 SATURATED |  |
| sms/twilioIsv/__tests__/localStack.tw4f1b.test.ts | KNOWN | 18/19 | 182 | 92%/9.1/26 -> 80%/6.1/29 SATURATED | pins exactly 14 tw4_runner_* functions; main has 16 (PR #266). failing: TW-4F-1b gate evidence against the local QA stack (real SQL functions, fake Twilio) the status shows only the current attempt's evaluation events; TRUNCATE and the older rollbacks are refused while this migration is applied |
| sms/twilioIsv/__tests__/localStack.tw4f3a.test.ts | PASS | 16/16 | 170 | 85%/6.2/26 -> 79%/4.2/29 SATURATED |  |
| sms/twilioIsv/__tests__/localStack.tw4f3b0.test.ts | PASS | 18/18 | 141 | 80%/4.2/26 -> 77%/2.6/29 |  |
| sms/twilioIsv/__tests__/localStack.tw4fi.test.ts | PASS | 25/25 | 219 | 82%/2.6/26 -> 83%/2.5/29 |  |
| sms/twilioIsv/__tests__/localStack.tw4fj1.test.ts | FAIL | 0/11 (+11 skipped) | 60 | 80%/2.4/26 -> 73%/1.2/29 SATURATED | [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression] |
| sms/twilioIsv/__tests__/localStack.tw4pilothard.test.ts | FAIL | 0/25 (+25 skipped) | 54 | 75%/1.1/26 -> 69%/0.7/29 SATURATED | [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression] |
| sms/twilioIsv/__tests__/localStack.tw4r1.test.ts | PASS | 11/11 | 126 | 86%/0.7/26 -> 66%/1.1/29 SATURATED |  |
| sms/twilioIsv/__tests__/localStack.tw4rfl.test.ts | FAIL | 0/87 (+87 skipped) | 65 | 74%/1/26 -> 72%/0.4/29 SATURATED | [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression] |
| sms/twilioIsv/__tests__/localStack.tw4rfld5.test.ts | FAIL | 0/21 (+21 skipped) | 65 | 79%/0.3/26 -> 75%/0.3/29 SATURATED | [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression] |
| sms/twilioIsv/__tests__/localStack.tw4rflevid.test.ts | FAIL | 0/60 (+60 skipped) | 74 | 78%/0.4/26 -> 78%/0.4/29 SATURATED | [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression] |
| sms/twilioIsv/__tests__/localStack.tw4rflops.test.ts | FAIL | 0/64 (+64 skipped) | 82 | 79%/0.3/26 -> 73%/0.3/29 SATURATED | [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression] |
| sms/twilioIsv/__tests__/localStack.tw4rflspend.test.ts | FAIL | 0/76 (+76 skipped) | 62 | 78%/0.4/26 -> 72%/0.4/29 SATURATED | [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression] |