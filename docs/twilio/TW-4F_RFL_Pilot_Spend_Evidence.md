# TW-4F: pilot SPEND approval evidence (owner decision U-4, every pilot spend approval)

Status: Git-only, dark. Migration `20261230090000_twilio_rfl_pilot_spend_evidence.sql` (rollback in `rollback/`) is **not applied to any shared environment**.
Validation (real database, dedicated container, fresh scratch DB per suite, serial; base schema + every main migration 20261208..20261229 then 20261230): `localStack.tw4rflspend` 76/76, `tw4rflevid` 60/60, `tw4rflops` 64/64, `tw4rfl` 87/87, `tw4rfld5` 21/21,
`r2brfl` 28/28, `f4recovery` 31/31, `j4activation` 10/10, `f1funding` 25/25. Through the isolated-QA harness (`scripts/qa/iso-qa.mjs run main` plus the 1228/1229/1230 migrations from this branch): `tw4f3a` 16/16, `tw4f3b0` 18/18, `feeres` 46/46, `r2a` 29 passed + 1 skipped by design (the
R2a-only rollback test skips when layers sit on top). BLOCKED: `tw4fj1` (fails identically in its first `beforeAll` assertion on plain main without 20261230 in the harness, 11 skipped: harness limitation, not this change), `r2b` (53 skipped: refuses the merged chain by design), the Playwright spec
`e2e/tests/sms-subaccount-panel-fees.spec.ts` (no auth-capable isolated stack). Migration chain: before 1230 = after rollback (function fingerprint and column hash equal; the three predecessor bodies restored with their grants), re-apply identical; the three new body md5s match `pg_proc`; rollback refuses with
evidence rows present and when a body was redefined; the apply precondition refuses a live evidence-free pilot approval and an existing pilot exception, and applies once cleared. Two test-side defects were found and fixed (audit rows are attributed to ANY location of the business; the credit-with-period position);
the `r2a` layered-rollback test now clears the fixture evidence inside its rolled-back transaction because the 20261230 rollback refuses while evidence exists, by design.
Builds on #305 (`20261229090000`, `docs/twilio/TW-4F_RFL_Pilot_Approval_Evidence.md`), which gave the pilot PERIOD cover structured evidence.
That note recorded the remaining gap as the PILOT-ACTIVATION BLOCKER: `tw4_spend_authorize(..., 'pilot', ...)` and `tw4_pilot_exception_create` still accepted a bare reference. This change closes it.

## 1. Rule

An approval reference must point to a dated, explicit written owner authorization. A reference alone is not authorization. Every pilot spend approval now carries the same structured evidence as #305:

| Field | Rule |
| --- | --- |
| date | not later than the UTC date, not older than 400 days |
| role | `founder_written` or `owner_written` |
| scope | one of the five below; must allow the fee kind |
| amount | in cents; equal to the amount being approved (which the database already requires to equal the published price), or the ceiling for the exception |
| period | only for `pilot_period_cover` (YYYY-MM); null for every other scope |
| document | an opaque id (6 to 120 of letters, digits and `. _ / # + -`) or a plain `https://` link (no query, fragment, credentials, `;` `&` `=` `%`) |
| sha256 | 64 lowercase hex characters (the SHA-256 of the exact bytes of the retained file) |

The text of the authorization is never stored: only the hash and the document reference (it may hold personal data; the hash lets an auditor match the retained document). The UI never echoes what was typed.

### Scope enum (exhaustive; a scope or a fee kind outside the map is refused, never defaulted)

| Scope | Used by | Fee kinds it allows |
| --- | --- | --- |
| `pilot_exception` | `tw4_pilot_exception_create` | none (it is not a fee; amount = the ceiling) |
| `pilot_onboarding_fee` | `tw4_spend_authorize` (pilot) | `brand`, `brand_low_volume` |
| `pilot_campaign_fee` | `tw4_spend_authorize` (pilot) | `campaign_vetting`, `monthly`, `monthly_low_volume` |
| `pilot_number_purchase` | `tw4_spend_authorize` (pilot) | `number` |
| `pilot_period_cover` | `tw4_rfl_pilot_cover` through `tw4_spend_authorize` | `number`, `monthly`, `monthly_low_volume`; requires the period |

The same map is in SQL (a `case ... else false end`, so an unknown kind such as `sms_usage` is refused) and in TS (`SCOPE_KINDS` / `scopeAllowsKind`); a shape test asserts they agree.
`pilot_period_cover` is not offered by the fee-approval form; a direct caller of `tw4_spend_authorize` could use it (with a period), which only records an authorization with period-cover evidence
and consumes the ceiling later exactly like any other approval, so it is allowed but documented.

## 2. Entry points and how each takes evidence

Inventory of the merged chain (to 20261229): spend approvals are inserted in exactly one place, `tw4_spend_authorize`; reservations are inserted by `tw4_spend_reserve` and the R2a/R2b reservation helpers, which only
**consume an already-authorized event and read its funding** (every other reservation insert in the chain, recurring/usage/commitment/reconciler, is hard-coded `'credit'`). The pilot exception is created only by `tw4_pilot_exception_create`.
So there are exactly two chokepoints (plus the #305 cover that calls the first):

* **`tw4_spend_authorize(p_entity_id, p_kind, p_amount_cents, p_approval_ref, p_actor, p_funding default 'credit', p_studio_id default null` + seven evidence arguments, all `default null`)**
  (`p_evidence_authorized_on date, p_evidence_role, p_evidence_scope, p_evidence_amount_cents int, p_evidence_period_key, p_evidence_document_ref, p_evidence_sha256`).
  * `funding = 'pilot'`: every evidence argument is required and validated (TW052). The existing 22023 pilot checks (location, reference of 10+ characters, the exception exists) come first and are unchanged.
  * `funding = 'credit'`: any evidence argument is refused (TW052), so credit behaves exactly as before for every existing caller (they pass the seven original arguments). The default-null arguments are acceptable **only** because
    pilot refuses without them and credit refuses with them; both are tested, argument by argument.
  * Same order as before: admin check, legal business row `for update`, validations, reference advisory lock and replay, price (TW008), spend cap (TW004), insert. The evidence row is written in the same transaction, after the event, under the `tw4.pilotev_write` flag.
  * Replay: an identical retry of a still-unused approval must carry the SAME evidence (else TW019); the existing reference-reuse refusal (TW019) is unchanged.
* **`tw4_pilot_exception_create(p_entity_id, p_ceiling_cents, p_approval_ref, p_actor` + six evidence arguments, no defaults)**: evidence is always required; scope `pilot_exception`; the evidence amount must equal the ceiling being created. The existing
  validations (admin, ConfiDance business, ceiling at most $150 and within the cap, reference of 10+ characters, plus a new upper bound of 200 characters for consistency with the other approval tables) come first; the evidence checks come next, then the
  existing replay (another ceiling is still 23505; a replay needs the same evidence, otherwise TW019; an existing exception recorded without evidence cannot be replayed into compliance, TW052). This function does not hard-code $150 beyond what it already did.
* **`tw4_rfl_pilot_cover` (the #305 cover)**: same signature and behavior; its call to `tw4_spend_authorize` now passes its already-validated evidence through. One transaction creates the cover, the spend approval, the cover evidence row (#305 table) and the spend
  evidence row (new table); the two rows carry the same fields and cannot disagree (a real-schema test compares them; a refused cover leaves neither).

### Automated paths: policy

Runners, F1/F4/F5 adapters, J4 activation and the ledger helpers never authorize a pilot spend: they only reserve against an event an administrator already authorized, reading `funding` from it. They need no evidence, cannot invent any, and are unchanged.
An authorized pilot event without evidence cannot exist after this migration (the only inserting function requires it), and the apply precondition (section 4) refuses a database where one exists. A real-schema test asserts `tw4_spend_authorize` is the only function that
inserts a spend approval. Nothing here lets an automated path "hold or refuse" differently: if no authorized event exists, they already stop.

## 3. Storage

New table `studio_sms_pilot_spend_evidence` (a sibling of #305's cover evidence table; its shape did not fit: this one is keyed to a spend event or to the business's pilot exception): `subject` (`spend_event` | `pilot_exception`), `spend_event_id` (unique, FK `on delete restrict`),
`legal_entity_id`, `studio_id`, `fee_kind`, `scope`, `period_key`, `authorized_on`, `authorized_by_role`, `amount_cents`, `document_ref`, `document_sha256`, `recorded_by`, `recorded_at`. A shape check ties the subject to its columns (an exception has no event, location, kind or period; a period
is present exactly for `pilot_period_cover`), and a unique index allows one exception evidence row per business. RLS on, every privilege revoked from every API role including `service_role`. Its own append-only guard (`_tw4pse_guard`, own flag `tw4.pilotev_write`, `enable always`):
update, delete and truncate are refused; an insert is accepted only under the flag and only for the record it describes (a pilot-funded spend event of that business/location/kind/amount/approver, or the business's own exception with that ceiling/approver). The shared guards are not replaced.
Audit: the existing `spend_authorized` and `credit_pilot_exception` audit rows now name the evidence id, scope, role and the first 12 hex of the hash (the audit vocabulary is unchanged).

## 4. Replaced functions, apply precondition, operator procedure

* md5 prechecks inside the migration (before any DDL): `tw4_spend_authorize` 20261202 body `6a166997fafa89b0b6c6b0d7054c9a0b`, `tw4_pilot_exception_create` 20261122 body `9a26f8aa67f6d438748de2ce168106c1`, `tw4_rfl_pilot_cover` 20261229 body `deffc1b878778dced134334260d62512`.
  A shape test also proves these are the latest definitions on the chain. Both old signatures are **dropped** in the same migration; a call with the old shapes fails (4 arguments: no such function; 7 arguments: lands on the new function with null evidence and is refused for pilot).
* New bodies: `tw4_spend_authorize` `daee5a70b4c7fe97cc35e9f172ef78fb`, `tw4_pilot_exception_create` `171b2d12a7476290b3e3efcdab71cef8`, `tw4_rfl_pilot_cover` `f5dffdaa3062febef97fa2ce9b0fa422` (pinned in the rollback; the cover body differs from #305's only by the pass-through arguments).
* Grants: revoked from public, anon, authenticated; `service_role` only (as today); the guard function is private.
* **Apply precondition (refuses with a clear message):** (a) any live pilot-funded spend approval (`funding = 'pilot'`, status `authorized` or `reserved`) that is not the spend approval of a #305 cover carrying cover evidence; (b) any row in `studio_sms_pilot_exceptions`.
  Void/released history does not block. Hosted DEV and PROD have none per the 2026-10-24 probe. **Operator procedure if it refuses locally:** withdraw unused approvals with `tw4_spend_withdraw` or let them be released/settled through their normal path, and for the exception
  use a database where it has not been created (an exception is permanent and this migration never deletes or edits one); then apply. Nothing is grandfathered silently.
* **Rollback** (`rollback/20261230090000_twilio_rfl_pilot_spend_evidence_rollback.sql`): md5-checks the three live new bodies first (a later migration that redefined them must be rolled back first), **refuses while any evidence row exists**, otherwise drops the new functions, table and
  guard and restores the three predecessor bodies byte for byte (grants restored), then re-checks all three md5.

## 5. UI and TypeScript

`src/lib/sms/pilotApprovalEvidence.ts` is extended (all five scopes, `SCOPE_KINDS`/`scopeAllowsKind`/`scopesForKind`, the validator takes an allowed-scope list and an optional period, `spendEvidenceParams`/`exceptionEvidenceParams`).
A shared form component `src/app/platform/sms/PilotEvidenceFields.tsx` (date, role with blank default, scope, document id/link, sha256, with the "reference alone is not authorization / text is never stored / no share links or names / hash of the exact file bytes" help) is used by the pilot-exception form and
(inside a closed block, not `required`, so credit approvals are unaffected) by the owner fee-approval forms; the amount is the form's own amount (the published price shown, or the ceiling). `panelCommands.authorizeFee` / `createPilotException` validate before any store call
(upper-case sha256 is lower-cased first); the stores (`panel.ts`, `entityStore.ts`, `creditStore.ts`) pass the evidence; `panelErrorMessage` maps TW052 to a fixed sentence. The #305 cover form and action are unchanged.

## 6. Callers of the changed functions

| Caller | Status |
| --- | --- |
| `src/lib/sms/twilioIsv/panel.ts`, `entityStore.ts`, `creditStore.ts`, `panelCommands.ts`, `app/platform/sms/SmsSubaccountPanel.tsx` (+ new `PilotEvidenceFields.tsx`) | updated |
| `src/lib/sms/providerFeeLifecycle.ts`, `recurringFeeActions.ts`, `RecurringFeesPilot.tsx` (the #305 cover) | unchanged (same signature) |
| `src/lib/sms/twilioIsv/__tests__/panel.tw4fpanel.test.ts` | forms get evidence fields (assertions kept) |
| real-schema suites: `localStack.f1funding`, `f4recovery`, `j4activation`, `r2brfl`, `tw4rfld5`, `tw4rflops`, `tw4rflevid`, `tw4rfl` (exception fixtures through `pilotExceptionArgs`; `tw4rfl` also its two pilot authorizes through `pilotSpendArgs`) | updated at call sites only |
| real-schema suites over PostgREST: `localStack.r2a`, `r2b`, `tw4fj1`, `feeres` (wrapper params through `spendEvidenceRpc` / `exceptionEvidenceRpc`), `tw4f3a` (store calls with evidence objects; privilege signature list), `tw4f3b0` (privilege signature lists) | updated at call sites only |
| `tw4rflops` body-fingerprint check, `tw4rfl` rollback-copy test (rolls 20261230 back first), `tw4rflevid` scratch scenarios (roll 20261230 back first), `rflPilotEvidenceMigrationShape.rflevid.test.ts` (windows bounded to before 20261229) | updated (forced by the new bodies/order) |
| `e2e/helpers/tw4fFixture.ts` (exception creation) and `e2e/tests/sms-subaccount-panel-fees.spec.ts` (drives the exception and pilot fee forms) | updated (forced by the signature/forms) |
| credit-funded callers (`tw4monthly`, `tw4fi`, `tw4f3a` credit paths, `e2e/helpers/smsOnboardingFixture.ts`) and direct fixture inserts under `session_replication_role = replica` (`tw4monthly`, `tw4recexec`, `tw4inbound`, `tw4recon`, `tw4sender`, `tw4usage`, `j3owner`, `f4recovery`, `tw4fi`, `j4activation`) | unchanged: credit takes no evidence; direct fixture inserts are test setup and bypass the functions |
| NOT updated (not mine): `scripts/hosted/tw4f/probe_fingerprint.sql`, `probe_objects.sql` (list the two functions at migration 20261122090000), `docs/twilio/TW-4F_Hosted_Apply_Manifest.md`, `TW-4F_Completion_Tracker.md`, the TW-4F design docs that mention the functions in prose | need a follow-up row/update for 20261230 (new table, three replaced bodies with the md5s above) |

## 7. Tests

Non-database (run): `rflPilotSpendEvidenceMigrationShape.rflspend.test.ts` (single transaction, md5 prechecks, latest-definition proof, old signatures dropped, defaults only on `tw4_spend_authorize`, minimal diffs vs predecessors, lock order, exhaustive scope map SQL = TS, apply precondition,
grants, rollback exact), `panelEvidence.rflspend.test.ts` (scope map, panel commands refuse every bad evidence before any store call, credit sends none, exception amount = ceiling, no echo), the updated panel/UI tests.
Real schema (results in the status block): `localStack.tw4rflspend.test.ts` (each entry point: happy path with evidence row and audit, every refusal, bare reference refused and not burned, credit refuses evidence, default-null arguments refused in every position, replay, TW019, admin-only,
old signatures gone, only function inserting approvals, grants, append-only, no text columns, races, cover pass-through consistency, apply precondition on a schema-only copy, rollback exactness and refusals), plus every existing real-schema suite listed above.

## 8. Residual risks

* Not run: `tw4fj1`, `r2b` (harness) and the Playwright spec (see the status block); rerun them where a stack exists. The PostgREST suites ran from the branch's committed tests against the harness's main chain plus 1228/1229/1230.
* A cover now has two evidence rows by design; they are written together and compared by a test, but a future change to one writer could drift them (the guard checks each row against its own record, not against the other table).
* The fee-approval form's evidence block is optional in the browser (so a credit approval is not blocked); the server and database enforce it for pilot.
* Same document hash recorded with a different date or role is not refused (possible later guard).
* The 7-argument call of a pilot approval now fails with TW052, not "no such function": any external caller must send evidence.
