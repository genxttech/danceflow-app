# R-14: operational obligations stay the organizer's (copy audit and disclosure spec)

Owner ratified 2026-11-24. Docs and display wording only; no SQL, behavior change, merge or deploy. Register: `governance/rule-register/rules/R14-*.json`.

**Principle.** Venue suitability, official meetings, event timetables, reporting deadlines, music, costume, conduct and applicable body operational obligations are the ORGANIZER's responsibility unless DanceFlow explicitly implements and verifies the rule. DanceFlow's individual safeguards (for example competitor conflicts between heats, heat floor capacity, scratch and no-show handling, locked heats) are real but are not body compliance; they are not described here as absent, and no unsupported requirement is described as enforced.

## Disclosure spec (text)
Where a governing-body sanction declaration is possible (`events.competition_sanctioning`, shown by `sanctioningDisclosure()` on the advanced page), show, after the existing "The organizer states this event is sanctioned by X. DanceFlow has not verified this.":

> DanceFlow does not currently verify or fulfill the applicable governing-body operational and reporting requirements (venue, timetable, meetings, reporting deadlines, surcharges and similar). These remain the organizer's responsibility.

Implemented as `OPERATIONAL_REQUIREMENTS_DISCLOSURE` (appended only for a declared sanction; the "Not sanctioned" text is unchanged). The disclosure is not a compliance bypass: the OD-01 restriction (PR 832) on declared events is unchanged, and no UI beyond this wording is added. Any other place that lets an organizer declare a body (a future event-level setter, public event pages, registration confirmation) must show the same text; none was added here.

## Copy audit (grep-based over the competition surfaces)
Surfaces searched: setup wizard and profile run notes, readiness page, advanced page, settings page, registration builder and status pages, results pages, schedule and day-of pages, check-in, action notices and error messages under `src/app/app/events/[id]/competition`, `src/app/events/[slug]/competition`, `src/lib/competition`. Notification and email text for competition events was not found in `src` beyond these.

| # | File | Wording | Finding | Action |
|---|---|---|---|---|
| 1 | `advanced/page.tsx` (WSDC rules profile form) | "Per-entry WSDC surcharge" field | The form creates an active flat per-entry fee rule "WSDC competitor surcharge" (`actions.ts`, `event_competition_fee_rules`), which the registration quote charges to competitors. The WSDC surcharge is the member's obligation to WSDC (2.2); DanceFlow must not collect it from competitors or remit it. Organizer-configured, not automatic. | Wording added beside the form; the behavior is an **implementation finding** for separate review |
| 2 | `advanced/page.tsx` | "Require WSDC results reporting" checkbox | Stores a flag only; DanceFlow produces no report and sends nothing to WSDC. | Wording added ("DanceFlow does not collect, report or remit anything to WSDC") |
| 3 | `scoring/registry.ts` `sanctioningDisclosure` | "DanceFlow has not verified this." | Did not say that operational and reporting requirements are not verified or fulfilled. | Disclosure appended (above) |
| 4 | `new/CompetitionSetupWizard.tsx:546`, `settings/page.tsx:75` | "Choosing them never means the event is run under, or approved by, a sanctioning organization", "Following a rules profile never means an organization sanctioned the event" | Accurate and protective. | none |
| 5 | wizard Multi-Dance hold note | "(NDCA III.D.44) are not computed by DanceFlow" | Accurate: states what DanceFlow does not do. | none |
| 6 | setup profile notes naming NDCA/UCWDC floor, music timing and schedule rules (`studioCustomV3.ts`) | cited as source references or "not mandated by the supplied rules" | Presented as sources, not as checks; no verification claim found. | none |
| 7 | day-of, schedule, readiness, registration, results pages | no wording found that claims DanceFlow verifies venue size, ceiling, meetings, timetable windows, report times, body reporting, entry caps, music/costume rules, late-entry fees or conduct | none | none |

Not fixed here (behavior, report only): item 1's competitor-facing surcharge fee rule; there is no venue, ceiling, meeting, timetable-window or reporting-deadline check anywhere, which is consistent with the copy found.

## Register (R14-*), all NOT IMPLEMENTED and must not block eligible Studio/Custom competitions
Mandatory: NDCA III.D.22 floor (60 x 36 ft = 2,160 sq ft; Championship 66 x 42), III.D.23 ceiling (ten feet; twelve for theatrical/cabaret), III.D.1 timetable (thirty minutes early/late; last final before 1:00 a.m.), III.D.46 mandatory Adjudicators meeting, III.E.1 computer scrutineering files within ten days; WSDC 2026.1C Venue definition (150 sq m), 3.2.3 (a competitor may compete in at most two skill-level Jack and Jill competitions), 2.3 results due at close and within three days, 2.2 Competitor Surcharge ($2 per competitor entry per contest, due within 30 days after close); UCWDC II.Q Judge Meeting. Advisory/optional, kept separate: NDCA III.C.10 late entry fee ("should"), UCWDC II.P.1 report 30 minutes before ("should"), UCWDC II.R Competitor Meeting (held at some events). UCWDC II.N.1 conduct and registration data (full name, mailing address, birthdate, phone, email, Associate Membership number) is a future privacy-design decision: current collection is not expanded and OD-02 is not relaxed. Printed pages as read in the pinned PDFs; NDCA effective date caveat in each entry.
