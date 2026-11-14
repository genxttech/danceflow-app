# TW-4F price publication runbook (ConfiDance pilot, Low Volume path)

Status: PREPARED, NOT EXECUTED. Nothing below is authorized until the owner approves the bounded release in the decision package. Executing it never bypasses the hardware-key or separate-session rules: those are enforced by the database, not by this runbook. Data for the six proposals: `docs/twilio/pricing/ConfiDance_pilot_price_manifest.json` (validated by `src/lib/sms/__tests__/pilotPriceManifest.test.ts`).

## A. Preconditions (re-verify read-only immediately before starting)

1. PROD has none of `20270210090000`, `20270210100000`, `20270210110000`, `20270212090000` (probe `to_regprocedure('public.tw4_price_propose(text,integer,integer,text,text)')` is null; `studio_sms_price_list` has 0 rows). `20261231130000` is applied.
2. `tw4_price_set` md5 is `36b3548cfa94cce34e7df10c2a74981f` (the 20261122 body the first migration pins); `auth.sessions`, `_tw4c_admin`, `_tw4_r1_is_platform_admin`, `_tw4c_truncate_guard` exist. All verified 2026-11-09.
3. PR #441 merged and its app build ready as a staged (not promoted) production deployment, with the previous production deployment recorded as the rollback target.
4. The owner has a hardware security key (two preferred: primary plus an offline recovery key) and an authenticator app enrolled on the platform account.

## B. Release order (each step a separate gate; stop on any unexpected result)

1. Apply SQL in this order, each from a scratch workdir with `supabase db query --linked -f`, files line-ending normalised, postflight after each: `20270210090000`, `20270210100000`, `20270210110000`, `20270212090000`. Each file fails closed on a wrong precondition, so a wrong order or a drifted function cannot half-apply.
2. Postflight: all four function groups present; `service_role` and `anon` have EXECUTE on none of the owner-ceremony functions and on `tw4_price_propose_micros`; `tw4_price_set_micros` ungranted; trigger count assertion in `20270210100000` passed; `studio_sms_price_list` still 0 rows.
3. Promote the PR #441 app build (the form accepts up to six decimals for the two per-segment kinds). 30-minute observation as in the previous releases.
4. Owner-level bootstrap (no application path): `_tw4price_bootstrap_with_recovery` with the relying party id, allowed origins, the primary credential and the recovery credential, then `_tw4price_attest_begin` / `_tw4price_attest_finish` so each credential carries its proof. Production setting `monitoring_expected = true` (hosted preflight enforces it).

## C. The six proposals (owner at the keyboard)

Order and amounts are in the manifest. For each of the six kinds:

1. Sign in, complete the authenticator code (must be at most 10 minutes old) and open Platform > SMS > Price changes > Propose a price change. Enter the kind, the customer price and provider cost from the manifest (dollars, up to six decimals for `sms_usage` and `sms_inbound`), the description and the reason. Submit. Result: request pending, cooling-off 24 hours, nothing published.
2. Wait at least 24 hours. Nothing a function, an administrator or a service key can do shortens this; it is a row constraint.
3. In a DIFFERENT session (sign out and in again), open the same panel, choose Authorize with my hardware key, read the summary (it comes from the database and shows the exact micro-dollar amounts, for example `$0.017`), and touch the key. The database verifies the signature over the hash of those exact values and publishes.
4. One open proposal per kind exists at a time, so all six can be proposed on the same day and authorized the next, each with its own touch.

A micro-dollar proposal is not revised: withdraw it (Withdraw proposal) and propose the corrected amounts, which restarts the cooling-off. Team-mode approval of a micro request refuses by design.

## D. Verification after publication

1. `select public.tw4_price_verify()` returns `ok: true` with no `price_unattested` or `request_anomaly` entries.
2. Six active rows in `studio_sms_price_list`; `sms_usage` shows `unit_price_micros = 17000`, `sms_inbound` `13000`; cents columns are the ceilings (2 and 2).
3. `studio_sms_price_audit` has a `proposed`, `challenge_issued`, `authorized` and `published` event per kind; the monitoring feed carries the same events.
4. Billing, sending and every SMS flag remain OFF. Publishing prices does not enable anything.

## E. Rollback

Reverse order: `rollback/20270212090000_...` (refuses while a micro request exists), then the `20270210110000`, `20270210100000`, `20270210090000` rollbacks. The rollbacks never restore a single-administrator publication path. Application rollback: promote the recorded previous production deployment first.

## F. Known verification gap (kept open on purpose)

Local test PA-33 (`session binding on every pricing entry point`) fails on the unchanged baseline too: the local database cannot create `auth.sessions` (`permission denied for schema auth`), so the "missing or non-uuid session id is refused, a uuid session must exist and belong to the caller" cases are not exercised locally. PROD has `auth.sessions`. Before relying on that control, exercise it against a real GoTrue-backed database (the `*.realtokens.test.ts` suites, or a hosted DEV rehearsal) and record the result; this runbook does not waive it.
