# TW-4F: evidence-backed resolution of fee-bearing provisioning operations (design, 2026-10-21)

Baseline: `main` 54ca06be (R2a, R2b, RFL, R2c-I1/I2 merged). Migration `20261212090000` (`20261211` is claimed by the recurring-fee operations session). Local/synthetic only: no hosted SQL, no real Twilio call, no fee, no SMS. The application constant `FEE_RELEASE_ENABLED` stays `false`; this slice does not activate the UI control.

## 1. The problem

R2a let a platform administrator close a fee-bearing operation with an UNKNOWN provider outcome as "not created" (`tw4_prov_resolve`) and, through `tw4_prov_settle_admin`, release a held reservation, on a written note and a 20-minute wait alone. For a credit-funded business that returns money the provider may still be billing; for the ConfiDance pilot it returns headroom to the cumulative $150 ceiling, which a late-discovered resource can then no longer be counted against. Nothing recorded WHAT the provider showed.

## 2. Release paths and their basis (after this change)

| Path | Basis required | Recorded as |
|---|---|---|
| `tw4_prov_finish(failed)` on a fee operation | the provider's definitive refusal (`api` code, existing rule), and NO provider listing showing a resource for the operation (trigger) | `provider_refusal` |
| `tw4_prov_resolve('not_created')`, fee-bearing | two independent complete provider listings showing nothing (sections 3-4); never for the pilot business | `verified_absence` with both listing ids |
| `tw4_prov_resolve('created')` | an administrator's typed SID is only a claim; nothing is released or captured (unchanged) | `created_claim` |
| `tw4_prov_settle_admin('released')` | abandoned operation: its recorded `verified_absence`. A SUCCEEDED operation exists at the provider: no release at all until a provider-verified cancellation exists (the lifecycle's cancellation digest is administrator-typed, so it is not proof). Never for the pilot business | `settled_released` |
| `tw4_prov_settle_admin('captured')` | unchanged (capturing spends what the owner authorized) | `settled_captured` |
| `tw4_prov_observe` (provider-read campaign FAILED) | the provider's own verdict, judged by the database (unchanged) | `reservation_released` |
| generic `tw4_credit_resolve_reservation` | refuses `prov:%` reservations (unchanged) | n/a |

Every settlement of a `prov:` reservation, by ANY path, also leaves an automatic `reservation_released` / `reservation_captured` disposition (trigger on `studio_sms_credit_reservations`), so no path is unaudited.

Free operations (the Messaging Service) keep the written-attestation resolution: there is no fee to release.

Strict separation: definitive provider refusal, evidence-backed non-creation, provider creation confirmed (a `present` listing, an `observe` verdict) and unknown/inconclusive outcomes are different records. Incomplete evidence is never promoted to any of the others.

## 3. Evidence provenance

`studio_sms_prov_listings` (append-only, RLS on, no API privileges) is written ONLY by `tw4_prov_listing_record(onboarding, lease_owner, operation, facts, source, digest)`:

* service role, the onboarding lease held, the operation must belong to that onboarding and be a fee-bearing campaign (any status: a late observation of a closed operation is the point);
* the facts name the business's ACTIVE subaccount (`TW005` otherwise) and the Messaging Service the ledger itself created (`TW049` otherwise); the listed SIDs must be QE-shaped;
* one record per provider read (`read_id`, unique per operation). The same read replayed changes nothing; the same read with a different digest is refused (`TW046`);
* `read_started_at` (adapter clock) must be at most 10 minutes old, not more than 60 seconds ahead of this database (clock skew between machines; it is clamped to the database's time so skew can never make a read count as later than it was), not before the attempt, and AFTER the previous record's `observed_at` (database clock): two reads are never one read recorded twice;
* the fake source is accepted only where the local-QA marker exists;
* the database computes the verdict: `inconclusive` (listing not complete), `present` (anything listed), `premature` (read began less than 20 minutes after the attempt), else `absent`.

The TypeScript recorder (`checkCampaignAbsence`) takes an evidence-only lease (`tw4_prov_evidence_claim`: a platform administrator, any non-cancelled onboarding, no state change; needed because an unknown fee outcome parks the onboarding in `exception`, which the runner's claim refuses), performs the provider read (the adapter's complete listing or a throw; GET only), once per operation per call, and records exactly what the provider listed. A failed read is not recorded: a transport error is not evidence either way. The real adapter's campaign listing throws on a foreign or unlabeled row and on a next-page link it cannot follow (it used to read as a clean, complete listing), so a truncated or filtered listing can never be recorded as complete. The recorder never decides anything.

## 4. The absence proof (`_tw4prov2_proof`, used by `tw4_prov_resolve`)

A fee-bearing `not_created` needs ALL of: no `present` listing was ever recorded for the operation; the latest listing is `absent`, no older than 60 minutes; an earlier `absent` listing recorded at least 10 minutes before it, whose read began at least 20 minutes after the attempt; the later read began after the earlier was recorded; both are of the same scope and subaccount; no non-absent listing at or after the earlier one (an inconclusive read in between breaks the chain); fake evidence only on a local-QA database. Any other state fails closed with `TW046`.

Provider consistency: Twilio documents no read-after-write guarantee for campaign registration. Two spaced reads make a late-appearing resource unlikely to be missed but cannot prove it impossible. That is why (a) a `present` observation after resolution is never ignored (section 5), (b) the pilot business can never use this path, and (c) the fee is not the only protection: duplicate registration is also refused by Twilio and by R2a's one-campaign-per-service check.

## 5. Late discovery (orphans)

Any listing (including one recorded for an already abandoned or failed operation) that shows campaigns no operation of the business accounts for is recorded in `studio_sms_prov_orphans` (unique provider SID, idempotent), with two idempotent alerts through the recurring-fee lifecycle's queue (`studio_sms_provider_alerts`, kind `inventory_gap`, dedupe `prov_orphan:<id>:owner` / `:admin`). The owner text names no SID, amount or error and says the studio will not be charged; the administrator text carries the orphan id. Each STILL-OPEN fee-bearing attempt of the studio may own one unaccounted resource (the runner adopts it by lookup), so up to that many candidates are not orphans; more candidates than open attempts are ambiguous and ALL are recorded.

While an orphan is `open` or `registered` a BEFORE INSERT trigger refuses every fee-bearing row in both provisioning ledgers (`studio_sms_prov_operations`, `studio_sms_num_operations`) for that legal business (`TW047`). `tw4_prov_orphan_register` (administrator) registers it as lifecycle inventory (`tw4_rfl_register`, source `admin`), so its provider cost becomes exposure through the lifecycle's own scan and dispositions (`absorbed`, `not_billed_confirmed`); nothing here posts a charge to the studio. `tw4_prov_orphan_close` is refused unless a database-checked fact holds: (a) the ledger now accounts for the SID; (b) two complete provider listings of its scope, recorded after it was found, 10+ minutes apart, the latest within 60 minutes, none listing it (and no later listing showing it); or (c) the lifecycle shows the registered resource cancelled with its cancellation evidence. There is no adoption path in this slice; adoption belongs with R2b's L3.

Known interaction (RFL-owned, reported to that session): once registered, an orphan is a studio resource for the lifecycle's coverage and alert rules (periods covered by the studio's own recurring charge, owner "authorize" alerts and the sending gate when uncovered). Registering is therefore an explicit administrator step, not automatic.

## 6. ConfiDance

For the pilot business `tw4_prov_resolve('not_created')` on a fee-bearing operation and `tw4_prov_settle_admin('released')` are refused with `TW048` whatever the evidence. "Pilot" is judged by the exception row OR by the operation's own pilot-funded reservations (so removing the exception never makes them releasable by absence). The releases that remain are the provider's own evidence: a definitive refusal recorded by `tw4_prov_finish`, and a provider-read FAILED campaign judged by `tw4_prov_observe` (the not-yet-captured monthly fee). The shared pilot-ceiling function (`20261202`) is not touched: the ceiling can only shrink through provider evidence, never through an absence determination.

## 7. Interfaces and ownership

* R2a: this PR replaces `tw4_prov_resolve` and `tw4_prov_settle_admin` (a precondition check refuses to apply if either differs from the R2a text). R2a's own suite is updated for the new rules; its rollback test now takes later layers off first.
* R2b owns L1-L4 for NUMBERS (`tw4_num_resolve`, `tw4_num_settle_admin`, orphan adoption, scheduled inventory). Not touched. **Gap to close there:** R2b's `tw4_num_resolve('not_created')` and `tw4_num_settle_admin('released')` still release fee-bearing number reservations (including the pilot's, which count against the $150 ceiling) on an administrator's attestation. R2b's L2 can reuse the proof pattern in section 4. This PR adds only the generic orphan-block trigger on `studio_sms_num_operations`.
* RFL: registration (`tw4_rfl_register`), the alert queue (`_tw4rfl_alert`, kind `inventory_gap`), exposure and cancellation evidence are consumed unchanged (confirmed with that session: no signature or kind change in its `20261211`); no competing table. Delivery of the alerts remains RFL's.
* Application: `FEE_RELEASE_ENABLED=false` in `provisionLedger.ts` is unchanged, so the console still cannot release a fee. A future slice may lift it only after this evidence flow has a console surface and an owner decision.

## 8. Not done / residual

* No scheduler calls `checkCampaignAbsence`; nothing here enables one. An administrator or a future job must run it at least twice, 10+ minutes apart and 20+ minutes after the attempt.
* The provider-consistency limit above; a resource that appears after both clean reads is caught by the next listing as an orphan, after the fee was released (the exposure is then DanceFlow's, never the studio's).
* `read_started_at` is the adapter's clock; the database bounds it (not older than 10 minutes, clamped to its own time, after the previous record) but cannot prove it. The spacing rules use the database clock.
* Listings and orphans need the onboarding lease, so an onboarding CANCELLED while an operation is open cannot record further evidence (retire or resolve before cancelling, as R2b already documents).
* A succeeded operation's held reservation is not releasable by the console until a provider-verified cancellation exists.
* No console UI for the evidence yet (`tw4_prov_evidence` is the read).
* Orphan adoption (turning a found campaign into a ledger-owned resource) is not built.

## 9. Deployment and rollback

Requires 20261207, 20261208 and 20261209. Apply in numeric order. Rollback (`rollback/20261212090000_..._rollback.sql`) refuses once any listing, disposition or orphan exists (settlement dispositions are written automatically, so after the first settled provisioning reservation a rollback is refused by design), restores R2a's two functions verbatim and drops the tables, triggers and helpers; roll the application back first. The audit-vocabulary extension is left in place.
