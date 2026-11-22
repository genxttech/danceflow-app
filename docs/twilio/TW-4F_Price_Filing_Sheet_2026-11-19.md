# TW-4F price filing sheet (2026-11-19). Proposals only; nothing is published by filing.

Where: platform admin, SMS page, section "Propose a price change". File six times. Fields: Price (dropdown), New customer price in dollars, DanceFlow provider cost in dollars, Description, Reason. Provider cost is internal, never shown to studios.

| # | Dropdown label (exact) | Customer price | Provider cost | Charge type |
|---|---|---|---|---|
| 1 | Outbound message | 0.017 | 0.012695 | per segment |
| 2 | Inbound message | 0.0155 | 0.010205 | per segment |
| 3 | Brand registration (Low-Volume Standard) | 7.00 | 4.50 | one time |
| 4 | Campaign vetting | 21.00 | 15.00 | one time, non-refundable |
| 5 | Campaign (monthly, Low-Volume Standard) | 2.25 | 1.50 | monthly |
| 6 | Phone number (monthly) | 1.65 | 1.15 | monthly |

Descriptions (3-200 chars) and reasons (10-500 chars) are in docs/twilio/pricing/ConfiDance_pilot_price_manifest.json. The only change: row 2 uses 0.0155 (owner decision 2026-11-18); keep the cost 0.010205.
Do NOT use the other dropdown entries: "Brand registration" (Standard, $46), "Campaign (monthly)" (non-Low-Volume).

Timing on PROD (config read 2026-11-19): single-owner mode, 24h cooling-off, then a 24h signing window. Each proposal must be signed with the hardware key within that window or the sweep expires it. File all six together, then sign all six in the window starting 24h later. Signing publishes: do not sign until you also intend publication (publication is a separate approval from me; signing is the act that publishes in this flow).
