# Marketing M-0 closeout runbook (prepared 2026-11-21; read-only and docs only)

Status: PREPARATION. Nothing here was applied to PROD. No sends, no unfreeze, no provider or Resend configuration, no SMS change.
Evidence below comes from read-only PROD queries (`sb.sh prod-read`) and DEV rehearsals (`sb.sh dev-read` / `dev-apply`) run on 2026-11-21 17:2x-17:3x UTC.
The queries are committed next to this file in `docs/marketing/m0-closeout/` (single-statement, aggregate counts only, no personal data).

## 0. Summary for the owner

1. **PROD is already in state S3, frozen.** Stage 1 AND stage 2 are in place (details in section 1). The earlier note that stage 2 was unverified is now closed: the stage-2 indicators are all present and PROD's M-0 schema fingerprint is byte-identical to DEV with stage 2 applied (`336 6b3a5c23b75004548d01ffef24112906`). The release steps 1-6 of `m0-email-compliance.md` section 6 have therefore been done; what remains is steps 7-9 (C1 repair, unfreeze, observe) and M-0D.
2. **PROD has almost no marketing data**: 2 studio campaigns (1 sent, 1 draft), 17 recipients (all `sent`), 0 organizer campaigns, 0 unsubscribes, 0 suppressions. The C1 historical-unsubscribe damage is **zero rows**, so no repair and no disclosure is needed on current evidence.
3. **The live app contains M-0 and matches main's compliance code.** The live line (`release/website-embeds`, tip `053346219`) contains the M-0 merge and is byte-identical to main for `src/lib/marketing/compliance`, the unsubscribe route and the organizer campaign actions. The only studio-campaign difference is main's newer M-1a/M-1b/M-2a work (not yet on the live line). `POST /api/email/unsubscribe/<token>` answers 200 on production (the M-0 one-click endpoint; the pre-M-0 build would answer 404). The exact live deployment commit was not read from Vercel by this session: confirm it before unfreezing (owner decision list, item 3).
4. **Unfreeze is low-risk on data but gated on four things:** the app is confirmed (above), the M-0D bounce/complaint webhook decision, the sender-domain check, and an owner go. See section 3.
5. **Finding that changes the rollback story:** stage 1 can no longer be re-applied after a rollback, because its authorization-state precondition predates the RFL policy `rfl_admin_alerts_not_staff_visible` on `outbound_deliveries` (migration 20261211). Rolling back stage 1 on PROD would strand it. Section 5 explains and gives the fix (a one-hash precondition update, a CODEOWNERS migration change, needs the owner).

**Update 2026-11-21 (later):** a stage-2 precondition defect (user-client delete of queued appointment notifications, PR #762) is live on PROD and needs a live-line release; see section 7.

**Owner dispositions 2026-11-26** (B1, B2, M1-M6): Gate 1 PASSED (read-only, 110 qualifying emails); sending stays FROZEN; the old conditional unfreeze authorization is retired in favour of section 6; evidence in [`m0-closeout/EVIDENCE_2026-11-26.md`](m0-closeout/EVIDENCE_2026-11-26.md).

## 1. PROD reconciliation (read-only, 2026-11-21)

Query: `docs/marketing/m0-closeout/m0_state_reconcile_readonly.sql` (and `m0_c1_repair_candidates_readonly.sql`). Run both with `sb.sh prod-read`.

| Check | PROD | DEV (stage 1 only, as found) |
|---|---|---|
| Freeze row | `frozen=true`, changed 2026-10-14 02:26:40Z, reason "M-0 stage 1 applied: frozen until the M-0 application is verified and an operator releases it"; 0 freeze events | frozen=true, 2026-10-13 |
| Stage-1 functions / tables | 25 functions; suppressions, message tokens, test sends, send controls, control events present | same |
| 12 `m0 ...` policies (stage 1) | present | present |
| S6 client write policies on recipients / `outbound_deliveries` (stage 2 drops them) | **none** | present |
| S7 anon/authenticated INSERT/UPDATE/DELETE/TRUNCATE grants on those tables | **none** | present |
| S8 grantees of `unsubscribe_marketing_recipient` | postgres, service_role (stage-2 end state) | PUBLIC, anon, authenticated, postgres, service_role |
| `claim_outbound_deliveries` body md5 | `aa4c7c08da017acd2d09ade1ca11c8f1` (stage-1 version) | same |
| Schema fingerprint (`m0_marketing_fingerprint.sql`) | **336 / 6b3a5c23...** | stage 1: 341 / c4804458...; after applying stage 2 on DEV: **336 / 6b3a5c23... = PROD** |
| Studio campaigns by status | sent=1, draft=1 | sent=1 |
| Organizer campaigns | none | none |
| Studio recipients by status | sent=17 | sent=9 |
| Organizer recipients | none | none |
| Unsubscribe records (studio / organizer) | 0 / 0 | 0 / 0 |
| Platform suppressions / test sends / message tokens | 0 / 0 / 0 | 0 / 0 / 0 |
| Campaigns stuck in `sending` | 0 / 0 | 0 / 0 |
| Recipients in a claim/attempt state | 0 / 0 | 0 / 0 |
| Recipient rows created after the freeze | 0 / 0 | 0 / 0 |
| Legacy organizer-unsubscribe-page signature rows after 2026-10-14 | 0 | 0 |
| Automation-family outbound rows in last 30 days | none (nothing is held in the queue) | none |
| Duplicate tokens / non-lowercase tokens / duplicate unsubscribe records | 0 / 0 / 0 | 0 / 0 / 0 |
| Campaigns whose ENT-1 usage exceeds sent rows (pre-M-0 C2 damage) | 0 | 0 |

Interpretation:

- **Stage 1 vs stage 2:** PROD = stage 1 + stage 2 (S3). The ops log (`danceflow-ops/log/ops.log`) starts on 2026-11-10, so the apply event itself is not in it; the evidence is the schema state plus the identical fingerprint. Who applied stage 2 and when is not recorded in this session's evidence (owner decision list, item 1).
- **Stage-2 precondition ("the old app must never run against stage 2"):** satisfied. No row signature of the pre-M-0 app exists after the freeze (C9 = 0, C10 = 0), the live line contains M-0, and the M-0 unsubscribe endpoint answers on production.
- **App-created rows that could violate stage-2 preconditions:** none (no rows created after the freeze; 17 recipient rows all `sent`; no `sending`/`delivery_unknown`).
- **C1 repair candidates** (`m0_c1_repair_candidates_readonly.sql`): R1..R11 are all 0 (no signature rows, nothing missing, no later deliveries, nothing pending). **No C1 repair is needed and there are no "cannot be recalled" disclosure facts on current evidence.** The C1 preflight must be re-run (and be 0) immediately before the unfreeze, because it is cheap and the set is closed once the M-0 app is live.
- **Held commercial email:** none queued, so unfreezing releases nothing from the dispatcher queue.
- **The one PROD campaign draft** is unsent. After the unfreeze its content can be edited (M-1a) and it must go through the normal recipient generation, claim and ENT-1 path.

## 2. Application compatibility

- Live line `release/website-embeds` tip `053346219` contains `13c4d547f` (M-0, PR #218). `git diff origin/release/website-embeds origin/main` over `src/lib/marketing/compliance`, `src/app/api/email/unsubscribe`, `src/app/unsubscribe` and `src/app/app/organizer-campaigns` is empty as of main `92cdc562e` (M-2a, which refactors the organizer validation without behaviour change, is not on the live line yet).
- Differences on `src/app/app/marketing` are only main's M-1a (studio draft edit), M-1b (ARIA apply) and M-2a (shared validation); none changes a send path. A TW-4F SMS opt-out ordering file and `dispatch.ts` differ on main vs the live line (SMS-owned, not marketing).
- M-0 app against the PROD DB (stage 1 + 2): compatible by construction. The app writes recipients and deliveries only with the service role and calls the stage-1 functions; stage 2 removed only client-role writes and the legacy page RPC. This is the documented S3 state.
- Not verified here: which exact commit Vercel serves on `www`. Confirm with `vercel inspect` / the production deployment's source SHA before the unfreeze.

## 3. Ordered sequence to "unfrozen and compliant"

Steps 1-6 of the existing release procedure (`m0-email-compliance.md` section 6) are already done on PROD. Remaining, each needing its own owner authorization where marked **[OWNER]**:

| # | Step | Gate / evidence to record |
|---|---|---|
| A0 | Deploy the #762 fix (queued appointment notifications deleted with the service role) on the live line | developer-owned QA; cherry-pick onto `release/website-embeds`; **[OWNER]** release approval |
| A | Confirm the live deployment SHA and that it is on the M-0 line | owner-gated read; record SHA. Run `node scripts/m0-rollback-build-smoke.mjs https://www.idanceflow.com`; expect `ROLLBACK TARGET VERIFIED` |
| B | Re-run `m0_state_reconcile_readonly.sql` and `m0_c1_repair_candidates_readonly.sql` on PROD | all values as in section 1; C1 R3 = 0 |
| C | **Sender-domain separation check** (read-only): confirm `MARKETING_FROM_EMAIL` and the transactional sender use different from-addresses, and decide whether marketing gets its own sending subdomain (open decision #17: marketing subdomain / reputation isolation). Verify SPF, DKIM, DMARC alignment for the marketing sender in Resend and DNS | **[OWNER]** reading Vercel env/Resend (no secrets printed) and the subdomain decision |
| D | **M-0D provider event ingestion (bounce/complaint -> platform suppression)** | **[OWNER]** for vendor configuration. Until it exists, hard bounces and complaints are NOT auto-suppressed; see section 4 for whether to unfreeze before or after it |
| E | One-time content QA on PROD-safe fixtures: DEV rehearsal of a full campaign send path already exists in the e2e suite; run `marketing-m0-compliance.spec.ts` and `marketing-m0-unsubscribe-survival.spec.ts` against the DEV-backed preview of the exact live SHA | developer-owned QA matrix |
| F | **Unfreeze**: `select public.marketing_set_send_freeze(false, '<operator>: M-0 verified <date>')` via `sb.sh prod-apply` with a committed one-line file and its SHA | **[OWNER]** explicit approval for that file and SHA |
| G | Immediate verification (section 6 checklist), then a 24 h observation | dispatch errors, `marketing_suppression_unavailable`, unsubscribe 503s, held-queue size, first real send follows the controlled-first-send rule below |
| H | **Controlled first send** (M4: own studio staff only; separately authorized) after unfreeze: smallest real audience (the owner's own studio, staff-only, using the existing draft), confirm claim, unsubscribe link, one-click headers, ENT-1 usage and footer on the received message before any larger send | **[OWNER]** approves the audience |

The unfreeze command is exactly `select public.marketing_set_send_freeze(false, 'reason')`; every call writes `marketing_send_control_events`. Re-freeze is `marketing_set_send_freeze(true, 'reason')` and is the first rollback action for anything after step F.

## 4. M-0D design and test plan (Resend delivery webhook; nothing configured)

Existing design: `m0-email-compliance.md` section 5. Concrete build and test plan for the next code PR (no vendor changes in it):

- **Endpoint** `POST /api/webhooks/resend` (the route does not exist yet; `src/app/api/webhooks/` currently holds only `mux`). Verify the Svix signature (`svix-id`, `svix-timestamp`, `svix-signature`) over the raw body against `RESEND_WEBHOOK_SECRET` with a 5 minute tolerance; reject unsigned, stale or malformed events with 400 and store nothing.
- **Event types:** `email.bounced` (only permanent / hard bounce suppresses), `email.complained` (suppresses), `email.delivered` (evidence only); everything else acknowledged and ignored.
- **Inbox table** `resend_webhook_events` (unique `svix_id`) with event type, provider email id, a recipient hash and minimal metadata; idempotent, replay-safe, tolerant of out-of-order events.
- **Suppression writes:** insert into `marketing_email_suppressions` (platform scope, marketing only; transactional mail unaffected, decision D2), matched to recipients by the stored `provider_message_id`, never by address alone. Soft bounces never suppress.
- **Migration:** a new table needs a migration (CODEOWNERS-protected, owner approval). This slice therefore starts with the migration proposal and DEV rehearsal.
- **Tests (signed fixtures):** valid signature accepted; bad signature, stale timestamp, missing headers rejected; duplicate `svix_id` is a no-op; hard bounce and complaint suppress and are honored by the next claim (`suppressed` outcome); soft bounce does not; unknown type ignored; an event for an unknown message id is stored and ignored; concurrency with a claim (event between generate and claim). Fail-closed behavior: a webhook DB error returns 5xx so Resend retries.
- **Vendor configuration (owner-gated, not done):** create the webhook in Resend pointing at the production endpoint, subscribe to the three event types, set `RESEND_WEBHOOK_SECRET` in Vercel, redeploy.
- **Sequencing recommendation:** with 0 suppressions and 17 sent recipients on PROD, the first controlled send (step H) can proceed before M-0D only if the audience is staff-only; any studio-wide or organizer send should wait for M-0D, because hard bounces and complaints would otherwise keep being mailed and hurt sender reputation. Owner decision item 4.

## 5. Rollback for each step (verified on DEV 2026-11-21)

Files: `src/lib/supabase/migrations/rollback/20261117090000_m0_marketing_send_integrity_rollback.sql` (stage 1) and `.../20261117091000_m0_recipient_write_lockdown_rollback.sql` (stage 2). Application rollback target: the rollback-compat build (`docs/marketing/rollback/m0-rollback-compat.patch`).

DEV rehearsal log (DEV started at stage 1 only, as found):

| Step on DEV | Result |
|---|---|
| fingerprint before | 341 / c4804458fbf250e7c0795de4154214cf |
| apply stage 2 (`20261117091000`, sha `56ae1f03...9fe`) | rc 0; S6/S7/S8 show the stage-2 end state; fingerprint 336 / 6b3a5c23... (= PROD) |
| stage-2 regression suite `test_T_m0_recipient_write_lockdown.sql` | `M-0 STAGE 2 SUITE PASS (54 checks)` |
| roll back stage 2 | rc 0; fingerprint 341 / c4804458... (exact restore) |
| stage-1 regression suite `test_T_m0_marketing_send_integrity.sql` | `M-0 SQL SUITE PASS (226 checks)` |
| roll back stage 1 | rc 0, but the pre-M-0 fingerprint is now 202 / 0c1241d1... rather than the 2026-10 value 191 / 9493285f... (DEV changed since: later migrations touch the same tables; not a rollback defect) |
| re-apply stage 1 unchanged | **REFUSED by its own precondition**: `unexpected authorization state on outbound_deliveries=281b5fa8921c9615e350f4d7ecdcf322` |
| re-apply stage 1 with that one hash allowed (scratch copy, DEV only) | rc 0, fingerprint 341 / c4804458... (back to the original), suite passes again (226 checks) |
| DEV left at | stage 1 only, frozen=true, matching how it was found (freeze `changed_at` is now 2026-11-21) |

Finding: the stage-1 precondition's `outbound_deliveries` signature does not know the restrictive policy `rfl_admin_alerts_not_staff_visible` (migration `20261211090000_twilio_rfl_ops.sql`). So stage 1 cannot be re-applied after a rollback on any current database. This does not affect the PROD end state (stage 1 is already applied) but means a PROD stage-1 rollback would be one-way until the signature in `20261117090000` line 1219 is updated to `281b5fa8921c9615e350f4d7ecdcf322`. Recommended: do not roll back stage 1 on PROD. If a rollback below M-0 is ever needed, re-freeze and use the application rollback only (below). Updating the migration's precondition is a CODEOWNERS-protected migration edit and an owner decision (item 5).

Per step:

| Step | Rollback |
|---|---|
| F unfreeze | `marketing_set_send_freeze(true, 'reason')` (immediate, logged). Already-sent mail cannot be recalled |
| D M-0D | disable/delete the Resend webhook; the endpoint rejects unsigned traffic; suppressions already written stay (they are conservative) |
| C1 repair (not needed) | `delete from organizer_marketing_unsubscribes where source = 'm0_c1_repair'` as service role |
| Stage 2 | `rollback/20261117091000_...` restores client-role recipient policies/grants; verified on DEV (exact fingerprint restore). Always before any application rollback |
| Application | promote the recorded, verified rollback-compat deployment, never the plain pre-M-0 build; keep the freeze on while it is live; `m0-rollback-compat.patch` verified to apply cleanly to the pre-M-0 base (`13c4d547f^` = `85ab15ef1`) with `git apply --check` on 2026-11-21 (the build and smoke verification still need a built deployment) |
| Stage 1 | not recommended (section 5 finding); needs the same authorization as an unfreeze, and a precondition update to ever re-apply |

## 6. Evidence to collect and go/no-go checklist

**This checklist is the current unfreeze gate.** By owner decision of 2026-11-26 (B2) it replaces the 2026-10-14 conditional unfreeze authorization, including its unwritten Gates 2-4; that authorization is retired and must not be resumed. Gate 1 passed on 2026-11-26, which satisfies none of the boxes below. No box is ticked: each must be evidenced at unfreeze time.

Before step F (all read-only, record outputs in the release log):

- [ ] Live deployment SHA recorded; `m0-rollback-build-smoke.mjs` against production prints `ROLLBACK TARGET VERIFIED`
- [ ] `m0_state_reconcile_readonly.sql`: freeze row frozen=true; fingerprint `336 6b3a5c23b75004548d01ffef24112906` (or an explained change); S6, S7 = none; S8 = postgres,service_role; C7 = 0/0; C8 = 0/0; C9 = 0/0; C10 = 0; C12, C13, C14 = 0
- [ ] `m0_c1_repair_candidates_readonly.sql`: R3 = 0 and R1 = 0
- [ ] Rollback files re-checked on DEV (last done 2026-11-21, section 5)
- [ ] Sender settings read, and sender-domain separation recorded (marketing sender != transactional sender; SPF/DKIM/DMARC pass on a received message or provider verification)
- [ ] Sending-subdomain change, if approved, applied and verified
- [ ] Bounce and complaint webhook handling live before any send beyond a narrowly authorized staff-only pilot (M2)
- [ ] First audience limited to the owner's own studio staff, operator named (M4), and the send separately authorized
- [ ] The unfreeze SQL file and its SHA-256 provided to the owner and approved

After step F:

- [ ] `marketing_send_frozen()` returns false; one new `marketing_send_control_events` row with the reason
- [ ] First controlled send: recipient receives message with the marketing sender, per-message unsubscribe link, `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers, studio footer address; recipient row `sent`; ENT-1 usage = exactly the recipient count
- [ ] Unsubscribe via link and via one-click POST each create exactly one record; a second claim for that address returns `unsubscribed`
- [ ] 24 h: no `marketing_suppression_unavailable`, no unsubscribe 503, queue size stable

Go / no-go: **GO** requires every box above ticked and the owner's explicit approval of the unfreeze file and SHA. Any `NOT A VALID ROLLBACK TARGET`, any non-zero C9/C10/R3, or a fingerprint other than the PROD value is **NO-GO** until explained.

## 7. SMS and consent dependencies, and the stage-2 precondition inventory

TWILIO's written answers (read-only review of main, 2026-11-21):

1. All SMS/TW-4F inserts into `outbound_deliveries` use the service role (`schedule/actions.ts` via `createAdminClient`, `lib/sms/providerFeeAlerts/sink.ts`, the dispatcher with the server client the cron route passes). No TW-4F path writes it as a signed-in user.
2. **Behavior to preserve:** `dispatch.ts` calls `claim_outbound_deliveries(p_owner, p_limit, p_lease_seconds)` and must keep receiving queued `channel = 'sms'` rows (and non-held email rows), leased, with the same columns. M-0 only holds `channel = 'email'` marketing-family rows (`aria_execution_*`, `automation_*`) while frozen; SMS return semantics are unchanged. There is no other claim function. Any future edit of the claim function must keep this.
3. `rfl_admin_alerts_not_staff_visible` (20261211090000) is final for TW-4F and is the only policy it adds to `outbound_deliveries`; TW-4F plans no new policies there (any new one needs a re-check of the M-0 preconditions, section 5). **Verified applied on PROD** by a read-only query on 2026-11-21 (the restrictive SELECT policy is present on PROD and DEV).
4. Marketing SMS stays locked; no TW-4F or marketing-SMS/consent work reuses `marketing_email_suppressions` or the email unsubscribe tables.

### Stage-2 precondition inventory (every write to `outbound_deliveries` and the marketing recipient tables, non-test code on main `d8aa8831`)

Stage 2 removes client-role writes, so every writer must use the service role. Method: scan of `.from("outbound_deliveries" | "marketing_campaign_recipients" | "organizer_marketing_campaign_recipients")` followed by insert/update/delete/upsert, then the client's origin checked.

| Writer | Operation | Client |
|---|---|---|
| `app/api/cron/aria-digest/route.ts` | insert | admin |
| `app/app/automations/actions.ts` (10 call sites) | insert / update | admin (`adminSupabase` or `createAdminClient()`) |
| `app/app/clients/[id]/actions.ts`, `documents/actions.ts`, `documents/sign/actions.ts` | insert | admin |
| `app/app/schedule/actions.ts` (appointment notification queue) | insert | admin (`notificationSupabase`) |
| `app/book/[studioSlug]/actions.ts` | insert | admin |
| `app/portal/[studioSlug]/schedule/actions.ts` | insert | admin (client passed as admin) |
| `lib/notifications/outbound.ts` (`queueOutboundDelivery`, all callers) | insert | admin |
| `lib/notifications/dispatch.ts` | update | admin |
| `lib/sms/providerFeeAlerts/sink.ts` | read/insert | admin |
| `lib/marketing/compliance/campaignDelivery.ts` (recipient tables) | RPC | service role |
| **`app/app/schedule/actions.ts` `deleteAppointmentAction` (queued appointment notifications)** | **delete** | **USER client: the one violation** |

The violation (found by TWILIO review, confirmed here) silently fails under stage 2 because the delete is best-effort and supabase-js returns the error instead of throwing, so a deleted appointment could leave queued reminders that still send. Because **PROD already has stage 2**, this is live now. Fix: PR #762 (one call switched to `createAdminClient()`, test added). `schedule/actions.ts` is byte-identical on main and the live line (`release/website-embeds`, tip `053346219`), so the same commit cherry-picks cleanly onto the live line; it must ride a live-line release. **Add to the unfreeze preconditions: #762 deployed on the live line.** Reads (selects) by the signed-in user remain allowed by stage 2 and are unaffected.

## 8. Owner decisions (answered 2026-11-26) and what remains

| Topic | Decision | Still needed |
|---|---|---|
| Gate 1 (B1) | Run read-only | Done: PASS |
| Old conditional authorization (B2) | Replaced by section 6 | Evidence for each box |
| Unfreeze (M1) | Stay frozen | Gates and preflights, then separate approval of the exact file and SHA |
| Bounce/complaint webhook (M2) | Required beyond a staff-only pilot | Design is section 4; build, migration and vendor configuration separately gated |
| Live SHA, sender, DNS (M3) | Read-only verification; prefer a dedicated sending subdomain | Sender variables not yet read; DNS/provider/env changes need approval |
| First audience (M4) | Own studio staff only | Operator, and authorization of the send |
| App changes to the live line (M5) | Prepare for the next suitable release | Review and release approval |
| Stage 1 / stage 2 (M6) | Do not roll back stage 1 merely because stage 2 exists; history verified read-only | None, unless the owner wants the stage-1 precondition fixed |
