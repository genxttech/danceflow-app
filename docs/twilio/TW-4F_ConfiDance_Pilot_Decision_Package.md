# TW-4F ConfiDance pilot: consolidated owner decision package (2026-11-09)

Status: decision package only. Nothing here is approved or executed. No price is published, no hosted migration applied, no Twilio call made, no fee incurred, no SMS sent. Engineering facts are verified (read-only PROD probes, local QA); Twilio figures are NOT confirmed by Twilio (ticket #29647095 is unanswered, and Twilio's fee article returns 403 to automated reads), so they are labelled below.

## 1. What is decided and what is not

| Item | State |
|---|---|
| Provisional per-segment rates | Outbound $0.017, inbound $0.013 (owner-approved as provisional). Stored as micro-dollars 17,000 and 13,000 (PR #441). |
| Fixed-fee customer prices | Candidates only, not approved (section 3). |
| Twilio tier (Low Volume vs Standard) | UNCONFIRMED (ticket #29647095, question 6). |
| Price publication mechanism | Built in PR #441, not merged or applied. Needs the `20270210*` chain on PROD first (section 5). |
| Pilot spending | Not authorized. The $150 ceiling is a safety limit, not a budget (section 6). |

## 2. Per-segment rates: reconciliation against Twilio's October 2026 price page

Source: `https://www.twilio.com/en-us/sms/pricing/us` ("Pricing current as of October 2026"), fetched 2026-11-09 and read cell by cell from the page HTML (the earlier text extraction merged blank cells, which is how a wrong figure entered the first version of this package).

**Correction.** The first version of this package said Verizon inbound can cost $0.0153 (base $0.0083 + $0.007). That is wrong. In the long-code carrier-fee table the columns are SMS Outbound, SMS Inbound, MMS Outbound, MMS Inbound. The Verizon row reads `$0.005 | (blank) | $0.007 | (blank)`: the $0.007 is the **MMS outbound** fee and the SMS inbound cell is **blank**. "All other carriers" reads `$0.0042 | (blank) | $0.01 | (blank)`. Where Twilio means zero it says so (the RCS table lists Verizon inbound as an explicit `$0`), so a blank means no inbound carrier fee is published on this page, not a stated $0. Treat Verizon and other inbound as base rate only ($0.0083) until the first invoice confirms it.

**Incoming messages (what a studio member's reply costs DanceFlow):** base $0.0083 per segment plus the inbound carrier fee.

| Carrier | Inbound carrier fee | Inbound cost per segment |
|---|---|---|
| AT&T | $0.0035 | $0.0118 |
| T-Mobile | $0.0025 | $0.0108 |
| US Cellular | $0.0025 | $0.0108 |
| Verizon | blank (none published) | $0.0083 |
| All other | blank (none published) | $0.0083 |

Blended with the recorded carrier mix (AT&T 28, T-Mobile 37, Verizon 35): 0.28 x 0.0118 + 0.37 x 0.0108 + 0.35 x 0.0083 = **$0.010205**. Worst case is AT&T at **$0.0118**. At $0.013 the inbound rate leaves about $0.0012 (9%) on the worst carrier and about $0.0028 (21%) blended, before Stripe and the variance reserve. There is no loss scenario on the published figures.

**Automated outgoing replies (what DanceFlow's own responses cost):** these are outbound messages and are priced as outbound, not as the inbound message that triggered them. Outbound cost per segment: base $0.0083 plus the outbound carrier fee, AT&T $0.0118, T-Mobile $0.0128, Verizon and US Cellular $0.0133, other $0.0125 (blended about $0.012695). Replies Twilio sends itself under its Advanced Opt-Out configuration (STOP, START and HELP keyword handling) are, according to Twilio's support articles, not billed. A reply DanceFlow sends through the API (for example a custom confirmation) is a normal billed outbound segment, about $0.0127 each, and DanceFlow absorbs it rather than charging the studio (already accounted in the pricing recommendation). The price page itself says nothing about opt-out replies, so this rests on Twilio's support articles and should be confirmed by the first invoice.

| Rate | Blended cost | Gross margin at blended cost | Worst carrier |
|---|---|---|---|
| Outbound $0.017 | $0.012695 | about 25% | $0.0133 cost leaves $0.0037 (22%) |
| Inbound $0.013 | $0.010205 | about 21% | $0.0118 cost leaves $0.0012 (9%) |

Margins are before Stripe fees (2.9% + $0.30 per top-up), the 5% variance reserve and absorbed compliance replies. The planning rates stand as provisional; they are not financial authorization.

## 3. Fixed fees (Twilio cost unconfirmed; candidate customer prices)

| Item | Twilio list (search extraction) | Candidate customer price | Path |
|---|---|---|---|
| Brand, Low Volume Standard | $4.50 one time | $7.00 | Low Volume |
| Campaign vetting | $15.00 one time, non-refundable (re-confirm) | $21.00 | both |
| Campaign, Low Volume Mixed | $1.50 per month | $2.25 | Low Volume |
| Phone number | $1.15 per month (read directly) | $1.65 | both |
| Brand, Standard (includes $41.50 secondary vetting) | $46.00 one time | $65.00 | Standard fallback |
| Campaign, Standard MIXED | $10.00 per month | $14.00 | Standard fallback |

Customer-price setup totals (what the $150 ceiling counts): Low Volume $31.90, Standard $101.65. Recurring: $3.90 or $15.65 per month.

## 4. Estimated costs (actual Twilio spend, not customer price)

| Scenario | Initial (brand + vetting + first campaign month + number) | Ongoing per month | Plausible maximum, first 90 days |
|---|---|---|---|
| Low Volume path (recommended if Twilio confirms) | **$22.15** | $2.65 plus usage | $22.15 + 2 x $2.65 = $27.45; with one rejected-and-resubmitted campaign +$15 = $42.45; plus testing messages below |
| Standard fallback (if Twilio says Low Volume does not apply to ISV-registered studio brands) | **$72.15** | $11.15 plus usage | $72.15 + 2 x $11.15 = $94.45; with one resubmission +$15 = $109.45; plus testing messages |

Testing messages (separate from setup): a $10 complimentary testing credit is about 588 outbound segments at $0.017; Twilio cost for all of it is at most about $7.82 at the worst-carrier $0.0133. Recommended pilot testing budget: **$10 credit, DanceFlow-funded.** No recommendation to raise it before there is invoice data.

Recommended maximum authorization to request: Low Volume path **$55** (setup $22.15, two further months $5.30, one resubmission $15, testing up to about $8, small rounding reserve). If the Standard path is forced, a new decision at about **$120** is needed; this package does not authorize it.

## 5. Price publication path (smallest compliant)

1. PROD currently has none of the dual-control functions (verified read-only 2026-11-09: `tw4_price_propose` absent, 0 price rows, 1 platform administrator, `tw4_price_set` still the 20261122 body, `auth.sessions` present). The existing single-administrator `tw4_price_set` path is the one the dual-control chain replaces.
2. Apply order on PROD (each file md5-pinned and fail-closed; all validated in order on a PROD-equivalent local database): `20270210090000_twilio_price_dual_control`, `20270210100000_twilio_price_owner_authorization`, `20270210110000_twilio_price_monitor`, then `20270212090000_twilio_price_micros_publication` (PR #441). `20261231130000` (micros columns) is already live. Rollbacks exist for each and run in reverse order.
3. App release carrying PR #441 (the micro-dollar form and the exact-value signing screen). Until then the form would only offer whole cents.
4. Owner-level bootstrap (no application path): relying party and the first hardware credential, plus an offline recovery key.
5. Per price: propose in a signed-in session with a fresh authenticator code, wait the mandatory 24 hours, sign in again in a separate session, and approve with the hardware key over the exact amounts.
6. Prices to publish for the Low Volume path: `sms_usage` 17,000 and `sms_inbound` 13,000 micro-dollars, plus `brand_low_volume`, `campaign_vetting`, `monthly_low_volume`, `number`. Six requests, which can run in parallel (one open proposal per kind). Elapsed time is about 2 days from the first proposal after the bootstrap.

## 6. Hardware-key approval mechanism (what the owner actually does)

Single-owner mode, one human. The authority is a FIDO2/WebAuthn credential in a hardware authenticator (user presence and user verification required; synced or backup-eligible passkeys are refused). The assertion is verified inside Postgres over a hash that includes the kind, old and new values, micro-dollar amounts, proposal version, request id and a database-issued single-use nonce, so a stolen session, JWT or service key cannot publish a price. Proposal needs an aal2 session with an authenticator-app code at most 10 minutes old; authorization must come from a different session than the proposal, after the 24-hour cooling-off, inside the authorization window. Up to three credentials are active; one recovery key is kept offline and can only freeze or start a delayed re-enrolment. The owner needs: one hardware security key (two recommended: primary plus offline recovery), a device that can use it in the browser, and the authenticator app already enrolled for the platform account. Whether the owner already has a suitable key is the single open question for this section.

## 7. Minimum provider operations (Low Volume path)

Free: create the studio subaccount; create the secondary customer profile and end users; assign the Primary profile; create the messaging service; configure webhooks. **Fee-bearing, each needing its own owner approval reference:** (1) Low Volume Standard brand registration $4.50; (2) campaign registration, vetting $15 plus the first month $1.50; (3) one local number $1.15 per month. Then number attachment and the first controlled test texts (funded by the testing credit, not the ceiling). Four fee-bearing actions in total. Twilio's answers on cross-account Primary assignment and credentials for subaccount Trust Hub calls (questions 1 to 5) affect HOW the free steps are built, not their cost.

Eligibility uncertainty, stated plainly: whether an EIN studio registered through the ISV Primary profile qualifies for Low Volume Standard and Low Volume Mixed is unanswered. Published criteria (EIN, under 6,000 segments per day) suggest yes; Twilio's written answer governs. If it is no, the Standard path costs $72.15 initially and $11.15 per month.

## 8. The $150 ceiling is not spending authorization

- It is a cumulative, non-spendable safety limit counted at published customer prices (Low Volume setup $31.90, Standard $101.65). Reaching it blocks further fee-bearing actions; not reaching it authorizes nothing.
- Each real fee-bearing Twilio action still needs its own separate written owner approval reference. There is no generalized bypass, and one approval never carries to another action.
- It does not fund messaging. Testing messages come from the separate $10 testing credit, which also needs its own approval.
- It does not authorize billing, SMS sending, number purchase, campaign registration or price publication. Those switches stay off until their own release conditions are met.
- Recurring monthly fees also count against it, so on the Standard path the ceiling is exhausted in about three months.

## 9. Decisions requested (one consolidated list)

1. Accept the six candidate fixed-fee customer prices in section 3, or name others.
2. Approve the PROD release path in section 5 as a future bounded release (SQL chain of four migrations, then the app with PR #441, then the bootstrap). Not authorized by this document.
3. Confirm the hardware key arrangement (section 6): which key, and recovery key custody.
4. Set the pilot maximum: recommended $55 Low Volume with the $10 testing credit inside it; Standard path to be decided separately.
5. Relay Twilio's reply on ticket #29647095 when it arrives (engineering cannot read the ticket). Engineering proceeds with the independent work in the meantime.
