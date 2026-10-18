# TW-4F-3a: account-scoped adapter, subaccount provisioning, spend cap (design, fake-only)

Status 2026-10-18. Design only, follows section 13 of `TW-4F_Production_Onboarding_Plan.md` (D2 revised: a Twilio subaccount per studio legal business). Nothing here calls Twilio or touches a hosted database. Implementation (local, fake adapter, local QA stack) starts only after this design is reviewed.

## Scope
In: legal-entity and subaccount tables, account-scoped adapter and fake, step P2 (create subaccount) with gate G-SUB, spend cap and ledger, account-SID columns and consistency checks, audit, tests. Out: Messaging Service, campaign, number, webhook mapping (4F-3b, 4F-4), `closeSubaccount`, any real Twilio method that is not already in `IsvAdapter`.

## 1. Data model (one migration, `2026112x…_twilio_tw4f3a_subaccounts.sql`, not applied to DEV/PROD without approval)
- `studio_sms_legal_entities(id, legal_name, ein_last4, spend_cap_cents int not null default 0, created_at)`. No EIN. Service role only, like the 4A tables.
- `studio_sms_entity_studios(studio_id pk, legal_entity_id)`: explicit multi-location link. A studio belongs to exactly one entity; many studios may share one. Linking a second studio is a platform action that requires matching legal name and EIN last four (checked server-side against the first studio's onboarding).
- `studio_sms_twilio_accounts(legal_entity_id pk, twilio_account_sid unique check ~ '^AC[0-9a-f]{32}$', environment, status in ('active','suspended','closed'), friendly_name, created_by, created_at)`. **No token column.** One row per legal entity (database-enforced).
- `twilio_account_sid` (nullable until P2) added to `studio_sms_onboarding`, `studio_sms_provisioning_steps`, `studio_sms_onboarding_audit`, `studio_sms_registrations`. Trigger/check: when a step or registration records a SID, `twilio_account_sid` must equal the entity's `studio_sms_twilio_accounts` row for that studio's entity; steps after P2 are refused without it.
- `studio_sms_spend_events(id, legal_entity_id, kind in ('brand','campaign_vetting','number','monthly'), amount_cents, status in ('authorized','incurred','void'), approval_ref text not null, authorized_by, created_at)` and a function `tw4_runner_spend_check(entity, kind, amount)` that refuses when `sum(authorized/incurred) + amount > spend_cap_cents` or no approval row exists. ConfiDance cap: 15000, set by a platform-admin action, never by default.
- Audit action `runner_subaccount_created` and `runner_spend_authorized`; ledger step key `P2`.
- Rollback file with the same guard pattern as 4F-1b (refuses once subaccount or spend rows exist).

## 2. Adapter and runner
- `IsvAdapter` is split: `IsvAccountAdapter` (every existing method, constructed with one account SID and its credential) and `IsvParentAdapter` (`findSubaccount(friendlyName)`, `createSubaccount(friendlyName)`, `getSubaccountCredentialFor(sid)`; parent credentials only, used for nothing else). `forAccount(sid)` on the factory returns the scoped adapter; there is no unscoped call path.
- Credential strategy (decision for the Opus review, default proposed): **runtime fetch of the subaccount auth token through the parent API, in-memory only, 5-minute cache, never persisted or logged**; the alternative (per-studio revocable API key, encrypted with the existing key-id pattern) is documented but not built. A scoped adapter asserts the account SID it was built for on every request and the runner asserts it equals the DB row before each step.
- P2: deterministic friendly name `df:{env}:{legal_entity_id}`; lookup first; an unknown outcome is reconciled by lookup before any retry; never auto-retried after an ambiguous response. G-SUB is a one-shot lease-bound confirmation in `studio_sms_submission_confirmations` (new `kind` value `P2`), typed `SUBMIT`-style phrase distinct from S11/T6, and it also requires the entity's spend cap to be set (creation itself has no documented fee, but the cap proves the owner's budget decision exists).
- Fee steps (B1 now, campaign/number later) call `tw4_runner_spend_check` before the adapter; failure ends the run with a new outcome `spend_cap_blocked`. Cap never auto-closes anything.
- Fake: `FakeIsvAdapter` becomes a registry of accounts. Resources belong to one account; using an SID from another account returns a not-found error exactly as Twilio would, so isolation bugs fail in tests. The fake parent can create subaccounts idempotently by friendly name.
- Real adapter: only the scoped constructor changes (basic-auth pair = subaccount SID + token; Addresses path uses the scoped SID). `TW4_ISV_REAL_CALLS` and the production fence are unchanged. Q-hdr (a scoping header) is deliberately not used.
- Stage A/B harness: untouched.

## 3. Authorization, isolation, audit
- Tables have no API privileges; all access through `tw4_runner_*` / new `tw4_entity_*` service-role functions that re-check the platform-admin actor (as today). Owners never see account SIDs.
- Every runner and audit row stores the account SID; the platform evidence view shows it (SID only).
- Cross-entity tests: studio A's runner cannot use studio B's subaccount, a forged account SID on a ledger write is refused by the DB check, two studios of one entity share one subaccount, two entities cannot.

## 4. Test plan
Unit (runner/fake): P2 happy path; replay is a no-op; crash between ledger write and reply reconciles; ambiguous create never retried; G-SUB missing/expired/consumed/other-lease refused; spend cap exact boundary, over-cap, no approval, void events; scoped adapter rejects foreign SIDs; mutation checks on each guard. Local-stack real SQL: constraints, grants (service role only), account/entity consistency triggers, rollback guard. E2E: platform panel shows the subaccount step and gate, refuses without the phrase and without a cap. Opus review: authorization boundary, credential handling, account isolation, spend enforcement.

## 5. Decisions needed from the owner before implementation
1. Credential strategy: runtime-fetched token (proposed) vs encrypted per-studio API key.
2. Whether G-SUB may be satisfied in the same run as the S10 evaluation (proposed: no; it is its own run, as for S11).
3. Entity linking rule for extra locations: automatic when legal name and EIN last four match (proposed, with platform confirmation) vs fully manual.

Real work that stays blocked: Q1b (cross-account Primary assignment), Q1c (webhook token) answers from Twilio; real subaccount creation; every fee.
