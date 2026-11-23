# Integration Candidates — research and recommendations

Status: DRAFT, docs only. Research date 2026-11-23, public vendor documentation and pricing pages only; nothing submitted, no account created, no vendor contacted. Status words: **[P]** primary vendor page read, **[S]** search snippet or third-party summary, **[?]** unverified. Where primary pages would not load (several Intuit, Apple, Zoom, Wave, Gusto pages) this is stated; treat those items as needing re-verification before any commitment.
Priority words: **Near** (next 1–2 quarters), **Later**, **Reject** (for now; revisit on demand).
Sizes: S ≈ days, M ≈ 1–3 weeks, L ≈ 3+ weeks of engineering, calendar time excluding provider review.
Internal-confidential: §9 contains the generic Competition-adjacent position only; it must not be copied outside the repo.

## 0. Native vs third-party (do not duplicate our own product)

| Capability | Already built | Third-party "integration" adds | Position |
|---|---|---|---|
| Calendar subscription (read-only) | Public ICS for studios and organizers; token ICS for instructors and coach schedules; embed calendar | Nothing technical; Apple/Outlook/Google all consume ICS | Extend natively (per-dancer feed), do not build per-vendor read integrations |
| Calendar push to Google | Live (one-way, studio + instructor) | Two-way/busy-time is the real gap | Maintain; fix defects first |
| Lead capture and intake | Native forms, embeds, NSI (dark) | Meta/Google ad leads as extra sources | Import via generic webhook/Zapier before native ad integrations |
| SMS/email | Twilio TW-4F, Resend | WhatsApp/Instagram DMs, Mailchimp | Separate consent/billing surfaces; mostly reject (§4) |
| Documents/waivers | Native documents (Phase 8) | DocuSign/Dropbox Sign | Reject for now |
| Payments | Stripe Connect | Square, Terminal | Stripe Terminal only, later |
| Video learning | Mux | YouTube/Vimeo | Link/embed only |
| Accounting export | Accountant deliveries, Wave posting | QuickBooks/Xero direct | CSV/journal export first |
| Payroll | Payroll prep + PDF batches; Gusto dormant | ADP/Paychex/Gusto APIs | Export first |

## 1. Calendars

### 1.1 Apple Calendar (ICS/webcal; CalDAV)
- **Use / mapping:** Dancers and instructors see lessons, classes, booked events on iPhone/Mac. Maps to appointments, class bookings, event tickets.
- **Access:** No public Apple Calendar write API found (absence of evidence, not an Apple statement) [?]. CalDAV at `caldav.icloud.com` needs the user to create an app-specific password (2FA required; 25 active; revoked on password change) [P: support.apple.com/en-us/102654]. Subscription refresh interval is client-controlled; current Apple page not found [?].
- **Approval / cost:** none.
- **Security:** ICS needs a secret, revocable, per-user URL (existing instructor feed pattern). Asking users for app-specific passwords is a credential risk; do not.
- **ARIA:** suggest "add your schedule to your calendar" in onboarding and after first booking; never create subscriptions on someone's behalf.
- **Complexity / support:** ICS S; CalDAV write L. **Recommendation: Near (native per-dancer ICS), Reject CalDAV.**

### 1.2 Microsoft 365 / Outlook (Graph)
- **Use:** Instructors on work/school Outlook; two-way busy time. Studio owners are mostly on Google/Apple, so demand is unproven.
- **API:** `Calendars.ReadWrite` delegated needs no admin consent; application permission does, and tenants can limit mailboxes. Change-notification subscriptions on events expire in under 7 days and must be renewed; 1,000 subscriptions per mailbox. Outlook throttle 10,000 requests / 10 min and 4 concurrent per app+mailbox [P: learn.microsoft.com/en-us/graph/permissions-reference, change-notifications-overview, throttling-limits].
- **Approval:** Publisher verification is free but needs a Microsoft Cloud Partner Program account; unverified multi-tenant apps can be blocked by risk-based consent [P: learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview]. Personal Microsoft accounts and work accounts differ in behaviour [?].
- **Cost:** no Graph fee found [?].
- **Complexity / support:** M–L; renewal jobs, tenant policies. **Recommendation: Later (ICS covers read-only now).**

### 1.3 Google Calendar — inbound/push and verification
- **Use:** Two-way: busy time as availability hints; edits reflected.
- **API:** `events.watch` needs HTTPS endpoint, no body in notifications, channels must be re-created before expiry [P: developers.google.com/workspace/calendar/api/guides/push]. Reading Calendar events is Google's own example of a *sensitive* scope; sensitive verification can take up to 10 days and needs a demo video, scope justification, brand verification and privacy policy; *restricted* scopes need an annual third-party security assessment (CASA) [P: developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification; support.google.com/cloud/answer/13464321]. **Uncertain:** no fetched page explicitly labels `calendar.events`; confirm in the Cloud Console. Narrower `calendar.app.created`/`calendar.events.owned` scopes exist [S] and might reduce review burden — unverified.
- **Action for the existing integration:** the live connection already requests `calendar.events`; its verification state is unknown (**A**) and is an owner question (OD-8).
- **Complexity:** M. **Recommendation: Later; first fix audit defects G1–G5.**

## 2. Accounting and payroll

### 2.1 QuickBooks Online
- **Use:** Owner/bookkeeper gets sales, payments, fees, payroll journals. Maps to the accounting entries and accountant deliveries.
- **API:** OAuth2; access tokens 1 h, refresh tokens 100 days rolling and rotating [S: Intuit auth FAQ via search]. Pricing moved to metered tiers (Builder $0 with monthly read credit cap; paid tiers $300–$4,500; variable fees from 2025-11-01) — **third-party summary only [S: apideck.com]**; Intuit pages did not render. App assessment/production-key requirements, rate limits and webhooks **not verified [?]**.
- **Native alternative:** journal/CSV export (accountant deliveries already exist) covers most value.
- **Complexity / support:** L, high (rotating tokens, chart-of-accounts mapping). **Recommendation: Later; ship QuickBooks-ready export first.**

### 2.2 Xero
- **API/pricing (official, effective 2026-03-02, AUD):** Starter free, 5 connections; Core $35/mo, 50; Plus $245/mo, 1,000 (requires App Certification); Advanced $1,445/mo, 10,000 (certification + security assessment). Egress $2.40/GB; daily rate caps 1,000 (Starter) / 5,000 (others); Starter/Core cannot be App-Store listed. Apps created from 2026-03-02 must use granular scopes [P: developer.xero.com/pricing, /faq/pricing-and-policy-updates, /faq/granular-scopes].
- **Complexity:** M–L. **Recommendation: Later (Starter tier suffices for a pilot; the 5-connection cap would make a broad rollout a cost question for a future owner decision; no pricing decision is made now (OD-5)).**

### 2.3 Wave (existing)
- Public developer portal live, GraphQL endpoint unchanged, no deprecation notice found [P: developer.waveapps.com]. Connecting businesses need Wave Pro/Advisor; a lapsed subscription makes token refresh fail with 403. Whether *new* apps are accepted could not be confirmed (support page 403) [?]. Wave may set request limits at its discretion [P: terms].
- **Recommendation: maintain the existing integration, add tests (audit W2), no new Wave investment.**

### 2.4 Payroll / HR (Gusto, ADP, Paychex)
- Gusto API is for App-Integration/Embedded partners; production keys after partnership review; cost unpublished [P: docs.gusto.com]. ADP: Marketplace partner path (sales, security, legal review, contract; no timeline) or client-bought API Central [P: marketplace.adp.com becoming-a-partner.pdf]. Paychex: questionnaire, sandbox, demo, production keys, per-client approval; timeline unpublished [S/P: developer.paychex.com/partner].
- Existing Gusto code is dormant (audit §4).
- **Recommendation: Near = payroll CSV/timesheet export (native); Reject direct payroll APIs until customer demand.**

## 3. Automation and long tail

### 3.1 Webhooks + public REST API (generic, native)
- No vendor approval; prerequisite for Zapier/Make; competitors treat Zapier as table stakes (§8). Complexity M; support moderate (key rotation, signing, retries, delivery log). **Recommendation: Near.** Design in Architecture §13. SMS content/phone numbers and Competition data classes are hard exclusions (§9; TW-4F coordinator confirmed SMS stays out of outbound events — engineering position, not an owner decision).

### 3.2 Zapier
- Free to build. Private (invite-link) integrations can be built by anyone and stay private; a **public** app must be built by the API owner, fully launched on production endpoints, with non-expiring test account, full API docs, every trigger/action tested with a live Zap; REST Hook triggers need subscribe/unsubscribe plus a polling fallback [P: docs.zapier.com/platform/publish/integration-publishing-requirements, /platform/build/hook-trigger]. Official: developer reaches out within about a week; total review unpublished, community reports ~10 to 60+ days [S, anecdotal].
- **Recommendation: Near for private invite-link app after §3.1 exists; public listing Later.**

### 3.3 Make
- Publishing creates an invite link with no review; review is only for "Approved" (visible to all). Requirements include own domain, secret sanitising, error handling, pagination [P: developers.make.com custom-apps docs]. **Recommendation: Later (after Zapier).**

## 4. Lead sources, marketing and messaging

| Candidate | Key facts | Native overlap | Rec |
|---|---|---|---|
| **Meta Lead Ads** | Real-time `leadgen` webhook then fetch by id; needs `leads_retrieval`, `pages_manage_ads` etc.; App Review required for non-role users; Business Verification weeks to ~60 days anecdotal; plan 4–12 weeks [P: developers.facebook.com lead-ads/retrieving, app-review; access-verification page says Tech Provider verification no longer required for this permission] | Zapier/Make lead-ad triggers and CSV cover it | **Later/Reject native; use webhook/Zapier** |
| **Google Business Profile** | Not self-serve: access application, profile verified 60+ days with website; quota 0 = not approved, 300 QPM = approved; Reviews API (list/reply); 10 edits/min/profile; Q&A API discontinued 2025-11-03 [S]; posts API status unverified [P: developers.google.com/my-business/content/prereqs, limits, review-data] | None | **Later** (reviews display/reply). Applying for access is free but is an **enrollment and therefore an owner-authorized action (OD-9)** |
| **Mailchimp** | OAuth app registration self-serve; terms require valid consent for uploaded contacts, no purchased lists; ongoing pricing/limits not confirmed [P: mailchimp.com/developer, /legal/terms] | DanceFlow email/campaigns | **Later** (opt-in-only one-way audience sync, if asked) |
| **HubSpot / Klaviyo / Constant Contact / ActiveCampaign** | HubSpot listing needs 3 active installs, review ≤10 business days initial; Klaviyo 5 active installs; CC partner approval; AC 5 req/s [P: respective developer pages] | Native + Zapier | **Reject** unless a customer asks |
| **Calendly / Cal.com** | Both have APIs; embedding fragments attendance, credits, Stripe | Native booking | **Reject** (allow a pasted link via embeds) |
| **Instagram / WhatsApp Business** | WhatsApp per-message pricing since 2025-07; free 24 h service window; from 2026-10-01 additional charges and payment-method requirement documented; Instagram messaging needs App Review [P: developers.facebook.com business-messaging pricing, instagram app-review] | Native SMS (TW-4F consent/billing) | **Later/Reject.** TW-4F coordinator: would bypass STOP/START/HELP handling, studio-prepaid credit and cost attribution; no new channel authorized (engineering position) |
| **Linktree / Wix / Squarespace / WordPress** | Embeds work via HTML/Code/iframe blocks; Wix sandbox wraps iframes (clipping, no UTM pass-through); Squarespace code blocks need paid tier [S]; app-store/plugin listing rules not researched [?] | **Native embeds** | **Near: per-builder snippet docs + auto-resize/UTM pass-through; defer listings** |

## 5. Passes, meetings, learning content, community

### 5.1 Apple Wallet + Google Wallet passes
- **Use:** Membership/class-pack/event-ticket pass on the dancer's phone; lock-screen QR for check-in; updated as remaining classes/expiry change. Maps to memberships, packages, bookings, check-in (Student app) and event tickets.
- **Apple:** Apple Developer Program membership, Pass Type ID and signing certificate, web service URL and APNs push for updates; certificate renews yearly [?: Apple page returned no text; from vendor knowledge, **re-verify**]. No pass review process [?].
- **Google:** Issuer account, Wallet API enabled, service account; starts in **Demo Mode** (only test accounts); "Request publishing access" triggers Google review; lead time undocumented [P: developers.google.com/wallet/generic/getting-started/issuer-onboarding, /auth/rest].
- **Security:** keep signing keys in the vault/KMS; QR carries an opaque, rotatable token only (no PII); revoke on cancellation.
- **Mobile:** buttons need no extra store review; privacy labels/Data Safety unchanged unless new SDKs [?].
- **ARIA:** suggest "add your pass" after purchase; propose lapse/renewal reminders as pass messages (never marketing pushes without consent).
- **Complexity / support:** M (both); certificate renewal and registration bugs. **Recommendation: Near** (high dancer value, only Google has a review).

### 5.2 Zoom / Google Meet / Teams
- Zoom: REST OAuth app creates meetings; Marketplace review in two phases (compliance, then security/scope), lead time forum-reported 72 h to 4+ weeks [P: developers.zoom.us app-review-process; S forum]. Each studio needs its own Zoom account. Meet REST API creates spaces and returns attendance [P: developers.google.com/workspace/meet]. Teams delegated meetings need work/school accounts; app-only needs tenant policy [P: learn.microsoft.com].
- **Recommendation: Later** (pasted-link field on a class is the interim, S; Zoom first if asked; Teams Reject).

### 5.3 YouTube / Vimeo
- YouTube Data API 10,000 units/day default; extensions need compliance audit; ToS permits audits and requires data deletion on termination [P: developers.google.com/youtube]. Vimeo plan/rate facts inconsistent [?].
- **Recommendation: Reject as Mux replacement; Later: "paste a URL to embed" as supplemental content.**

### 5.4 Slack / Discord
- Slack directory listing needs security review (allow weeks) and locks the live version; Discord privileged intents review now user-count based (10,000) [P: docs.slack.dev, docs.discord.com].
- **Recommendation: Later; incoming webhooks via the generic layer only if asked.**

### 5.5 Community platforms (Circle, Mighty Networks, Facebook Groups)
- Circle Admin API on Business plan and above; Mighty Admin API tier docs conflict [S]; Facebook Groups API not verified [?]. Studio must pay for a third-party plan; native messaging overlaps. **Recommendation: Later, link-out only; no SSO.**

## 6. Music, practice, health

- **Spotify:** Development Mode limited (Premium owner, 5 allowlisted users, endpoints reduced Feb 2026); Extended Quota is organization-only with business/MAU requirements (reported ≥250k MAU, up to ~6 weeks) [P: developer.spotify.com quota-modes, february-2026-migration-guide]. **Reject API; Near/S: paste-in Spotify/Apple Music playlist link field per class.**
- **Apple MusicKit / SoundCloud / Soundslice / tempo tools:** MusicKit needs paid developer account + tokens; SoundCloud by application; Soundslice API for paying customers and not dance/BPM-oriented; no public API found for slow-downer apps [P/?]. **Later, optional.**
- **HealthKit / Health Connect (workout write):** Health Connect needs the Play Console Health declaration per data type [P: developer.android.com/health-and-fitness/health-connect/publish]; HealthKit review specifics unverified [?]. Fitbit legacy API ending 2026 and Garmin access reportedly paused [S]. **Later (write-only workout/streak); Reject Fitbit/Garmin.** Privacy: explicit consent, write-only, no health-data reads.

## 7. Compliance, signatures, payments, insurance

- **E-signature (DocuSign / Dropbox Sign):** DocuSign production needs a paid developer plan and go-live review; Dropbox Sign API tiers $75–$250/mo (re-confirm) [S: ecom.docusign.com; P: help.dropbox.com]. ESIGN/UETA general validity; minors/liability releases are state contract law — no legal conclusion here. **Reject for now; keep native documents.**
- **Background checks (Checkr):** Partner application, OAuth, ~2 weeks integration claimed, public report pricing $29.99–$94.99 [P: docs.checkr.com/partners, checkr.com/pricing]. FCRA disclosures/adverse-action obligations apply [P: ftc.gov guidance]; counsel review required. **Later: a native "background check status/date/expiry" tracking field with link to the studio's own account; never store reports; Reject deep integration.**
- **Insurance:** No public carrier APIs found for dance studios [S]; Mindbody has a first-party referral. **Native: COI upload with expiry reminders (S, documents). Reject API.**
- **Stripe Terminal / Square:** Terminal supports Connect direct charges (readers belong to the connected account) [P: docs.stripe.com/terminal/features/connect]; Square would add a second processor, onboarding and reconciliation model [S]. Pricing not confirmed [?]. **Later: Stripe Terminal only (L, mobile SDK work); Reject Square.**
- **Review platforms (Yelp, Facebook ratings):** Yelp returns three excerpts; Facebook needs App Review [S]. **Reject; link to profiles.**

## 8. What competing studio platforms advertise (public pages, small sample)
Jackrabbit: partner marketplace (payments, payroll, QuickBooks export, Zapier, curriculum, streaming). Mindbody: public API (free sandbox, 1,000 calls/day; per-call fee beyond, per FAQ), insurance referral. Studio Pro: Zapier-first (QuickBooks, Xero, Mailchimp via Zapier), Google apps. Studio Director: native QuickBooks Online per Capterra, no Zapier app. Pike13: native Mailchimp, Zapier. Sources: jackrabbitclass.com/partner-marketplace, developers.mindbodyonline.com/resources/faqs, zapier.com listings, capterra.com, help.pike13.com [mixed P/S]. Reading: Zapier and QuickBooks (native or via Zapier) are table stakes; most others are rare. No public API for dance competition, recital, costume or photo vendors was found (§9).

## 9. Competition-adjacent (internal-confidential, generic)
- Hard exclusions for any generic Connected Apps/webhook/Zapier layer, per the Competition coordinator: **minors' (U18) data, scoring/results and judge identity, and payment/Stripe data**, until a rulebook-governed decision says otherwise.
- ICS/calendar subscription for such events is **excluded until release**; the owner decides. No outreach to organizers or directors is proposed here (permanent policy).
- Public dance APIs found are federation/scoring APIs (e.g. WDSF restricted to certified software) and are not studio-commerce integrations [S]. Nothing to integrate.

## 10. Ranked summary

| # | Candidate | Native / 3rd | Value | Effort | Approval lead | Duplication risk | Priority |
|---|---|---|---|---|---|---|---|
| 1 | Per-dancer + staff ICS feeds (extend existing) | Native | High (all dancers; Apple/Outlook/Google read-only) | S | none | none | **Near** |
| 2 | Webhooks + public REST + API keys; Zapier/Make private apps | Native + 3rd | High long-tail | M + S | none (private) | low | **Near** |
| 3 | Apple/Google Wallet passes | Native + platform | High (dancer, front desk) | M | Google publish review | low | **Near** |
| 4 | Accounting/payroll exports (QuickBooks-ready CSV/journal, payroll timesheet) | Native | Med-High | S–M | none | existing accountant deliveries | **Near** |
| 5 | Embed docs/snippets per website builder | Native | Medium | S | none | none | **Near** |
| 6 | Playlist link field; COI upload+expiry; background-check status field | Native | Medium | S each | none | none | **Near/Later** |
| 7 | Google Calendar two-way/busy hints (after fixes) | 3rd | Medium | M | Google verification | overlaps ICS | Later |
| 8 | Microsoft Graph calendar | 3rd | Low-Med | M–L | publisher verification | overlaps ICS | Later |
| 9 | QuickBooks Online / Xero direct | 3rd | Medium | L / M–L | Intuit/Xero tiers | export covers most | Later |
| 10 | Google Business Profile reviews | 3rd | Medium | M | access application | none | Later |
| 11 | Zoom; Mailchimp; Stripe Terminal; HealthKit/Health Connect write; Slack | 3rd | Low-Med | M–L | various | partial | Later |
| 12 | Meta Lead Ads / WhatsApp / Instagram | 3rd | Low | L | App Review + Business Verification | overlaps SMS/forms | Reject (use Zapier) |
| 13 | HubSpot, Klaviyo, CC, AC; Calendly/Cal.com; Square; DocuSign; Spotify API; Fitbit/Garmin; Teams; CalDAV write; embedded payroll; review APIs | 3rd | Low | M–L | high | high | Reject |

## 11. Cross-cutting provider-approval facts (lead times)
No review: Apple Wallet, ICS, Make invite link, Zapier private, Mailchimp/Constant Contact app registration. Documented: Google sensitive-scope verification up to 10 days (+ CASA for restricted); HubSpot ≤10 business days initial; Zapier first response ~1 week. Undocumented/anecdotal: Meta Business Verification (weeks–60 days), Google Wallet publishing, Google Business Profile, Zoom (3 days–4+ weeks), Slack (weeks), Gusto/ADP/Paychex (weeks–months), Spotify Extended Quota (~6 weeks, org-only). Install-count gates: HubSpot 3, Klaviyo 5 active installs. Webhook/subscription renewals needed: Microsoft Graph (<7 days), Google `watch`.

## 12. Items needing re-verification before commitment
Intuit (assessment, rate limits, webhooks, pricing), Apple Wallet certificate/update specifics, Google `calendar.events` sensitivity label, Wave new-app acceptance, Gusto/Paychex/ADP costs, Stripe Terminal pricing, Meta data-use terms, Mailchimp API policy/rate limits, builder app-store rules, minors/waiver law.
