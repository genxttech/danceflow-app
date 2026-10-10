# Phase 10C.5 — Competition Setup Wizard + Draft Generator

Status: implemented on DEV/local only. PR #212 is open and not merged; PROD is untouched.

**The organizer describes the event. DanceFlow builds the structure.**

## Wizard flow

The wizard ends with **Create Competition Draft**. Its steps are:

1. **Purpose.** Competition, Showcase / Performance, or Competition + Showcase / Performance. The purpose is not a scoring mode.
2. **Styles.** Country, West Coast Swing, Ballroom, Other / Studio-defined, or Multiple styles. Styles are asked for every purpose, so a Country Showcase stays part of Country.
3. **Adjudicated?** Asked once per style, as Adjudicated or Non-Adjudicated. The adjudicated result option comes from the profile:
   - Country: Medal Marks (the judge input) producing Placement (the result).
   - Ballroom and WCS: Placements.
   - Other: Placements or Gold / Silver / Bronze ratings.
4. **Rules.** Studio / Custom Rules. UCWDC, WSDC and NDCA are visible but "Not available yet".
5. **Sanction.** Only shown for rules that can be sanctioned, so never for Studio / Custom.
6. **Offerings.** The style's entry formats.
   - Showcase / Performance offers only performance formats.
   - Showcase-type formats (Showcase, Spotlight, Showcase / Showdance, Routine / Showcase, Choreographed Routine) can be judged "Same as the style", Adjudicated or Non-Adjudicated.
7. **Divisions.** Chosen per entry format.
8. **Dances.** Chosen per entry format.
9. **Rounds.** A Final per division, or a Performance round when Non-Adjudicated.
10. **Registration basics.**
11. **Pricing.** Per dance, per entry, included with registration fee, free, or configure later.
12. **Review.**

## Country Showcase and Spotlight (UCWDC terminology, not reversed)

| | Showcase | Spotlight |
|---|---|---|
| Music | Set music for each dance. UCWDC pre-selects it on a rotating schedule; under Studio / Custom the organizer supplies it. Source: UCWDC Couples and ProPro/ProAm 2026, II.G.2.a. | Chosen by the competitors. Source: UCWDC ProPro/ProAm 2026, II.A.20 and II.K.8. |
| Structure | Danced per dance. | A dance or medley of dances; ProAm and ProPro; 2½–4 minutes (II.K.4.d, II.M.1.h.i). |
| Couples on the floor | NOT SPECIFIED IN PROVIDED SOURCE (floor_mode `not_specified`) | NOT SPECIFIED IN PROVIDED SOURCE (floor_mode `not_specified`) |

Both may be Adjudicated or Non-Adjudicated, and both run at a program-block boundary.

Local terminology is supported without reversing official names. Other / Studio-defined offers a "Choreographed Routine" whose label, music source, duration, adjudication, floor behavior and placement are marked organizer-configurable (the builder for that is a future slice). Ballroom's "Showcase / Showdance" and WCS's "Routine / Showcase" are Studio policy (competitor-selected music), not governing-body definitions.

## Scoring metadata: stages, not one method

Each judging definition carries a `ScoringModel`, an ordered list of `ScoringStage`s. Each stage holds:

- `family`: advancement, final or overall;
- `round_types`;
- an advancement `direction`: promote or retire;
- a `MarkScheme` ballot: input type, profile-supplied values and scale, whether ties are allowed, and whether marks are scored per entry or per role;
- an `EngineBinding`: key, profile parameters and status;
- a tie-break chain;
- several `ResultOutput`s, with one primary;
- source references.

`adjudication_stages` is an ordered list of penalty and adjudication stages, at these timings:

- ballot/recall alteration;
- per-dance final adjustment;
- post-multi-dance adjustment;
- post-result adjustment;
- disqualification.

`source_conflicts` records unresolved disagreements between supplied documents. A material conflict blocks activating a sanctioned profile.

Studio / Custom uses `studio_placeholder` engines. Medal Marks bind to the generic `custom` storage method; that is a storage detail kept separate from the semantics (judge input `medal_marks`, result `placement`). It is never `cumulative_points`.

`src/lib/competition/setup/scoringReference.ts` holds source-cited reference descriptions of UCWDC, WSDC and NDCA scoring. They are not profiles, they cannot be selected, and no engine in them is implemented. They prove the contract can represent each body. The recorded NDCA Formation conflict (III.D.11 vs XII.N.3) is unresolved.

## Programming order metadata (metadata only; the floor planner does not read it yet)

Every value records its basis:

- `source_grounded`, with citations;
- `studio_recommendation`;
- `owner_operational`;
- `not_specified`.

The current values:

| Style | Hierarchy | Basis | Notes |
|---|---|---|---|
| Country | level → age → dance | owner operational | Not stated in the UCWDC rules. The dance sequence (Triple Two, NightClub, Waltz, Polka, Cha-Cha, East Coast Swing, Two-Step, West Coast Swing) is source-grounded (UCWDC Couples II.M.1.a–b). Special offerings run at the age-group boundary. |
| Ballroom | style → level → age → event | owner operational | Not mandated by NDCA. The American Smooth and Rhythm dance orders are source-grounded (NDCA IX.A.1.c–d). Style blocks are listed. The boundary is the style block. |
| WCS | contest format → division → round | owner operational | The boundary is the contest format. |
| Other | level → age → dance | Studio recommendation | |

## Authority

- **One derivation.** `deriveDraft(answers, profile)` drives the Review, counts, pricing summary, special-format semantics and the payload. The server recomputes it from the stored profile.
- **`create_competition_draft`.** It is atomic, idempotent, manager-scoped, validates the profile version, and creates one program per style. Registration stays CLOSED and programs stay unpublished. It validates:
  - per-style adjudication and the result options that style allows;
  - that only Showcase-type formats override;
  - Showcase purpose → only performance formats;
  - Competition + Showcase → at least one of each kind.

  Each category records its adjudication, its source (style or override), its judging, and its kind, music and floor semantics.
- **Configure later.** It blocks `open_competition_registration` until `set_competition_category_pricing` completes the pricing.

## Database

The migration is `20261113090000_phase10c5_competition_draft.sql`, with a rollback that:

- refuses while pricing is pending;
- restores `open_competition_registration` exactly;
- drops the new functions;
- retires v2.

The incorrect pre-correction v2 existed only on DEV and was never referenced. It was removed by a one-off DEV-only script that is not part of the migration, before the corrected v2 was seeded.

## Carry-forwards

- Bundle / package pricing.
- Organizer-defined routine builder.
- Governing-body profiles and engines: 10F (needs an authoritative Skating specification), 10I and 10J.
- Event Operations Schedule (`event-operations-schedule.md`).
- Owner walkthrough.
