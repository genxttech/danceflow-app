# TW-4F RFL operational alert delivery: runbook (PR 2 of 3, dark)

Application side of alert delivery for the recurring provider-fee lifecycle. It codes against the SQL contract that PR 1 (`20261211090000_twilio_rfl_ops.sql`) implements; nothing here is applied to, or deployed against, any hosted environment, and nothing is scheduled. Every step that touches hosted DEV/PROD, an environment flag, a database switch or a schedule needs the owner's explicit approval.

## 1. How delivery works

One scheduled pass (`runProviderFeeLifecycleScan`) runs in this order:

1. `tw4_rfl_scan_begin`: heartbeat. `ran=false` stops the pass (`switched_off` = database scan switch off, `busy` = another run holds the lease). Nothing else is done and nothing is finished.
2. `tw4_rfl_scan_entities` + `tw4_rfl_scan_entity` per business, then `tw4_rfl_inventory_gaps`.
3. `tw4_rfl_escalate_delivery`: on EVERY pass (even with delivery off), so an alert whose delivery was exhausted (failed, 5 attempts) raises one administrator alert `alert_delivery_exhausted`.
4. Delivery, only when a sink exists: `tw4_rfl_alerts_claim` -> sink -> `tw4_rfl_alert_finish`. Without a sink nothing is claimed; alerts stay pending and visible.
5. `tw4_rfl_scan_finish`: always once a run began. `failed` when any step errored, else `completed`. The summary is counts only.

The sink (`src/lib/sms/providerFeeAlerts/sink.ts`) resolves recipients with `tw4_rfl_alert_recipients` (verified, capped, audience-honouring, never crossing legal businesses: authorized by the database), renders the template for the alert kind, queues each email through the existing idempotent outbound queue (`queueOutboundDelivery`, sent later by `/api/notifications/send`), and records every outcome with `tw4_rfl_alert_delivery_record` using the claim token.

## 2. Flags and switches (all default OFF, all fail closed)

| Control | Where | Effect |
|---|---|---|
| `SMS_FEE_LIFECYCLE_SCAN` = `on` | env (existing) | the route answers 404 otherwise |
| `CRON_SECRET` | env (existing) | required by the route |
| database `scan` switch | `tw4_rfl_set_switch('scan', ...)` | `tw4_rfl_scan_begin` refuses the pass (`switched_off`) |
| `SMS_FEE_LIFECYCLE_DELIVERY` = exactly `on` | env | otherwise no sink is built (`yes`, `ON`, `true`, ` on` all count as off) |
| database `delivery` switch | `tw4_rfl_set_switch('delivery', ...)` | the route builds a sink only if `tw4_rfl_switch_enabled('delivery')` is true; a lookup error is off; the database also returns no claimable alerts while it is off |

Delivery therefore needs the env flag AND the database switch; either one off means alerts stay pending.

## 3. Recipient rules

- Owners: verified active `studio_owner`s of the alert's studio, or of every location of the legal business for an entity-level alert. Administrators: `platform_admin`s. At most 5 owners and 10 administrators. Only addresses that are present and email-confirmed.
- The sink re-checks the database rows: unverified or malformed addresses (`normalizeEmail`) are recorded `invalid_recipient` and never queued; rows outside the alert's `audience` are ignored; the caps are re-applied.
- Queue studio: the studio the recipient row names (owners). An administrator row without a studio uses the alert's own studio. If neither exists (entity-level alert, administrator) that recipient is recorded `invalid_recipient` and is NOT sent (the queue row needs a studio and the database names none): it fails visibly if nobody else is reached.
- Recipient reference: `<owner|admin>:<user_id>`, never an address. When there are no recipients at all the reference is `<owner|admin>:none` (admin for admin-audience alerts, owner otherwise) with outcome `no_recipient`.

## 4. What is and is not in an email

Templates are keyed per alert kind and per recipient kind: owner-addressed `platform_rfl_<kind>`, admin-addressed `platform_rfl_admin_<kind>` (an unknown future kind falls back to `platform_rfl_alert` / `platform_rfl_admin_alert`). Both start with `platform_`, so they are DanceFlow system mail with no studio reply-to and are operational, not marketing.

Body: the alert's already-sanitized `summary`, `Studio: <name>` for an owner recipient only, and one link (owner: `/app/settings/sms`; administrator: `/platform/sms`) built with `buildAppUrl`.

Never: a Twilio SID, token or credential, cents or any price, balance, provider cost or invoice reference. Defense in depth: a summary that looks sensitive (SID shape, `$` amount, the words cents/token/balance/credential/password/secret/invoice) is replaced by the kind's generic sentence. A unit test scans every template, recipient kind and a hostile summary for these.

### Who can read these rows

Admin-addressed rows are queued under a studio (the queue requires one) but are NOT readable by that studio's staff: the database adds an RLS exclusion for `template_key like 'platform_rfl_admin_%'` on `outbound_deliveries` (PR 1), and the Communications page (`src/app/app/communications/page.tsx`) additionally excludes those keys from its query and its in-memory list. A test pins that every admin-addressed delivery uses the admin prefix and no owner-addressed one does. Owner-addressed rows (`platform_rfl_<kind>`) do appear in that studio's Communications list, like any other staff email.

## 5. Dedupe and replay

- Queue dedupe key: `rfl:<alert-id>:<recipient-ref>`. The queue's unique conflict returns `duplicate`, so a replay, a retry, or two concurrent workers produce exactly one queued email per recipient. A `duplicate` counts as reached.
- Delivery records are unique per (alert, recipient reference) in the database; a replay is `replayed:true`.
- `recorded:false` means the claim token is no longer current: the sink stops at once and throws (`RflAlert_claim_lost`); the runner's finish is refused by the database too. No further email is sent.

### "Delivered" means queued, not sent

An alert marked delivered in the outbox means every reachable recipient's email was QUEUED in `outbound_deliveries`, not that it was sent. The dispatcher (`/api/notifications/send`) sends later; a terminal provider failure after queueing is NOT retried by this feature (the dedupe key blocks a re-queue). Operators find it in the existing outbound delivery statuses: `outbound_deliveries` rows with `template_key like 'platform_rfl_%'` and `status` not `sent` (`error_message` has the reason); owner-addressed failures also show in that studio's Communications page (failed deliveries first). Admin-addressed rows are visible to platform operators with service-role access only.

## 6. Failure and escalation

- The sink throws (the alert is marked failed with the error NAME only, e.g. `RflAlert_queue_failed`; attempts are counted and bounded at 5 by the database) when: no recipient exists (`no_recipient`), a queue or record call fails, or nobody could be reached (`unreachable`). Error text never contains an address or database message.
- A failing recipient does not block the others; recipients already queued are not repeated on retry (dedupe), only the missing ones are.
- One failing alert never blocks the others in the pass. A business scan failure never stops the other businesses.
- After 5 failed attempts `tw4_rfl_escalate_delivery` (every pass) raises one `alert_delivery_exhausted` administrator alert; `tw4_rfl_health` reports `alerts_exhausted` and `stale` runs.
- Time and size budget: alerts are claimed in batches of 5, at most 8 batches (40 alerts) per pass, and no new batch is claimed more than 40 s after the pass started (the route's maxDuration is 60 s). The run still finishes its heartbeat. Whatever is left stays pending for the next pass; the summary field `deferred` is 1 when delivery stopped early with a full last batch (more may remain), else 0. Deferral is not an error.
- Heartbeat summary: `tw4_rfl_scan_finish` accepts only a flat object of numbers, so the finish summary is numeric only (booleans as 0/1, no strings); a unit test fake rejects anything else exactly as the SQL does.
- The route returns counts only (`ran`, `ranReason`, entities, opened, closed, alertsCreated, inventoryGaps, escalated, delivered, failed, errors, deliveryEnabled, truncated, deferred). A heartbeat refusal is a clean 200; any error is a 500.

## 7. DRAFT activation checklist (separate, owner-approved step: nothing below has been done)

1. PR 1 migration applied hosted (DEV first, then PROD), with the usual preflight/postflight. Verify `tw4_rfl_switch_enabled('scan')` and `('delivery')` are both false.
2. This PR's application deployed (route still 404 by itself, no schedule).
3. Set `SMS_FEE_LIFECYCLE_SCAN=on` (production env). Turn the database `scan` switch on (`tw4_rfl_set_switch`, reason >= 10 chars). Call the route once by hand with the cron secret; expect `ran:true`, `deliveryEnabled:false`, `errors:0`; check `tw4_rfl_health`.
4. Review pending alerts in the administrator overview before enabling delivery.
5. Set `SMS_FEE_LIFECYCLE_DELIVERY=on` (exactly) and turn the database `delivery` switch on. Run once by hand; check recipients received exactly one email each, no sensitive data, links resolve, `studio_sms_rfl_alert_deliveries` rows exist.
6. Only then, in its own reviewed PR, register the schedule (suggested daily). Cron entry text to add LATER (NOT added by this PR; the unit test that pins "not registered" must be updated in that PR):

   ```json
   { "path": "/api/cron/sms-provider-fee-lifecycle", "schedule": "0 14 * * *" }
   ```
7. Watch two completed scheduled runs. Rollback: turn the `delivery` switch off (instant), then the `scan` switch off; unset the env flags if desired. Emails already queued are sent by the normal dispatcher.
