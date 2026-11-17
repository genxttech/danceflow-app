# TW-4F pricing release package: GO / NO-GO (2026-11-09)

Nothing below has been executed. No production SQL, deployment, credential bootstrap, price publication, Twilio resource, charge or SMS. Planning approvals only (owner, 2026-11-09): Low Volume fixed-fee customer prices $7.00 brand, $21.00 vetting, $2.25 campaign per month, $1.65 number per month; per-segment $0.017 outbound, $0.013 inbound. Low Volume eligibility and actual Twilio fees stay pending ticket #29647095.

## Verdict

| Part | Verdict |
|---|---|
| A. Production SQL (four migrations) | **GO** once you authorize it |
| B. Application release of PR #441 | **GO** once you authorize it, after A |
| C. Hardware-key bootstrap | **NO-GO until you confirm the keys** (section 5) |
| D. Six price proposals and authorizations | Owner actions, after C; not engineering operations |
| Twilio provisioning, SMS sending, billing | Out of scope; stay off |

## 1. Baseline preserved

Live: `www` = `dpl_6cCoRGWgir71KWiExC1bnv2Z5B9U` (commit a965f477 plus the three monitoring flags; contains CI-B, R2, H1, Founder Pricing, TW-4F dark code). The release candidate is PR #441 head `adbc665e` (tree `9652c9aa788ac43889c489d530564bb479ab0df3`), which is a965f477 plus **only**: the price panel and signing screen (`src/app/platform/sms/Price*.tsx`, `priceChangeActions.ts`), `src/lib/sms/priceChange.ts` and `priceMicros.ts`, one new migration with its rollback, tests and docs. `git diff --name-only a965f477 adbc665e` touches nothing outside `docs/`, `src/lib/sms/`, `src/app/platform/sms/` and `src/lib/supabase/migrations/`. CI on that head: both Vercel builds success. No environment variable change is needed.

## 2. Migration fingerprints (LF-normalised sha256, first 16 hex; git blob)

| Order | Migration | sha256 | blob |
|---|---|---|---|
| 1 | 20270210090000_twilio_price_dual_control | 64b639323e844410 | eb41b06871 |
| 2 | 20270210100000_twilio_price_owner_authorization | e5e55ba1bea31210 | 0be353dbe8 |
| 3 | 20270210110000_twilio_price_monitor | 339ab79c90e7af66 | 38c01ee312 |
| 4 | 20270212090000_twilio_price_micros_publication | f5734c57c7dd6a30 | 4ab14221fd |

Rollbacks: `..._dual_control_rollback` 5ad7636f9c9bed39; `..._owner_authorization_rollback` 303727c2e0f20e83; `..._price_monitor_rollback` 89dbad0d5a36e476; `..._micros_publication_rollback` a75ce023ce81e3b0. Each migration pins the md5 of every function it replaces and fails closed on drift. Production preconditions re-verified read-only today: none of the four applied, 0 price rows, `tw4_price_set` md5 `36b3548cfa94cce34e7df10c2a74981f` (the pinned 20261122 body), `auth.sessions` present, `20261231130000` (micros columns) live.

## 3. Verification completed

- **Chain order and rollback** on the TW-4F isolated harness (baseline image + main chain): extras apply; rollback of the extras equals the main-only catalog (0 differences); re-apply equals first apply; 43 rollbacks run without error; second cycle identical. The one non-green line (full rollback versus the July baseline) is six accepted residue lines in pilot-evidence check constraints, unrelated to pricing.
- **PA-33 session binding, previously open: now verified** against a real GoTrue-backed `auth.sessions` (harness `--auth`): PA-33 passes, as do PA-32 and PA-37, and the real-token price authorization suite passes 11/11 (real tokens through Kong and PostgREST). The earlier local failure was the missing `auth.sessions` table only.
- New micro-publication suite 12/12 (including the production `monitoring_expected = true` setting); price monitor suites 9/9 and 6/6; dual-control suites pass; typecheck clean.

## 4. Financial controls and dark state (production, read-only today)

| Control | Observed |
|---|---|
| Prices published | 0 rows |
| Usage-billing switch rows | 0 (billing off) |
| Credit accounts, ledger rows, pilot exceptions | 0, 0, 0 |
| $150 pilot ceiling | CHECK `ceiling_cents` 1 to 15000 present; burned-ceiling guard trigger enabled |
| Inbound absorbed-cost allowance and volume alert | $20.00 and 200 segments per day |
| `tw4_price_set_micros` | EXECUTE granted to no API role |
| SMS-related production variables | only `SMS_USAGE_RECONCILER`, `SMS_FEE_LIFECYCLE_SCAN`, `SMS_FEE_LIFECYCLE_DELIVERY` (monitoring); no billing, purchase or sending flag |
| Fee-lifecycle switches | `scan` and `delivery` on (monitoring only) |
| Competition registration, OD-17, refund freeze | registration route 404; OD-17 untouched; freeze untouched |

**Existing exposure this release closes:** until migration 1 is applied, `tw4_price_set` (single administrator, no second person) is still executable by `service_role` on production. There are no price rows and no credit accounts, so nothing is at risk today, but dual control removes that path (it then refuses every caller).

After the release, all of the above stays unchanged: nothing publishes, bills, sends or provisions.

## 5. Operations requiring your approval

**Release R1 (one bounded window, engineering executes; fail closed, stop on any unexpected result):**
1. Fresh read-only production preflight (the four migrations absent, preconditions above).
2. Apply the four migrations in order 1 to 4 with `supabase db query --linked`, postflight after each (functions present, API grants, trigger counts, price list still 0 rows).
3. Stage the PR #441 build as a non-promoted production deployment from tree `9652c9aa`; promote it; 30-minute observation (health pages, webhook, refund reconciliation checkpoint via `checkpoint_cib.sh`, no new runtime errors).
4. Rollback: application first to `dpl_6cCoRGWgir71KWiExC1bnv2Z5B9U`; SQL rollbacks run manually in reverse order (4, 3, 2, 1). The rollback of migration 2 refuses once any credential, owner request or audit row exists; after the bootstrap the remedy is forward-fix or the freeze, not rollback.

**Bootstrap B1 (separate authorization, after R1):** engineering records the relying party and the two public keys with the owner-level bootstrap. Needs from you: (a) confirmation that you hold **two hardware security keys** (one primary, one offline recovery) and an enrolled authenticator app; (b) approval of relying party `www.idanceflow.com` with allowed origin `https://www.idanceflow.com` (an exact host, narrower than the apex); (c) the public key material from your enrolment ceremony. Engineering never holds a private key.

**Owner actions D1 (not engineering):** six proposals from the manifest `docs/twilio/pricing/ConfiDance_pilot_price_manifest.json`, then six separate-session hardware-key authorizations after the mandatory 24 hours. Publishing prices is yours alone; engineering cannot do it by design.

## 6. Explicit non-goals of this release

No Twilio call or fee, no subaccount, brand, campaign or number, no SMS send, no billing or credit purchase flag, no pilot exception, no price publication by engineering, no change to the refund freeze, competition registration or OD-17. The $150 ceiling is a safety limit, not spending authorization; the $55 planning figure is a plan. Each fee-bearing Twilio action later needs its own written approval.

## 7. Residual items

- Twilio ticket #29647095 unanswered: Low Volume eligibility and actual fees unconfirmed. Not a blocker for R1, B1 or D1.
- Verizon and other inbound carrier fees are blank on Twilio's page (treated as none); confirm on the first invoice.
- Admin alert email end to end is still tested only locally (no business exists on production).
