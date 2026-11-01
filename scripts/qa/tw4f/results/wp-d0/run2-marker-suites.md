### TW-4F Q1 run: wpd0-marker
- base origin/main @ 23ffbc43; tests origin/main @ 23ffbc43; image df-isoqa/base:20261119092100 (14e2a42e657c); order numeric
- applied: 20261120090000 20261121090000 20261122090000 20261123090000 20261124090000 20261125090000 20261126090000 20261127090000 20261128090000 20261129090000 20261130090000 20261201090000 20261202090000 20261202140000 20261202150000 20261203090000 20261204090000 20261205090000 20261206090000 20261207090000 20261208090000 20261209090000 20261210090000 20261211090000 20261212090000 20261213090000 20261214090000 20261215090000 20261216090000 20261217090000 20261218090000 20261219090000 20261221090000 20261222090000 20261223090000 20261224090000 20261225090000 20261226090000 20261227090000 20261228090000 20261229090000 20261230090000 20261231090000 20261231100000 (* = extra)

**Suites (each on a fresh clone of the applied chain)**: FAIL in 4251s
| Suite | Result | Tests | Seconds | Host start -> end (CPU %/free GB/containers) | Note |
|---|---|---|---|---|---|
| sms/twilioIsv/__tests__/localStack.f5canceltarget.test.ts | PASS | 8/8 | 100 | 76%/5.3/26 -> 41%/9/29 |  |
| sms/twilioIsv/__tests__/localStack.j4activation.test.ts | FAIL | 9/10 | 204 | 73%/8.8/26 -> 41%/8.6/29 |  failing: TW-4F J4: activation console end to end (real schema, real server functions, fake provider) a credit-funded (non-pilot) location 2. one refusal per checklist item: activate and mark ready refuse with TW042 naming the item and its detail; the state does not change |
| sms/twilioIsv/__tests__/localStack.r2a.test.ts | FAIL | 28/30 (+1 skipped) | 202 | 61%/8.7/26 -> 42%/8.4/29 |  failing: TW-4F R2a: Messaging Service and campaign provisioning (real schema, fake provider) rollback discovery: every later rollback script is classified, none silently omitted |
| sms/twilioIsv/__tests__/localStack.r2b.test.ts | FAIL | 0/53 (+53 skipped) | 41 | 83%/8/26 -> 52%/8.2/29 |  |
| sms/twilioIsv/__tests__/localStack.r2brfl.test.ts | PASS | 28/28 | 232 | 57%/8.3/26 -> 48%/7.8/29 |  |
| sms/twilioIsv/__tests__/localStack.tw4fj1.test.ts | PASS | 11/11 | 62 | 58%/7.8/26 -> 26%/7.9/29 |  |
| sms/twilioIsv/__tests__/localStack.tw4pilothard.test.ts | PASS | 25/25 | 343 | 47%/7.9/26 -> 65%/7.3/29 |  |
| sms/twilioIsv/__tests__/localStack.tw4rfl.test.ts | PASS | 87/87 | 1305 | 79%/7.1/26 -> 32%/5.4/29 |  |
| sms/twilioIsv/__tests__/localStack.tw4rfld5.test.ts | PASS | 21/21 | 309 | 68%/5.3/26 -> 68%/4.7/29 |  |
| sms/twilioIsv/__tests__/localStack.tw4rflevid.test.ts | PASS | 60/60 | 556 | 84%/4.6/26 -> 74%/4.2/28 |  |
| sms/twilioIsv/__tests__/localStack.tw4rflops.test.ts | FAIL | 0/64 (+64 skipped) | 51 | 89%/4.1/25 -> 78%/4/29 SATURATED | [resource exhaustion suspected: host saturated during this suite; rerun on an idle host before treating as a regression] |
| sms/twilioIsv/__tests__/localStack.tw4rflspend.test.ts | PASS | 76/76 | 570 | 84%/3.8/26 -> 85%/4.2/29 SATURATED |  |