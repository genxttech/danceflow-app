# KB-2A (D7): evidence and independent review record

Scope: content-only corrections to 25 existing articles flagged in KB-1 section 2.7, made on the Markdown files from KB-2B-3. Each change below lists the exact old and new text and the code evidence. Independent reviewers received only the evidence table and the code (not the author's conclusions) and wrote the verdicts in Part 2. Findings from review were applied before this PR was opened (see Part 3).

## Part 1: evidence tables

### Table A
#### D7 evidence A (src paths relative to worktree kb-d7)

| slug | old text | new text | claim corrected | evidence | why wrong today |
|---|---|---|---|---|---|
| getting-started-with-organizer-workspace | "- Performer or competitor registration" | "- Performer registration" | competitor registration offered as ticket option | src/lib/competition/registrationFlag.ts:3-4 (NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED === "true") | public competition registration is flag-off |
| checking-in-event-attendees | "- Scan the attendee QR code when QR scan mode is available" | "- Scan the attendee QR code with the scanner on the event check-in page, where your device and browser allow camera access" | nonexistent "QR scan mode" | src/app/app/events/[id]/check-in/page.tsx:16,1172 (TicketCodeScanner); src/app/app/events/checkin/page.tsx:505,574 | no mode toggle; a scanner panel/component |
| checking-in-event-attendees | "## Duplicate check-in protection ... the system should protect the attendance record from being duplicated." | "## Duplicate check-ins ... shows a warning ... This is a warning for staff to act on, not a guaranteed block" | duplicate protection | check-in/page.tsx:269-275 (warning text); registrations/actions.ts:1385-1403, 1615-1626 (read-then-warn redirect, no atomic guard) | only a warning |
| using-event-qr-tickets-and-scan-check-in | "## Check in with QR scan mode ... 2. Choose scan mode when available." | "## Check in with a QR scan ... 2. Use the scanner at the top of the page (or the manual ticket-code field)." | scan mode | same as above; checkin/page.tsx:574 ("scanner and manual ticket-code field at the top") | no mode choice |
| using-event-qr-tickets-and-scan-check-in | "## Duplicate check-in protection / ...should help prevent duplicate attendance records." | "## Duplicate check-ins / ...shows a warning ... Verify the attendee before admitting a duplicate ticket." | duplicate protection | check-in/page.tsx:269-275; registrations/actions.ts:1403,1626 | warn only |
| using-early-bird-ticket-pricing | "- Competitions and showcases" (in "works well for") | removed | competition use case | registrationFlag.ts:3-4; src/app/events/[slug]/... register gate (test asserts notFound when flag off, lib/competition tests ~131-139) | competition/showcase public registration flag-off |
| using-expenses-and-floor-fee-expense-tracking | "lets studios and independent instructors record business expenses in DanceFlow." | "lets studio owners and admins (and organizer owners and admins) record business expenses in DanceFlow. Other studio roles, such as front desk, can view expenses but not add them, and independent instructors do not have access to the studio Expenses page." | independent instructors record expenses | src/app/app/expenses/page.tsx:182-184 (redirect), 192-196 (allowManage = platform admin / organizer_owner/admin / studio_owner/admin); lib/auth/permissions.ts:426-434 | instructors redirected; front desk not in allowManage |
| what-is-danceflow | "- Event registrations, tickets, and check-in" | "... (event registration and ticketing require the Organizer Suite)" | included for every studio | src/app/app/events/actions.ts:398-413 (without Suite: registrationRequired=false, windows, waitlist off), 1084-1111; event checkout routes return organizer_suite_required (api/events/cart/checkout/route.ts:604) | needs Organizer Suite |
| what-is-danceflow | "- Keep event tickets and QR codes in their wallet" and "- Register for events through the student app when available" | removed | student app/wallet as available | no web wallet in src/app (grep); mobile/student is v0.1.0 (app.json:6), store release unconfirmed | not confirmed released |
| what-is-danceflow | "stays connected through the portal and app" | "stays connected through the portal" | app availability | same | same |
| current-danceflow-capabilities | (Events section) added: "Event registration and ticketing require the Organizer Suite; without it, events can be listed but registration and ticket sales are not available. Public registration for competitions is not yet generally available." | | included for all; competition | events/actions.ts:398-413; registrationFlag.ts:3-4 | |
| current-danceflow-capabilities | "## Student app and wallet" section (native in-app payments, wallet, QR, etc.) | "## Student portal" - "Studios can link clients to a student portal for schedule visibility and student-facing documents on the web." | student app/native payments/wallet presented as available | mobile/student/app.json:6 (0.1.0), store release unconfirmed; web portal exists src/app/portal/[studioSlug] | not confirmed released |
| how-danceflow-protects-your-data | "...public forms." (Rate limiting section) | + "These limits are currently tracked in memory on each server instance rather than shared across all of them, so they reduce abuse but are not a hard global cap." | rate limiting strength | src/lib/security/rate-limit.ts:19-31 (globalThis Map), checkRateLimit; login use src/app/(auth)/actions.ts:329-335 | per-instance in-memory |
| how-danceflow-protects-your-data | "DanceFlow avoids showing sensitive ... details in user-facing error messages." | "DanceFlow works to avoid ... This is still being tightened: a few screens and API responses can show the underlying error text." | error message safety | src/app/app/automations/actions.ts:323,342,386 (redirect error=encodeURIComponent(db error.message)) rendered at automations/page.tsx:515; ~11 api route files return error.message (e.g. api/notifications/generate/route.ts:300,575) | raw DB messages reach users |

## Not changed
- how-danceflow-protects-your-data "Oversold events" (event ticketing controls): capacity checks exist (api/events/cart/checkout/route.ts:734) with a capacity hold (~1166); could not prove oversell is possible from code read.
- what-is-danceflow "Event waivers and signed-document receipts" / capabilities "Documents": could not prove waiver features are Suite-gated.
- getting-started article "Competitions" event type, and Step 7 text: event type creation exists; only public registration is flagged.
- security article mobile app ownership checks: API routes exist; wording does not claim store availability.
- Student-app mentions elsewhere in the security article ("student app requests", wallet items): describe server-side checks, not availability; left.
- capabilities "Security and privacy" paragraph lists rate limiting/error handling as hardening passes; accurate as history.

### Table B
#### D7 evidence B (paths relative to worktree kb-d7)

| article | old text | new text | claim corrected | evidence | why wrong today |
|---|---|---|---|---|---|
| sms-consent-and-message-history | (none, after intro sentence) | "Text messaging is not active yet for studios. You can record consent now ... until your studio's SMS registration is approved." | article implied SMS works | src/app/app/clients/[id]/ClientSmsConsentCard.tsx:68-74; src/lib/sms/compliance.ts:381-421 | sending is fail-closed; UI says not active yet |
| sms-consent-and-message-history | "go to the Marketing tab." | "go to the Communication tab." | tab name | src/app/app/clients/[id]/page.tsx:547 (id marketing, label "Communication") | tab labelled Communication |
| sms-consent-and-message-history | "The client Marketing tab can show recent SMS message history, including queued, sent, delivered, or failed messages when available." | "The client Communication tab can show ... queued, sent, delivered, failed, not sent, or received messages when available. Because texting is not active yet, expect this history to be empty for now." | tab name, status set, history | compliance.ts:345-355 (labels incl. Not sent, Received); ClientSmsMessageHistoryCard.tsx (empty state); ClientCommunicationWorkspace.tsx | tab name wrong; statuses incomplete; no sends occur |
| sms-consent-and-message-history | "If a client replies STOP, keep them opted out unless they later opt back in." | "If a client replies STOP, they stay blocked from texts until they text START to resubscribe; staff cannot lift a text STOP." | STOP/START rule | compliance.ts:108-110, 138-141 | only contact can lift STOP via START |
| sms-opt-in-for-studios | (none) | "Text messaging is not active yet for studios. You can record consent now, but ... SMS registration is approved." | implied SMS working | same as row 1 | same |
| sms-opt-in-for-studios | "Clients can opt out of SMS messages by replying STOP. They may reply HELP for help." | "...replying STOP, and can resubscribe by replying START. They may reply HELP for help." | START omitted | compliance.ts:193-197 | START resubscribes |
| using-aria-revenue-insights | "prepare or send certain low-risk communications" | "...low-risk email communications" | channel | src/lib/aria/automation-catalog.ts:28 (executableChannel "email"/"system"/"none"), no sms | execution is email-only |
| using-automations-for-client-follow-up | "permission to send an email or text message.\n\nExternal delivery still depends on the underlying rule being explicitly allowed to send." | "permission to send an email.\n\n... explicitly allowed to send. ARIA automation sends email only; it does not send text messages." | SMS automation | automation-catalog.ts:28 and grep: no sms channel in src/lib/aria | no SMS execution |
| aria-autonomy-and-safety | "to send email or SMS.\n\nA communication is sent automatically only when ..." | "to send email.\n\n... ARIA automation sends email only; it does not send text messages." | SMS automation | same | same |
| aria-automation-center-and-operations | "Front Desk pack = Handle automatically ... ARIA can automatically perform the safe parts of supported Front Desk workflows. A cancellation or schedule conflict ... changed automatically." | "Sales and Retention pack = Handle automatically ... ARIA can automatically send email for the supported rules in that pack, such as low package balance outreach. Front Desk items, such as a cancellation or an unconfirmed appointment, are surfaced in Operations ...; ARIA does not act on them automatically." | Front Desk execution | automation-catalog.ts:114-122, 274-281, 366-373 (all front_desk rules executableChannel "none"); email rules at :130-204 are sales_retention, client_relations, billing_payments | no Front Desk rule executes |
| creating-a-marketing-campaign | workflow steps 6-8 (Send a test email / Review final confirmation / Send) | inserted "Prepare the send list"; "tick the confirmation box"; added "Campaign sending is not generally available yet..." | missing steps; freeze | src/app/app/marketing/campaigns/[id]/page.tsx:1331-1334 (Prepare Send List), 1470-1482 (confirmSend checkbox), 1500-1507; release fact: M-0 sends frozen in prod | steps missing; sending not live in prod |
| creating-a-marketing-campaign | "DanceFlow can suppress unsubscribed contacts, but each studio is responsible for using marketing tools responsibly.\n\nMarketing emails should include the studio's required footer information and a clear unsubscribe option." | "When you prepare the send list, DanceFlow checks it against unsubscribed contacts and excludes them, but ... A campaign cannot be sent until the studio's mailing address is saved in Settings for the email footer. Before sending you must tick a box confirming..." | suppression timing; footer is enforced requirement | src/app/app/marketing/campaigns/actions.ts:995-997 (eligibility decided when list is generated), page.tsx:114-115, 172-181, 848, 1450-1459, 1470-1482 | footer address and confirm box are hard requirements, not advice |
| understanding-marketing-audiences | "- Event registrants\n- Checked-in event attendees" | "- All event registrants\n- Specific event registrants\n- Specific event checked-in attendees" | audience labels | src/app/app/marketing/campaigns/page.tsx:64-79 | labels differ |

## Not changed
- Marketing audiences "depend on subscription tier" sentence: no code proof either way.
- Audience preview "Suppressed or unsubscribed contacts" bullet: campaign page shows suppressed counts (page.tsx:738-741, 783); true.
- using-aria-revenue-insights "First-lesson clients who should receive a follow-up message": surfacing only; true.
- Financial-safety lists in ARIA articles: not contradicted by code reviewed.
- Handle automatically / Prepare / Notify / Off definitions: not verified against runtime, left.
- No claim in campaign article of working List-Unsubscribe; the "unsubscribe link" is only in the send checkbox UI text.

### Table C
#### D7 evidence C (worktree kb-d7, branch claude/kb-2a-d7-corrections)

All paths below are under src/ of the worktree. Article edits are in src/content/knowledgebase/articles/.

| article slug | old text | new text | claim corrected | evidence | why wrong today |
|---|---|---|---|---|---|
| taking-in-person-payments-with-tap-to-pay | "- Quick Sale & Payment for package sales or package payments" | "- Sell to Client (the Sell page) for package sales or package payments" | nonexistent page name | app/app/sales/new/page.tsx:20 (redirect to /app/sell); app/app/layout.tsx:653 label "Sell to Client"; app/app/sell/page.tsx:405 title="Sell" | No "Quick Sale & Payment" exists; legacy route redirects to Sell. |
| taking-in-person-payments-with-tap-to-pay | "- Payments page for ad hoc payments" | "- Take Payment for ad hoc payments (choose Record collected payment)" | ad hoc payments page/flow | app/app/payments/take/page.tsx:100 h1 "Take Payment"; TakePaymentForm.tsx:~381 option label "Record collected payment"; layout.tsx:643 "Take Payment / Payouts" | Ad hoc payments are recorded on Take Payment, not a generic "Payments page". |
| taking-in-person-payments-with-tap-to-pay | "- Payment method: Card" | "- Method: Card already collected" | field/option label | TakePaymentForm.tsx:~285 label "Manual method", :294 `<option value="card">Card already collected</option>`; SellPackageForm.tsx:472 same option | Field is "Manual method" and the card option reads "Card already collected". |
| taking-in-person-payments-with-tap-to-pay | "- Payment channel/source: In-person or Tap to Pay, when available" (line removed) | (removed) | nonexistent field | grep of app/app/payments/take/TakePaymentForm.tsx and app/app/sell: no channel/source field and no "Tap to Pay" option | There is no channel field. |
| collecting-in-person-card-payments-in-danceflow | "3. Choose In-person card reader." | "3. Choose Card reader (on a package sale, click Continue to Card Reader)." | option label | TakePaymentForm.tsx:385 label "Card reader", :450 "Continue to card reader"; SellPackageForm.tsx:681 "Continue to Card Reader"; memberships/sell/SellMembershipForm.tsx:397 "Card reader" | Option is "Card reader" (the "In-person card reader" wording only exists on event ticket sales, events/sell-tickets/SellTicketsForm.tsx:282). |
| collecting-in-person-card-payments-in-danceflow | "7. Refresh the status after the payment is completed, if needed." | "7. Click Refresh status after the payment is completed, if needed." | button label | app/app/payments/terminal/[paymentId]/page.tsx:390 "Refresh status" | Names the real button. |
| collecting-in-person-card-payments-in-danceflow | "or quick charge when available" | "or Quick Charge" | Quick Charge presented as future | app/app/payments/quick-charge/QuickChargeClient.tsx:307; app/app/sell/UnifiedSalesForm.tsx:274 "Quick Charge" tile; payments/take/page.tsx:145 | Quick Charge is live. |
| collecting-in-person-card-payments-in-danceflow | "The intended flow is:" | "The flow is:" | presented as future | same as above (QuickChargeClient.tsx:30-31 presets "Group Class", "Social Party"; :401 "One click sends the preset amount to the selected Stripe reader and records the payment when it succeeds.") | Flow is implemented. |
| collecting-in-person-card-payments-in-danceflow | "DanceFlow sends the payment to the default registered reader." | "DanceFlow sends the payment to the reader selected on the Quick Charge page." | wrong reader selection | QuickChargeClient.tsx ~315 "Pick the front desk reader once. Preset buttons will send the charge directly to that reader." | Reader is selected on the page, not a "default". |
| collecting-in-person-card-payments-in-danceflow | "use the cancel option before trying again." | "use Cancel attempt before trying again." | button label | payments/terminal/[paymentId]/page.tsx:399 "Cancel attempt" | Names the real button. |
| collecting-in-person-card-payments-in-danceflow | "Quick Charge may be expanded separately ... fewer steps." (paragraph) | NOT removed (see note) | n/a | n/a | Unchanged; the earlier edit in my batch did not touch it (the node script did not include it). Left as is; see not changed. |
| importing-client-data-from-a-csv | "- status\n- is_independent_instructor" (recommended columns) | (removed) | columns not read | app/app/settings/import/actions.ts:500-531 buildClientCandidate reads no status or is_independent_instructor column; actions.ts:~4586 inserts `status: "active"` | These columns have no effect on client import. |
| importing-client-data-from-a-csv | "The most important fields are first name, last name, and email. If a client does not have..." | "First name and last name are required on every row. Email is optional, but if a client does not have..." | required columns | actions.ts:1767-1771 "First name is required." / "Last name is required."; :1960,:1973 missing-header errors; no email requirement | Email is not required by the import. |
| importing-client-data-from-a-csv | "**Settings > Import**" | "**Settings > Import existing data**" | menu label | app/app/settings/page.tsx:~484-490 link to /app/settings/import labelled "Import existing data" | No "Import" item. |
| importing-client-data-from-a-csv | "Click **Upload**." | "Click **Review Clients File**." | button label | app/app/settings/import/page.tsx:526 `submitLabel={\`Review ${activeStage.label} File\`}` (ImportUploadForm.tsx:314 renders submitLabel; default "Create Import Batch" is not used here) | Upload button is labelled "Review Clients File". |
| importing-client-data-from-a-csv | "- Invalid status values" | (removed) | invalid-status error | actions.ts:500-531 (status not read for clients) | No client status validation. |
| importing-client-data-from-a-csv | "Click **Execute Import** or **Import Ready Rows**." | "Click **Execute Client Import**." | button label | app/app/settings/import/[batchId]/page.tsx:152 `"Execute Client Import"`; no "Import Ready Rows" button (only a "Ready Rows" metric, :827) | Real label. |
| importing-client-data-from-a-csv | "email addresses, phone numbers, and status values imported correctly" | "email addresses, and phone numbers imported correctly" | status values | actions.ts:~4586 status forced "active" | Status is not imported. |
| billing-payments-and-payouts | "Subscription billing is managed from the Billing & Payouts area." | "... which only the studio owner can open." | wrong roles | app/app/layout.tsx:~744-752 (Billing & Payouts inside `isOwner ? [...]`); lib/billing/subscriptionAuthority.ts:11-15 (studio_owner, organizer_owner, platform admin only) | Subscription management is owner-only. |
| billing-payments-and-payouts | "The Client Payments page helps staff search and review payment activity." | "The Payment Ledger page (open it from Take Payment / Payouts) helps staff search and review payment activity." | page name | app/app/payments/page.tsx:235 title="Payment Ledger"; layout.tsx:643 "Take Payment / Payouts" -> /app/payments | No "Client Payments" page. |
| billing-payments-and-payouts | "- Client\n- Date range\n- Payment status\n- Payment method\n- Source\n- Payment type" | "- Search (client, description, method, or reference)\n- Date range\n- Status\n- Method\n- Payment type" | filters | payments/page.tsx:306-308 search placeholder "Client, description, method, reference..."; :325-357 range/status/method/type selects; no source filter | No Client or Source filter exists. |
| client-portal-linking-invites-vs-existing-accounts | "log in through **Public Account / Client Portal** and access the portal for your studio." | "log in through **Student / Dancer** on the DanceFlow login page and access ..." | login option | app/(auth)/login/page.tsx:186 "Studio", :224 "Student / Dancer" | No "Public Account / Client Portal" option. |
| client-portal-linking-invites-vs-existing-accounts | "Use linking when ... using the same email address." | "... using the same email address, and that account has verified the email. If the account has not verified that email, DanceFlow will not link it; send a portal invite instead." | linking precondition | app/app/clients/[id]/actions.ts:653-659 and :831-840 (portal_account_unverified); clients/[id]/page.tsx:2043-2047 message "...Send a portal invite instead..." | Linking requires a verified email. |
| client-portal-linking-invites-vs-existing-accounts | "2. Open the client record.\n3. Confirm the client has a valid email address.\n4. Choose the portal invite option.\n5. Send the invite." | "2. Open the client record and open the **Portal / Account** tab.\n3. Confirm ...\n4. Click **Send Portal Invite**." | UI path | clients/[id]/page.tsx:551 tab "Portal / Account"; :5509 "Send Portal Invite" | Real tab and button. |
| client-portal-linking-invites-vs-existing-accounts | "4. Use the portal linking option.\n5. Save the change." | "4. Open the **Portal / Account** tab and click **Link Existing Account**." | UI path | clients/[id]/page.tsx:5489 "Link Existing Account"; the action runs on click with no Save step | Real button, no save step. |
| client-portal-linking-invites-vs-existing-accounts | "After linking, the client can log in through **Public Account / Client Portal**" | "... through **Student / Dancer**" | login option | login/page.tsx:224 | as above |
| client-portal-linking-invites-vs-existing-accounts | "The client is using **Public Account / Client Portal**, not **Studio Login**" | "The client is using **Student / Dancer**, not **Studio**" | login options | login/page.tsx:186,224 | as above |
| client-portal-linking-invites-vs-existing-accounts | "- The email on the client record matches the login email" | "... matches the login email, and the account has verified that email" | troubleshooting | clients/[id]/actions.ts:653-659 | linking blocked if unverified |
| troubleshooting-client-portal-invite-emails | "**Public Account / Client Portal**" and "**Studio Login**" | "**Student / Dancer**" and "**Studio**" | login options | login/page.tsx:186,224 | as above |
| troubleshooting-client-portal-invite-emails | "- Use notify@idanceflow.com or another verified sender.\n" | (removed) | internal ops advice | Studios do not configure the DanceFlow sending address; no studio setting for invite sender found in app/app/clients/[id] or settings | Not actionable for studios. |
| managing-booking-requests | "Go to **Schedule > Requests**.\n\nThe request queue shows pending, approved, declined, and all requests." | "Go to **Self-service Requests** in the menu (the **Schedule Requests** page). The **Booking Requests** button on the Schedule page opens the same page.\n\nThe request queue has tabs for pending, executed, declined, and failed requests." | nav/page/tabs | components/app/sidebar/navUtils.ts:216,1545 "Self-service Requests"; app/app/schedule/self-service/page.tsx:239 "Schedule Requests", :277 tabs `["pending","executed","declined","failed"]`; schedule/requests/page.tsx redirects to self-service; schedule/page.tsx:1737 "Booking Requests" button | No "Schedule > Requests" path or "approved/all" tabs. |
| managing-booking-requests | "- **Approved**: converted into an appointment\n- **Declined**: not scheduled" | "- **Executed**: approved and carried out on the schedule\n- **Declined**: not scheduled\n- **Failed**: the request could not be carried out" | status names | self-service/page.tsx:75-78; lib/booking/selfServiceExecution.ts:180 `status: "executed"` | Approved requests are stored and shown as executed. |
| managing-booking-requests | "approve it and create the appointment." | "approve it so the appointment is created." | flow | self-service/actions.ts:115 approval executes the booking itself | Staff do not separately create the appointment. |
| approving-or-declining-booking-requests | "Go to **Schedule > Requests** and open the pending request." | "Go to **Self-service Requests** (the **Schedule Requests** page) and find the request on the **Pending** tab." | nav | as above | as above |
| approving-or-declining-booking-requests | "the request is marked approved." | "the request moves to the **Executed** tab." | result status | selfService actions.ts:136; selfServiceExecution.ts:180; page.tsx:277 | Result is executed. |
| portal-schedule-requests | "This is not instant booking. The studio still reviews and approves the request before an appointment appears on the schedule." | "Unless the studio sets the booking mode to Instant, this is not instant booking. The studio still reviews ... \n\nThe studio chooses the mode in Settings under Student portal scheduling: Disabled, Request only, Approval required, or Instant." | modes | app/app/settings/SettingsForm.tsx:34 modes, :72 "Booking mode" select; portal SelfServiceBookingPanel.tsx:90-112 ("Instant booking", "Your lesson was booked.") | An Instant mode exists, so "not instant booking" is not universally true. |
| portal-schedule-requests | "Staff reviews portal schedule requests from **Schedule > Requests**." | "... from **Self-service Requests** (the **Schedule Requests** page)." | nav | as above | as above |
| portal-schedule-requests | "Keep instant booking disabled until" | "Keep the booking mode off Instant until" | label | SettingsForm.tsx:34 | Real mode name. |

Note on the row marked "NOT removed": I did not edit the paragraph "Quick Charge may be expanded separately from linked package or membership payments because door-sale payments need fewer steps." It still reads as future-tense; that is listed below.

## Not changed

- collecting-in-person-card-payments-in-danceflow: the sentence "Quick Charge may be expanded separately from linked package or membership payments..." (future-tense, but not demonstrably false).
- collecting-in-person-card-payments-in-danceflow / taking-in-person-payments-with-tap-to-pay: "Staff know which ... lesson balance via Schedule or Daily Closeout" ("Daily Closeout" exists, schedule/page.tsx:1835); "Memberships for membership payments", "Event or door-sale tools" left as is.
- importing-client-data-from-a-csv: "Use Dry Run" / "Create or Update" wording (these modes exist at ImportUploadForm.tsx:273-275 but sit in an advanced details section); the independent-instructor troubleshooting section (hedged, still true because the column is ignored); Step 3 text (kept; real Recent Imports button also labelled "Review Clients File", import/page.tsx:830).
- billing-payments-and-payouts: "Starting a trial / Canceling or changing a plan" examples, payout wording, manual payment types (not contradicted by code read).
- client portal articles: "email from DanceFlow with a secure sign-in link", "should not need to request multiple magic links", spam-folder advice, "Resend the invite" (resend flow not verified either way).
- booking request articles: the whole public intro lesson request flow, "Future staff-created request workflows", and email notification sentence "received, approved, or declined" (approval-gap area or unverifiable; left alone). Not verified: the difference in behaviour between Request only and Approval required; article does not claim one.
- Decline "Add a staff note": real field is "Optional decline note" (self-service/page.tsx); advice is not false, left.

## Part 2: independent review verdicts

### Review of table A
getting-started-with-organizer-workspace (competitor reg) | CONFIRMED | registrationFlag.ts:3-4 flag gate; one-word edit minimal.
checking-in-event-attendees (QR scan mode) | CONFIRMED | check-in/page.tsx:16,1172 renders TicketCodeScanner, no "mode"; camera wording matches TicketCodeScanner.
checking-in-event-attendees (duplicate) | CONFIRMED | check-in/page.tsx:269-275 warning text; [id]/registrations/actions.ts:1396-1408 redirects with warning=already_checked_in (read-then-write, no atomic guard). Note: in the normal path no duplicate record is written, so "not a guaranteed block" is true only as a race caveat; acceptable but slightly strong.
using-event-qr-tickets (scan mode) | CONFIRMED | events/checkin/page.tsx:574 "QR scanner and manual ticket-code field at the top"; no mode toggle.
using-event-qr-tickets (duplicate) | CONFIRMED | same warning at check-in/page.tsx:274; actions.ts:1403.
using-early-bird-ticket-pricing (Competitions and showcases) | OVERREACH | registrationFlag.ts gates only competition registration; showcases are ordinary events with public registration, so removing the whole bullet drops a true use case (minimal edit would be "Showcases").
using-expenses (independent instructors) | CONFIRMED | expenses/page.tsx:182-184 redirects independent instructors; 191-195 allowManage = platform admin / organizer owner+admin / studio_owner+admin; page has no other role gate so front desk can view.
what-is-danceflow (events require Suite) | CONFIRMED | events/actions.ts:399-413 forces registrationRequired=false/waitlist off without Suite (hasOrganizerSuite 1109); cart checkout route.ts:601-604 organizer_suite_required for organizer events.
what-is-danceflow (wallet / student app bullets removed) | UNVERIFIABLE | mobile/student has wallet.tsx and app.json version 0.1.0; store release cannot be determined from code, so old text is not provably wrong; removal is conservative.
what-is-danceflow ("portal and app" -> "portal") | UNVERIFIABLE | same as above (app availability not provable); edit minimal.
current-danceflow-capabilities (Events Suite sentence) | CONFIRMED | events/actions.ts:399-413; registrationFlag.ts:3-4; wording does not document flag-off behaviour.
current-danceflow-capabilities (Student app -> Student portal) | UNVERIFIABLE | old text's availability unprovable (mobile/student/app.json:6 0.1.0, wallet.tsx exists); new text true (portal/[studioSlug]/documents exists, schedule/appointments pages exist). Removes more than wallet (learning content, self-service booking, lesson check-in claims) without per-claim evidence: partly OVERREACH if those are released.
how-danceflow-protects-your-data (rate limiting) | CONFIRMED | lib/security/rate-limit.ts:25-35 globalThis Map store, per-instance; new sentence true.
how-danceflow-protects-your-data (error messages) | CONFIRMED | app/app/automations/actions.ts:320-345 redirects with encodeURIComponent(db error.message); 59 api route.ts files reference error.message (e.g. notifications/generate/route.ts:300 returns it); "a few" slightly understates but acceptable.

Unlisted diff lines (in these 8 articles): none. (current-danceflow-capabilities removal of "Students can review pending client-assigned documents..." and "The app is designed to help dancers..." belong to row 16.)
Other 17 articles in the diff (booking requests, ARIA, billing, SMS, CSV, marketing, etc.) are outside this evidence table; not reviewed.

### Review of table B
#### D7 review B (paths relative to kb-d7/src)

1 | CONFIRMED | app/app/clients/[id]/ClientSmsConsentCard.tsx:67-74 shows "Text messaging is not active yet" when !canSend; lib/sms/compliance.ts:381-421 readiness defaults to pending/canSend false. "until registration is approved" matches (per-studio approval itself not provable in code, consistent with owner statement).
2 | CONFIRMED | app/app/clients/[id]/page.tsx:547 tab id "marketing" is labelled "Communication".
3 | CONFIRMED | lib/sms/compliance.ts:345-355 labels Delivered/Sent/Failed/Not sent/Received/Queued; tab name per row 2. "expect empty for now" is a hedged inference from no sending (acceptable).
4 | CONFIRMED | lib/sms/compliance.ts:108-110,124,139-141: consumer STOP blocks, only contact can lift by START; no staff override found (only blocked_by_text_stop consumers are send gates and UI tip).
5 | CONFIRMED | same evidence as row 1 (ClientSmsConsentCard.tsx:67-74).
6 | CONFIRMED | lib/sms/compliance.ts:~193-197 STOP reply says "Reply START to resubscribe"; START reply resubscribes.
7 | CONFIRMED | lib/aria/automation-catalog.ts:28 executableChannel is "email" | "system" | "none" only; grep for sms/twilio in lib/aria returns nothing. (Old wording was generic rather than false; narrowing is justified but marginal.)
8 | CONFIRMED | automation-catalog.ts:28 and no SMS in lib/aria. (Old sentence was a negation, so only mildly misleading; new sentence is true.)
9 | CONFIRMED | same as row 8 (aria-autonomy-and-safety.md).
10 | CONFIRMED | automation-catalog.ts:114-123 (aria_booking_request_aging), 274-282 (unconfirmed appointment), 366-374 (cancellation follow-up): all front_desk-listed rules have executableChannel "none" and approval_required; email rules at 128-204 are packKey sales_retention (low package balance, auto_send, automatic). Note: the old text's "cancellation ... appears in Operations" was nearly right; edit is acceptable.
11 | UNVERIFIABLE-IN-CODE | Steps are correct: campaigns/[id]/page.tsx:1331-1334 "Prepare Send List", 1152/1184 "Send test email", 1470-1482 confirmSend checkbox. The sentence "Campaign sending is not generally available yet" rests on the M-0 production freeze; code only has an operator switch (lib/marketing/compliance/sendFreeze.ts, marketing_send_frozen RPC), so the owner must confirm PROD is still frozen at publication time.
12 | OVERREACH | Footer address requirement (page.tsx:114-115,172-181,1450-1459, "Add Marketing Footer First" button) and confirm box (1470-1482) are true; suppression at list-prepare (actions.ts:995-997) is true. But the old lines were not wrong (suppress unsubscribed; footer/unsubscribe guidance) and the edit drops the true statement that every email carries an unsubscribe link (page.tsx:1479-1481), so it is wider than needed; also "Settings" location of the address is not verified beyond error text at page.tsx:115. Low severity; consider keeping the old unsubscribe sentence.
13 | CONFIRMED | campaigns/page.tsx:64-79 labels "All event registrants", "Specific event registrants", "Specific event checked-in attendees".

(Rows 1-13 here are the 13 numbered rows in the order of the table: 1 sms-consent intro, 2 tab name, 3 history, 4 STOP; 5 opt-in notice, 6 START; 7 revenue insights; 8 follow-up automations; 9 autonomy-safety; 10 automation-center Front Desk; 11 campaign steps; 12 campaign suppression/footer; 13 audiences.)

## Diff lines with no row in table B
The git diff also modifies these 17 files that are not in table B (presumably covered by another evidence table; not reviewed here): approving-or-declining-booking-requests, billing-payments-and-payouts, checking-in-event-attendees, client-portal-linking-invites-vs-existing-accounts, collecting-in-person-card-payments-in-danceflow, current-danceflow-capabilities, getting-started-with-organizer-workspace, how-danceflow-protects-your-data, importing-client-data-from-a-csv, managing-booking-requests, portal-schedule-requests, taking-in-person-payments-with-tap-to-pay, troubleshooting-client-portal-invite-emails, using-early-bird-ticket-pricing, using-event-qr-tickets-and-scan-check-in, using-expenses-and-floor-fee-expense-tracking, what-is-danceflow.
Within the 8 articles in table B, every changed hunk maps to a row; no unlisted changes.

Not-changed items in table B (audience "subscription tier" sentence): code shows nothing either way (understanding-marketing-audiences.md:29), correctly left.

### Review of table C
#### D7 review C (paths under kb-d7/src)

Row ids = table line numbers (7-44).

7 | CONFIRMED | layout.tsx:653 "Sell to Client", sell/page.tsx:405 title "Sell"; sales/new redirects to /app/sell; no "Quick Sale" string anywhere.
8 | CONFIRMED | payments/take/TakePaymentForm.tsx:379 "Record collected payment"; layout.tsx:643 "Take Payment / Payouts".
9 | CONFIRMED | TakePaymentForm.tsx:286 "Manual method", :294 "Card already collected"; packages/sell/SellPackageForm.tsx:472 same option (new text says "Method:", acceptable shorthand).
10 | CONFIRMED | no channel/source/Tap to Pay field in TakePaymentForm.tsx or SellPackageForm.tsx.
11 | CONFIRMED | TakePaymentForm.tsx:385 "Card reader"; SellPackageForm.tsx:681 button "Continue to Card Reader" (no option there); "In-person card reader" only at events/sell-tickets/SellTicketsForm.tsx:282.
12 | CONFIRMED | payments/terminal/[paymentId]/page.tsx:390 "Refresh status".
13 | CONFIRMED | UnifiedSalesForm.tsx:274 "Quick Charge" tile; QuickChargeClient.tsx exists and is live.
14 | CONFIRMED | QuickChargeClient.tsx:30-31,401 flow implemented.
15 | CONFIRMED | QuickChargeClient.tsx:316 "Pick the front desk reader once..."; reader is chosen on page.
16 | CONFIRMED | terminal page.tsx:399 "Cancel attempt".
17 | n/a (not edited; paragraph unchanged, future-tense left, acceptable)
18 | CONFIRMED | settings/import/actions.ts:500-538 buildClientCandidate reads no status/is_independent_instructor; :4582 status forced "active". Removal minimal (only those two list items).
19 | CONFIRMED | actions.ts:1767-1771 first/last name required; no email requirement.
20 | CONFIRMED | settings/page.tsx:484-489 link "Import existing data" -> /app/settings/import (shown on the Settings page; "Settings > Import existing data" path accurate). Old "Import" label not found.
21 | CONFIRMED | import/page.tsx:526 submitLabel `Review ${activeStage.label} File`, clients label "Clients" (:38) -> "Review Clients File".
22 | CONFIRMED | no client status validation in buildClientCandidate/validation (actions.ts ~1760-1800); line removal minimal.
23 | CONFIRMED | import/[batchId]/page.tsx:152 "Execute Client Import"; no "Import Ready Rows"/"Execute Import" for clients.
24 | CONFIRMED | actions.ts:4582 status forced "active"; only "status values" removed from sentence.
25 | CONFIRMED | layout.tsx:745-752 Billing & Payouts under isOwner; settings/billing/page.tsx:1166-1190 non-owner sees "reserved for the account owner" page; subscriptionAuthority.ts:11-15 owner-level (organizer_owner/platform admin edge cases irrelevant to a studio article).
26 | CONFIRMED | payments/page.tsx:235 title "Payment Ledger"; layout.tsx:643 nav "Take Payment / Payouts" -> /app/payments.
27 | CONFIRMED | payments/page.tsx ~306-358: search "Client, description, method, reference...", range, status, method, type selects; no Client or Source filter. (New "Status"/"Method" shorthand for "All statuses"/"All methods" selects is fine.)
28 | CONFIRMED | (auth)/login/page.tsx:186 "Studio", :224 "Student / Dancer"; no "Public Account / Client Portal" string.
29 | CONFIRMED | clients/[id]/actions.ts:653-659 portal_account_unverified; clients/[id]/page.tsx:2043-2049 message says send portal invite.
30 | CONFIRMED | clients/[id]/page.tsx:551 tab "Portal / Account", :5509 "Send Portal Invite".
31 | CONFIRMED | page.tsx:5489 "Link Existing Account"; action redirects after run with no save step (actions.ts ~660ff).
32 | CONFIRMED | login/page.tsx:224.
33 | CONFIRMED | login/page.tsx:186,224.
34 | CONFIRMED | actions.ts:653-659.
35 | CONFIRMED | login/page.tsx:186,224 (both replacements in the same article).
36 | CONFIRMED | actions.ts:350-362 sender resolved by resolveOutboundFromEmail ("{Studio} via DanceFlow"), studio cannot set a sender; the sentence was not actionable/misleading. Only that bullet removed.
37 | CONFIRMED | navUtils.ts:1545 "Self-service Requests"; self-service/page.tsx:239 "Schedule Requests", :277 tabs pending/executed/declined/failed; schedule/page.tsx:1731-1737 "Booking Requests" -> /app/schedule/requests which redirects to self-service.
38 | CONFIRMED | self-service/page.tsx:75-78 statuses; selfServiceExecution.ts:180 status "executed". Pending line kept.
39 | CONFIRMED | self-service/actions.ts:105-125 approve calls executeApprovedStudentBookingAction (creates appointment itself).
40 | CONFIRMED | same as 37; pending is a tab.
41 | CONFIRMED | actions.ts approval redirects success=approved; request status becomes "executed" (selfServiceExecution.ts:180) shown on Executed tab.
42 | CONFIRMED | settings/SettingsForm.tsx:34 modes Disabled/Request only/Approval required/Instant, :70-72 section "Student portal scheduling", select "Booking mode"; portal SelfServiceBookingPanel.tsx:90 "Instant booking" mode exists.
43 | CONFIRMED | as 37.
44 | CONFIRMED | SettingsForm.tsx:34 "Instant" mode name.

## Unlisted diff lines
- collecting-in-person-card-payments-in-danceflow: "or quick charge when available" -> "or Quick Charge" is row 13; every changed hunk maps to a row. 
- billing: "Payment status" -> "Status", "Payment method" -> "Method" and removal of Client/Source are within row 27.
- portal-schedule-requests: added paragraph "The studio chooses the mode in Settings under Student portal scheduling: ..." is part of row 42 (verified SettingsForm.tsx:70).
- No changed lines found without a row. Minor note: in taking-in-person article, "Method: Card already collected" drops the "Manual method" prefix on Take Payment (acceptable).

Counts: CONFIRMED 37 (rows 7-16, 18-44), n/a 1 (row 17), all other verdicts 0.

## Part 3: dispositions after review

- using-early-bird-ticket-pricing: reviewer found OVERREACH (removed "Competitions and showcases"; only competition registration is flag-gated). Fixed: "Showcases" restored, "Competitions" stays removed.
- creating-a-marketing-campaign: reviewer found OVERREACH (dropped the true statement that emails carry an unsubscribe link). Fixed: "Marketing emails include an unsubscribe link." restored.
- creating-a-marketing-campaign, sentence "Campaign sending is not generally available yet": UNVERIFIABLE IN CODE. Rests on the release fact that Marketing M-0 sends are frozen in production (read-only verification 2026-11-21, per the APPS coordinator). Owner must confirm this still holds when the wording is published, or drop the sentence.
- what-is-danceflow and current-danceflow-capabilities (student app, wallet, "portal and app"): UNVERIFIABLE IN CODE whether the store release has happened. The edit is conservative (claims removed, not asserted false). Owner to confirm the Student app release state; if released, the claims can be restored in accurate form.
- Not touched, by design: the public intro-request approval question (articles 11, 41, 42), which needs a product decision; claims the code could not prove wrong are listed under "not changed" in each table.
