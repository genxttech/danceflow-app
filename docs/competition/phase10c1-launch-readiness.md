# Phase 10C.1 — Competition OS Launch Readiness + Entry UX

Status: local candidate (no SQL, no deployment). Public flag `NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED`
stays **off** in production.

## Organizer entry — one model, two obvious paths

| Path | Flow |
|---|---|
| **A. Competitions** (sidebar → Events → Competitions, owners/admins) | Competitions list → **New Competition** → the existing Create Event form preselected to *Competition* ("New Competition" heading) → **Create Event & Set Up Competition** → competition setup wizard → Overview |
| **B. Create Event** | Choose event type *Competition* → button becomes **Create Event & Set Up Competition** (help text says setup comes next) → wizard → Overview. Every other event type is unchanged (*Create Event* → events list). |
| Existing event | Event page shows **Set up competition** (no setup yet → wizard) or **Competition** (→ Overview). |

There is no second competition system: a competition is an event plus its workspace
(`/app/events/[id]/competition`); the Competitions list, the event page and the sidebar all resolve to that
same workspace. The workspace header links to *Competitions* and *Event details*; the sidebar keeps
*Competitions* highlighted inside every workspace page. The empty workspace has one action
(*Create competition*) and no Advanced-settings line. Finishing the wizard lands on the Overview, where
Open / Close / Reopen registration live.

## Buyer flow (verified locally against DEV + Stripe TEST mode)

| Step | Result |
|---|---|
| Public event page → *Open Competition Registration* | builder with open categories/divisions |
| Guest registration, pricing display | $25.00 entry shown and charged (database snapshot) |
| Checkout | test-mode Checkout Session on the studio's connected (Express, test) account, card-only (`payment_method_types: ["card"]`); Stripe's page also shows Link-funded options |
| Retry / resume | same Checkout Session reused, one order |
| Success | webhook finalized once: order + registration confirmed/paid, entry confirmed, one `event_payments` row bound to the connected account, `competition_entry_revenue` $25.00 |
| Status page | *Payment received — confirming your entries* before the webhook; *Registration confirmed* after; never confirmed from the URL |
| Cancel (Stripe back link) | session expired at Stripe, order cancelled/unpaid, entry *Released*, *Registration cancelled … You were not charged*; cancelling an already-paid session does **not** release |
| Waiver | builder lists the document and *Continue to documents*; DanceFlow Sign completes; resume goes straight to Checkout; assignment signed + bound to the registration, envelope completed, no direct signature rows |
| Expiry | `checkout.session.expired` → order expired, entry withdrawn, checkpoint expired, *Registration hold expired* |

Not exercised by the agent (needs a signed-in account; sign-in credentials would be sent to hosted
Supabase): the authenticated organizer walkthrough and the verified *this is me* buyer path.

## Organizer expectations for launch

- **Refunds are whole-order.** A staff refund of a competition registration refunds the entire purchase
  and withdraws all of its entries. Refunding one entry of a multi-entry order is not supported yet
  (Event / Competition Refund Integrity follow-up). Nothing in the buyer UI promises per-entry refunds.
- **Waivers are signed by the buyer.** The registration contact signs each required document once for the
  whole purchase (the signing page labels the signer *Event attendee* until they type their name). For a
  parent registering a child or a studio registering its dancers this is the usual practice; events that
  need every adult competitor to sign personally should wait for per-competitor waivers.

## Launch gates before enabling the public flag

1. Stripe **live** Connect webhook endpoint subscribed to `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
   `checkout.session.expired` (could not be verified from the repo: live-mode access required; there are
   no test-mode webhook endpoints).
2. Authenticated organizer walkthrough on DEV/preview (Competitions → New Competition → wizard → Open /
   Close / Reopen → Event details → back).
3. Verified *this is me* buyer path on DEV/preview.
4. Owner acceptance of whole-order refunds and buyer-signed waivers for the first events.
