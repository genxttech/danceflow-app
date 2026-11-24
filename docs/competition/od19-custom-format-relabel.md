# OD-19: Studio/Custom formats are DanceFlow formats (relabel, Option C)

Owner decision 2026-11-23 (OD-19): Option C now, Option A for future governing-body profiles. Governance:
[RULEBOOK_GOVERNANCE.md](RULEBOOK_GOVERNANCE.md). Register entries: `governance/rule-register/rules/OD19-*.json`.

## What changed (application copy only)

`src/lib/competition/setup/studioCustomDisplay.ts` maps the persisted `custom` format ids to DanceFlow wording.
The seeded profile `studio_simple@3` (TypeScript mirror + SQL, drift-guarded) is immutable once referenced, so the
profile is not edited. The layer is applied in the setup wizard page and inside `deriveDraft`.

| Persisted id (unchanged) | Was | Now |
|---|---|---|
| `showcase` | Showcase | Studio/Custom: Showcase |
| `spotlight` | Spotlight | Studio/Custom: Spotlight |
| `routine` | Routine / Showcase (Studio) | Studio/Custom: Routine / Showcase |
| `ndca_student_student` | Student/Student | Studio/Custom: Student pair |
| `ndca_showdance` | Showdance | Studio/Custom: Showdance |
| `ndca_cabaret` | Cabaret | Studio/Custom: Cabaret |
| `ndca_theatre_arts` | Theatre Arts Compulsory | Studio/Custom: Theatre Arts |
| `custom_routine` | Choreographed Routine | Studio/Custom: Choreographed routine |

Descriptions, eligibility notes (which cited NDCA rules) and the Showcase music note (which named UCWDC) are
reworded the same way; copy no longer names a governing body or implies compliance. Only label, description,
`eligibility_note` and `music_source.note` of these formats change. Ids, `entry_format`, `contest_type`, roles,
scoring, divisions, pricing, sanction handling and the OD-01 restrictions are untouched.

## Not changed, and why

- **Participant roles stay flexible** (`allowedRolesForFormat` default branch, `_comp10c_allowed_roles`). The
  profile's per-format role list is still stored and never read; eligibility safeguards belong to OD-02/OD-03/OD-18.
- **Persisted contest names (known gap, needs an owner decision).** For NEW setups, the category name saved in
  `event_competition_contests.name` is built inside `public.create_competition_draft` from the profile row
  (`v_cat_def->>'label'`). That row is immutable, so those saved names keep the legacy label
  (for example "Student/Student — American Smooth") on registration, schedule and results pages. Closing it takes
  either a separately reviewed migration (profile `studio_simple@4` plus a function change, owner-gated PROD SQL)
  or render-time mapping at every read site using `configuration.simple.category_type`. No migration is written here.
- Server-side `raise exception` messages (PROD SQL) also use the legacy profile label, e.g. via the friendly() error path; TypeScript validation normally catches these first.
- Content edits besides names: Cabaret now says a couple's performance (was "solo"); Theatre Arts drops the "Compulsory" name and the 50%-lift sentence; Spotlight keeps its 2½–4 minute default length as a Studio setting; the Student pair note no longer says adults only (the adult-only division scheme `ballroom_adult_open` is unchanged).
- Existing saved contests and historical data are not rewritten.
- Program/style names (Country, Ballroom), the Ballroom dance style names, division scheme names and the
  governing-body-named non-custom formats (for example "Pro/Am Single-Dance") are out of scope for OD-19.

## Future governing-body profiles (Option A, NOT IMPLEMENTED; blockers)

| Future profile format | Requirement | Source (re-read in pinned PDF 2026-11-23) | Register |
|---|---|---|---|
| NDCA Student/Student | verified roles: two adult Pro/Am Student Competitors; not open to Open Amateur proficiency dancers | NDCA Rule Book June 2026 II.A.6.a-b | OD19-NDCA-STUDENT-STUDENT-ROLES |
| NDCA youth Student/Student | unresolved conflict with II.B.8.a; fail closed (OD-02 forbids under-18 at first activation anyway) | II.B.8.a vs II.A.6.b | OD19-NDCA-STUDENT-STUDENT-YOUTH |
| UCWDC Spotlight | ProAm or ProPro participant requirements | UCWDC-PA II.A.20, II.K.4.d, II.K.8 | OD19-UCWDC-SPOTLIGHT-ROLES |
| UCWDC Showcase | ProAm/ProPro and Couples structure; offering-versus-level question | UCWDC-PA II.G.2.a-b; UCWDC-C II.G.2.a-b | OD19-UCWDC-SHOWCASE-PROAM / -COUPLES |
| NDCA Showdance / Cabaret / Theatre Arts | no role restriction beyond the couple definition | NDCA II.B.4(2)-(3), XI.A | OD19-NDCA-SHOWDANCE-CABARET-THEATRE-ROLES |

Implementing these needs a new entry format with roles in TypeScript and SQL together (drift guard) and an
owner-gated PROD SQL apply. Studio/Custom formats must never be shown as certified or approved by a governing body.

## Tests

`src/lib/competition/setup/__tests__/studioCustomDisplay.od19.test.ts`: id/enum snapshot before vs after, only
display fields differ, idempotent, no body names in labels/descriptions/notes, flexible roles unchanged, draft payload
types unchanged; `setup.phase10c5.test.ts` review labels updated.

## Addendum: R-02 and OD-32 AE-08 (same PR, separate commit)

**R-02 (ratified 2026-11-23).** `STUDIO_PARTNERSHIP_DISPLAY` relabels the Studio/Custom partnership formats and `solo`: `wcs_couples`, `wcs_pro_am`, `studio_pro_am`, `studio_pro_pro`, `studio_couples`, `studio_professional`, `studio_jack_and_jill`, `studio_solo` (and Country `solo`, whose text made a UCWDC statement) to "Studio/Custom: ...". `wcs_couples` was "Studio / Custom couple contest. WSDC defines no Couples contest."; it is now "A couple contest you define, as a DanceFlow Studio/Custom format." No replacement claim about WSDC is made. `studio_team` and the other team formats are in the OD-28 PR; `custom_routine` is in the table above. Neutral rewording of the (unrendered) `studio_wcs` scheme note; the `studio_generic` age note now says Youth, Adult and Senior carry no thresholds, map to no body class (AE-26, FD-26, FD-37), are never checked against age, and that DanceFlow's initial-release policy (OD-02) is 18 or older whatever the label. Division names and ids are untouched.

**AE-08.** The Country Couples age-division note now states that UCWDC Couples II.D.3.a-b (re-read in the pinned PDF, p3) allows an adult to dance Open or Masters with a partner aged 16 or above, that this exception is NOT available in this release because OD-02 prohibits all competitors under 18, and that DanceFlow does not enforce UCWDC age eligibility. Register: `OD32-UCWDC-MASTERS-PARTNER-16`, `R02-STUDIO-PARTNERSHIP-LABELS`.

**Surfaces audited (rendered code paths).** Setup wizard offerings (label, description, eligibility note), division step (axis labels and notes; scheme notes are not rendered), pricing step, review step (category labels) and server-side `deriveDraft` messages: all use the display layer. Registration builder, staff registration/readiness pages, public and staff results, and any export show only the names saved in the database (from the SQL profile), none identifies the rules profile as Studio/Custom, and no Studio/Custom marker exists on them. Those are gaps beyond display-label scope; closing them needs a reviewed migration (new profile version plus function) or render-time mapping at every read site. Per-format "Studio" wording in saved names exists only for the formats already named "(Studio)".

**OD-02 and Youth.** The Studio Youth/Adult/Senior values are plain labels with no age data, so they cannot widen who may register. The test that a Studio "Youth" division still refuses an under-18 competitor, and that the Masters 16-year-old partner case is refused, needs the OD-02 gate (PR 835), which is not on this base; it belongs to that PR.

**Merge order and residuals (review).** The new wording states the OD-02 policy as policy; enforcement is PR 835, which is not on this base, so this PR should merge with or after it. The layer now applies only to the "Studio / Custom Rules" profile, so a future body profile reusing generic keys is never relabelled. Residual body text that remains, outside the R-02 list or not rendered: WCS offering group "WSDC Registry contest" and `jack_and_jill` "(WSDC Registry contest)" (real WSDC format), Country `couples` "(UCWDC Couples dance type)" and `team` "(UCWDC Teams)", Country age labels, and unrendered stored value notes (the `Open` skill value note on `studio_generic`/`studio_wcs` mentions UCWDC; the Country Couples `Open` note about a 16-year-old partner contradicts the new note but is not rendered). Cleaning them needs a new profile version.
