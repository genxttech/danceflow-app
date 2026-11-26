# TW-4F Saturday signing checklist (2026-11-21)

Signing publishes. Only the owner signs, with the hardware key. Nothing here signs, publishes or changes production.

## Window (actual filing times)
Signable from Sat 11-21 20:06:24Z (3:06 PM EST). Earliest expiry Sun 11-22 20:06:24Z (3:06 PM EST). Unsigned proposals then expire and need re-filing.

## The six proposals (all must read pending, amounts exact)
| # | Kind (UI label) | Customer price | Provider cost |
|---|---|---|---|
| 1 | Outbound message | 0.017 | 0.012695 |
| 2 | Inbound message | 0.0155 | 0.010205 |
| 3 | Brand registration (Low-Volume Standard) | 7.00 | 4.50 |
| 4 | Campaign vetting | 21.00 | 15.00 |
| 5 | Campaign (monthly, Low-Volume Standard) | 2.25 | 1.50 |
| 6 | Phone number (monthly) | 1.65 | 1.15 |

## Preflight (read-only, run by engineering before the owner is asked)
`C:/Users/mcurt/danceflow-ops/sb.sh prod-read docs/twilio/ops-sql/pricing_signing_preflight.sql`
Go only if: pending_total 6, matched 6, signable_now 6, price_rows 0, verify.ok true, frozen false, recovery_hold false, mode single_owner, monitor_last under 20 min old, monitor_findings_since_filing 0, min_minutes_left over 120.
Any miss is a blocker; the owner is told and does not sign until it is resolved or the proposals are re-filed.

## Owner step
Sign in to the admin SMS page, open each pending proposal, "Authorize with my hardware key" six times. Order is irrelevant. Do not leave any unsigned past expiry.

## After signing (engineering, read-only)
`... prod-read docs/twilio/ops-sql/pricing_post_signing_verify.sql`
Expect pending 0, price_rows 6 with the amounts above, verify.ok true, monitor findings 0. Then watch the next two monitor runs.

## Not authorized by signing
SMS activation, provider spending, fixture capture, number or brand provisioning and the recurring fee lifecycle each need separate authorization.

## Automation (no manual SQL)
Windows scheduled task `TW4F-Pricing-Check` runs `ops-sql/pricing_check.mjs auto` every 15 minutes through Sun 11-22 about 20:00 EST, independent of the Claude app. Output: `ops-sql/pricing_check_latest.txt` (latest verdict + JSON), `pricing_check_log.txt` (history). While no price rows exist it is the PRE preflight; once rows exist it becomes the POST verification (six pending→0, six active rows with exact amounts, verify ok, monitor clean). BLOCKED writes `PRICING_BLOCKED.txt` and shows a desktop message.
Fresh-GO rule: do not sign unless the latest line is PRE GO and under 15 minutes old. Engineering confirms this before telling the owner to sign.
