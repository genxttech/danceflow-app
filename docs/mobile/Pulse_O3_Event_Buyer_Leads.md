# Pulse O3: a genuine lead who later buys an event ticket

Status: **decided by the owner on 2026-11-26 (disposition P2: both protections).** The three-part rule below is implemented in `isPulseLead` and its loader (#892; "appointment attendance" is read as a non-cancelled appointment or an attended class). Checkout no longer writes attribution on an existing client (#891; its migration is not applied). The web Leads page is unchanged. The rest of this note is the analysis as written before the decision: counts only, no names or contact details; source DEV database, 2026-11-22, through the sanctioned read-only runner.

## The question
Pulse counts a client as a lead when `status = 'lead'` and the client is not an event registrant and not an independent instructor. Event checkout (`src/lib/events/settlementSideEffects.ts`) creates a ticket buyer as `status = 'lead'`, `referral_source = 'Event Registration'`, `source_system = 'event_registration'`. When the buyer's email already matches an existing client, it only fills blanks: `source_system` becomes `event_registration` if it was empty, `referral_source` becomes "Event Registration" only if it was empty, and `status` is left alone.

So an existing genuine lead (for example `referral_source = 'Website'`, status `lead`) who buys a ticket keeps status `lead` and gets `source_system = 'event_registration'`. Pulse's rule "source_system is event_registration" then drops a real lead from its counts, while the web Leads page still lists them. Opposite error for the plain buyer: the web Leads page lists the buyer as a lead (it only checks the lowercase key), Pulse does not.

## What DEV shows (counts)
| | count |
|---|---|
| clients with status lead | 5 |
| of those, referral says event registration | 2 |
| of those, source_system says event_registration | 2 |
| lead with event source_system but a different or empty referral (the "stamped existing client" shape) | 0 |
| clients of any status with source_system event_registration | 3 (1 is already a student) |
| event-origin leads that also hold an active package or an appointment | 1 |
| event registrations / linked to a client | 35 / 14 |

DEV is small and has no instance of the stamped-existing-lead shape yet, so the cost today is zero on DEV; the shape is possible by construction on any studio that runs events and a lead funnel. One of the two event-origin leads already behaves like a customer (package or appointment), which shows "event buyer" and "real lead" overlap in practice.

## Proposed rule (for discussion)
A client is an **event-only buyer**, and not a Pulse lead, when all of these hold:
1. status is `lead`, and
2. event origin: `referral_source` reads as event registration (any spelling) OR `source_system = 'event_registration'`, and
3. no other evidence of a studio relationship: `referral_source` is empty or event-spelled (a staff-chosen source like Website or Referral means someone owns the lead), and no `lead_activities` row, and no package or appointment attendance.

Anything with event origin plus another signal stays a lead and appears in Pulse (and, once it books or buys, leaves by the normal status change). This keeps real leads that bought a ticket and still hides pure ticket buyers.

## Cheaper structural option
Event checkout could record its origin in a dedicated field (or only set `source_system` when creating the client, never when stamping an existing one), so `source_system` keeps meaning "where this client came from". That is a change to event checkout and to the web Leads page, not to Pulse; it belongs to whoever owns lead integrity.

## Asked of lead-integrity (no change requested here)
1. Which definition of "lead" should the web Leads page and Pulse share (PR 576 area)?
2. Should event checkout stop stamping `source_system` on an existing client?
3. Is the three-part rule above acceptable as the interim Pulse predicate, which lives in one function (`isPulseLead` in `src/lib/staff/pulseCards.ts`)?
