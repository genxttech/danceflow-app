# OD-27: role flexibility, gender and body role rules

Owner decision **OD-27, 2026-11-23: Option B, retain Studio/Custom role flexibility; document body limitations.**
Documentation only: no gender collection, new column, migration, role-lock, UI or copy change is made or authorized. Nothing
here claims NDCA, UCWDC or WSDC compliance.

## 1. Preserved Studio/Custom behavior (`OD27-DF-0001`)

- A couple-style entry needs exactly one leader and one follower (line dance partnerships may omit both, Jack and Jill is one person with one role, team entries use neither) (`participantShapeErrors`, `src/lib/competition/participantRoles.ts`,
  mirrored in SQL by `_comp10c4_participant_shape_errors`); the people can be any people.
- The dance role is stored per participant per entry (`event_competition_entry_participants.dance_role`: leader or follower; it may be empty, and the registration cart table `event_competition_registration_cart_entry_people` also carries it), separate
  from the relationship role (student, professional, instructor, ...).
- Studio/Custom division schemes for the Country formats use only the **skill-level and age-group axes**
  (`studioCustomV3.ts`, `divisionSchemes.country_proam`, `country_propro`, `country_couples`; `country_routine` has an age-group axis only).
- Organizer-managed eligibility is preserved. **No gender is collected, no column or migration is added, and no role lock is
  enforced** for initial activation.
- Observations: the role is per entry, so nothing checks that one partnership keeps its roles across different entries; and the
  `country_proam` scheme note in `studioCustomV3` cites UCWDC II.A.7 but describes a division as a level in an age division, with no Mixed-Role dimension.

## 2. Dance role is not gender (`OD27-DF-0002`)

Dance role and gender stay separate concepts. Never infer gender from leader/follower role, from a name, or from unrelated profile
data. No universal gender collection.

### Evaluation checklist for any future gender-data collection

A separate privacy and data-minimization decision, not part of OD-27. Answer all before building:

1. **Purpose:** which body rule or product need requires it (for example UCWDC Line Dance gender divisions, UCWDC traditional
   Couples, NDCA Pro/Am gender categories)? Is there a non-gendered alternative (a division declaration instead of a personal attribute)?
2. **Necessity and scope:** which formats and bodies only; optional or required; self-declared division choice versus a stored personal attribute.
3. **Access controls:** who can read it (competitor, organizer, scorer, judge), least privilege, hidden from public pages by default, read auditing.
4. **Retention:** how long (event, Dance Season), deletion on request, whether it is copied into results, exports or reports.
5. **Verification:** whether and how it is checked (the Line Dance text does not describe a check), who may change it and when, audit trail.
6. **Participant disclosures:** a plain notice of purpose, who sees it, and that choices are the participant's, with respectful options
   consistent with each body's text.
7. **Interactions:** age and eligibility data (OD-02/OD-03), confidentiality (OD-10), and OD-01 on body claims.

## 3. UCWDC (rules v1-26-2026; printed pages)

Each body requirement below is NOT IMPLEMENTED and a profile-activation blocker (the Teams II.C.1 permission and the discretionary NDCA II.B.7.c are not mandatory requirements).

| Rule | Text (short) | Register |
|---|---|---|
| Couples II.A.7, II.A.12 (p.2) | A division is defined by "Age, Skill Level, and Mixed-Role" (example "ProAm Female Diamond Novice"); Mixed-Role means "traditional dance-gender roles ... are not required" | `OD27-UCWDC-0002` |
| Couples II.C.1 (p.3) | In non-Mixed-Role Couples divisions a pair is "one (1) male leader and one (1) female follower"; "Only momentary role reversals are accepted." | `OD27-UCWDC-0001` |
| Couples II.C.2 (p.3) | In Mixed-Role divisions a pair is "one (1) follower and one (1) leader of any gender"; both "must retain their roles throughout each Dance Category" | `OD27-UCWDC-0002` |
| ProAm/ProPro II.C.1-2 (p.3) | Same structure with a student and their pro; Mixed-Role allows "any gender" | `OD27-UCWDC-0003` |
| Line Dance II.C.1-2 (p.3) | The division registered for "is the gender they are and must be throughout a Dance Season"; gender-specific and non-gender-specific divisions both exist | `OD27-UCWDC-0004` |
| Teams II.C.1 (p.3) | A Team may use "any number and combination of genders" (permission) | `OD27-UCWDC-0005` |
| Teams II.C.2 (p.3) | A Team "Couple" must portray a leader and a follower, with "no gender restriction" (mandatory) | `OD27-UCWDC-0006` |
| ProAm/ProPro II.K item 8 (p.10) | competitor-selected music differs per division "unless they are switching roles": a competitor may hold different roles in different divisions (not a gender rule) | noted in `OD27-UCWDC-0003` |

**Mixed-Role modelling, and what existing data does and does not cover.** A future profile models one leader and one follower of any
gender with role consistency throughout each Dance Category.
- *Sufficient today:* the per-entry `dance_role` and the one-leader-plus-one-follower shape rule need no gender at all.
- *Not sufficient:* no Mixed-Role division axis; no check that a partnership keeps its roles across entries or a Dance Category;
  no gender-named divisions; no gender attribute for the traditional-Couples and Line Dance rules; no Team Couple role (team entries
  do not use lead or follow); and "Dance Category" is not mapped to DanceFlow dances.

## 4. NDCA Rule Book June 2026 (SHA `d1b73e1f...`; printed pages)

- **II.A.7.a(1) (p.5):** "Partners may not switch roles at any time during an event (single-dance or multi-dance)." (`OD27-NDCA-0001`)
  **Correction of the audit:** the audit said "event" was undefined; the text states the scope in a parenthesis, single-dance or multi-dance.
  **Remaining questions:** how it applies across rounds, across the dances of a multi-dance event, whether any momentary reversal is
  tolerated (no exception is stated), whether it binds a partnership entered in more than one event, and how it applies to Mixed-Role
  or same-sex couples.
- **II.A.7.a (p.5):** a couple is "a leader and follower without regard to the sex or gender of the dancer", for all classifications.
  (`OD27-NDCA-0002`)
- **II.B.7.c (p.7):** Pro/Am competitions may offer "separate or merged categories by age or gender, etc." (`OD27-NDCA-0003`, discretionary.)
  How gender categories fit the gender-neutral couple definition is not explained in the text read; no interpretation is chosen.

## 5. WSDC

Not read for this decision. No WSDC role or gender rule is stated or implied here.

## 6. Disclosure specification (text only; no UI change authorized)

Studio/Custom must say, wherever scoring or eligibility is described, that it **does not enforce UCWDC gender or Mixed-Role requirements
or NDCA role-switching requirements**. Suggested sentence (owner to approve before any use):

> "DanceFlow Studio lets organizers register any leader and follower pair. It does not check gender, Mixed-Role division rules,
> or whether partners keep their roles, so it does not enforce UCWDC gender or Mixed-Role requirements or NDCA role-switching rules."

Follow the wording rules of the OD-13 disclosure spec (no "official", "certified" or "compliant"). Surfaces to label later, after separate
approval: the setup wizard (format and division step), the registration builder, the organizer eligibility notes, public event rules text.

## 7. Coordination, blockers and what is not verified

OD-02/OD-03 (age and eligibility), OD-18 and OD-19 (relabelling) are being handled in sibling PRs; OD-28 is a placeholder. OD-01 (PR 832) is
preserved. Every body requirement above is a profile-activation blocker.

Not verified: tests (docs only); a search of `src` found no gender or sex field, cross-entry role check or role lock outside a migration comment, but database data and non-code configuration were not audited; the NDCA `effective_from` date is a placeholder (the rule book states only "June 2026 EDITION", OD-30); WSDC rules; how
UCWDC "Dance Category" maps to DanceFlow dances; the sibling PRs' contents.
