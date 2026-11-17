# Student release-readiness audit (code and docs only)

Date 2026-11-17, against main c47e3ae17. No device, no hosted database. Findings are from reading the code and the existing docs; anything not run is marked.

## 1. No raw caught message reaches a dancer

Guard tests exist and pass (`errorHelperGuard.test.ts`: no `x instanceof Error ? x.message : "..."` in `app/`, no fixed text from a bare catch). Reading every remaining `.message` use in `app/` and `src/`:

| Site | Verdict |
|---|---|
| `app/wallet/documents/[assignmentId].tsx` PDF `onError` set the viewer's own error message (or `String(pdfError)`) as the screen text | **Fixed in this PR**: fixed wording, the detail goes to the log only. The guard pattern missed it (multi-line ternary). |
| `app/events/orders/[orderId].tsx:185`, `app/events/[id]/register.tsx:336` `setNoticeMessage(error.message)` | OK: only when `isPaymentCancelled(error)`, whose text is our own ("Payment was cancelled"-style). |
| `app/settings.tsx:149` deletion refusal shows `error.message` | OK by design: only when it contains the server's "can't be deleted here" wording; otherwise a fixed sentence. |
| `app/settings.tsx:69` `result.message` (login email change) | Server-authored copy from the DanceFlow API. OK. |
| `src/lib/auth.tsx` `authLinkError` / reactivation | `friendlyAuthLinkError` maps codes; the reactivation message is compared, not shown. OK (not device-verified). |
| `src/lib/paymentSheetOutcome.ts:25` throws `new Error(sheetError.message)` | The payment provider's SDK text becomes an Error that screens then pass to `friendlyMessage`; see F1. |

**F1 (open, needs a decision): `friendlyMessage` keeps any caught message that is not offline or signed-out.** Its own comment says this is deliberate, so server wording like "That time was just taken" reaches the dancer. The cost is that any other thrown text also reaches the dancer: a database error from `if (error) throw error` in `src/lib/danceflowApi.ts:45` or in a direct Supabase read, or the payment SDK's message. 28 call sites use it (settings, wallet, checkout, documents, learn, discover, schedule request, auth secure-account, reset-password). I did not find a screen that shows a concrete database message today, but nothing prevents one. Recommended fix (small, safe to test): only pass a message through when the error is one the app marks as server-authored (a `DanceFlowApiError` from `danceflowApi.ts`, the payment-cancel class), and use the screen's fallback for everything else; then the guard test can forbid `friendlyMessage` on unmarked errors. Not changed here because it alters wording on up to 28 screens and the schedule-request flow relies on RPC-authored messages; it needs the owner's or coordinator's go-ahead and a pass over each call site.

## 2. No vendor names in the app's own wording

Found three user-visible strings naming the payment provider, all **fixed in this PR**: Wallet "Stripe confirmed the purchase" (now "Your payment went through."), order screen "Waiting for payment confirmation from Stripe." and the checkout form "After Stripe confirms payment" (now "After your payment is confirmed"). New guard `vendorNameGuard.test.ts` fails on Stripe, Supabase, Twilio, Firebase, Expo or FCM in any screen or component line that is not an import, comment, console call or code identifier. The payment sheet itself is the provider's own UI and is out of scope. Not checked: strings that come from the database or the server (studio copy).

## 3. Account deletion path wording

In-app: Settings, Delete Account, "Delete DanceFlow account?" (Continue), "Final confirmation" (Permanently Delete); a studio-owner login is refused with the server's reason. The first dialog states what is removed and that studios may retain billing, attendance, documents, payments and communications. This matches the public page and the iOS note. Doc inconsistency **fixed**: `Google_Play_Internal_Testing.md` said deletion "requires typing DELETE"; the app uses two confirm dialogs and sends `confirmation: DELETE` itself. Still open and not code: `/account-deletion` is absent from the live checkout until main reaches production (RC checklist A2), so the Play data-safety deletion URL 404s today.

## 4. Play data-safety statements and the claim call

`claim_my_event_registrations` is not a new data type: it attaches registrations that carry the signed-in user's own verified email to that account (sets `event_registrations.user_id` only where empty), with no arguments, once per app run, authenticated only; it never touches clients, payments, leads or notifications (proved by the must-not-change snapshots in the device and HTTP runs). **Added a row to the Data safety table** in `Google_Play_Internal_Testing.md` saying so, filed under purchase history and email/name already declared. Permissions in `app.json` (location, push; camera, audio, overlay and storage blocked) still match section 9 of that doc. Not changed by this PR, listed for the owner: "shared with studios" for name, location retention, AI assistant processor and crash reporting remain OWNER INPUT items in the doc.

## 5. Other observations

- Event ticket codes appear in the UI as `QA-...` only in test data; nothing in app copy mentions claiming, linking or verifying (guarded by the harness check and jest).
- Open product questions carried over: gift recipients never see a gifted ticket; a checkout email that differs from the account email is not covered by the claim.
