# TW-4F: Twilio provider integration (canonical)

Status: implemented locally on branch `twilio-tw4f-provider-integration` (fake adapters and synthetic fixtures only). Migration `20261129090000` is applied to the LOCAL QA database only; NOT applied to DEV or PROD. No real Twilio call, registration submission, fee, SMS or Stripe transaction was made.

This document is the reference for how DanceFlow talks to Twilio once each studio legal business has its own subaccount (D2, owner decision 2026-10-18). It replaces the working assumptions Q1b and Q1c in `TW-4F_Production_Onboarding_Plan.md` §13 and `TW-4F-3a_Subaccount_Design.md`.

## 1. What Twilio confirmed (support ticket #29647095, 2026-10-19)

| # | Question | Twilio's answer | Where it is implemented |
|---|---|---|---|
| 1 | Can the parent ISV Primary Customer Profile be assigned to a Secondary Customer Profile inside a studio subaccount (same organization)? | Yes. | Runner step S9 assigns the configured Primary SID to the subaccount's Secondary profile. The fake models it: a subaccount can assign the Primary by SID but cannot read it. |
| 2 | Which credentials do Trust Hub and A2P operations in a subaccount need? | Subaccount-scoped credentials. | Every registration call goes through `adapterFor(subaccountSid)`, signed with that subaccount's SID and Auth Token. The parent client has no write method for Trust Hub or A2P. |
| 3 | Which token signs SMS and registration webhooks for subaccount resources? | The subaccount's Auth Token (`X-Twilio-Signature`). | `verifyTwilioWebhookAccount` in `src/lib/sms/twilioWebhookAccount.ts`, used by the inbound and status routes. |
| 4 | Can the parent retrieve a subaccount's Auth Token on demand? | Yes, with parent credentials. | `RealIsvParent.getSubaccountToken` (GET `/Accounts/{sid}.json`), behind `SubaccountTokenProvider` (memory only, at most 5 minutes, never stored). |
| 5 | Does Auth Token rotation have an overlap window? | No. | Re-read once on rejection (API 401 or webhook signature failure), spaced per account; the old token is never accepted again. See §4. |
| 6 | Can EIN-registered studios use Low-Volume Standard brands and Low Volume Mixed campaigns? | Yes, if eligible, and subject to Twilio review. | `registrationPath.ts`, per-onboarding tier chosen by a platform admin (`tw4_onboarding_set_tier`). The paid Low-Volume Standard brand is blocked until a tier price exists (§5). |

Semantics checked against Twilio's public ISV API guide (read-only page fetch, 2026-10-19): a Low-Volume Standard brand is `BrandType=STANDARD` with `SkipAutomaticSecVet=true`, which Twilio allows only for Low-Volume Standard brands and 527 political organizations. There is no separate brand type. The Low Volume Mixed campaign use case is `LOW_VOLUME`. Standard keeps `MIXED`.

## 2. Accounts and credentials

| Credential | Used for | Never used for |
|---|---|---|
| Parent (ISV) Account SID + Auth Token, or a parent API key (registration runtime) | Listing and creating subaccounts, reading a subaccount's Auth Token, GET of the ISV Primary profile (run preflight) | Creating, assigning, evaluating or submitting any Trust Hub or A2P resource; brand or campaign calls; signing a subaccount request |
| Subaccount SID + its Auth Token (fetched on demand) | Every Trust Hub and A2P call for that studio legal business; verifying that subaccount's webhooks | Any other subaccount; anything in the parent |

The Primary profile preflight changed. It used to be read through the registration adapter. In a subaccount that read is not confirmed to work, so it now goes through `IsvParentAdapter.getPrimaryProfile()`. That method is GET only and takes no argument, so only the configured Primary can be read. A run without the parent reader fails closed: the subaccount cannot see the Primary, so the preflight reports `primary_profile_not_approved` before any write. This is the one Trust Hub request parent credentials make.

## 3. Webhooks (inbound SMS and delivery status)

Order of checks. Each failure is final, and nothing is mutated before the last step:

0. A form that repeats a key → 403. The signature covers the last value of a key but the routes read the first, so a captured signed request could otherwise carry different values. Twilio never repeats keys. This applies to the parent path too.
1. No `X-Twilio-Signature` → 403. No lookup and no token read.
2. `AccountSid` absent or equal to `TWILIO_ACCOUNT_SID` → the existing parent-token verification. Parent-account behavior is unchanged.
3. `AccountSid` malformed → 403.
4. `AccountSid` is not an active or suspended DanceFlow subaccount (`tw4_webhook_account`, service role, returns ids and status only) → 403, with no token read.
5. Subaccount verification switched off in this deployment → 403, the same answer as an unknown account, so a prober cannot tell which SIDs are DanceFlow customers. The reason code is logged. The webhook is never accepted.
6. The signature must verify with the subaccount's current token. If it doesn't, the token is re-read once (spaced, §4) and checked again. Otherwise → 403.
7. **Tenant isolation:** the studio the webhook would affect must belong to that subaccount's legal business (`webhookMayActForStudio`). Inbound uses the studio resolved from the receiving sender. Status uses the studio that owns the logged message. A mismatch → 403, with no effect.
8. **Replay ledger** (`sms_webhook_receipts`, append-only): inbound is keyed by `MessageSid`, status by `MessageSid:MessageStatus`. A repeat delivery is a no-op: an empty TwiML for inbound (no second reply, no second consent change), or `{ ok: true, duplicate: true }` for status. An exact replay of an earlier status therefore changes nothing. A genuine out-of-order callback (`sent` arriving after `delivered`) still applies, as before; status ranking is a follow-up. The ledger applies to parent-account webhooks too, so a parent duplicate is now also a no-op. That is the only change on the parent path.

Step 4 reads the database before the signature is verified, because the token to verify with depends on the account. It is one indexed, read-only lookup through a definer function. Rejected requests are rate-limited per IP by the routes, as before.

The replay ledger fails open. If it cannot be reached, the event is still processed and a warning code is logged. Dropping a genuine STOP is worse than processing a replay twice. The signature is already verified, and consent and status effects are idempotent. The event is recorded before its effects. If the process fails after recording, a re-delivery (Twilio's inbound fallback URL, a manual re-drive) is treated as a duplicate and the effect is lost. For a STOP, the carrier-level opt-out (Advanced Opt-Out) still applies, but DanceFlow's own consent row would not change. This is accepted as rare for now. The alternative, recording only after the consent RPC or status update succeeds, is a follow-up. Status callbacks are not retried by Twilio. Follow-up: a retention purge of old receipts. The table is append-only and truncate is blocked, so the purge needs its own definer function (rows hold only SIDs and status words).

Switches. `TW4_SUBACCOUNT_WEBHOOKS=on` works only on a production deployment with a production build. It is independent of `TW4_ISV_REAL_CALLS`, because verifying a callback is a read, never a registration write. It uses the existing `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`. In local fake mode (`TW4_ISV_FAKE=on`, local database) the in-memory fake parent's tokens are used.

## 4. Token rotation (no overlap window)

- **API calls** (`rotation.ts`): a 401 from the subaccount triggers one token re-read. If the token changed, the same request is sent once more. This is safe even for a POST, because Twilio rejects an unauthenticated request before acting on it. If the token is unchanged, or the retry also fails, the error stands as an `account` error. There is no loop, and the call never falls back to parent credentials.
- **Webhooks:** a signature that fails with the cached token triggers one re-read, as in §3 step 6.
- **Spacing (webhook path):** parent reads of one account are shared while in flight, and happen at most once every 30 s (`REFRESH_MIN_INTERVAL_MS`), measured from the last read, whether it succeeded or failed. Inside the interval the cached token is the answer. With nothing cached, the verification fails (503) without asking Twilio. A flood of forged webhooks naming a real subaccount therefore costs at most one parent request per interval per server instance. The registration runner, which only an admin triggers, re-reads immediately on a 401 (interval 0) but still retries at most once.
- **No fallback to the old token, with a bounded cache window:** the old token is never kept as a fallback. A token cached before a rotation, however, keeps verifying webhooks in a warm server instance until its webhook TTL ends (`WEBHOOK_TOKEN_TTL_MS`, 60 s), or until a failed signature after the spacing interval forces a re-read. If a rotation is a response to a leak, assume the old token stays usable against DanceFlow webhooks for up to about 60 s per instance. To close that window at once, redeploy (which clears every instance's memory). **Operational cost:** a genuine callback signed with the old token a moment before the rotation can be rejected (403). Rotate a subaccount token in a quiet period, then reconcile delivery status for messages sent around the rotation (a follow-up read-only status reconciliation, not built).
- Tokens live in memory only (`RedactedSecret`, at most 5 minutes). They are never logged, stored, put in an error or returned by a verification result. Tests assert this.

## 5. Registration tiers

| Tier | Brand | Secondary vetting | Campaign use case | Paid brand step |
|---|---|---|---|---|
| `standard` (default, D3 for the pilot) | `STANDARD` | automatic (on) | `MIXED` | runs at the published `brand` price |
| `low_volume_standard` | `STANDARD` | skipped (`SkipAutomaticSecVet=true`) | `LOW_VOLUME` (Low Volume Mixed) | **blocked**: `tier_unpriced`, right after the tier is read, before any Twilio write (no profile, no submission, no reservation). An onboarding whose brand already exists, for example from a mock run, is not blocked |

- A platform admin chooses the tier per onboarding (`tw4_onboarding_set_tier`). It needs a written reason, is refused while a runner holds the lease, and is frozen as soon as any B1 (brand) attempt exists. Every change is appended to `studio_sms_tier_decisions`. No choice means Standard.
- Eligibility is a review judgement (EIN-registered, low expected volume) and Twilio still reviews the brand. The application does not claim approval.
- A Twilio **mock** brand (free) may use either tier.
- No UI sets the tier yet. Follow-up: a platform-panel control with the eligibility checklist.

## 6. Dependencies on the monthly spending-limit work (not done here, by design)

This slice changes no price, spend, credit, monthly-limit, Stripe or billing object, and no shared migration. The financial side owns:

1. **A tier-specific brand price.** Today `studio_sms_price_list` has one active `brand` price, the Standard brand with secondary vetting. A Low-Volume Standard brand needs its own published price kind (for example `brand_low_volume`) in the price list, spend kinds, `tw4_spend_authorize`, `tw4_spend_reserve` and `tw4_spend_settle`, and its monthly-limit category. Once it exists, set `brandPriceKind` for `low_volume_standard` in `registrationPath.ts` and pass the kind to `reserveSpend` / `settleSpend` (both currently hard-code `"brand"` in the runner). That small runner change is coordinated with that work.
2. **Campaign fees per tier.** The campaign step (R2, not built) will register `MIXED` or `LOW_VOLUME`. Campaign vetting and monthly campaign fees differ by use case and are priced on the financial side.
3. **Monthly limits.** Registration and recurring charges count against the calendar-month limit. Nothing here reserves or charges anything new.

Migration ordering: `20261129090000` depends only on TW-4F-3a (`20261121090000`). It is independent of `20261128090000` (monthly limits) and applies cleanly in either order.

## 7. Files

- `src/lib/sms/twilioIsv/registrationPath.ts`: tiers and their provider semantics.
- `src/lib/sms/twilioIsv/rotation.ts`: the rotation-aware subaccount adapter.
- `src/lib/sms/twilioIsv/account.ts`: `SubaccountTokenProvider.refresh` (spaced re-read).
- `src/lib/sms/twilioIsv/real.ts`: `RealIsvParent.getPrimaryProfile`, `createWebhookTokenParent`.
- `src/lib/sms/twilioIsv/config.ts`: `subaccountWebhooksAllowed`.
- `src/lib/sms/twilioIsv/runner.ts`: Primary preflight through the parent, the tier, `tier_unpriced`.
- `src/lib/sms/twilioWebhookAccount.ts`, `src/lib/sms/twilioIsv/webhookRuntime.ts`: webhook verification, tenant check and replay ledger.
- `src/app/api/sms/twilio/{inbound,status}/route.ts`: wired.
- `src/lib/supabase/migrations/20261129090000_twilio_tw4f_provider_integration.sql`, plus its rollback and the SQL suite `sql-tests/test_T_twilio_tw4f_provider_integration.sql`.

## 8. Release order (each step needs its own authorization)

1. SQL `20261129090000` on DEV, then PROD (additive). The rollback refuses once receipts or tier decisions exist. Because parent-account webhooks write receipts too, **the SQL rollback window closes with the first webhook after the app deploy.** Roll back the app first; the receipts table can then stay as inert evidence.
2. App deploy. Parent-account webhooks are unchanged. Subaccount webhooks return 503 until the switch is on.
3. `TW4_SUBACCOUNT_WEBHOOKS=on` in Production, only once a real subaccount sends messages.
4. Supervised first subaccount run (owner present). The first real subaccount webhook should be checked in the logs: there must be no `twilio_signature_invalid` for genuine traffic.
