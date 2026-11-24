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
