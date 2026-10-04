# DanceFlow Current State

Short, operational snapshot. The authoritative roadmap is [`DanceFlow_Master_Roadmap.md`](DanceFlow_Master_Roadmap.md). Update this file whenever main, the PROD deployment, or the active slice changes.

**Last updated:** 2026-10-03 (roadmap v1.9: GC-S1B implementation candidate recorded, not released; GC-S1A and GC-R1 released and closed; Phase 5 PARTIAL; ENT-1 released and closed; BR-6 parked)

> **Roadmap-affecting phase closeout requires canonical roadmap/current-state update before the phase is considered closed.**

## Release state

| | |
|---|---|
| **CURRENT MAIN** | `8bb14afd8f1e6f4dca2e880ad99708d0679aa5e3` (GC-S1A schema foundation, PR #143; schema only, no app deployment). Live application is unchanged: `dpl_HcdC6KRD9ZRWFN4FtyvEGbpsNVcE` (GC-R1; rollback `dpl_HcYmcSqF4hLApbwASov1xacA4mbu`). The docs-only commits that record this lag it by one commit each time |
| **CURRENT PROD DEPLOYMENT** | `dpl_HcYmcSqF4hLApbwASov1xacA4mbu` (source `782fd680fdb0ab8928faccb4ac859bbe4e6109f6`; ENT-1 live on `www.idanceflow.com` and `idanceflow.com`; promoted 2026-10-03). Previous production deployment and rollback target: `dpl_HnWJ1Qn2g3onGb9wEWULyKZkfd5K` (BR-4, source `f189d15cbef301a24e3410b79f20d3bcef7135d9`). The later docs-only commits (BR-5 collateral, this closeout) change no runtime and were not deployed |
| **SUPABASE DEV** | `epdrtzcydvnoidwrepqz` |
| **SUPABASE PROD** | `hvsujyfbftfffxpfmlpb` |
| **PRIMARY REPO LINK** | DEV |
| **NON-TWILIO LAUNCH STATUS** | READY / CLOSED; no new launch blocker from BR-4, BR-5 or ENT-1 |
| **PENDING PROD MIGRATIONS** | None. ENT-1 migration `20261013090000_ent1_usage_allowance_reservations.sql` was applied to PROD 2026-10-03 23:01:22–23:01:24Z (isolated scratch workdir, exit 0) and verified before the application deployment |
| **PACKAGE REFUND HOLD** | Released / `false` |
| **ACTIVE ENGINEERING LAUNCH BLOCKERS** | None identified outside the Twilio operational dependency |
| **KNOWN HYGIENE DEBT** | pre-existing lint errors in some public pages (not introduced by BR-4, BR-5 or ENT-1); they keep the changed-file lint step in CI red when those files are touched |

BR-4 (Public Website & Launch Messaging) is merged and live. Public smoke of the live domains and the live attribution cookie passed; authenticated production smoke was intentionally omitted. BR-5 (Event / Print Collateral) is merged as PR #137.

## BR-6 (active, parked)

| | |
|---|---|
| **Branch** | `br-6-promotional-media` (local; not pushed, no PR, not merged) |
| **Head** | `1f19305` |
| **Status** | ACTIVE / PARKED. The Rough Cut 3 visual system and motion engine are built; the owner locked a first-person master narrated by ARIA herself (`docs/brand/media/VOICEOVER_V4.md`). The next full master render waits for the professional ARIA voice recording (`media/_work/voice/aria-pro/`) |
| **Not done** | No music sourced or licensed; no voice talent engaged by engineering; no short cuts; BR-7 not started; BR-6 is not complete |

## ENT-1 (released and closed)

| | |
|---|---|
| **Status** | ENT-1: RELEASED / COMPLETE. Monthly email-campaign recipient allowance enforced for studio and organizer sends: whole-campaign atomic admission, delivery in the existing batches under that one commitment, success-only durable settlement, stale-batch reconciliation. Also fixes the organizer send pipeline recording provider-rejected sends as sent |
| **Pull request** | #138, squash merged to main as `782fd680fdb0ab8928faccb4ac859bbe4e6109f6` (parent `1310e3a107404c7c81fd031696dcf9cf120c76d6`; tree identical to the reviewed branch head `6ce0d27`) |
| **Migration** | `20261013090000_ent1_usage_allowance_reservations.sql`: applied and verified in PROD (table, RLS with no tenant policies or privileges, `reserve_usage_allowance` and `settle_usage_reservation` SECURITY DEFINER with service_role-only EXECUTE, function bodies identical to the reviewed file and DEV, superseded DEV-only functions absent). Rollback file reviewed against the final schema, not run |
| **Deployment** | `dpl_HcYmcSqF4hLApbwASov1xacA4mbu` (source `782fd680fdb0ab8928faccb4ac859bbe4e6109f6`), promoted to `www.idanceflow.com` and `idanceflow.com` |
| **Release verification** | Safe checks only: deployment source SHA, public route health (200), PROD ENT-1 database fingerprint unchanged after deploy. Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure. Authenticated behavior was instead validated in DEV/local before release. |
| **Phase 4** | Remains PARTIAL: SMS gating, payroll/marketplace/ARIA billing keys, a reusable upgrade-prompt component, an approved email add-on product (none exists) and enforcement for other email paths such as ARIA-originated sends are not done |

The BR-6 branch is not main. Do not treat BR-6 as merged until its pull request is merged.

## Twilio status

External dependency awaiting Sachin / Twilio response before ConfiDance resource configuration and submission actions. Engineering for the per-studio A2P model is live (SMS-A2P-1 through 3C). No `studio_sms_registrations` row exists in PROD, the global SMS status has not been changed, and every studio is fail-closed until individually approved. Twilio does not block unrelated roadmap work. No new Twilio information is recorded here.

## Current roadmap position

**ACTIVE PHASE:** Phase 3 — Branding Relaunch (PARTIAL)

**BR-4 (Public Website & Launch Messaging):** COMPLETE AND LIVE

**BR-5 (Event / Print Collateral):** COMPLETE AND MERGED (PR #137)

**BR-6 (Promotional Media):** ACTIVE / PARKED awaiting the professional ARIA voice recording. BR-7 (final branding / public-launch QA) follows BR-6 and has not started. Phase 3 is not complete until both are done.

**PHASE 4:** PARTIAL by decision. ENT-1 (email-campaign recipient allowance) is RELEASED and closed (PR #138). No dependency-safe Phase 4 implementation remains: the rest (SMS, payroll, marketplace and ARIA plan placement) is blocked on open decision #8, with pricing in Phase 22. SMS plan placement is blocked independently of the Twilio / Sachin dependency. No speculative billing keys; no email add-on is approved or required. Shared upgrade-prompt / usage-display UX moved to Phase 17; existing entitlement-denial behavior is sufficient until then.

**PHASE 5 (in progress, PARTIAL):** GC-R1 — canonical group-class attendee reminders — is RELEASED AND CLOSED. **RELEASED 2026-10-03:** PR #141 (reviewed head `1c7c415c1d7146cf5c82b99207d3c98065f55a33`) squash-merged to main `087c2c7a7a3d832fa9699682c926eff290151ff8` (parent `56b3a9c0b005990da5c8aff13008421bf32b4f3e`), promoted to PROD as `dpl_HcdC6KRD9ZRWFN4FtyvEGbpsNVcE` (www and apex); rollback target `dpl_HcYmcSqF4hLApbwASov1xacA4mbu`. No migration was required: the PROD `notification_deliveries.dedupe_key` column and its unique partial index were verified read-only before and after deployment. Authenticated production smoke was intentionally omitted under the permanent release rule (prior production read-only verification attempts resulted in secret/key exposure; authenticated behavior was validated in DEV/local before release). Enrolled (`booked`) attendees of appointment-based classes get the existing 24h/2h email reminders via the existing generator and branded HTML (no confirmation link); idempotent via `dedupe_key`; no ENT-1 allowance; no SMS; legacy Events reminders untouched. Only GC-R1 is complete. Remaining Phase 5 gaps: legacy Events group-class retirement (needs a production-data inventory before any retirement or migration), series/occurrences, multiple rooms/locations, class revenue reporting, and the unresolved depleted-credit decision (#10). Public class discovery stays Phase 6. Phase 4 remains PARTIAL on open decision #8; BR-6 remains parked awaiting the professional ARIA recording; Twilio/Sachin remains an external wait.

**GC-S1A (series schema and authority foundation): RELEASED AND CLOSED.** **GC-S1A RELEASED AND CLOSED (2026-10-03):** PR #143 (reviewed head `efa68d14e2fa3f9966da9a7df096279a68f162bc`) squash-merged to main `8bb14afd8f1e6f4dca2e880ad99708d0679aa5e3` (parent `61ef3dafe8d3e8f5025c32e2d4e91b93a55a0896`). Migration `20261014090000_gcs1a_group_class_series_foundation.sql` was applied and verified in DEV (79 SQL checks; rollback validated and the migration re-applied) and applied once, manually, through the PROD Supabase SQL Editor, then verified read-only: PROD and DEV definitions match after normalizing cosmetic carriage returns. The 203 existing PROD appointments were unchanged; at release there were zero series rows, zero appointments attached to a series, zero override entries and zero canonical group-class appointments. Legacy Events data was unchanged (8 group-class events, 66 sessions). No application deployment or Vercel promotion was required (no runtime code). Authenticated production smoke was intentionally omitted under the permanent release rule (prior production read-only verification attempts resulted in secret/key exposure; authenticated behavior was validated in DEV/local). **GC-S1B has NOT started.** Remaining GC-S1 slices (S1B–S1F) are not started. Phase 5 remains PARTIAL: legacy Events retirement (needs canonical parity and the 12-session date-pattern analysis first), the rest of the series work, multiple rooms, class revenue reporting and the unresolved depleted-credit decision (#10). Known gap recorded: canonical group-class create/edit has no instructor/room conflict detection.

**GC-S1B (series creation and occurrence materialization) — IMPLEMENTATION CANDIDATE COMPLETE; NOT RELEASED.** All four slices are implemented and reviewed on a feature branch: B1 SQL (migration `20261015090000_gcsb1_group_class_series_materialization.sql`: shared deterministic finite occurrence generator, `preview_group_class_series`, `create_group_class_series`, `client_request_id` idempotency; **applied to DEV only, NOT applied to PROD**), B2 server actions with instructor/room conflict enforcement through the existing conflict engine (preview, authoritative re-preview and recheck on create, safe error mapping), B3 owner-facing "Class series" creation UI (preview, explicit skip/restore, daylight-saving guidance, request id created once per form, safe handling of failed actions) and B4 integration, security and polish closeout. A coordinated production release (PROD migration preflight and apply, then app release) is **pending** and is not recorded here as released. Legacy Events group-class creation remains active and untouched; nothing here indicates legacy retirement readiness. Not part of GC-S1B and still future: S1C (edit/exception/cancel semantics), S1D (series enrollment and roster integration), S1E (reminder/calendar/conflict integration for edits) and S1F (security, polish, closeout). Depleted-credit decision #10 remains unresolved. Phase 5 remains PARTIAL.

**Live state is unchanged by this candidate:** PROD has the GC-S1A schema foundation only; the `preview_group_class_series` / `create_group_class_series` functions and the `client_request_id` column do not exist in PROD yet, and no application code that creates series is deployed. The recorded main SHA below is therefore still the GC-S1A release state.

### Public-claim restrictions (still in force for BR-6 onward)
- No meaningful Featured Events promotion claim; avoid "Featured" language beyond implemented behavior.
- Partner Match may be described only as the existing dance-partner directory; no compatibility or matching claims, no "free forever" promise, no Partner Match SEO launch until moderation and a web request path exist.
- No Competition OS claims (judging, scoring, results, awards, live heat management).
- No SOC 2 certification or compliance claim.
- No unrestricted ARIA autonomy claim, and no claims about unreleased automation.

## Current external dependencies

- Twilio / Sachin
- Migration Center real-studio pilot validation
- Eventual pricing cutover business/configuration decision
- Banner vendor / stand selection (BR-5 follow-up, needed only before a banner print order)

## Major product decisions still open

- Featured Events governing/business model
- Partner Match age, moderation, and future-monetization details
- Group-class depleted-credit behavior
- Floor-rental authoritative pricing model
- Final mobile app boundary (Phase 18)
- Landmark 1A canonical closeout scope (invitation flow, seat UI, audit viewer)
- Whether to pull Partner Match moderation and the web request path forward
- Competition scoring system(s) and where judging runs
- Plan placement of SMS, payroll, marketplace and ARIA features
- Video cut list (BR-6)
- Demo-request / interest-capture storage (deferred; needs a storage decision)
- Per-event print attribution (static QR codes cannot distinguish events; needs a per-event print run or a signup survey question)

## NEXT GATE

None for ENT-1 (closed). BR-6 resumes when the professional ARIA voice recording arrives. Roadmap execution proceeds to Phase 5 (read-only reconciliation first). Remaining Phase 4 work waits on open decision #8.
