# WP-D3 tracking: the 29 mutating functions with zero calls in the WP-D0 baseline

Source: `coverage.md` (track_functions=all, one fresh DB per suite, scope = probe_fingerprint.sql names, 277 volatile, 248 called, 29 never called).
Classification was derived from the repo (migrations for the trigger wiring and grants, `src/**` tests for callers), not from guesses.
Suite names below are the `localStack.*` vitest files under `src/lib/**/__tests__`.

## Meter limitation that explains class A (raising functions)

`pg_stat_user_functions` is updated when a function call returns normally. A trigger function whose job is to `raise exception` never returns, so its calls are
not counted even when a passing test fires it. Several class A functions below are fired by passing suites (evidence column) and still show 0. See the
verification note at the end of this file. For class A the right WP-D3 check is therefore NOT the meter but a firing test (below) plus the existing assertion text.

## A. Guard triggers (10 functions): count only when the trigger fires, and a firing guard raises

| Function | Trigger (table, event) | Existing test that fires it | How a firing test covers it |
|---|---|---|---|
| `_sms_onb_refuse_truncate` | `studio_sms_provisioning_steps_20_no_truncate` (and sibling onboarding tables), BEFORE TRUNCATE | none found by message | `truncate public.studio_sms_provisioning_steps` as the owner, expect the raised refusal (inside `begin; ... rollback;`) |
| `_sms_webhook_receipts_guard` | `sms_webhook_receipts_10_append_only`, BEFORE UPDATE/DELETE | none (only route tests with a mocked RPC) | insert a receipt via `sms_webhook_receipt_record`, then `update`/`delete` it, expect 42501 `append-only` |
| `_tw4c_truncate_guard` | credit ledger / top-ups truncate triggers | `tw4f3b0` ("never truncated") | already fires; covered functionally, invisible to the meter |
| `_tw4f1b_confirmations_truncate_guard` | `studio_sms_submission_confirmations_truncate_guard` | `tw4f1b` line 411 (suite is a KNOWN failure, 18/19; this assertion is not the failing one) | already fires |
| `_tw4fi_append_only` | `studio_sms_approval_refs_10_append_only`, BEFORE UPDATE/DELETE | `tw4fi` ("approval references are permanent") | already fires |
| `_tw4ml_guard` | `studio_sms_entity_timezones_guard`, `studio_sms_monthly_limits_guard`, BEFORE UPDATE/DELETE | `tw4monthly` (truncate guard only found; row update/delete not asserted by message) | `update`/`delete` one row of each table, expect `rows are append-only` |
| `_tw4p1_guard` | `studio_sms_num_identity_reads_guard`, `studio_sms_num_history_reads_guard`, BEFORE UPDATE/DELETE | only reachable through r2b-only observe functions (class B) | needs a row from `tw4_num_identity_observe` / `tw4_num_history_observe` first (class B/C), then update/delete, expect `provider identity evidence is append-only` |
| `_tw4p_append_only_guard` | `studio_sms_panel_requests_10_append_only`, BEFORE UPDATE/DELETE | none by message | create a request row (`tw4_panel_subaccount_begin`), then update/delete, expect `append-only` |
| `_tw4us_append_only` | `studio_sms_usage_switch_log_guard`, `studio_sms_billed_senders_guard`, BEFORE UPDATE/DELETE | `tw4usage`/`tw4sender` mention append-only; function still 0 (see meter note) | update/delete a switch-log row and a billed-sender row, expect the guard message |
| `prevent_sms_consent_history_change` | `trg_sms_consent_history_immutable` (UPDATE/DELETE) and `..._no_truncate` | none: `tw4recon` DELETES consent rows only after `session_replication_role = replica` (bypasses the trigger by design) | as a non-replica role: update, delete and truncate `sms_consent_history`, expect the refusal |


## B. Refused by design on the composed chain (exercised only by `localStack.r2b`, which BLOCKS on the merged chain): 11 functions

`localStack.r2b` refuses to run when the real recurring-fee lifecycle (20261209) is present, so these appear only there (grep of `src/**` tests; no other suite calls them):

`tw4_num_identity_observe` (r2b:789), `tw4_num_inventory_ack` (r2b:664, 741-830, 1498), `tw4_num_inventory_status` (r2b:1533, 1710), `tw4_num_orphan_exposure` (r2b:1714),
`tw4_num_orphan_resolve` (r2b:291), `tw4_num_recon_claim` (r2b:1359, 1588), `tw4_num_recon_mark` (r2b:1608), `tw4_num_reopen` (r2b:778-860, 1395),
`tw4_num_resolve` (r2b:668-1020), `tw4_num_settle_admin` (r2b:974, 1005), `_tw4num_free_selection` (internal helper called by `tw4_num_resolve` / the expiry path; only r2b reaches those).

WP-D3 action: port the relevant r2b scenarios to a suite that runs on the merged chain (r2brfl is the natural host: it already drives tw4_num_observe/retire/registration_*), or retire the r2b assertions that duplicate r2brfl. Until then these 11 have no passing coverage anywhere.

## C. Genuinely missing tests (no suite exercises them against a real database): 8 functions

| Function | Caller in app | Test state |
|---|---|---|
| `tw4_num_history_observe` | none yet (grants in 20261213) | referenced by no test at all (not even r2b); only `tw4_num_identity_observe` is in r2b |
| `tw4_panel_subaccount_confirm` | `twilioIsv/panel.ts:338` | no test references it by name (only the TS wrapper) |
| `tw4_usage_billed_sender_set` | admin path | `tw4usage:252` and `tw4sender:186` only assert that `service_role` has NO execute privilege; the positive path is never run |
| `tw4_usage_touch` | `usageReconciler.ts:105` | only mocked in `usageReconciler*.test.ts`; no localStack call |
| `record_sms_public_opt_in` | `publicConsent.ts` | mocked in `publicConsent.a2p1b.test.ts`; `consentIntegrity.tw2.test.ts` is static text |
| `upsert_sms_contact_permission` | `compliance.ts:258` | no test at all against the database |
| `sms_webhook_receipt_record` | webhook routes | mocked in `subaccountWebhooks.tw4f.test.ts` and `route.inboundUsage.test.ts`; never run for real |
| `purge_due_sms_onboarding_eins` | cron route `sms-onboarding-purge` | `route.test.ts` / `dryRun.tw4r1.test.ts` mock the RPC; `localStack.tw4a:136` only counts functions that mention the onboarding table |

WP-D3 action: one localStack test per function (positive path + the refusal that matters), reusing an existing fixture suite where one exists (tw4a for the onboarding purge, tw4recon for consent/receipts, tw4usage/tw4sender for billed sender, tw4a9/panel for the subaccount confirm).

## Totals

A 10 + B 11 + C 8 = 29.

## Verification note

* Callers, grants and trigger wiring were read from the migrations and from `src/**` tests (line references above). Class B is "only r2b" by exhaustive search of `src/**/*.ts(x)`.
* The meter limitation is inferred, not separately instrumented: `tw4f3b0` (PASS) asserts the `never truncated` refusal of `studio_sms_credit_ledger` and `tw4fi` (PASS) asserts the permanent-approval refusal, yet `_tw4c_truncate_guard` and `_tw4fi_append_only` show 0 calls. PostgreSQL only counts a function call that returns (`pgstat_end_function_usage` is not reached on an error exit). A direct confirmation would be a 3-line throwaway function that raises, called with track_functions=all; it was not run here.
* A guard that only counts when it "fires" therefore cannot be proven by this meter at all; WP-D3 should either assert the refusal text in a firing test (the real check) or teach coverage-report.mjs to list "raise-only trigger functions" as a separate, non-meterable class.
