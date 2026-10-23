# TW-4F F5: provider release adapters and offline contract tests (dark)

Baseline: `main` 960a9d02. Tracker items: A-11 (provider cancellation adapters), P-1 / P-2 (offline request-shape contract for every real adapter method).
Local and offline only. Nothing here calls Twilio, applies SQL, deploys, or switches anything on.

## What changed

* **Real adapters (`real.ts`)**: new methods only. Each URL was checked against Twilio's public API reference on 2026-10-22, and the code comment next to it records the reference.
  * `RealNumberAdapter.releaseNumber(PN)`: `DELETE /2010-04-01/Accounts/{AC}/IncomingPhoneNumbers/{PN}.json`.
  * `RealNumberAdapter.detachNumber({MG, PN})`: `DELETE /v1/Services/{MG}/PhoneNumbers/{PN}`. This does not release the number.
  * `RealNumberAdapter.numberPresence(PN)`: GET of the number.
  * `RealProvisioningAdapter.deleteCampaign({MG, QE})`: `DELETE /v1/Services/{MG}/Compliance/Usa2p/{QE}`.
  * `RealProvisioningAdapter.deleteMessagingService(MG)`: `DELETE /v1/Services/{MG}`. Twilio deletes the service's campaign with it.
  * `campaignPresence` / `servicePresence`: GETs.
  * Only Twilio's documented 404 with code `20404` reads as "already absent". Every other failure propagates as `IsvApiError`.
  * A presence `200` about another SID or account throws; it never counts as an answer.
  * The only edit to existing code is widening `request()`'s method type to allow `DELETE`.
* **Interfaces (`releaseTypes.ts`)**: `NumberReleaseAdapter` and `ProvisioningReleaseAdapter` are separate from the provisioning interfaces, so code that only provisions cannot release.
* **Fakes**: `FakeNumberAdapter` and `FakeProvisioningAdapter` implement both interfaces. They have deterministic outcomes, and the existing `failNext` seam covers refusal, transient, lost response (applied but unseen) and unexpected.
* **`cancelRunner.ts`**: a pure runner with no I/O of its own; see "Runner semantics".
* **`cancelRuntime.ts`**: decides whether the panel may offer "Release at Twilio now"; see "When release is offered".
* **Panel**: `RecurringFeesCancel.tsx` shows a **Release at Twilio now** form beside the manual Begin/Withdraw. It appears only for an `authorized` operation and only when `cancelReleaseAvailable()` is true. `rflCancelReleaseAction` runs `requirePlatformAdmin()` first, takes the actor from the session, needs an irreversibility checkbox, and maps every runner outcome to a fixed sentence.

## Runner semantics

1. **Preconditions, read only.** A refusal here claims nothing and calls nothing.
   * The target must be readable.
   * The provider SID must match its kind, and the subaccount SID must be recorded.
   * The operation must be `authorized`.
   * A campaign needs its Messaging Service SID.
   * A Messaging Service needs no live dependents.
   * A number needs a **consumed** `cancel_number` dual-control approval whose requester and approver are two **different** administrators (RFL Ops D3).
   * The adapter must exist and belong to the resource's subaccount.
2. **`tw4_rfl_cancel_begin`.** Only `execute` proceeds. `in_progress`, `reconcile` and `skip` are reported and never acted on. A claim about a different SID or kind than the one checked is recorded `unknown` (`target_mismatch`), and nothing is called.
3. **One release request.** It is never repeated.
   * A definite refusal is recorded `refused` with code `api`. A definite refusal means a parseable 4xx other than 404, 408 or 429, with kind validation or account.
   * Everything else is recorded `unknown`: transient, 429, 5xx, a network failure, an unreadable 2xx, an unexpected error, or a 404 without 20404. After that, every later begin answers `reconcile`.
4. **Read-back.** `absent` leads to `confirmed`, with the SHA-256 evidence digest of `{schema, operation, resource, kind, sid, account, release result, read-back, evidence source, observed_at}`. `present` or a failed read leads to `unknown`.
5. **If `finish` fails after the provider step**, the runner returns `record_failed` with the outcome and digest. The operator records it by hand, the operation stays claimed, and nothing is retried.

## Builder for J1 (`factory.ts` owner)

```ts
import { buildCancelRunner, type CancelRunnerDeps } from "@/lib/sms/twilioIsv/cancelRunner";
buildCancelRunner({
  ledger: new ProviderFeeLifecycleStore(createAdminClient()),      // tw4_rfl_cancel_begin / _finish
  targets,                                                         // CancelTargetSource (see open dependency)
  adaptersFor: async (accountSid) => ({                            // ONE subaccount, its own credentials
    numbers: numberCallsAllowed(env).allowed ? createScopedNumberAdapter(config, accountSid, token, env) : null,
    provisioning: provisioningCallsAllowed(env).allowed ? createScopedProvisioningAdapter(config, accountSid, token, env) : null,
  }),
});
```

* To light up the panel's real path, pass `realAdaptersFor` to `cancelReleaseRuntime(env, { realAdaptersFor })`. It also requires `provisioningCallsAllowed`.
* Token rotation: wrap the build the way `rotatingSubaccountAdapter` does, or return null on failure. The runner treats a throwing `adaptersFor` as "no adapter": nothing is claimed.
* Local fakes: `sharedFakeReleaseHubs()` returns the process-wide `FakeNumberHub` / `FakeProvisioningHub`. Use the same hubs when wiring R2a/R2b fakes, so local QA releases what it provisioned.

## When release is offered

All of the following must hold. Otherwise the panel keeps today's manual path.

* `TW4_CANCEL_RELEASE=on`. This is a new switch, off everywhere.
* The cancellation target read (migration 20261224090000) is applied. Where it is not, every release attempt is refused before any claim.
* An adapter path exists:
  * locally, the fakes, only when `fakeAdapterAllowed` holds (non-production, `TW4_ISV_FAKE=on`, loopback database);
  * on production, the real adapters, only when J1 supplies them and `provisioningCallsAllowed` holds.

## The cancellation target read: migration 20261224090000 (coordinator-approved 2026-10-22)

The service role has no privileges on `studio_sms_provider_resources`, `studio_sms_provider_cancel_ops` or `studio_sms_rfl_dual_requests`. `tw4_rfl_dual_list` lists only pending and approved requests.

`tw4_rfl_cancel_target(p_operation_id, p_actor)` is one NEW function:

* STABLE, `security definer`, `search_path` pinned;
* platform-admin checked (`42501` otherwise);
* `service_role` only, explicitly revoked from public, anon and authenticated;
* writes nothing, and changes no existing body.

It returns the operation status, kind, provider SID, subaccount SID, a campaign's live Messaging Service (same location and subaccount), a service's live campaigns (`live_dependents`) and, for a number, the dual-control approval.

For a number it **fails closed** (returns NULL) unless there is a `cancel_number` request that is all of the following:

* `consumed`;
* for the same resource;
* with the same `approval_ref_norm` as the operation;
* consumed by the authorizing administrator, no later than `authorized_at`;
* with `requested_by` ≠ `decided_by`.

An unknown operation also returns NULL.

* **Rollback:** `rollback/20261224090000_..._rollback.sql`, a plain `DROP`.
* **The SIDs:** go to the server-side runner only. They are never rendered and never logged.
* **Where the function is not applied:** the RPC fails (`PGRST202`), the target source reads "no target", the runner claims nothing, and the operator uses the manual path.

The database stays the backstop: the dual-control version of `tw4_rfl_cancel_authorize` refuses to create a number operation without consuming a second administrator's approval.

## Opus review (2026-10-22) and fixes

No P0.

* **P1-1 (fixed): already absent confirmed with no proof.** A DELETE 20404 followed by a GET 20404 could confirm a resource these credentials never saw, for example with a stale service SID or another subaccount's credentials. Fix: a free pre-claim presence read must show the resource present, with matching `sid` and `account_sid`, or nothing is claimed. This also stops a rotated credential from consuming the written authorization.
* **P1-2 (fixed in the read + runner): dual control not bound to the operation.** The approval is now bound by the SQL (same resource, `ref_norm`, consumer, time), and the runner also requires `dualControl.resourceId === target.resourceId`.
  * Residual: `tw4_rfl_cancel_begin` itself does not re-check dual control (an RFL-owned body, not changed here). The manual Begin path is unaffected.
* **P2-1 (fixed): facts can change between the check and the claim.** After the claim the runner re-reads the target. Any change (dependents, SIDs, account, status) is recorded `unknown` with `no_call_recheck_failed`, and nothing is deleted.
* **P2-2 (fixed): numbers under the provisioning gate only.** Supplied real number adapters are dropped unless `numberCallsAllowed` holds.
* **P2-3 (deferred): no provider facts in the evidence digest.** The digest commits to the normalized observation (release result, read-back, evidence source, time). Twilio request IDs would need `FetchLike` to expose headers, a change to shared real-adapter plumbing, left for a follow-up. The manual path's digest is weaker (typed by the admin).
* **P2-4 (deferred, RFL-owned): malformed execute reads as skip.** `ProviderFeeLifecycleStore.beginCancel` maps an `execute` reply without `provider_sid` to `skip`, leaving the operation `in_flight`. Reported to the RFL owner.
* **P3:** `target_mismatch` is renamed `no_call_target_mismatch`. A test pins that the runner never calls `detachNumber`. An async provider delete can make the read-back show `present`, giving a `cancel_unknown` alert: the safe direction.

### Opus re-review (2026-10-22)

P1-1, P1-2 and P2-2 are CLOSED. P2-1 is closed for registered resources.

* **New P2 (fixed): campaigns the inventory does not know.** Deleting a Messaging Service also deletes campaigns the inventory does not know about, such as an unknown-outcome R2a create or a console-created campaign. The runner now lists the service's campaigns at the provider (`findCampaigns`, an evidence-grade list) before the claim, and again after it. Any campaign, or a failed listing, means no delete: refused before the claim, or recorded `unknown` / `no_call_recheck_failed` after it.
* **P3 (fixed):**
  * The `record_failed` message no longer says the provider step ran when the code is `no_call_*`.
  * Upper-case ids are normalized.
  * The localStack suite now covers `in_flight` and a Messaging Service recorded under another subaccount.
* **P3 (documented):**
  * A lost `tw4_rfl_cancel_begin` response leaves the operation claimed with no provider call; it is resolved by hand after 20 minutes.
  * Once `TW4_CANCEL_RELEASE=on` but before 20261224090000 is applied, the button is offered and every click is refused before any claim.
  * The localStack fixtures are replica-mode rows: the real authorize ordering (consume, then insert) is argued from the function bodies, not exercised end to end.

## QA-only fixture note

The isoqa base image's `auth.users` is a stub. On the dedicated container `f5-rfl-pg` only, two changes were made so the existing RFL suites run as on hosted Supabase. No migration or repository file changes this.

* `email_confirmed_at`, `banned_until` and `deleted_at` were added (as `supabase_admin`) so that the RFL suites' fixtures insert.
* `grant update, delete on public.outbound_deliveries to authenticated` was added. Hosted Supabase grants this by default, and one tw4rflops assertion compares write behavior under that role.

## Shared local fakes with J1

J1's `factory.ts` exports `fakeNumberHub(env)` / `fakeProvisioningHub(env)` on the same `globalThis` keys this slice uses (`__tw4FakeNumberHub`, `__tw4FakeProvisioningHub`), so both share one hub per process. Whichever creates a hub first wins; J1's seeds the number catalogue. Once both are merged, `sharedFakeReleaseHubs()` can delegate to J1's accessors.

## Contract findings (offline)

* Every real R2a / R2b method is pinned: HTTP method, URL, query and form.
* The campaign request's required Usa2p parameters and documented lengths are asserted: Description 40–4096, MessageFlow 40–2048, 2–5 samples of 20–1024, messages 20–320, keywords ≤ 255 alphanumeric.
* `serviceFriendlyName` / `numberFriendlyName` slice at 128 characters, while Twilio's Messaging Service FriendlyName limit is 64. Realistic names (env + UUID + sequence) are ~55 characters, and the test pins that they fit. A longer env name would exceed 64. P3, owned by R2a/R2b.

## Activation blockers (unchanged by this slice, plus)

* Apply 20261224090000 (after 20261211090000; SQL before app).
* J1 wiring.
* A controlled first real release on a non-pilot test subaccount: read the provider's answer to DELETE (Twilio documents 204 for PhoneNumbers; the Usa2p and Service deletes are assumed 204) before `TW4_CANCEL_RELEASE` is switched on anywhere.
* Owner approval for an automated irreversible provider action.
