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
6. **Offerings.** The style's entry formats, under headings (for example Ballroom: Partnerships, Youth, Performances, Teams). Nothing is pre-selected.
   - Showcase / Performance offers only performance formats.
   - Offerings that are entered per dance style (Ballroom partnerships, Solo Star and Showdance) show the dance styles to choose once selected. Each chosen style becomes its own category.
   - Who may enter, as stated by the source, is shown under the offering. 10C.5 does not enforce eligibility.
   - Showcase-type formats (Showcase, Spotlight, the Ballroom performances, Routine / Showcase, Choreographed Routine) can be judged "Same as the style", Adjudicated or Non-Adjudicated.
7. **Divisions.** Chosen per entry format, and shared by every dance style it is entered in.
8. **Dances.** Chosen per category. A styled offering shows one group per chosen style, with only that style's dances.
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

Local terminology is supported without reversing official names. Other / Studio-defined offers a "Choreographed Routine" whose label, music source, duration, adjudication, floor behavior and placement are marked organizer-configurable (the builder for that is a future slice). WCS's "Routine / Showcase (Studio)" is Studio policy (competitor-selected music), not a governing-body definition.

## Offerings by style: governing body or Studio, never shared

The full source-to-UI mapping is [phase10c5-source-to-ui-matrix.md](phase10c5-source-to-ui-matrix.md); the documents and their SHA-256 values are in [governing-body-source-registry.md](governing-body-source-registry.md).

- **Each offering belongs to exactly one style.** It records its `origin` (`ucwdc`, `wsdc`, `ndca` or `studio`) and, unless Studio, the sections it rests on. A Studio offering inside a governing-body style is labelled "(Studio)".
- **Country (UCWDC 2026).** ProAm, ProPro, Couples, Showcase, Spotlight and Team are UCWDC offerings. The single-dancer offering is "Solo routine (Studio)". UCWDC Solo Medley is a couple's multi-dance Showcase routine (Couples II.A.20, II.M.1.h.i) and is not modelled yet.
- **West Coast Swing (WSDC 2026.1C).** Only Jack & Jill is a WSDC offering, with the WSDC skill and age contests. "Couples (Studio)", "Pro-Am (Studio)" and "Routine / Showcase (Studio)" use Studio levels.
- **Ballroom (NDCA June 2026).** The offerings are NDCA competition classifications: Pro/Am, Amateur, Mixed Amateur, Student/Student, Professional, Mixed Professional, Solo Star, Showdance, Cabaret, Theatre Arts Compulsory, Pro/Am Theatrical, Pro/Am Exhibition, Formation and Team Match. A couple is the partnership inside an offering (NDCA II.A.7), never an offering of its own, so the earlier generic Ballroom "Couples" is gone.
- **Other / Studio-defined.** Studio offerings only, with their own keys (for example `studio_pro_am`).

### Ballroom dance styles

Dance style is a category dimension. The profile lists the styles with their dances (NDCA IX.A.1):

- International Standard: Waltz, Tango, Viennese Waltz, Slow Foxtrot, Quickstep.
- International Latin: Cha Cha, Samba, Rumba, Paso Doble, Jive.
- American Smooth: Waltz, Tango, Foxtrot, Viennese Waltz.
- American Rhythm: Cha Cha, Rumba, Swing, Bolero, Mambo.
- Additional American Style Dances (IX.A.1.e): only dances the organizer adds.

An offering entered in two styles becomes two categories, for example "Pro/Am — American Smooth" and "Pro/Am — International Latin". Each category accepts only its style's dances; organizer-added dances belong only to Additional American Style Dances. Showdance is entered in the four primary styles (NDCA XI.B). Withdrawing a style removes its dances.

### Source conflicts and fail-closed decisions

The profile records `source_conflicts`:

- `ndca_student_student_youth` (II.A.6.b adults only vs II.B.8 youth Student/Student). It is unresolved and material, so Student/Student offers one adult division and no youth Student/Student.
- `ndca_formation_scoring` (III.D.11 vs XII.N.3). Studio Formation uses Studio placements.

Pro/Am Theatrical and Pro/Am Exhibition are Pro/Am performance divisions (II.B.7.c), not levels. Their music is NOT SPECIFIED IN PROVIDED SOURCE and is recorded as such.

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

## Adjudication, feedback and the official result are separate

Non-Adjudicated means **no official competitive result**. It does not mean no judge or no feedback.

- **Adjudicated?** asks "Will this produce an official competitive result?".
- **Judging metadata.** Each judging definition records `official_result` (true for Medal Marks, Placements and ratings; false for Non-Adjudicated). It also records `feedback_modes`, which are all of `none`, `written`, `written_plus_grade` and `written_plus_score`.
- **Profile-level feedback policy.** `feedback` lists the feedback options and their outputs (critique text, grade, numeric score). The default is `none`.
- **Separate outputs.** `evaluation.ts` keeps official result outputs (only from an Adjudicated judging definition's stages) apart from feedback outputs (always `official: false`).
- **Feedback stays feedback.** A grade or score given as feedback never becomes a placement, ranking, advancement, medal threshold or official result.
- **Deferred.** Feedback entry (critique UI) and choosing a feedback mode per offering are a carry-forward. 10C.5 stores no feedback selection.

## Divisions: what is offered, per entry format

Divisions are event configuration (what the event offers), not competitor classification.

- **Schemes.** Each style maps each entry format to a division scheme (`division_schemes`). A scheme has one or more **axes**, each with its values, `required`, `allow_custom`, provenance and optional eligibility. The axis keys are `skill_level`, `age_group`, `style`, `proficiency`, `contest_type` and `custom`.
- **Selection (owner decision, 2026-10-11).** Nothing is pre-selected — no levels and no age divisions, not even Open. Every applicable value is shown immediately as a multi-select chip (no "More options"), with Select all / Clear and the organizer's own values where allowed.
- **Required axes.** A required axis must have at least one value before the format has any divisions, so an empty axis never produces level-only or age-only divisions by accident. Country ProAm, ProPro and Couples require both a level and an age division (a UCWDC division is an age and a level, II.A.7); Country routines require an age division; NDCA Amateur requires a proficiency level and an age category (NDCA X); NDCA Pro/Am requires a level, with ages optional; NDCA Professional requires a contest (Open Professional or Rising Star); Solo Star requires a youth age; Other and one-open-division formats require a level; WSDC contests require neither on its own.
- **Combination.**
  - `cross`: one division per level × age, e.g. "Novice · Diamond" (UCWDC II.A.7: "ProAm Female Diamond Novice is a division"). An optional axis left empty does not split.
  - `separate`: each value is its own contest. WSDC skill contests and age-based contests (Juniors / Sophisticated / Masters) are separate, because "age-based … contests must be open to competitors of all skill levels" (WSDC 3.1.3.a).
- **Storage.** `skill_label` and `age_label` as before; every division also records its axis values in `configuration.setup.axes`. No table change. Limits stay 80 divisions per format and 300 overall.

| Style / format | Levels offered | Age divisions offered | Basis |
|---|---|---|---|
| Country ProAm (level and age required) | Newcomer, Newcomer IV–I, Novice, Intermediate, Advanced, AllStars, Open Level | Junior Primary, Junior Youth, Junior Teen, Open, Crystal 30+, Diamond 40+, Silver 50+, Gold 60+, Platinum 70+, Pearl 80+ | UCWDC ProAm 2026 II.D, II.E.1. Studio Newcomer and Open Level are Studio values. |
| Country ProPro (level and age required) | ProPro II, ProPro I, Open Level | The shared ProPro/ProAm age divisions (as ProAm) | UCWDC ProPro/ProAm II.E.2 (levels), II.D (ages: general section of the combined booklet, no ProPro exclusion) |
| Country Couples (level and age required) | Studio Newcomer, Novice, Intermediate, Advanced; Newcomer IV–I; Classic III, II, II/I, I; Open Level | Juniors (older partner), Open, Crystal to Platinum (no Pearl), Masters, Masters Plus 45+, Crown 40+, Crown Plus 55+ (ascension) | UCWDC Couples 2026 II.D, II.E |
| Country Showcase / Spotlight / Solo (age required) | — | UCWDC ProAm ages | UCWDC II.D |
| WCS Jack & Jill | Newcomer, Novice, Intermediate, Advanced, All Star, Champion | Separate optional contests: Juniors <18, Sophisticated 35+, Masters 50+ | WSDC 2026.1C |
| WCS Couples / Pro-Am (Studio) (level required) | Studio Newcomer, Novice, Intermediate, Advanced, Open Level | — | Studio (WSDC defines no Couples or Pro-Am contest) |
| Ballroom Pro/Am (level required) | Newcomer, Beginner, Intermediate, Advanced, Pre-Bronze, Bronze, Silver, Gold, Gold Star, Supreme Gold | Optional: Pre-Teen I to Youth (II.B.8.a), A 19+, B 36+, C 51+, S1–S4 (II.B.7.f, multi-dance) | NDCA II.B.7.c / II.B.7.f / II.B.8.a ("may offer any or all") |
| Ballroom Amateur (proficiency and age required) | Bronze, Silver, Gold, Novice, Pre-Championship, Open Amateur | Pre-Teen I to Senior IV; combined Pre-Teen, Junior, Senior; Under 21 | NDCA X.A / X.B |
| Ballroom Professional (contest required, separate) | Open Professional, Rising Star | — (16+, no age categories) | NDCA II.B.1 |
| Ballroom Solo Star (age required) | — | Pre-Teen I to Youth | NDCA II.A.3, II.B.10 |
| Ballroom Student/Student | One Adult Open division | Adults only (conflict, fail closed) | NDCA II.A.6 |
| Ballroom Mixed Amateur, Mixed Professional, performances, teams | One open division | — | Studio (NDCA defines none) |
| Other | Studio Newcomer, Novice, Intermediate, Advanced. Also Open Level, Bronze/Silver/Gold | Optional Studio Youth / Adult / Senior | Studio |

Open is two different things:

- **Open (age)** is the UCWDC adult age division (source-grounded).
- **Open Level** is a Studio / Custom skill level. It is never presented as a UCWDC ProAm level.

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
| Ballroom | style → level → age → event | owner operational | Not mandated by NDCA. The Standard, Latin, Smooth and Rhythm dance orders are source-grounded (NDCA IX.A.1.a–d); the styles themselves are on the program (`styles`). The boundary is the style block. |
| WCS | contest format → division → round | owner operational | The boundary is the contest format. |
| Other | level → age → dance | Studio recommendation | |

## Authority

- **One derivation.** `deriveDraft(answers, profile)` drives the Review, counts, pricing summary, special-format semantics and the payload. The server recomputes it from the stored profile.
- **`create_competition_draft`.** It is atomic, idempotent, manager-scoped, validates the profile version, and creates one program per style. Registration stays CLOSED and programs stay unpublished. It validates:
  - per-style adjudication and the result options that style allows;
  - that only Showcase-type formats override;
  - Showcase purpose → only performance formats;
  - Competition + Showcase → at least one of each kind;
  - a styled offering names one of its allowed dance styles, an unstyled offering names none, each (offering, style) pair appears once, and a styled category holds only its style's dances (organizer-added dances only where the style allows them).

  Each category records its adjudication, its source (style or override), its judging, its dance style (`configuration.setup.style`), and its kind, music and floor semantics. A styled category is named "Offering — Style".
- **Configure later.** It blocks `open_competition_registration` until `set_competition_category_pricing` completes the pricing.

## Database

The migration is `20261113090000_phase10c5_competition_draft.sql`, with a rollback that:

- refuses while pricing is pending;
- restores `open_competition_registration` exactly;
- drops the new functions;
- retires v2.

The incorrect pre-correction v2 existed only on DEV and was never referenced. It was removed by a one-off DEV-only script that is not part of the migration, before the corrected v2 was seeded.

**Ballroom correction (no schema change).** Dance styles, origins, source conflicts and the NDCA classifications are profile data inside the unreleased `studio_simple@2`. The existing `contest_type` and `entry_format` values already cover them (Student/Student uses `custom`). The only function change is in `create_competition_draft` (style validation, per-style uniqueness, contest naming, `configuration.setup.style`). No table, constraint or index changes. The per-program category limit is now 60, because one offering entered in several styles counts once per style.

## Carry-forwards

- Bundle / package pricing.
- Organizer-defined routine builder.
- Governing-body profiles and engines: 10F (needs an authoritative Skating specification), 10I and 10J.
- Event Operations Schedule (`event-operations-schedule.md`).
- Not modelled yet (recorded in the matrix): UCWDC Solo Medley; NDCA Mixed Proficiency Amateur Couples (II.B.9); NDCA Studio Showcase (I.G); gender-separated categories; Pro/Am single- vs multi-dance event types.
- Eligibility enforcement at registration (the notes are shown, not enforced).
- Owner walkthrough.
