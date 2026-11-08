# TW-4F: financial integrity follow-up (approval references, Low-Volume Standard pricing)

Status: implemented on branch `twilio-tw4f-financial-integrity` (local QA only). Migration `20261202090000_twilio_tw4f_financial_integrity.sql` is applied to the LOCAL QA database only; NOT applied to DEV or PROD. No price was published, no Twilio call, registration, fee, SMS or Stripe transaction was made.

## 1. Approval references are permanent

**Defect fixed.** One written owner approval was meant to authorize one fee-bearing operation. The database enforced that only while the approval was open (partial unique index `studio_sms_spend_events_one_approval`, `status in ('authorized','reserved')`, per legal business). Once an approval was withdrawn or released (`void`) the same reference could be recorded again, and a reference recorded for one legal business could always be recorded for another.

**Now.** `studio_sms_approval_refs` holds one row per normalized reference for the life of the system:

| Column | Meaning |
|---|---|
| `ref_norm` (primary key) | NFKC, every whitespace run collapsed to one space, trimmed, lower-cased (`Owner email` = `  OWNER\temail `) |
| `source` | `spend_authorization` or `pilot_exception` (the founder's ceiling approval) |
| `legal_entity_id`, `studio_id` | the business, and the location the approval names (null: a credit-funded approval for the whole business; the reservation then names the location) |
| `spend_event_id`, `kind`, `amount_cents`, `funding`, `approved_by` | the authorization it created |

- Rows are written by `AFTER INSERT` triggers on `studio_sms_spend_events` and `studio_sms_pilot_exceptions`, in the same transaction, so no insert path can skip them. The triggers are `ENABLE ALWAYS`: they also fire in replica mode (restores, data-fix sessions). The table is append-only (no update, delete or truncate) and has no API-role privileges.
- Monthly-limit ceiling approvals (`studio_sms_limit_ceilings`) share the namespace in both directions: a ceiling approval is never accepted as a fee approval, nor the reverse. Ceilings may still repeat each other's reference.
- `tw4_spend_authorize`: an IDENTICAL retry (same business, kind, amount, funding, location and approver) of an approval that is still unused returns it (`replayed: true`). Every other use of a recorded reference is refused with **TW019**: after withdrawal, release, capture, by another approver, location, kind, amount or business.
- Concurrency: every use of a reference takes a transaction advisory lock on its normalized form (fee, pilot and ceiling namespaces alike), so racing uses of one reference serialize and exactly one is recorded; requests for the same business also serialize on the business row.
- Linkage: `tw4_approval_ref_trace(ref, actor)` (platform admin) returns reference -> business -> approved location -> authorization (status, operation key, onboarding) -> credit reservation (location, status) -> ledger rows.
- The migration refuses to apply if existing evidence already reuses a reference (ambiguous linkage: reconcile by hand first).

Reservations still bind the OLDEST open approval of the operation's kind for the location (existing behaviour); the binding is recorded permanently on the authorization (`reservation_key`, `credit_reservation_id`).

## 2. Low-Volume Standard price kinds

| Kind | Fee | Path |
|---|---|---|
| `brand` / `monthly` | Standard brand (with secondary vetting) / MIXED campaign monthly fee | Standard, or no tier chosen (owner decision D3 default) |
| `brand_low_volume` / `monthly_low_volume` | Low-Volume Standard brand / Low Volume Mixed campaign monthly fee | Low-Volume Standard, **verified** |
| `campaign_vetting`, `number`, `sms_usage` | shared | both |

"Verified" (`_tw4fi_location_path`): the location's active onboarding is on Low-Volume Standard, its latest tier decision is Low-Volume Standard with the complete eligibility checklist (`_tw4p_lvs_checklist_complete`), and the location's legal business has the EIN last four of the submitted setup. It is re-checked on every use, not only when the tier is decided.

Enforcement, all in the database (**TW020** on refusal):

- `BEFORE INSERT` on `studio_sms_credit_reservations` (every reservation: setup fee, recurring first-month set-aside, recurring charge) and on `studio_sms_spend_events` (approvals that name a location). A low-volume kind also needs a location.
- `tw4_spend_reserve` / `tw4_spend_settle` accept the new kinds; capture and release are unchanged. `tw4_recurring_authorize` accepts `monthly_low_volume` (same owner wording as `monthly`) and allows one campaign fee per location across both kinds.
- `tw4_onboarding_decide_tier` / `tw4_onboarding_set_tier` refuse a switch while the other path has an open approval (unused, or reserved and still held) or an active recurring authorization for the location (both directions; previously only Standard -> Low-Volume).
- Lock order: the path check takes no lock. Every fee write already holds its legal business row (authorize FOR UPDATE, recurring authorize FOR SHARE, recurring charge FOR NO KEY UPDATE, reserve under the runner lease), and a tier decision locks the onboarding and THEN that business FOR UPDATE: the runner's order (onboarding -> business -> credit account), so a decision and a fee write serialize without deadlock.
- A monthly charge of a recurring authorization (`rec:<authorization>:<period>`) follows the path checked when the owner authorized it (kind and price are fixed on the authorization); it is not re-checked each month.
- Re-verification: `tw4_onboarding_decide_tier` with Low-Volume Standard and the full checklist on an onboarding that is ALREADY Low-Volume Standard but unverified records a new decision (`reverified: true`), also after the B1 freeze (the tier does not change).
- The migration refuses to apply while a Low-Volume Standard location has an open Standard-priced approval or recurring authorization.

Application:

- `registrationPath.ts`: each path carries `brandPriceKind` and `campaignMonthlyPriceKind`. A paid Low-Volume Standard run asks the database (`tw4_runner_fee_kinds`, under the lease) before any Twilio write: path not verified -> `tier_ineligible`; no published price -> `tier_unpriced`; unreadable -> `exception`. It reserves and settles `brand_low_volume`. **The Standard run is unchanged** (no extra read; `brand`).
- Platform panel: the brand approval row of a Low-Volume Standard location records `brand_low_volume` at its own price; the "price not published" blocker reads that kind.
- Owner settings: the recurring panel offers the campaign fee of the location's path (`sms_location_fee_kinds`, owner/admin of the location); an unverified or unreadable path offers no campaign fee (number rent is path-neutral).

Prices stay DRAFT (`TW-4F-3b_Pricing_Proposal.md` §5). Without a published price, nothing of these kinds can be authorized (TW008).

ConfiDance: the pilot ceiling logic is kind-agnostic and unchanged: a pilot-funded approval of either brand kind still needs its own written approval for one location, and the cumulative $150 ceiling counts reserved + captured reservations of every kind. Standing recurring authorizations stay refused for the pilot business (TW011).

## 3. Deployment and rollback

- Hosted order: `20261128 -> 20261129 -> 20261130 -> 20261201 -> 20261202`. Apply 20261202 before deploying this app build: without it the owner's recurring panel offers no campaign fee (fail closed) and a paid Low-Volume Standard run stops at its readiness read. An older app build against 20261202 stays safe (it never authorizes low-volume kinds; a Standard brand approval for a Low-Volume Standard location is now refused).
- Rollback order: 20261203 (inbound usage recording, a later slice that builds on this one) BEFORE 20261202; this rollback refuses while `studio_sms_inbound_usage` exists.
- Rollback: application first, then `rollback/20261202090000_twilio_tw4f_financial_integrity_rollback.sql`. It refuses once any low-volume kind has been priced, approved, reserved, charged or authorized. It drops the registry (every reference remains on its spend event / pilot exception) and restores the previous function bodies; after it, a void approval's reference can be reused again.

## 4. Known limitations

- Test fixtures: approval references are permanent, so a local-stack suite that deletes its spend events in replica mode must delete its `studio_sms_approval_refs` rows too (done for the monthly, recurring-execution and 3a suites), or use per-run references.
- Pre-existing on main (not changed here): the R1 SQL suite pins 11 `tw4_runner_*` functions and the 4F-1b suite pins 14; main already has 15 (this branch adds `tw4_runner_fee_kinds`).

- Reference normalization is NFKC + whitespace + case. It does not fold punctuation or confusable letters from different scripts (`Owner email 2026-10-20` and `Owner email 2026.10.20` are different references). References are written by platform admins from the owner's written approval; the registry makes exact and near-exact reuse impossible, not every paraphrase.
- A cancelled onboarding is ignored when deriving the path; a new onboarding starts on the Standard default until a tier is decided.
- The runner reserves only the brand fee today; campaign vetting and number fees are not runner steps yet (later slices use the same kinds and triggers).

## 5. Independent review (Opus, 2026-10-20)

No P1. Six P2s, all fixed in this branch:

| # | Finding | Fix | Evidence |
|---|---|---|---|
| P2-1 | The onboarding share lock inside the path triggers inverted the runner's lock order (deadlock possible on Standard too) | Path check takes no lock; tier decisions lock onboarding then business | Two-session experiment on local QA with an injected delay: old order `deadlock detected`, fixed order proceeds; stress test in `localStack.tw4fi.test.ts` |
| P2-2 | A fee approval and a limit-ceiling approval with one reference could both commit | Advisory lock per normalized reference in every namespace | Race test (6 rounds, exactly one recorded) |
| P2-3 | Zero-width / soft-hyphen / dash / quote variants made new references | Normalizer strips format characters, folds dashes and quotes | Variant test (9 spellings refused) |
| P2-4 | Recurring charges re-checked a path that can drift; no way to re-verify | Recurring charges pinned to their authorization; same-tier re-verification | Pinned-charge and re-verification tests |
| P2-5 | Pre-existing Standard-priced commitments on Low-Volume Standard locations would be stranded | Migration precondition refuses to apply | Code review (needs an unapplied database to exercise) |
| P2-6 | Approvals could commit between the duplicate check, the backfill and the triggers | `LOCK TABLE ... SHARE ROW EXCLUSIVE` at the start | Code review |

P3s addressed: replica-mode bypass (ALWAYS triggers, tested), replayed approval reported as new in the panel (now "already recorded"), NFKC length expansion (registry key limit 2000), ended campaign fee of the other kind blocking a renewal. P3s left: a 3-character database minimum for credit approval references (the panel requires 10; raising it in the database would change the Standard path), no panel blocker for "Low-Volume Standard chosen but unverified" (the database refuses the fee), the race of an uncommitted recurring authorization with a brand-new onboarding (fails closed at the next charge only for non-`rec:` reservations).
