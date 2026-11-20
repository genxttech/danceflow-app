# Student app: where past event registrations should live (proposal, no code)

2026-11-20, main `415002778`. Proposal only; nothing implemented. For the owner's decision through the APPS coordinator.

## What happens today (verified in code and on a device)

- **Tickets & registrations** (`app/schedule/events.tsx`, reached from Schedule and from a ticket notification) lists **upcoming events only**. It was like this before the past-events fix (#700), which did not touch it. The split uses the **device's local date** against the event's start date (`isUpcomingEvent`), not the shared end-of-event rule the Events list now uses. An ended registration is simply not shown there; there is no past section and no empty-state hint about it. Evidence: past-events smoke runs, `C:\dfr-out\qa-past-events` (the ended registration is absent, the upcoming one is listed).
- **Wallet > Event tickets** (`app/wallet/event-tickets.tsx`, reached from More and from the ticket notification) lists **every ticket, past ones included**; the ended event's ticket `QA-PAST-0001` still showed (run 3). So tickets are never lost; registrations without an issued ticket (for example a pending or free registration) and the registration-level facts (status, payment status, quantity) for ended events are the part with no home.
- The ended event's own page still opens by link or id and says "This event has ended" (#700).
- Receipts/orders for ended events: not covered here (no seeded order in the smoke; BLOCKED).

## Options

| Option | What it is | Cost | Risk |
|---|---|---|---|
| A (recommended) | A **Past events** section at the bottom of Tickets & registrations, newest first, capped at 12 with "Show more" | Small Student change: same wallet data already loaded; the upcoming/past split switches to the shared end-of-event rule | The wallet select needs the event's `end_date`, `end_time` and `timezone`; they come through the existing `events(...)` embed (the dancer views do not hide embedded event columns), so **no SQL is expected**, to be confirmed on a disposable stack before building |
| B | A link "My past tickets" from the Events screen's Past segment to Wallet > Event tickets | Tiny | Only tickets, not registrations; two places to look |
| C | Leave as is: history is Wallet > Event tickets plus each event's page | None | A registration with no ticket is unreachable once the event ends; the screen's own empty state ("No upcoming events") can read as "you have nothing" |

## What the owner decides

1. A, B, both, or C.
2. How many past items to show before "Show more" (proposal 12) and how far back (proposal: no limit).
3. Wording: "Past events" (proposal) or "Attended / Earlier events".
4. Whether cancelled, refunded or unpaid registrations appear in Past, or only confirmed ones (proposal: all, each with its status chip, as in the upcoming list).
5. Whether a past ticket keeps its QR on the ticket screen (today it does) or is marked "Event ended" and the QR hidden after a grace period (privacy/fraud call; related to the open offline-ticket decision B4 in `Student_Release_Candidate_Checklist.md`).

## If A is approved: plan

Student only, no server change expected. Split by `isEventPast` with the event's own end and time zone (the same rule as the Events list); keep the existing card; heading "Past events" with the cap; empty state unchanged when there is nothing past. Tests: jest for the split and the cap, a screen test for the section, and the `--past-events` smoke gets one more check (ended registration listed under Past). Effort: about one day including the smoke; needs the next Student build to ship.
