# TW-4F coordinated pilot release sequence (2026-11-19). Plan only: nothing filed, signed, published, applied, deployed or spent.

## 1. Inbound cost basis ($0.010205 vs $0.0118)
$0.0118 is the WORST single carrier (base $0.0083 + AT&T $0.0035); $0.010205 is the EXPECTED blend over the 28/37/35 carrier mix (AT&T 0.0035 x 28% + T-Mobile/US Cellular 0.0025 x 37% + Verizon 0 x 35% = $0.001905 on top of $0.0083). The cost field holds the expected blend, consistent with outbound ($0.012695 is also a blend). Margin protection is in the price, not the cost field: at $0.0155 the net margin (0.959 minus cost/price) is 30.1% expected and 19.8% on the worst carrier. Twilio's written answer (ticket 30376594) is no inbound 10DLC surcharge, so the true cost may be lower. Recorded in the manifest (`costBasis`), PR #681.

## 2. #668 consent-hardening release package (three owner gates, in order; nothing executed)
State: PR #668 head b5ae0f83 (draft, mergeable, f3recon 13/13 and the earlier SMS suites pass in isolated QA; the live line has no required CI). PROD today: `studio_sms_pending_opt_outs` table absent, `sms_pending_opt_out_blocks` absent, 0 pending price requests, 0 price rows.
1. SQL + flag together (one gate): apply `20270215100000_twilio_pending_opt_outs.sql` to PROD via danceflow-ops, then set `SMS_PENDING_OPT_OUT_REQUIRED=1` in Production (build-time, so it takes effect with step 2's build). Verify: table exists, service-role-only grants, `select public.sms_pending_opt_out_blocks('00000000-0000-4000-8000-000000000000','+15550000000')` returns false. The app that does not know the table keeps working with the SQL applied (SQL first is the safe order). Rollback: the file `rollback/20270215100000_twilio_pending_opt_outs_rollback.sql`, after rolling the app back.
2. Staged production-target build of the #668 merge commit (`vercel deploy --prod --skip-domain`, APPS holds the CLI), checks: no new crons (the parked-STOP drain rides the existing 15-minute notifications send), env name present.
3. Promotion, 30-minute observation, rollback dpl_EJ968dkDy (then dpl_BVxHhpW5...).
Merge of #668 into release/website-embeds precedes step 2; it needs your approval.

## 3. Price filing: what must be true first (the signing action publishes)
Timeline: file at T0; cooling-off to T0+24h; signing window T0+24h to T0+48h (PROD config: single_owner, 24/24). Unsigned proposals are expired by the hourly sweep and must be re-filed (a new 24h cycle).
Before T0 (all must hold):
1. You can sit with the hardware key at some point in [T0+24h, T0+48h] for six signatures, and have chosen the time (target T0+26h; the last 12 hours are the fallback). Pick T0 so the day-2 slot is a time you will be at your machine.
2. Your written decision that signing = publication of all six prices at the values on the sheet, given once at filing time. That is the publication gate; no second approval cycle is needed afterwards.
3. Values locked: sheet + manifest #681 merged (inbound 0.0155). No more price changes pending.
4. PROD preflight (I run it at T0 minus an hour): price list 0 rows, 0 pending requests, publication not frozen, verifier ok, sweep and monitor clean. Verified today: not frozen, no recovery hold, mode single_owner, one primary credential.
5. Your signed-in session is recent (propose needs a fresh session).
NOT required before T0: #668 release, fixture capture, provisioning, any provider step. Publishing prices spends nothing and activates nothing; the price list is read only when a studio is billed, and all billing flags are off. The signing window is independent of the #668 gates, which can run inside the 24h cooling-off.
Known risk: only one hardware key (primary) is enrolled; no spare or recovery key. If it fails during the window the proposals expire. Enrolling a spare has its own 24h delay, so it cannot help this window; it is worth doing afterwards.

## 4. One sequence
- T-1h: PROD preflight (me). #677, #681 merged on green CI.
- T0: you file the six proposals (about 10 minutes; sheet is docs/twilio/TW-4F_Price_Filing_Sheet_2026-11-19.md) and record the one publication decision. I verify six pending requests with the right amounts and cooling_until/expires_at.
- T0 to T0+24h (parallel, each its own gate): #668 gate 1 (SQL + flag), gate 2 (staged build), gate 3 (promote, observe 30 min); fixture capture if you release it ($1.30, cap $5); pilot controls named (daily checker, stop action, runner window).
- T0+24h onward: you sign all six in one sitting. I verify: six active price rows, verifier ok, amounts and kinds match, monitor clean.
- After publication, each its own approval, in this order: G-SUB (subaccount) -> G1/G1b attestations and G2 submit -> G3 brand fee (needs the published brand price) -> Twilio brand review -> G4 number -> G5 campaign fee + vetting -> Twilio campaign review, verify Advanced Opt-Out -> flags/schedulers one clean cycle each -> G6 activation -> G7 first consented test SMS -> STOP/START round trip -> 7 clean days -> invoice reconciliation.
The long pole after prices is Twilio's brand and campaign review (days to weeks), which only starts at submission, so the sooner T0 happens the sooner the clock on everything else starts.
