# TW-4F: platform-admin subaccount onboarding panel (supervised pilot)

Status: built locally on branch `twilio-tw4f-admin-panel` (fake Twilio adapters, synthetic fixtures). Migration `20261130090000` is applied to the LOCAL QA database only; NOT applied to DEV or PROD. Nothing was deployed. No real subaccount was created, no registration submitted, no fee incurred, no SMS sent.

This is the supervised pilot interface on `/platform/sms` (section "Subaccount onboarding"). It is not the final self-service onboarding experience.

## What the panel does

There is one card per studio that has a submitted setup, a legal-business link or a pending location request. Each card shows:

- the progress across five stages;
- the single next action;
- a collapsible "Steps, approvals and evidence" area.

Only the card the last action was about opens automatically.

| Stage | What the admin does here | Guard (database, re-checked on every call) |
|---|---|---|
| Legal business | Create it from the owner's submitted setup, with a verification note and an "I verified it" confirmation. The note may not contain an EIN. | `tw4_entity_create_for_studio`: platform admin; submitted, attested onboarding; one entity per name and EIN last four |
| Location links | Decide an owner's attestation that another location belongs to an existing business: approve with a verification note, or reject | `tw4_entity_decide_link`: pending request only. The attester must own a studio of that entity, and the claimed name, EIN last four and the studio's own onboarding must all agree. Never automatic. |
| Setup budget and fee approvals | Set the cumulative setup budget (amount typed twice). Record ONE owner-approved fee at the published price, with the owner's written approval reference and an explicit confirmation. Withdraw an approval that has not been reserved. | `tw4_entity_set_spend_cap`, `tw4_spend_authorize` (one approval reference per open operation; published price only; within budget; pilot funding only with the exception and a location), `tw4_spend_withdraw` |
| ConfiDance pilot ceiling | Record the founder-authorized $150 non-spendable ceiling (once) | `tw4_pilot_exception_create`: verified ConfiDance Unlimited, LLC only, at most $150 and within its budget, one in the whole system |
| Twilio subaccount | "Create subaccount" with the typed phrase `CREATE SUBACCOUNT` | `tw4_panel_subaccount_confirm(key, studio, actor)`: the legal business is derived from the studio, never taken from the form. One-time request key, taken after the entity lock. Nothing is recorded for an active, suspended or closed account, or for a creation started less than 10 minutes ago (TW006). An older `creating` row is interrupted and can be confirmed again; it is reconciled by lookup. An open confirmation by the same admin is reused, never doubled. Then `provisionSubaccount`: lookup first, never creates twice, and reports truthfully when even recording the outcome fails. The runtime is checked first: a deployment that cannot create records nothing. |
| Registration path | Standard, or Low-Volume Standard with a documented reason and the full eligibility checklist | `tw4_onboarding_decide_tier`: Low-Volume Standard needs every checklist item (JSON true only), the location's legal business on file, and the studio's own EIN last four agreeing with it. It is refused while a Standard-price brand fee approval is open. Frozen once a brand attempt exists. |
| Twilio registration | Read only. The run and its step evidence stay in the existing registration runner below. | (unchanged) |

State words, always in this sense:

- **Configured**: recorded in DanceFlow.
- **Approved**: a person approved it (an owner fee approval, an admin link decision, or Twilio's review).
- **Submitted**: sent to Twilio and waiting.
- **Active**: in force.

**Needs attention** marks anything a human must resolve.

The audit evidence comes from the onboarding audit trail (entity, location, budget, fee approval, reservation, subaccount and pilot events) and the tier decisions.

**Low-Volume Standard is never presented as approval.** The checklist records DanceFlow's eligibility judgement; Twilio still reviews and decides. While no Low-Volume Standard brand price exists, the panel:

- disables the brand fee approval for that location;
- refuses a forged one: the action reads the tier from the database, never from the form;
- shows the price gap as a blocker.

The runner refuses the paid brand step in any case (`tier_unpriced`).

## Messages and free text

- **Result banners:** the text travels in a short-lived (60 s), httpOnly, same-site cookie set by the server action. The URL only carries `?panel=1` or `?panel_error=1`, so a crafted link cannot show fake text. The owner page shows only fixed messages selected by a code.
- **No full EIN in free text:** every free-text field (verification notes, link notes, approval references, withdraw notes, the tier reason, the pilot approval and the owner's claimed legal name) refuses anything shaped like a full EIN, in any spacing or dash, or nine digits in a row. Only the EIN's last four digits are ever recorded.
- **Money-controls note for the financial workstream:** a void (released or withdrawn) approval frees its approval reference, by the 3b0 design. A resubmitted old form could then record a new approval under the same written reference. The owner approval should be unique per operation; consider a never-reused reference or a link to the operation.

## Owner side

The new page `/app/settings/sms/location` (owner only, pilot studios only) lets an owner send the attestation "this location belongs to my existing business": legal name, EIN last four and a confirmation. It creates a pending request only.

The Texting settings page links to it in one click ("Another location of a business already texting with DanceFlow?", **Link this location**). The link is shown only to the owner, only while the setup is not paused, and only while the location does not belong to a legal business. That last check reads the existing credit overview; when that read is unavailable the link stays, and the page and the database re-check. The owner cannot read a pending request, so after sending one the link stays; a second request is refused with "already waiting for review".

## Database (`20261130090000_twilio_tw4f_admin_panel.sql`)

- `tw4_panel_overview(actor)`: the panel's read model. It is limited to platform admins. It returns only ids, names, the EIN's last four, amounts and states; never ciphertext or a token.
- `studio_sms_panel_requests` and `tw4_panel_subaccount_confirm`: one-time request keys for the Create subaccount confirmation. The table is append-only.
- `studio_sms_tier_decisions.eligibility` and `tw4_onboarding_decide_tier`. `tw4_onboarding_set_tier` now refuses Low-Volume Standard; the rollback restores its 20261129 body.
- Non-financial: no price, spend, credit, pilot, monthly-limit or audit-vocabulary object is created or replaced. The financial functions are only called, never changed.
- Depends on `20261129090000` and `20261122090000`. Independent of `20261128090000` (monthly limits). Apply it after that one.
- Rollback: application first, then the rollback script. The rollback refuses once panel request keys or eligibility records exist.

## Dependencies on the monthly spending-limit work (documented, not done here)

1. **Monthly limits on the panel.** Done in the UI follow-up (see below).
2. **Low-Volume Standard brand price.** This needs a tier-specific price kind, already listed as a financial follow-up. Once it exists, enable the brand approval for Low-Volume Standard locations (`registrationPath.ts`, `brandPriceKind`).
3. **Settings link** to the location attestation page. Done in the UI follow-up (see Owner side).

## UI follow-up: monthly limit on the panel, attestation link, chevrons

- **Monthly spending limit.** It sits inside "Setup budget and fee approvals", above the budget forms. It shows:
  - the owner-approved limit, and the ceiling cap when it binds;
  - what has been used this month and what remains;
  - the business's timezone, and next month's when it changes.

  Its status is *Approved*, *Not set* (no limit, so SMS usage and monthly fees are refused) or *Used up*. A chevron disclosure holds the usage / recurring / set-aside breakdown, the month's dates in the business's timezone, the platform ceiling, next month's limit and the last five limit changes. The block is read-only: only the owner sets the limit, on the Texting screen. When the read is unavailable the block says so; it never shows `$0` or *Not set* in that case.
- **Read path** (`20261202150000_twilio_tw4f_panel_monthly_limits.sql`). `tw4_panel_monthly_limits(actor)` needs a platform-admin actor, is callable by the service role only, and is STABLE.
  - It computes every figure with the same `_tw4ml_*` helpers as the owner's `sms_monthly_limit_overview`, and returns the same keys plus `legal_entity_id`.
  - The app parses it with the owner screen's parser (`src/lib/billing/smsPanelMonthlyLimits.ts`).
  - It never records a timezone.
  - Rollback: application first, then drop the function.
- **Performance fix** (`20261202140000_twilio_tw4ml_default_tz_perf.sql`).
  - The problem: `_tw4ml_default_tz` ran the `pg_timezone_names` check (about 130 ms) on every studio, before joining to the business's own locations. Every monthly-limit read for a business with no recorded timezone row paid studios × 130 ms several times, and so did its first charge, under the account lock.
  - The fix: it now checks only the business's own locations. The answers are the same: checks D01–D05 of the SQL suite pass against both the old and the new body.
  - Locally, ten such businesses went from more than 400 s to 24.5 s. What remains is the zone check itself, about 2.4 s per business without a timezone row on the local Docker stack. A business gets a timezone row once a limit or timezone is set.
- **Chevrons.** Every `<details>` on the panel shows a chevron that turns when it opens, and so does the owner's "View the information on file". Each uses a named Tailwind group, so nested disclosures never turn each other's chevrons.
- **QA**
  - Unit: 21 new tests covering the parser, loader refusals, rendering, the read-only block, per-business separation, chevrons, and the owner link's visibility by role, link state and pause.
  - SQL suite `test_T_twilio_tw4f_panel_monthly_limits.sql`, 18 checks:
    - the panel row equals the owner overview;
    - refusals for an owner, a plain user, and a null or unknown actor;
    - privileges;
    - no timezone write;
    - default-timezone equivalence.
  - Browser E2E: the panel spec gains two tests. One checks the monthly block in the real page, including the chevron turning; the other checks that an owner whose location is linked sees no link. The attestation test now starts from the Texting page link.

## QA summary

- **Unit:** panel model and commands, actions and render (73 tests across the panel and subaccount files).
- **SQL suites:**
  - the panel suite, 23 checks;
  - the provider suite, 16 checks, updated for the new tier rule.
- **Browser E2E** (`e2e/tests/sms-subaccount-panel.spec.ts`, 7 tests, local stack, fake Twilio). Each item below was checked as refusal first, then success where there is one:
  - owner shut out;
  - entity creation, including the "EIN in note" refusal;
  - setup budget;
  - Create subaccount: the wrong phrase is refused, and a double click creates exactly one;
  - Low-Volume Standard checklist and its price blocker;
  - owner attestation, a duplicate pending request, a database-refused link, and rejection.
- **Browser E2E, money controls** (`e2e/tests/sms-subaccount-panel-fees.spec.ts`, 5 tests, run once the shared local database was free). Each was checked as refusal first, then success:
  - ConfiDance legal business and a $150 budget;
  - the pilot ceiling: refused without the acknowledgement or above $150, then recorded and shown as non-spendable;
  - an owner brand fee approval: refused without the owner confirmation, recorded once against the pilot ceiling, and a replayed written approval refused;
  - the budget cannot drop below what is approved;
  - Low-Volume Standard is refused while the Standard-price brand approval is open, allowed after withdrawal, and its brand approval is then disabled while other fees still work.
- **Regression:** the existing wizard (8) and runner (10) specs pass with the panel on the page.
