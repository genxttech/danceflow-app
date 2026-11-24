# R-07 Multi-Dance disclosure specification (text only)

Status: **SPECIFICATION ONLY.** No UI, export, email or API change is made or authorized by this document.
Source: owner ratification R-07 (2026-11-23), items (6) and (7). This is DanceFlow policy, not a governing-body rule
([R07-DF-0005](../rule-register/rules/R07-DF-0005.json)). Coordinate wording with the relabelling workstream
(OD-19 / OD-28 / R-05) before any surface adopts it, and with the OD-13 / OD-23 Studio-scoring disclosure.

## Behavior being disclosed

- A Studio/Custom Multi-Dance round is a prescribed set of dances (R-05). Each dance is calculated independently and
  has its own placements (engine rule X-6: one dance per calculation).
- DanceFlow produces no combined, overall or championship placement across dances, and never infers an overall winner
  from the per-dance results.
- Official aggregate Multi-Dance championship procedures are **not implemented**: UCWDC Scoring Format v16.9b
  Rules #9-#11 (aggregate formulas and head-to-head tiebreakers); NDCA III.D.36, III.D.44 and III.C.3.b(1)(d)
  (Skating System applied across dances); WSDC finals Relative Placement (a separate system from preliminary
  callbacks). See register entries R07-UCWDC-0002, R07-NDCA-0001/0002, R07-WSDC-0001.

## Proposed text (English)

**Short label (results tables, exports, headers)**

> Results are shown for each dance separately. DanceFlow does not calculate an overall Multi-Dance result.

**Full disclosure (setup page, results page footer, export cover note, organizer publish confirmation)**

> This event's results are calculated one dance at a time. Each dance has its own placements, produced by the
> DanceFlow Studio scoring method you selected. DanceFlow does not calculate official aggregate Multi-Dance
> championship results (for example an overall or all-dances placement under a governing body's rules), and it never
> chooses an overall winner for you. If your event awards an overall or championship title, the organizer must
> determine it outside DanceFlow under the rules that apply to the event.

**Where a governing body is declared on the event (sanctioning is not `none`/`other`)**

> The organizer has declared a governing body for this event. DanceFlow Studio scoring is not that body's official
> scoring, and DanceFlow does not calculate that body's overall Multi-Dance championship results.

(The body name is never used to imply that DanceFlow's per-dance results are certified, approved or compatible.)

## Constraints on wording

1. Never say or imply "official", "certified", "approved" or "compatible with" NDCA, UCWDC or WSDC.
2. Never show a combined, total or average across dances, an overall rank column, or a "winner" label.
3. Never describe the Studio ordinal ballot or callback tally as a WSDC-compatible callback or Relative Placement
   method (R-07 item 10): WSDC preliminary callbacks and finals Relative Placement are distinct systems.
4. Never describe medal-style or Bronze/Silver/Gold ballots as UCWDC medal ballots (R-07 item 8).
5. Keep the text short enough for a results header (label) and plain enough for a spectator; do not quote rulebooks.

## Implementation notes for a later, separately authorized slice

- Surfaces to consider: Studio setup (`STUDIO_METHOD_DISCLOSURE` in `studioSetup.ts`), results pages, publication
  preview, exports, the entrant-facing results view.
- A test should assert the disclosure renders whenever a round's program has more than one dance and that no template
  emits an overall/combined column.
- Nothing here changes scoring, SQL, or persisted data.
