# Student app: release candidate checklist and web-dependency map

2026-11-15. Student (`com.idanceflow.student`). Status vocabulary: DONE (evidence), PENDING OWNER, BLOCKED (needs something outside Student), OPEN (Student work). Evidence: `docs/mobile/Student_Device_QA_R5.md` to `R7.md`, `Student_TalkBack_Audit.md`, `Student_iOS_Readiness.md`, `docs/mobile/APPS_STATUS.md` (coordinator's authoritative queue).

## A. What must be live server-side before a Student candidate is useful

| # | Requirement | Owner | Status |
|---|---|---|---|
| A1 | Student web APIs the app calls exist on PRODUCTION. Checked by route file against the live checkout (`C:\dwr`, 447d9b85): every `/api/student/*` route, `/api/stripe/client-checkout` and `/api/tickets/qr` the app calls is present on live. Re-run after the main-vs-live reconcile (the live checkout may be behind the deployed commit). | Coordinator / web | DONE for 447d9b85; re-verify after reconcile |
| A2 | `/account-deletion` public page live (the in-app "How account deletion works" link and the Play data-safety URL point at it, `LegalLinks.tsx`). **It is in main but absent from the live checkout 447d9b85: the link 404s until main reaches production.** `/privacy`, `/terms`, `/knowledgebase`, `/security`, `/dpa` are in live. | Owner (release of main) | BLOCKED on main-vs-live reconcile (`docs/audit/2026-11-15/I_main_vs_live_reconcile.md`) |
| A3 | #438 web pieces for Student (staff API is Business only; Student needs only the existing student routes in A1) | Web | No Student dependency on #438 beyond A1 |
| A4 | Stripe TEST publishable key and a connected test account, so the payment sheet and Pay Now return can be proven on a device (event tickets, payment requests) | Owner | BLOCKED (no Stripe TEST key); Pay Now browser handoff/return PASS without a real payment (R7) |
| A5 | Firebase project for release: `danceflow-mobile-dev` is a DEV project; decide whether Play internal testing uses it or a production project (new apps, `google-services.json`, FCM v1 key in Expo). Real push delivery needs the chosen project. | Owner | PENDING OWNER (decision 3 in APPS_STATUS) |
| A6 | Play upload keystore and Play App Signing (release builds refuse debug signing and a placeholder `google-services.json`, #513) | Owner | PENDING OWNER (decision 4) |
| A7 | Marketplace purchase channel. The app does not sell digital content (the item screen says "not sold inside the mobile app"; `createStudentMarketplaceCheckout` in `studentMarketplace.ts` is unused), while the public marketplace pages say "Purchase in the DanceFlow student app". Today nobody can buy. | Owner / product | PENDING OWNER (decision needed before marketplace is advertised; see D) |

## B. Student app items

| # | Item | Status |
|---|---|---|
| B1 | `fontScale` in MainActivity `configChanges` (live text-size change clips sign-in without it) | DONE: #533 merged (main 157f0098) with the owner's approval; the new text size applies at next launch (Android recreates the activity otherwise) |
| B2 | Photo-library string for iOS (`app.json`, `expo-image-picker` plugin) | PR #569 prepared, NOT merged: PENDING OWNER approval on its head (protected `app.json`). Three other introspected iOS plist items for the owner are listed in `Student_iOS_Readiness.md` |
| B3 | Real-device checks still BLOCKED: Event detail and Ticket (seed and harness flag ready in #572; waits for the emulator slot, order android-release, Business, Student), photo upload, real push delivery, real payments, Android 12 and older (no AVD), 16 KB page size, R8 minification, EAS cloud build, TalkBack gesture walk, VoiceOver, iOS | BLOCKED (see Student_Device_QA_R7.md "Still BLOCKED") |
| B4 | Offline ticket (cached tickets/QR at rest) | Open owner product decision (privacy/fraud); not built |
| B5 | Evidence already green (merged: #551 smoke, #552, #554 retry states, #557 VoiceOver announce, #560 named switches + tree audit, #566 buyers without a studio, #567 access-ended wording, plus #524 to #547 earlier): sign-in, magic link cold/warm, notification wording/channel/switch, dark mode, font 1.0/2.0, Pay Now return, smoke 13/13, jest 37 suites, screen-reader names/roles/announcements (#524 to #560) | DONE |
| B7 | In review, not merged: #572 (harness `--events` seed + ticket screen screen-reader tests, prepares the Event/Ticket device rows), #574 (checkout URL and Pay Now hardening, test-only) | OPEN, merge on green CI |
| B6 | Run the one-command device smoke (`mobile/student/scripts/qa-smoke/run.mjs`) then `a11y-audit.mjs` on the exact candidate commit before upload | OPEN at candidate time |

## C. Candidate gate (all must be true)

A2 live, A5 and A6 decided and in place, B1 done (merged), B2 decided, B6 PASS on the candidate commit, B3 rows either run or explicitly accepted by the owner, and the release is a signed AAB built from the recorded commit (artifact, versionCode, signing recorded in the coordinator report).

## D. Dependency map: Student behaviours versus the web fixes (A2/E audit, backlog G-01, G-05)

Context: G-01 moves the client record and portal link from checkout creation to after verified settlement (or opt-in). Audit file: `docs/audit/2026-11-15/A2_E_instruction_marketplace.md`.

| Student behaviour | File | Depends on a client/link created at checkout? | Verdict |
|---|---|---|---|
| Digital purchases in Wallet | `src/lib/studentWallet.ts` (reads `commerce_entitlements` by `user_id`) | No, by account | Safe. One gap fixed in this PR: with no linked studio the studio name fell back to "Studio"; it now comes from the server's library (`studentWalletDigital.test.ts`) |
| Digital library in Learn, playback, progress | `src/lib/studentDigitalContent.ts`, `app/(tabs)/learn.tsx`, `app/learn/digital/[entitlementId].tsx` (`/api/student/digital-content*`) | No; the list also renders with no portal access | Safe |
| "Owned" state on a marketplace item | `app/discover/marketplace/[catalogItemId].tsx` (`item.owned` from `/api/student/marketplace/[id]`) | Server computes `owned`; must be by entitlement/user, not by client link | Web to confirm in G-01 acceptance |
| Buying marketplace content | none in the app (A7) | n/a | G-01 has no live effect through the app today; the web buy path has to exist for G-01 acceptance (1) to be exercised |
| Studio portal for a buyer (schedule, billing, booking, signing, Lumi, self-service slots) | `/api/student/studio-links`, `getStudentAccess`, `app/(tabs)/home.tsx`, `wallet.tsx`, `learn.tsx` | **Yes**: a marketplace buyer previously got an active link with all four permissions and so saw the studio in the app | After G-01 new buyers see the no-studio states ("Ready when your studio connects"); these paths exist and are rendered. Existing marketplace-created links remain until the owner-gated cleanup; if links are removed the app shows the same empty states |
| Payment requests, packages, memberships, event tickets | `studentWallet.ts` by `client_id` | Only for a real studio client | Unaffected |
| Booking a lesson | `app/schedule/request.tsx`, `StudioSectionScreen.tsx` | Needs a link or the Discover inquiry path | A buyer who relied on the checkout-created link must use the inquiry path (already in the app) |
| Refund and expiry (G-05) | `studentWallet.ts` filters status `active` and `refunded_access_retained`; item shows `expiresAt` | Server writes `revoked`/`expired` | A revoked item simply disappears from Wallet and Learn with no explanation: needs a server field/status to show "access ended"; app change is small once the status exists |
| Paid but access not yet granted (PAY-WH-1 gap for digital settlement) | `app/(tabs)/wallet.tsx` has a checkout-sync card for event orders only | Webhook/RPC failure after capture | Not applicable while the app sells nothing; if purchases move to web, Wallet shows the item once the entitlement exists (pull to refresh); a "payment received, access pending" state needs a server signal |
| Mux playback and webhook reliability | `/api/student/digital-content/[id]/playback` | Server | Player surfaces errors with a retry (#554) |
| Web Learn/Wallet pages absent | n/a | n/a | No Student change |
