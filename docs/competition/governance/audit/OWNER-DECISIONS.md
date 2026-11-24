# Retrospective rulebook audit: owner decision list (consolidated)

Status: **DRAFT for owner decision, docs only.** Internal. Baseline: `origin/release/website-embeds` (governance PR #792). Date: 2026-11-22.
Governed by [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md) and [README.md](README.md) in this directory. Nothing here changes code, SQL or behavior, and **nothing here is a decision**: every "Recommendation" below is an *engineering recommendation, NOT approved*. The earlier judging design brief (PR #783) is **not approved** either (see section 5).

**What this replaces.** The owner does not need to read the 256 inventory rows. The nine inventory files stay in their own draft PRs (#787, #788, #790, all unmerged) as evidence. This file is the one place to decide. Each decision below says which rows it covers, so nothing is dropped.

## How to use this file

1. Read the headline table (section 1) and the risk summary (section 2).
2. Answer the decisions in section 3, in order. Each ends with ONE question. Answering "defer" is allowed and keeps the public-activation gate closed for that item.
3. Ratify the DanceFlow-policy list once (section 4). Read the cross-cutting findings (section 5).

Public Competition OS activation stays **not authorized** until every decision here is answered and the tracker is closed (README "Public activation gate").

## 0. Ground rules used in this consolidation

- **Sources.** Only the pinned documents in [governing-body-source-registry.md](../../governing-body-source-registry.md) (SHA-256 checked by each inventory author, and re-checked by the independent verification in section 6). Citation keys are copied from the inventories; the two PR families use different aliases for the same file:

| Key(s) in inventories | Document and edition | SHA-256 (first 8) |
|---|---|---|
| NDCA | NDCA Rules and Regulations, compiled rule book, June 2026 edition, Master v1 | d1b73e1f |
| UCWDC-C / UC-C | UCWDC Rules, Contest Procedures and Scoring Format, Couples, 2026 (v1-26-2026) | 8a45ee58 |
| UCWDC-PA / UC-PP | same, ProPro/ProAm | d6257b65 |
| UCWDC-L / UC-L | same, Line Dance | 98e90011 |
| UCWDC-T / UC-T | same, Teams | 7e71fdce |
| UCWDC-SF / UC-SF | UCWDC Scoring Format, v16.9b ("2026-2028 Rules") | 44290a06 |
| WSDC | WSDC Registry Event Rules, Version 2026.1C (file name says 2026.1B) | 140caae7 |
| RP-ref | Tigges Relative Placement explanation, updated 12.20.2021: **reference only, not WSDC rule text** | 573cb005 |

- **Effective dates.** None of these documents states an effective date in the text the auditors read (they carry edition labels only; the age inventory notes NDCA X.A.1 says age classes change on the birthday). Every citation therefore gives **edition label, not an effective date**. This is itself a finding (OD-30). No 2027 draft (WSDC, registry status "not current") was used.
- **Pages.** The judging and scoring inventories cite "p.N"; the others cite "pN". Page numbers are the documents' own printed page, copied as written.
- **Live versus dark.** I took the state from the inventories and project status, and did **not** re-verify production (no production access in this task). Competition OS is dark: public activation is not authorized and the flags/registration/publication switches are OFF. The exceptions are database objects already applied to PROD (for example PV-1 recompute and OJ-1 judging access) and any behavior in the main studio app that touches competition tables. "Dark" below means unreachable by a competitor today; it does not mean harmless once activated.
- **What "unsupported" means in these inventories.** The audit README defines `unsupported` as "no basis in the cited source". The auditors in practice used it for two things: **GAP** rows (the rulebook *does* require or define something and DanceFlow does not model it) and **POLICY** rows (DanceFlow behavior with no rulebook basis). 27 rows are tagged GAP, 16 POLICY, 39 untagged (mixed). The material GAP rows are therefore promoted into decisions below and are **not** treated as mere policy.
- **Body scope.** Per FD-01, a new setup can only use the Studio/Custom profile (`studio_simple@3`, no sanction claim); the NDCA, UCWDC and WSDC bodies are visible but not selectable. But `events.competition_sanctioning` is a free organizer declaration, and that is why OD-01 comes first.

## 1. Headline table (recounted)

I recounted by parsing every inventory row table (rows whose first cell is an inventory id) rather than trusting the file headers. **The recount equals the expected totals: 256 rows; 55 / 57 / 82 / 62.** Only one note: the judging and scoring files also contain an eight-row "material findings" table each (F1..F8) that is not an inventory row and is not counted.

| Classification | Rows | Share |
|---|---|---|
| verified compliant | 55 | 21% |
| inconsistent | 57 | 22% |
| unsupported | 82 | 32% |
| requires interpretation | 62 | 24% |
| **Total** | **256** | |

By inventory file (V / I / U / RI):

| PR | File | V | I | U | RI | Total |
|---|---|---|---|---|---|---|
| #787 | inventory-formats-divisions | 19 | 4 | 14 | 3 | 40 |
| #787 | inventory-age-eligibility | 9 | 2 | 12 | 3 | 26 |
| #787 | inventory-classifications | 4 | 1 | 9 | 1 | 15 |
| #787 | inventory-registration-partners | 5 | 3 | 9 | 1 | 18 |
| #790 | inventory-judging | 3 | 24 | 6 | 13 | 46 |
| #790 | inventory-scoring-placements | 10 | 15 | 10 | 12 | 47 |
| #788 | inventory-withdrawals-corrections | 2 | 2 | 4 | 15 | 23 |
| #788 | inventory-organizer-authority | 1 | 2 | 5 | 9 | 17 |
| #788 | inventory-other-rule-dependent | 2 | 4 | 13 | 5 | 24 |
| | **Total** | **55** | **57** | **82** | **62** | **256** |

Verified-compliant rows (55) need no decision. 12 of the 62 requires-interpretation rows are labelled policy-only by their authors (rulebook silent: 4 in organizer authority, 8 in withdrawals) and are covered by the ratification list in section 4; the other 50 are mapped to the decisions in section 3. Judging is the riskiest file: 24 of its 46 rows are inconsistent, and 37 of 46 are inconsistent or requires-interpretation.

## 2. Risk-ranked summary

Ranking basis: (1) could it change an eligibility, placement, refund, disqualification, safety, judge-independence or result-integrity outcome; (2) breadth of competitors affected; (3) whether it is reachable today. **32 decisions.** Rows marked "master" gate several others.

| Rank | ID | One-line issue | Domain | Risk | State |
|---|---|---|---|---|---|
| 1 | OD-01 | An organizer can declare NDCA/UCWDC/WSDC sanctioning and still be scored by Studio methods, with nothing blocking or warning | scoring/sanction | outcome, master | dark |
| 2 | OD-02 | No under-18 or guardian-consent handling; date of birth is optional and unused | safety | safety | dark |
| 3 | OD-03 | No age validation anywhere; any age is accepted into any age division | eligibility | eligibility | dark |
| 4 | OD-04 | Event deletion is not blocked once ballots exist, contradicting the contract's own claim | integrity | result integrity | **DB path exists today** |
| 5 | OD-05 | No conflict-of-interest or recusal mechanism of any kind | judging | judge independence | dark |
| 6 | OD-06 | An event owner/manager can be a judge and also calculate and approve results | judging | judge independence | dark |
| 7 | OD-07 | A completed round can never be corrected, even after its publication is withdrawn | results | placement | dark |
| 8 | OD-08 | A couple that leaves after the Final starts is excluded, not placed last as NDCA III.D.30 says | placement | placement | dark |
| 9 | OD-09 | NDCA recall count, final size cap and semi-final rules are not enforced; the manager, not the chair, sets the count | advancement | placement | dark |
| 10 | OD-10 | Managers and scorers can read every judge's ballot before publication | judging | result integrity | dark |
| 11 | OD-11 | A judge's correction can be entered by a scorer on the judge's behalf, with a wider reason than the rule allows | corrections | result integrity | dark |
| 12 | OD-12 | Paper ballots are transcribed by one person with no second-person check | judging | result integrity | dark |
| 13 | OD-13 | Tie chain stops early and shares places where UCWDC rules would keep separating | placement | placement | dark |
| 14 | OD-14 | Over-capacity callback ties are blocked, not advanced; sources conflict | advancement | placement | dark |
| 15 | OD-15 | No qualification, certification or membership data for any official | judging | eligibility of officials | dark |
| 16 | OD-16 | Panel minimums and chair requirement are below the bodies' minimums | judging | result integrity | dark |
| 17 | OD-17 | Panel appointment timing, publication and substitution are not controlled | judging | result integrity | dark |
| 18 | OD-18 | Amateur/professional status, proficiency and level eligibility are not evaluated | eligibility | eligibility | dark |
| 19 | OD-19 | "Custom" formats (Student/Student, Spotlight, Showcase) accept any roles | eligibility | eligibility | dark |
| 20 | OD-20 | Disqualification, dangerous-lift mark, rule-breach DQ and eligibility disputes have no product action | DQ | placement | dark |
| 21 | OD-21 | Minimum-couples rule, single-couple division and next-couple replacement | placement | placement | dark |
| 22 | OD-22 | Withdrawing/hiding a published result vs WSDC 30-day posting and UCWDC finality | publication | result integrity | dark |
| 23 | OD-23 | Score reports/scrutineer sheets are never published; default visibility | publication | transparency | dark |
| 24 | OD-24 | Which bodies' scoring is in scope; missing source text for NDCA and WSDC methods | scoring | outcome | dark |
| 25 | OD-25 | Heat size, balancing, randomization and contiguity per body | heating | competitor fairness | dark |
| 26 | OD-26 | Mid-event running-order changes and timetable limits | scheduling | fairness | dark |
| 27 | OD-27 | UCWDC gender / Mixed-Role structure not modelled | divisions | eligibility, privacy | dark |
| 28 | OD-28 | Team structure (Formation, Team Match, Country Team) | divisions | eligibility | dark |
| 29 | OD-29 | Personal devices for judge ballots; remote judging | judging | integrity | dark |
| 30 | OD-30 | Rulebook edition and effective-date handling; age reference dates | governance | all outcomes | dark |
| 31 | OD-31 | Audit baseline line: U18/U18-S status guards are not on this branch | integrity | result integrity | dark |
| 32 | OD-32 | Low-risk documentation and label corrections (batch) | docs | none | none |

---

## 3. Decisions

Each entry: **Issue**, **Governing sources**, **Today**, **Options**, **Recommendation** (engineering recommendation, **NOT approved**), **Blast radius**, **Decision needed**. Row ids are from the inventory files named in section 1. "Dark" = see section 0.

### OD-01 Sanction declaration versus Studio scoring (master)

- **Issue.** An organizer can declare NDCA, UCWDC or WSDC sanctioning on an event and still run it with the two DanceFlow Studio methods; nothing blocks it and the disclosure is provisional and appears only on one draft page.
- **Sources.** UCWDC-SF preamble (p.1): all UCWDC contests must use the Majority Rules format, supervised by a certified Contest Coordinator, with verified scoring staff and a vetted, authorized scoring system; General Information (p.8): systems and staff trained, tested and authorized by a UCWDC Scoring Examiner. NDCA III.D.11 (p.21): Skating System in all Sanctioned events; III.B.1.e (p.14): at least one NDCA-certified Scrutineer; III.E.1 (p.25): organizers deliver the computer scrutineering files from NDCA Premier or CMPMGR. WSDC 3.4.9 (p.20): WSDC-approved Callback system for preliminaries and Relative Placement for finals in all WSDC Jack and Jill contests; 3.4.9.b: a computerized system is required; Section 6 (p.23) lists what the system must do.
- **Today.** `events.competition_sanctioning` (`none`, `ucwdc`, `ndca`, `wsdc`, `other`) is an unverified declaration independent of the method (`20270113090000_competition_scoring_registry.sql`, `protect_competition_sanctioning`; registry code `SCORING_REGISTRY`, `selectableMethods`, `sanctioningDisclosure`); disclosure only on `src/app/app/events/[id]/competition/advanced/page.tsx`, behind the Finals flag. Rows S-01U/N/W; related O-05, J-02N/W/U, J-21*, S-27*.
- **Options.** (a) Disclosure only (today). (b) Require an explicit "not scored under body rules" acknowledgement before publish when a body is declared. (c) Block rule-bound functions (publish, approve) for declared bodies until that body's profile is supported. (d) Remove the body declaration from setup until supported.
- **Recommendation (engineering, NOT approved).** (c), with the acknowledgement of (b) as the only path forward. It is the smallest change that stops a result being presented as body-compliant. It makes most body-specific findings below moot until a body profile exists.
- **Blast radius.** Dark. App code plus possibly a CHECK/guard in SQL (`protect_competition_sanctioning`); an SQL change would need an owner-gated PROD apply.
- **Decision.** Block, acknowledge, or disclose only, for an event that declares NDCA, UCWDC or WSDC while using a Studio method?
- **DECIDED 2026-11-23 (owner): BLOCK (Option C).** Block approval and publication of Studio-scored results where a declared body's mandatory scoring requirements have not been implemented and verified. Registration, scheduling, payments and other non-scoring operations are preserved. Organizer acknowledgement is never a blanket override of mandatory body scoring rules. WSDC's non-WSDC-contest opt-out (Registry Event Rules 3.4.9.f, p.21) is handled separately with contest-level identification and published disclosure, and never applies to WSDC Jack and Jill contests. Studio/Custom is unchanged; `other` stays unblocked without implying verified sanctioning compliance. Scoring algorithms and source gaps (NDCA Skating System, WSDC Relative Placement, UCWDC authorized-system designation) stay unresolved until independently verified. Authorized: one bounded draft PR (app-layer guards, tests, disclosure copy, rule-register updates). Not authorized: SQL apply, merge, deployment, public activation.

### OD-02 Under-18 competitors and guardian consent

- **Issue.** Nothing captures that a competitor is a minor, a guardian's consent, or a chaperone; date of birth is optional and format-checked only.
- **Sources.** UC-C II.O.2 (and UC-PP II.O.2, UC-L II.O.2, UC-T II.N.2): competitors under the legal age of 18 must be accompanied (see inventory X-12 for the full clause). NDCA III.C.5 (p19): entry blanks need a parent or guardian's consent signature for Juniors. UCWDC-PA II.B.1.a (p3) and UCWDC-C II.B.1.a (p3): membership with birthdate before registering.
- **Today.** `_comp10c_quote` (migration `20261110090000`, line 237) accepts an optional DOB and never reads it; buyer signing only; per-competitor waivers are a recorded carry-forward. No minor flag or guardian field exists. Rows X-12 (unsupported), RP-12 (unsupported), AE-20 (unsupported).
- **Options.** (a) Collect DOB (required) and a guardian name/consent flag for under-18 and let the organizer see a minors list. (b) Organizer-attestation only ("organizer is responsible for minors policy"). (c) Defer; do not allow under-18 registrants in the first activation.
- **Recommendation (engineering, NOT approved).** (c) for first activation, then (a). It removes the safety exposure at no cost and keeps (a) as a deliberate slice. The guardian-capture design is a privacy decision (OD-27 shares it).
- **Blast radius.** Dark. (c) is a config/UI gate; (a) needs a migration (new columns) and an owner-gated PROD SQL apply.
- **Decision.** Allow under-18 registrants at first activation, and if so with what capture?
- **DECIDED 2026-11-23 (owner): Option C for first activation, Option A as the future design.** For initial Competition OS activation, under-18 competitor registration is prohibited across all competition event types, including Studio/Custom. This is a temporary launch restriction, not a permanent exclusion of young dancers. Required: server-side enforcement at every registration and entry path; evaluate each competitor, not only the purchaser; fail closed when age cannot be established; minimize personal-data collection and keep birthdates out of logs; cover couples, teams, staff-created entries and registration changes; no effect on general DanceFlow student records, NSI or ordinary studio scheduling; re-read the pinned rulebooks before any rule-specific claim and preserve WSDC uncertainty. Authorized: one bounded draft PR (restriction, copy, automated tests) and a design document for Option A (guardian consent, signatures, accompaniment, permissions, privacy). Any SQL needed for reliable enforcement is a separate approval requirement. Not authorized: merge, PROD SQL, deployment, registration activation.

### OD-03 No age validation in registration

- **Issue.** Registration accepts a participant of any age into any age-restricted division (Youth, Junior, Masters, Senior I-IV); the age data on divisions is neither shown nor read.
- **Sources.** NDCA X.A (p42-43) and II.B.7.f-g (p7-8) (age classifications; effective on the birthday with an optional 60-day window, X.A.1 p42; couple's age is the older partner's for Pre-Teen to Adult and the younger's for Senior, X.A.6 p43; Senior I-IV need one partner 35 and the other 30, 45/40, 55/50, 65/60: X.A.1.g(1)-(4) p42); UCWDC-PA/C II.D (p3-4); UCWDC-C II.D.3.b (p3): Masters adults, with a 16-or-older partner exception; WSDC Definitions "Age-based Contests" (p3): age at the close of the event, and 3.1.3 (p10). Dance-up/age-gap: NDCA X.A.4 (p42-43), X.A.5 (p43), II.B.8.d (p8). Professional 16 or older: NDCA II.B.1 and II.B.1.b(1)(a)-(h) (p6).
- **Today.** `QUOTE-TS` participant checks; wizard stores labels only; `studioCustomV3.ts` `divisionSchemes.*` carry `min_age` (single value) and a note for Senior. Rows AE-19 (inconsistent), AE-02, AE-16, AE-17 (RI), AE-13, AE-14, AE-15, AE-18, AE-12 (unsupported). The profile itself says "10C.5 does not enforce eligibility" (WIZ).
- **Options.** (a) Compute age per body from a required DOB with per-body reference dates (needs OD-30 and OD-02) and block or flag out-of-category entries. (b) Organizer verification gate: an entry cannot be confirmed or scheduled until `eligibility_status` is eligible or waived (the workflow exists, AE-21), and registrants are told age is verified by the organizer. (c) Phased: (b) now, (a) per body later.
- **Recommendation (engineering, NOT approved).** (c). The gate already exists as DanceFlow policy and ships without new data; computed enforcement is a per-body build that also needs the whose-age decision (AE-16: whose age counts in ProAm/Couples is NOT SPECIFIED IN PROVIDED SOURCE) and the Senior two-threshold encoding (AE-02).
- **Blast radius.** Dark. (b) is code (readiness/confirmation gate) with no SQL if `eligibility_status` is reused; (a) needs migration(s) and an owner-gated PROD SQL apply.
- **Decision.** Choose (a), (b), or (c) for first activation; and confirm whose age decides in ProAm and Couples.
- **DECIDED 2026-11-23 (owner): Option C, subject to OD-02 compatibility.** For initial activation, organizer verification of age-division eligibility; automated governing-body-specific age calculation is a later, separately reviewed phase. OD-02 stays absolute: under-18 competitor registration is prohibited at first activation across all Competition OS events, and an eligibility waiver can never bypass it or a body's mandatory age requirement. An auditable organizer eligibility determination is required before an age-restricted entry is confirmed. Copy must disclose that DanceFlow does not yet automatically verify body age divisions. Whether existing data and workflows can reliably enforce the adult-only requirement server-side must be determined and any gap reported, not claimed ready. The ProAm/Couples whose-age rule stays UNRESOLVED and fail-closed until the applicable rulebooks are verified. NDCA, UCWDC and WSDC differences (reference dates, Senior thresholds, permitted exceptions) are preserved. Authorized: one bounded draft PR (readiness gate, copy, tests) that cannot conflict with OD-01 or OD-02. Not authorized: SQL apply, merge, deployment, registration activation.

### OD-04 Event deletion with ballots present (possible gap in the contract)

- **Issue.** The results contract says deleting an event is blocked once any ballot exists, but the audit found no delete guard on `events`, and the history-protection trigger explicitly permits removal when the parent event is deleted.
- **Sources.** NDCA III.E item 2: organizers retain the original adjudicators' score sheets for 30 days after the event closes. WSDC 3.1 item 9: results (rounds, placements, score reports) open to competitors for at least 30 days (the inventory cites it as §3.1 item 9; the scoring file as 3.1.9 p.12).
- **Today.** `20261107090000_phase10a_competition_foundation_reconcile.sql` `protect_competition_history_evidence` (returns the old row when the event no longer exists); ballot tables `on delete cascade` from `events`; contract `scoring-results-contract.md` line 215 (K0 §10) claims the block. **Independently confirmed in this consolidation:** a search of the migrations for a `BEFORE DELETE` guard on `events` found none. Row X-18 (requires interpretation, the auditor's wording "possible material gap").
- **Options.** (a) Add a guard that refuses event deletion while ballots or results exist (archive instead). (b) Keep deletion, correct the contract wording. (c) Defer until activation.
- **Recommendation (engineering, NOT approved).** (a). Result evidence should not be removable by a cascade, and (b) only makes the documentation honest. This is a defect against the project's own contract, so it should not be left as "interpretation".
- **Blast radius.** The database path exists in PROD today (PROD has the 10A tables); there are no competition ballots in PROD, so no data is at risk now. Fix is SQL (a trigger/guard), therefore an owner-gated PROD SQL apply.
- **Decision.** Approve a delete guard (SQL slice), or correct the contract?

**OD-04 DECIDED 2026-11-23 (owner): Option A, BLOCK.** Draft PR preparation authorized for database-level protection against hard deletion of Competition OS events once ballots or results exist. Requirements: applies to all Competition OS events including Studio/Custom; existing authorization-controlled deletion preserved for competition events without ballots or results; blocked at the database boundary including cascade paths; ballots, scoring results, adjudication records and audit evidence preserved; a safe archive/hide workflow without destroying evidence, identifying any missing archive capability rather than assuming one; governing-body retention and publication requirements preserved and no automatic deletion after 30 days; ordinary studio event deletion unchanged; migration, rollback, automated tests and results-contract corrections included; independent review and rollback-safety verification before any protected approval request. Not authorized: merge, DEV/PROD SQL apply, deployment, public activation.

### OD-05 No conflict-of-interest or recusal mechanism

- **Issue.** Nothing relates an official to competitors: a judge can judge a relative, a student, a partner, a team they coach, or be a competitor in the same event.
- **Sources.** NDCA IV.A.1 (p.25) must excuse; IV.D.1.a(2) (p.28) same, with a different definition of "immediate family" (an NDCA internal conflict); IV.A.2 (p.25): related persons not on the same panel in Open Adult Amateur "A" events or any Professional event at Sanctioned Championships; IV.A.8 (p.25): should excuse from heats with an active Pro/Am student partner (advisory); III.D.21 (p.22): owners, organizers, chairmen, adjudicators, MCs, scrutineers, music directors and demonstrators may not compete at NDCA events; IV.A.7 (p.25): active professional competitors may judge only Amateur and Pro/Am categories; XII.N.4 (p.52): coaches shall not judge formation events their teams enter. WSDC 3.4.6.a (p.19) and 3.4.6.b: conflicts identified and avoided, recusal, with three exceptions; 3.4.2 (p.18) and p.19: owners/directors, chief judge and the score person must not compete in swing contests, with exceptions; 3.4.6.a.i: bias is a recommendation only. UCWDC-C II.F.6.e (p.5) and UCWDC-L II.F.5.d: Crown/SuperStars may not judge the Dance Type they are dancing in those divisions. UCWDC-C II.N.3 (p.13): complaints about panel composition go post-event to the Judge Review Board; the Judge Certification Code of Conduct is **not provided**.
- **Today.** None found in E1, E2, F2, CF1, PV1 or `src/lib/competition/`. Rows J-09N/W, J-10U, J-11N, J-12N, J-13N, J-15N, J-16W (inconsistent), J-14N, J-17W, J-18U (RI), J-18X, O-07 (unsupported, "material").
- **Options.** (a) Judge-declared conflicts per round with an entry-level block on ballot submission, plus an organizer-visible list; no inference from names. (b) Organizer-entered panel-level relatedness declaration, blocking at lock for the divisions NDCA names. (c) Automatic cross-check of official ↔ competitor identity at assignment and at lock. (d) (a)+(c). (e) Warn only. (f) Defer and state "no conflict handling" in organizer terms.
- **Recommendation (engineering, NOT approved).** (d), delivered in two slices (identity cross-check first because it is automatic and unambiguous; declarations second), with body-specific definitions applied only for events that declare that body (OD-01). Where a body is silent (UCWDC), label it "organizer policy".
- **Blast radius.** Dark for the competition; official assignment and ballots are already in PROD SQL (E1/E2 migrations). Needs new tables/columns and an owner-gated PROD SQL apply for (a)/(c); declarations also touch the judge UI.
- **Decision.** Which of (a)-(f), and block or warn?

**OD-05 DECIDED 2026-11-23 (owner): Option D, BLOCK, with panel-level safeguards (Option B's declaration/validation where the applicable body requires it).** Bounded, independently reviewed slices: (1) automatic identity and role-conflict checks at assignment and before ballot acceptance, with ambiguous shared-account matches treated as review cases, not proof; (2) judge-declared conflicts by contest, division, round or heat scope, with authorized organizer/Chief Judge visibility, documented resolution and audit history; (3) server-side recusal enforcement that blocks only the affected assignment or ballot; (4) panel-lock validation for body-specific panel restrictions, including NDCA once the source-definition conflict is resolved; (5) baseline direct-conflict protection for Studio/Custom as DanceFlow policy, with mandatory NDCA/WSDC requirements and documented exceptions kept body-specific; (6) record the conflicting NDCA "immediate family" definitions (IV.A.1 vs IV.D.1.a(2)) as a source conflict and obtain the missing UCWDC Judge Certification Code of Conduct, inventing no rule and claiming no compliance while definitions are unresolved; (7) preserve ballot confidentiality, least privilege, tenant isolation and immutable audit evidence, avoiding unnecessary sensitive relationship detail in general staff views; (8) coordinate schema and guards with OD-06, OD-15 and OD-16. Authorized: draft PRs, migrations, rollbacks, automated negative tests, independent reviews; heavy QA respects the lock. Not authorized: DEV/PROD SQL apply, merge, deployment, public activation.

### OD-06 Owner/manager as judge and as approver; role separation

- **Issue.** The event owner or any manager can be added as a judge or chair and can also calculate and approve results; one "manager" role performs every organizer action.
- **Sources.** WSDC 3.4.1 (p.18): event director(s) and owner(s) must not perform chief judge, judge or scoring functions; 3.4.1.a extends this to spouses and immediate family; 3.4.3 (p.19): chief judge and scoring/tabulation must be different people; WSDC 2.3 (p.9): event director and/or chief judge verify results. NDCA IV.C (p.26-27) and IV.C.1 item 7: chairman's duties and final decision on marking and timetable; IV.C.5 (p.27): chairman checks marks and transcription. UC-SF intro: contests supervised by a certified Contest Coordinator with a verified Scoring Director/Scrutineer. NDCA/UCWDC do not forbid owner judging (searched III, IV: NOT SPECIFIED IN PROVIDED SOURCE).
- **Today.** E1 `add_competition_official` (no exclusion); F2 `calculate_competition_round` (manager or scorer), `approve_competition_round_result` (manager; a different manager than the calculator or an audited override reason, owner D3); `can_manage_event_competition`. Rows J-08W (inconsistent), S-25, O-01, O-02, O-13, W-15 (RI), J-08X (unsupported), J-01 (RI role mapping: chair ≈ NDCA Chairman ≈ WSDC Chief Judge, but the bodies assign different duties).
- **Options.** (a) For WSDC-declared events refuse officials who are managers, and require the person who calculates/approves to differ from the chair. (b) Apply that for every body (it is also sound practice). (c) Keep as is and document that the manager role collapses these duties.
- **Recommendation (engineering, NOT approved).** (a) now (cheap, behind OD-01), with the role-mapping table documented and approved (J-01). Adding the chair as an approver for sanctioned events is a later slice.
- **Blast radius.** Dark. Code and possibly a SQL guard in `add_competition_official` (owner-gated PROD SQL apply if so).
- **Decision.** Do WSDC (or any body's) separation-of-duties rules bind DanceFlow-run events, and do you approve the manager/chair role mapping?

**OD-06 DECIDED 2026-11-23 (owner): Option A, enforce WSDC separation of duties.** DanceFlow account owner/manager is NOT automatically equated with WSDC Event Owner, Event Director, Chief Judge or Scorekeeper. Instead design explicit event-level designation and verification of Event Owner(s) (including applicable financial ownership interests), Event Director(s) (including anyone involved in selecting judging/scoring personnel), Chief Judge, scoring/tabulation operator, and judges and other relevant officials. Requirements: apply WSDC's mandatory separation rules to WSDC-declared Registry Events respecting their event-wide scope; block prohibited Event Owner/Event Director judging or scoring assignments; require separate individuals for Chief Judge and scoring/tabulation; do not confuse the Chief Judge's required finalist review with performing scoring/tabulation; preserve ordinary platform administration where it does not violate an event-specific duty restriction; handle WSDC exceptions narrowly with evidence and body references; do not impose WSDC requirements on NDCA, UCWDC or Studio/Custom as if mandated by those bodies; fail closed on restricted judging/scoring operations when required designations are missing; document the role-to-permission mapping and obtain independent security/rulebook review; coordinate with OD-05's shared design. Authorized: draft design and bounded implementation PR preparation only. Not authorized: merge, DEV/PROD SQL apply, deployment, activation.

### OD-07 A completed round can never be corrected

- **Issue.** Once a round is `complete` it is terminal for every role; a published result can be withdrawn but a corrected result can never then be calculated, approved or published.
- **Sources.** WSDC 3.1 item 9 (inventory cites §3.1 item 9): inaccurate results must be corrected; WSDC 2.3: results verified and reported within three days after the close. UC-C II.N.3 (p.13): challenges to a judging panel's results are made post-event to the Judge Review Board.
- **Today.** F2 `open_competition_round_correction` (opens only from `calculated`/`approved`/`published`, `COMP_RESULT_INVALID_TRANSITION` otherwise); O1 `_compo1_guard_round_status`; F3 `withdraw_competition_round_result` (allowed on a completed round). Rows W-22 (inconsistent, auditor: "material"), O-16 (RI, clock-time window).
- **Options.** (a) Add an owner-authorized post-completion correction route (reopen `complete` → `ballots_locked`, chair/manager co-sign, reason). (b) Document that post-event corrections happen outside the product. (c) Time-limited window (for example, until reporting is due).
- **Recommendation (engineering, NOT approved).** (a) with the co-sign and reason, because (b) leaves a withdrawn result with no way back. Also confirm that "round completed" is the intended end of the correction window (O-16).
- **Blast radius.** Dark. Guard changes in O1/F2 SQL: owner-gated PROD SQL apply.
- **Decision.** Must completed rounds be correctable, and if so by whom and until when?

**OD-07 DECIDED 2026-11-23 (owner): Option A, controlled post-completion corrections.** Bounded draft PR authorized. Policy: authorized post-completion correction workflows with no arbitrary time limit (the WSDC three-day reporting deadline is not a correction cutoff); explicit reason, authorized initiator and a distinct qualified co-signer; co-signing follows body-specific role requirements (for WSDC preserve Chief Judge/scoring separation and Event Director verification; do not assume NDCA Chairman = WSDC Chief Judge); for Studio/Custom require an independent designated reviewer as DanceFlow policy, no self-approval; preserve every prior ballot, result version, approval, withdrawal and publication event, never overwriting original evidence; publish corrected results as new versions linked to superseded results, preserve WSDC public availability and identify any external reporting or resubmission; distinguish computational corrections from ballot alterations (original adjudicator submissions stay protected); respect UCWDC's post-event Judge Review Board process and do not imply DanceFlow adjudicates formal external challenges; coordinate with OD-04 and OD-05/06; verify whether `complete` back to `ballots_locked` is safe and prefer an explicit correction state/version workflow if reopening would compromise evidence integrity. Prepare migration, rollback, negative and lifecycle tests, independent review; identify unresolved role-mapping or workflow dependencies before implementation. Not authorized: DEV/PROD SQL apply, merge, deployment, public activation.

### OD-08 Withdrawal after the Final has started

- **Issue.** A couple leaving after the Final starts is excluded from the ranking; NDCA says that couple is awarded last place for the dances they did not dance.
- **Sources.** NDCA III.D.30: once a final round commences and a couple must withdraw (injury or illness), that couple is awarded last place for any dances in which they did not dance. UCWDC and WSDC: no equivalent found.
- **Today.** A6 `20270120095000_competition_cf1_a6_withdrawal.sql` refuses withdrawal once the Final is `staging`/`active`/`complete` (`COMP_ADVANCEMENT_FINAL_STARTED`); engines `studioCallbackTally.ts` / `studioOrdinalMajority.ts` (K1 X-5: scratched/no-show excluded, "never placed last", S-15); NS1 no-show. Row W-04 (inconsistent, auditor: "material"); related S-15, W-03.
- **Options.** (a) NDCA-profile exception to X-5: "withdrew after the final commenced → last place in dances not danced", recorded with reason and co-sign. (b) Keep X-5 for every body and label it DanceFlow policy.
- **Recommendation (engineering, NOT approved).** (b) while only Studio events exist, and (a) as part of any NDCA profile. This changes a placement, so it needs your decision before an NDCA profile ships; no behavior changes until then.
- **Blast radius.** Dark. (a) changes engine specs (a new engine version, never editing `@1`) and SQL recompute (PV-1): owner-gated PROD SQL apply.
- **Decision.** Approve an NDCA-profile exception to the "excluded, never placed last" rule?

**OD-08 DECIDED 2026-11-23 (owner): Option A, NDCA-specific exception, future verified NDCA profile only.** NDCA III.D.30 withdrawal policy approved for a future verified NDCA scoring profile. Studio/Custom Scratch behavior preserved. For an applicable NDCA Final: a documented injury/illness withdrawal after the Final begins is allowed; last place is awarded for each dance not performed, never automatically across all dances or the overall competition; an authorized official's recorded reason and independent confirmation are DanceFlow policy with no unnecessary medical detail; immutable audit evidence coordinated with OD-07 versioning; OD-21 replacement-couple handling stays separate; no invented Skating System arithmetic (OD-24 remains a blocker); compare the pinned June 2026 NDCA rule book against the July 2026 edition listed on NDCA's official website and record version differences and effective-date uncertainty under OD-30. Authorized: a design-level draft PR identifying the versioned scoring-engine and SQL changes. Not authorized: scoring-engine implementation, SQL apply, merge, deployment, activation.

### OD-09 NDCA advancement structure and who owns the callback count

- **Issue.** The manager sets the callback target and Final size freely; NDCA sets recall at 50% minimum per round, a cap of eight in a final, and required semi/quarter-finals; WSDC puts the count with the chief judge.
- **Sources.** NDCA IV.C.1.a (p.27): the Chairman determines the recall count (at least 50% of couples each round, limited exceptions) and should consult the organizer; IV.C.1.b and IV.C.2 (p.27): no more than eight couples in any final round; IV.C.1.c: for professional and championship adult amateur events a semi-final when eight or more couples are pre-registered and a quarter-final when fifteen or more (recommended for multi-dance Pro/Am); IV.C.1.e (p.27): a semi-final may be split into two heats; IV.C.1.f (p.27). WSDC Definitions (p.3): heats, number of callbacks and cuts to finals decided by the chief judge or secondary chief judge. UCWDC-SF Rule #1.1-#1.3 (pp.1-2): the Contest Coordinator decides Prelims and the number of Yes marks; Rule #2: Semi-Finals.
- **Today.** `start_competition_round` (`COMPO1_CALLBACK_TARGET_UNSET`), A4a `20270120091000_competition_cf1_a4a_callback_target_guard.sql`, A0 `_cf1_callback_target_check`, A4a (error string `COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY`), `finalCapacity.ts`; target T ≥ 2 and ≤ round capacity (≤ 100); one callback round then a Final (S-22). Rows X-02, S-14N, S-19N, S-19W, O-03 (inconsistent); S-19U (RI); S-19, S-22 (unsupported).
- **Options.** (a) For declared NDCA/WSDC events: cap a Final at 8 (NDCA), require T ≥ 50% of entries, allow quarter/semi rounds, and record that the chair/chief judge decided T. (b) Only record a chair acknowledgement on the round-start audit row. (c) Keep organizer-set T and treat these as body rules not supported (OD-01).
- **Recommendation (engineering, NOT approved).** (c) now through OD-01, (a) when an NDCA profile is built. Multi-round (semi/quarter) support is a separate build (S-22).
- **Blast radius.** Dark. (a) is SQL (guard) plus engine support: owner-gated PROD SQL apply.
- **Decision.** Must the chair/chief judge own the callback count for body-declared events, and is an eight-couple Final cap required?

**OD-09 DECIDED 2026-11-23 (owner): Option C now, Option A required for a future NDCA scoring profile.** Current Studio/Custom advancement behavior is preserved for initial activation. Mandatory prerequisites before enabling an NDCA scoring profile: (1) the NDCA Chairman of Adjudicators controls or explicitly authorizes callback counts through a verified event-level role; (2) enforce the applicable 50% minimum recall rule including verified exceptions; (3) support quarterfinal and semifinal structures; (4) enforce the eight-couple Final restriction only after reconciling NDCA IV.C.1.f versus IV.C.2 including tie and event-format exceptions; (5) keep WSDC Chief Judge and UCWDC Contest Coordinator authority mappings separate and do not impose NDCA advancement rules on those bodies; (6) record decision-maker, callback target, rule version, exceptions and audit history; (7) coordinate role enforcement with OD-05/06 and scoring calculations with OD-24; (8) preserve the OD-01 restriction on publishing unverified body-compliant results. NDCA advancement support is NOT IMPLEMENTED and a blocker to NDCA profile activation. No advancement-engine implementation authorized; no SQL apply, merge, deployment, activation.

### OD-10 Ballot visibility before publication

- **Issue.** Managers and scorers can read every judge's ballot before results are published.
- **Sources.** NDCA III.D.16 (p.21): only the Chairman of Adjudicators and the Scrutineer have direct access to the original marking sheets until the end of the competition.
- **Today.** `src/lib/competition/results/contract.ts` `RESULT_READER_MATRIX` (manager and scorer: ballots all); E2 RLS `competition_ballots_manager_read`, `competition_ballots_scorer_read` (K0 §7). Row J-31N (inconsistent).
- **Options.** (a) For declared NDCA events restrict ballot reads to chair and scorer. (b) Keep manager read (organizer must see results) and document it. (c) Make manager reads audited.
- **Recommendation (engineering, NOT approved).** (a)+(c): restrict by role for declared-NDCA and audit every read. It supports judge independence at no cost to normal operation.
- **Blast radius.** Dark for events; the RLS policies exist in PROD (E2 migration). Changing them is an owner-gated PROD SQL apply.
- **Decision.** Is manager access to ballots before publication acceptable (and logged)?

**OD-10 DECIDED 2026-11-23 (owner): Options A + C, with audit logging for ALL Competition OS events.** For NDCA-declared events, restrict pre-end-of-competition access to original adjudicator marking sheets and their sensitive electronic equivalents to explicitly designated, authorized Chairman of Adjudicators and Scrutineer roles, consistent with verified rules (NDCA III.D.16). A generic DanceFlow scorer is not equated with an NDCA-certified Scrutineer, nor a studio owner/manager with the Chairman. Least-privilege ballot visibility is DanceFlow baseline policy for Studio/Custom, WSDC and UCWDC, with body-specific exceptions only after verification. Owners and managers may see appropriate aggregated results without automatically receiving individual pre-publication ballot access. Every authorized ballot retrieval is audited across all competition types (actor, event, scope, timestamp, purpose), with no ballot contents copied into audit records. Enforcement is designed across RLS, RPCs, API routes, exports and administrative paths, identifying direct SELECT routes that cannot be reliably audited and closing those bypasses. Immutable ballot evidence preserved; coordinate with OD-04, OD-05/06, OD-07. Record the distinction between the NDCA rule on original marking sheets and DanceFlow's additional electronic-ballot confidentiality policy. Authorized: a design-level draft PR and independent security review first, identifying exact role and SQL dependencies before implementation. Not authorized: SQL apply, merge, deployment, activation.

### OD-11 Corrections of a judge's ballot (who enters it, and for what reason)

- **Issue.** A scorer or manager can enter a replacement ballot on a judge's behalf, any valid ballot can replace the old one after a co-sign, and an ordinal Final correction needs no co-sign.
- **Sources.** NDCA IV.C.6-7 (p.27): cards needing correction go back to the adjudicator concerned; the chairman's decision on marking questions is final. IV.D.1.c(10) (p.29): marks signed in ink, every alteration initialled. NDCA V.B.4: markings final unless incorrectly evaluated. NDCA IV.C.1 items 5-6: the chairman checks transcription and refers the card to the adjudicator concerned. WSDC §1.1 item 6: fair, unbiased, untampered judging and scoring.
- **Today.** A7 `cosign_competition_correction`, `_cf1_check_correction_ballot`, `_cf1_record_ballot_correction`; E2 `_compe2_insert_ballot`, `_compe2_guard_ballot_insert` (version+1); migration `20270120095500_competition_cf1_a7_od13_correction_integrity.sql` (OD-13b/13c: co-sign for callback ballots only). Rows J-33, W-14, S-26N (RI).
- **Options.** (a) Require the judge's own confirmation for a scorer-entered correction and restrict the stated reason to transcription/evaluation errors (shown to the co-signer). (b) Keep OD-13 as approved and label it DanceFlow policy.
- **Recommendation (engineering, NOT approved).** (a). The approved OD-13 design is wider than anything the cited text allows; the confirmation and reason restriction narrow it without removing the audit trail.
- **Blast radius.** Dark. Code and SQL (`cosign_competition_correction`, reason constraint): owner-gated PROD SQL apply.
- **Decision.** Narrow the correction path (judge confirmation, reason type), or keep it as DanceFlow policy?

**OD-11 DECIDED 2026-11-23 (owner): Option A, judge-confirmed ballot corrections.** (1) Any alteration to a judge's actual marks requires authenticated confirmation from the original adjudicator, linked to the precise replacement ballot version. (2) A scorer or manager may propose a correction but cannot independently replace a judge's marks. (3) The Chairman may review, refer and authorize the workflow per applicable rules but cannot substitute their confirmation for the judge's own approval. (4) If the judge is unavailable, hold the alteration pending authorized resolution; no emergency override, no silent substitution. (5) Distinguish reasons: transcription error against original evidence; judge-confirmed marking/entry correction; scoring/tabulation/evaluation error handled through OD-07 without changing the original ballot. (6) Preserve original ballots, replacement versions, reasons, identities, timestamps and confirmations as immutable evidence. (7) Independent review and role authorization for every replacement; no self-approval or bypass of OD-05/06. (8) Baseline safeguards apply to all Competition OS events, with NDCA requirements identified separately from DanceFlow policy. (9) Respect OD-10 confidentiality. (10) Design-level draft PR first with exact SQL dependencies, role mappings and negative-test requirements; coordinate with OD-07 and OD-12. Not authorized: SQL apply, merge, deployment, activation.

### OD-12 Paper-ballot transcription and retention

- **Issue.** Paper ballots are entered by one scorer with no second-person check; no prompt to retain the originals.
- **Sources.** WSDC 3.4.9.b.i (p.20): transfer of paper score sheets must be audited by the chief judge or an approved scoring team, verified by a person other than the one inputting. NDCA III.D.12 (p.21): each adjudicator marks and signs a card per heat; III.D.16: originals handled only by chairman and scrutineer; IV.C.5-6 (p.27): chairman verifies transcription; III.E item 2: retain originals 30 days.
- **Today.** E2 `enter_competition_paper_ballot` (L1009), `_compe2_insert_ballot` (source `scorer_paper`). Rows J-32W (inconsistent); J-32N, X-19 (RI).
- **Options.** (a) A "verified by" second person for paper entries before lock and a report of unverified rows at approval; plus a "paper originals retained until <date>" checklist. (b) Treat the scorer entry as the scrutineer's transcription (as is) and document it.
- **Recommendation (engineering, NOT approved).** (a). It is small and independent of any body being supported.
- **Blast radius.** Dark. New column + lock check: owner-gated PROD SQL apply.
- **Decision.** Require a second-person verification of paper ballots?

**OD-12 DECIDED 2026-11-23 (owner): Option A, mandatory independent verification of paper-ballot transcription for ALL Competition OS events.** (1) Every paper ballot entered must be verified by a different authorized individual against the original paper markings before it can contribute to finalized or published results; (2) WSDC: verification by the Chief Judge or an appropriately approved scoring-team member (WSDC 3.4.9.b.i); (3) NDCA: preserve the Chairman's responsibility for transcription accuracy after each heat and restricted access to original marking sheets; a generic scorer or manager is not assumed to qualify; (4) Studio/Custom and events where rules are silent: independent verification as DanceFlow policy; (5) block finalization while paper entries remain unverified, reporting precisely which entries need attention without exposing confidential ballot information; (6) record transcriber, verifier, verification time, source ballot version, discrepancies/corrections; (7) alteration of actual marks uses OD-11's judge-confirmed process, preserving original evidence; (8) organizer-facing retention checklist for original paper ballots, identifying the NDCA 30-day minimum, never claiming DanceFlow physically retains paper or auto-deletes evidence; (9) preserve OD-10 confidentiality and event-level designations, no generic manager access by default; (10) keep directly authenticated digital judge submissions separate from paper transcription verification. Authorized: design-level draft PR coordinated with OD-10 and OD-11, with exact SQL and role dependencies, negative-test requirements and independent security/rulebook review before implementation. Not authorized: SQL apply, merge, deployment, activation.

### OD-13 Ordinal-majority tie chain and ballot rules

- **Issue.** The Studio ordinal method stops the tie-break after two steps and shares the place; UCWDC Rules #6-#8 would keep separating (example: fixture F-OM-09 shares first place where UCWDC Rule #6 would rank entry 12 first).
- **Sources.** UCWDC-SF Rule #3.4-#3.5 (p.3) majority mark; Rules #4-#8 (pp.3-5): majority size, majority sum, look-ahead (#6), look-behind (#7), head-to-head (#8); Rule #3.2 (p.3): in ProAm/ProPro judges may tie contestants. Rule #1.1 (p.1) and #2.3 (p.2): finals may be two heats. NDCA and WSDC: NOT SPECIFIED IN PROVIDED SOURCE (algorithms undefined).
- **Today.** `studioOrdinalMajority.ts`; PV1 `_comppv1_ordinal` (L330); D-OM-1..3 (approved 2026-10-24: "adopted as DanceFlow Studio rules, no compliance claim"); `ordinal_rank@1` ballot. Rows S-08, S-11P, S-13 (inconsistent); S-06, S-10, S-11X (RI).
- **Options.** (a) Keep as a labelled Studio rule and rely on OD-01 so no body event uses it. (b) Build a separate UCWDC engine from the supplied worked examples (never edit `@1`).
- **Recommendation (engineering, NOT approved).** (a). Do not call the method any body's rule; revisit (b) only as part of OD-24.
- **Blast radius.** Dark. (b) is a new engine and a new SQL recompute path: owner-gated PROD SQL apply.
- **Decision.** Keep the Studio tie chain as labelled DanceFlow policy?

**OD-13 DECIDED 2026-11-23 (owner): Option A, preserve DanceFlow Studio scoring.** The existing Studio ordinal-majority tie chain is retained as DanceFlow policy, not UCWDC, NDCA or WSDC compliance. `ordinal_rank@1` and historical scoring behavior are preserved. Differences from UCWDC Scoring Format v16.9b (Rules #6-#8, shared placements) are documented. Studio scoring is to be clearly labelled in the wizard, results displays, previews and exports without implying body certification or compliance. OD-01 approval/publication restrictions for body-declared events using unverified Studio scoring are preserved. UCWDC's additional tiebreaking requirements are recorded NOT IMPLEMENTED and a blocker for future UCWDC profile activation. Any future UCWDC engine must be independently verified, separately versioned and evaluated under OD-24; the Studio engine is not modified to achieve it. Authorized now: only the docs-only rule-register and scoring-disclosure changes. Not authorized: scoring-engine implementation, SQL apply, merge, deployment, activation.

### OD-14 Over-capacity callback ties

- **Issue.** A tie at the cut that would exceed the Final's capacity blocks approval; the bodies either advance every tied couple or conflict.
- **Sources.** UCWDC-SF Rule #1.4 (p.2): ties at the cut are promoted, no capacity limit stated. NDCA IV.C.1.f (p.27): extra couples may dance in case of a tie, but IV.C.2 (p.27) caps a final at eight: the two clauses conflict. WSDC Section 5 (p.23): chief judge's raw scores break a callback tie; no "advance all tied" rule.
- **Today.** `studioCallbackTally.ts` (`blocked_tie_over_capacity`), `cf1_guard_advancement_approval` (L981, `COMP_ADVANCEMENT_BLOCKED`), `competition_round_advancement_preview`; D-CT-4 and OD-1 option D (owner 2026-10-30). Row S-21 (RI). CFD §0.2 itself records UCWDC as silent on over-capacity.
- **Options.** (a) Keep the block for Studio events and state in the body disclosure that DanceFlow blocks rather than promotes. (b) Add a manager pick or runoff. (c) Auto-advance all tied couples for UCWDC.
- **Recommendation (engineering, NOT approved).** (a). It is your approved policy and the sources conflict, so no change is justified without a body in scope.
- **Blast radius.** Dark; none for (a).
- **Decision.** Is the block still acceptable when a declared body says ties advance?

**OD-14 DECIDED 2026-11-23 (owner): Option A, preserve the Studio over-capacity tie block.** `blocked_tie_over_capacity` and the existing advancement-approval guard are preserved for Studio/Custom. No arbitrary manager selection, runoff procedure or automatic advancement of all tied competitors. Recorded as DanceFlow Studio policy, not UCWDC, NDCA or WSDC compliance. The outdated CFD statement that UCWDC is silent on over-capacity ties is corrected: UCWDC Scoring Format Prelim Rule #4 addresses advancement plus ties. UCWDC advance-plus-ties is NOT IMPLEMENTED for a future UCWDC profile. The NDCA IV.C.1.f versus IV.C.2 conflict stays unresolved with no invented exception or unverified Final-cap enforcement. WSDC tie resolution is recorded separately, pending confirmation against the pinned rulebook. OD-01 restrictions preserved. Documentation coordinated with OD-09, OD-13, OD-24. Authorized: docs-only rule-register, compliance-gap and Studio-scoring disclosure-spec updates. Not authorized: UI, export, scoring-engine or SQL changes, merge, DEV/PROD SQL apply, deployment, activation.

### OD-15 Qualifications, certification, membership and role mapping of officials

- **Issue.** A judge or scorer needs only an active studio/organizer team membership and a verified email; no roster, membership, certification or license field, and no UCWDC Contest Coordinator or NDCA scrutineer concept.
- **Sources.** NDCA III.B.4 (p.16) chairman must be a US resident on the roster with full membership; for Championships a Scrutineering Certificate; levels CH1-CH3; III.B.3 (p.16) roster and certification per category; IV.A.6 (p.25) license, Associate or higher, Full Member or Fellow for Championships; III.D.5 (p.20) no one may officiate unless registered; III.B.1.e (p.14) NDCA-certified Scrutineer; III.B.2 (p.15) exam at 100%, levels S1-S3; III.B.1.f (p.15) back-up scrutineer. UCWDC-C II.B.1.b (p.3) current Associate Membership mandatory for every judge, contest coordinator, scrutineer and scoring director; I.A.4 (p.1) certified pool; UCWDC-SF p.1 and General Information (p.8): "verified" Scoring Directors/Scrutineers using an "authorized" system. WSDC Definitions (p.3): chief judge experience, may not compete; Section 7 (p.24): judge certification launches 2027-01-01, 30-50% guidelines "anticipated".
- **Today.** E1 `add_competition_official` (team member + `verified_email_for_user`), `set_competition_chair`; OJ1 `_comp_e1_is_team_member`; F2 `calculate_competition_round`. Rows J-04N/W, J-05N/U, J-06N/U (inconsistent); J-01, J-02U, J-05W, O-05 (RI); O-06 (unsupported); RP-11, X-10 (membership, registration verification).
- **Options.** (a) Optional credential fields (body, level, roster id, expiry) with a readiness warning per declared body. (b) Organizer attestation that officials are qualified. (c) No change; body events are unsupported (OD-01).
- **Recommendation (engineering, NOT approved).** (b) now, (a) when a body profile exists. UCWDC tiers are not buildable until the Judge Certification Code of Conduct (not provided) is supplied. Whether to ask UCWDC for it is an owner contact-policy decision, not mine.
- **Blast radius.** Dark. (a) needs new columns: owner-gated PROD SQL apply.
- **Decision.** Record credentials, or attestation only, and who verifies them?

**OD-15 DECIDED 2026-11-23 (owner): Option B now, Option A for future governing-body profiles.** Organizer attestation for the initial Studio/Custom release, with future role-specific credential recording and verification. (1) The event organizer or an explicitly designated authorized administrator is accountable for attesting officials' qualifications; record actor, event, official, assigned role, timestamp and the applicable declaration. (2) Never represent organizer attestations, free-text credentials or unverified documents as independent governing-body certification. (3) For future NDCA, UCWDC and WSDC scoring profiles design role-specific credential records, verification status, evidence references, expiration and applicable rulebook version. (4) Keep body roles distinct: NDCA Chairman/Scrutineer, UCWDC Contest Coordinator and WSDC Chief Judge are not generic manager or scorer permissions. (5) Require applicable credentials and verified role eligibility before restricted body judging/scoring operations become available; attestation alone never overrides mandatory requirements. (6) Keep Studio/Custom setup practical, with no unsupported professional-certification obligations. (7) Coordinate with OD-05, OD-06 and OD-16 in the existing #834 design workstream; no overlapping migrations. (8) Track WSDC's future certification changes as unverified until effective rules are confirmed; record missing UCWDC certification sources without contacting directors or outside parties. (9) Preserve OD-01 restrictions and all release gates. Authorized: documentation and coordinated design only. Not authorized: credential SQL, merge, applying migrations, deployment, activation.

### OD-16 Panel size, chair requirement, non-voting chair

- **Issue.** A chair is optional; the odd, at least three judge minimum is a DanceFlow default and is below the bodies' minimums; the chair counts as a voting judge.
- **Sources.** NDCA III.B.1.a,c,d (p.14): 3 minimum for non-championship (5 if the professional first prize is $1,000 or more), 5 for open multi-dance Pro/Am Championships, 7 for Professional and Adult Amateur Championships; XII.N.1 formation at least 3; III.B.1.b (p.14): at least one qualified Chairman at every sanctioned event; III.B.4 (p.16): the chairman should, if possible, be non-voting. WSDC 3.4.7 (p.20): preliminaries at least 4 judges per role plus chief judge; finals at least 5 plus chief judge, odd, 7 for Tier 5-6 finals; 3.4.7.c (p.20): the chief judge joins the general panel only if there is an unforeseen shortage; 3.4.4 (p.19) chief judge reviews finalists; Definitions (p.3). UCWDC-SF Rule #3.4 (p.3): the majority mark is defined for an odd panel; an even panel is allowed for contingency or emergency purposes, with no minimum count stated (J-21U).
- **Today.** E1 `competition_round_panel_status` (min panel default 1, `min_panel_judges` configurable, chair counts if lettered); E2 `lock_competition_round_ballots`; engines apply "X-3" odd ≥ 3 and fail closed otherwise. Rows J-02N/W, J-03W, J-21N/W (inconsistent); J-03N (RI); J-20, J-21X, J-21U (unsupported/policy).
- **Options.** (a) For declared bodies, a division-class → minimum table, chair as a ready/publish blocker, optional non-voting chair per round, and a recorded shortage reason before a chair counts toward WSDC's minimum. (b) Keep the DanceFlow minimums and label them policy.
- **Recommendation (engineering, NOT approved).** (b) now (via OD-01), (a) with any body profile.
- **Blast radius.** Dark; (a) is SQL/engine: owner-gated PROD SQL apply.
- **Decision.** Are sanctioned-event panel minimums enforced (block), advisory (warn), or out of scope?

**OD-16 DECIDED 2026-11-23 (owner): Option B now, Option A for future governing-body profiles.** The current DanceFlow Studio/Custom judging model is preserved for initial activation, subject to resolving its internal panel-minimum inconsistency. For future NDCA, UCWDC and WSDC profiles: mandatory body panel sizes, qualifications, chair requirements and role restrictions are hard blockers; advisory provisions are warnings; role and panel models stay separate per body; NDCA accounts for event classification, prize thresholds, qualified Chairman and judge minimums (non-voting Chairman is advisory); WSDC enforces per-role preliminary counts, final-panel requirements, tier rules, the virtual-judging prohibition and narrowly defined Chief Judge shortage exceptions; UCWDC preserves its odd/even-panel contingency rules without inventing a minimum; designs coordinate with OD-05, OD-06, OD-15 and OD-17. Studio defect to investigate: `min_panel_judges` can be 1 while engines require an odd panel of at least 3; prepare a bounded correction recommendation so invalid configurations cannot appear ready for scoring. Body requirements are recorded NOT IMPLEMENTED and blockers to their profile activations. Authorized: documentation and coordinated design only; no body panel SQL or engine changes. Not authorized: merge, SQL apply, deployment, activation.

### OD-17 Panel appointment, publication and substitution

- **Issue.** Panels can be changed until the round starts, no officials list is published ahead, and a judge cannot be replaced mid-round.
- **Sources.** NDCA III.D.1 (p.19): all panels appointed before the event commences and kept except emergencies; III.B.6 (p.16): list posted at least thirty days before; no changes after approval without NDCA approval; III.B.6 (p.16-17): a substitute with the NDCA Observer's approval and announcement, else remaining officials act and a written explanation in ten days (the inventory notes the rule book cross-references III.B.5); IV.C.8 (p.27): the chairman may excuse an adjudicator whose judgment may be impaired.
- **Today.** E1 `assign_competition_panel_member`, `unassign_competition_panel_member`, `guard_competition_panel_assignment` (frozen when the round leaves draft/scheduled); E2 `record_competition_judge_attendance` (reason 1-500, refused once the judge has ballots). Rows J-23, J-25N (inconsistent); J-22, J-14N (RI).
- **Options.** (a) For declared-NDCA: lock assignments before the event start or require an emergency reason; an optional "officials list published" state; an audited substitute path; chair-initiated excuse. (b) Leave as DanceFlow policy.
- **Recommendation (engineering, NOT approved).** (b) now; (a) with a body profile.
- **Blast radius.** Dark; (a) is SQL: owner-gated PROD SQL apply.
- **Decision.** Is audited mid-round substitution wanted, and is advance publication of the officials list required?

**OD-17 DECIDED 2026-11-23 (owner): Option B now; Option A required for a future NDCA profile.** Studio/Custom panel appointment and substitution behavior preserved for initial activation. For a future NDCA scoring profile: record the requirement to publish the proposed officials list at least 30 days before the competition (NDCA III.B.6); require documented NDCA authorization for changes after the list is approved; design an audited emergency substitution workflow requiring the applicable NDCA Observer approval, reason, announcement and timestamps; preserve the original judge's ballots and audit evidence with no silent transfer, overwrite or invalidation; support authorized Chairman-initiated excusal under verified NDCA rules (IV.C.8); track the organizer's written-explanation obligation (ten days) when no substitute is available without claiming DanceFlow submits it; distinguish organizer attestations from independently verified body approvals; coordinate with OD-05, OD-06, OD-15, OD-16 in #834; record the mandatory NDCA requirements as NOT IMPLEMENTED and blockers to NDCA profile activation; do not impose NDCA procedures on Studio/Custom, UCWDC or WSDC without separate justification. Authorized: documentation and coordinated design updates only. Not authorized: substitution SQL, workflow activation, merge, DEV/PROD SQL apply, deployment, activation.

### OD-18 Amateur/professional status, proficiency and level eligibility

- **Issue.** Status (amateur, professional, Pro/Am student, Rising Star), proficiency points, skill-level ascension and Points Registry rules are not evaluated; an entrant picks a label.
- **Sources.** NDCA II.A.1.a-d (p4) professional; II.A.2.a(1)(a)-(c) (p4) amateur; II.A.4.a-h (p4-5) Pro/Am Student Competitor; II.A.5.a(1) (p5) Mixed Amateur; II.B.2 (p6) Mixed Professional; X.C.1-11 (p43-44) proficiency points; II.B.7.c(1)-(2), II.B.7.d, II.B.7.e (p7) Newcomer and winner rules; II.A.1.d (p4). UCWDC-PA II.A.1, II.A.17 (p2), II.F.8.a-f (p5); UCWDC-C II.F.9.a-f (p5) and II.F.4.c (p4); UCWDC-PA II.F.4.b-d (p4), II.F.1-8 (p4-5), II.L.3 (p11). WSDC 3.1.6 (p10-11), 3.2.3-3.2.8 (p12-13), Chart 3 (p15), Chart 4 (p16); WSDC 3.2.3-3.2.4, 3.2.6.b (p12-13) and §3.2 item 3: entry limits. NDCA III.D.4 / V.A.2: registration of competitors.
- **Today.** Roster person types are DanceFlow vocabulary (CL-14); `eligibility_status` workflow exists (unverified/eligible/needs_review/ineligible/waived; check-in readiness counts eligible or waived, AE-21); `ROLES allowedRolesForFormat`; `_comp10c_allowed_roles`. Rows CL-01, CL-02, CL-03, CL-07, CL-08, CL-12, CL-13, AE-22, AE-23, AE-24, AE-25, RP-10, RP-11, X-10, X-20 (unsupported GAP).
- **Options.** (a) Organizer verification gate on entries (existing workflow), with registrant wording that the organizer verifies status. (b) Capture body membership/registration IDs. (c) Evaluate rules in software, per body (large build).
- **Recommendation (engineering, NOT approved).** (a) now; (b) only with a body profile; (c) not recommended before the owner scopes bodies.
- **Blast radius.** Dark. (a) is code only if the existing workflow is reused; (b)/(c) need SQL: owner-gated PROD SQL apply.
- **Decision.** Is organizer verification (a) enough for first activation?

**OD-18 DECIDED 2026-11-23 (owner): Option A for initial activation.** Organizer verification of amateur/professional status, proficiency and skill-level eligibility for Studio/Custom. (1) Extend the OD-03 eligibility workflow to record verification of applicable status and level criteria; (2) an authorized organizer or designated official makes the determination with auditable actor, timestamp, criteria and outcome; (3) OD-02 under-18 stays absolute, no waiver bypasses it; (4) a waiver must not override a body's mandatory eligibility requirements, distinguishing legitimate event-policy exceptions from prohibited eligibility overrides; (5) no irrelevant status/proficiency checks for Studio/Custom divisions that do not use those classifications; (6) state that Studio/Custom eligibility is determined by the organizer and never claim DanceFlow verified NDCA registration, UCWDC membership or WSDC Points Registry eligibility; (7) OD-01 restrictions preserved; (8) record future body requirements (NDCA registration/professional-amateur/proficiency; UCWDC membership/status/level ascension; WSDC Points Registry/skill levels); (9) for future profiles design credential capture and verified rule evaluation without inventing provider APIs or claiming authoritative verification without evidence; (10) bounded implementation coordinated with OD-03, stacked on #837, with separate eligibility dimensions and no conflicting gates. Authorized: draft PR preparation, tests and independent review. Not authorized: SQL apply, merge, deployment, activation.

### OD-19 Role structure of "custom" formats

- **Issue.** Formats built as `custom` (Student/Student, Spotlight, Showcase, Showdance, Cabaret, Theatre Arts, routines) accept any two participants with any relationship role, although the profile declares narrower intended roles that are stored but never read.
- **Sources.** NDCA II.A.6.a-b (p5): Student/Student is a Pro/Am Student Competitor partnering another, adults only; II.B.8 (p8): describes Pre-Teen/Junior/Youth Student/Student events (an NDCA internal conflict, recorded as unresolved `ndca_student_student_youth`); NDCA II.B.4(2)-(3) (p6) and XI.A (p46): no role restriction for Showdance/Cabaret/Theatre Arts beyond the couple definition. UCWDC-PA II.A.20 (p3), II.K.4.d (p9), II.K.8 (p10): Spotlight is ProAm/ProPro only; UCWDC-C II.G.2.a-b (p6), UCWDC-PA II.G.2.a-b (p7), E.1.i / E.2.c (p4): Showcase.
- **Today.** `studioCustomV3.ts` `.categoryTypes.ndca_student_student` (entry_format custom) etc.; profile roles copied by `20261115090000_phase10c5_registration_isolation.sql` line 1183 and never read by the quote; `_comp10c_allowed_roles`. Rows CL-09, FD-30, RP-04 (inconsistent); FD-11, FD-29 (RI).
- **Options.** (a) New entry formats with roles (for example `student_student`, a ProAm/ProPro pair for Spotlight), in TypeScript and SQL together (drift guard). (b) Document the limitation and leave custom flexible. (c) Relabel these offerings Studio/Custom and drop the body name.
- **Recommendation (engineering, NOT approved).** (c) now, because it is honest and free; (a) when a body profile is built. Keep failing closed on youth Student/Student until you read II.A.6.b against II.B.8.
- **Blast radius.** Dark; (a) is code plus SQL: owner-gated PROD SQL apply; (c) is code/labels.
- **Decision.** Relabel these as Studio/Custom, or constrain roles per body?

### OD-20 Disqualification, dangerous-movement mark, rule-breach DQ, eligibility disputes

- **Issue.** The product has "Excluded (organizer decision)" and a heat no-show, but no action for a rule-breach disqualification, no "D" dangerous-movement mark, no "compete now, refer after the event" state, and no ruling record.
- **Sources.** NDCA III.D.47: a complaint about eligibility received at/just before an event is not dealt with then; NDCA IX (Dances and Tempi), lifts and dangerous movements items (2)-(3): adjudicators mark "D"; NDCA V.A.5: leave the floor only at end of music or risk disqualification; NDCA V.A.1: enter only eligible categories; V.B.2: be present half an hour before. UC-C II.P.3.a (also UC-PP, UC-L): failing to report or answer the call for a heat is disqualified from that dance category; UC-T II.O.2.a: "scratched (disqualified) from that dance category"; UC-C II.N.2: UCWDC may exclude a competitor at its sole discretion; UC-C II.G.1.c; NDCA IV.C.1 item 7 (chairman's ruling final); WSDC §3.1 item 8 (restarts).
- **Today.** CF1 A5 `20270120094000_competition_cf1_a5_exclusion_action.sql` (`request_round_exclusion`, `cosign_round_exclusion`); NS1 `20270115090000_competition_ns1_heat_no_shows.sql` (no-show excluded, not placed last); `disqualified` exists only as a status read by some guards; no ruling object. Rows W-02, W-05, W-06, O-14 (unsupported); W-01, W-03 (RI policy/UCWDC mapping).
- **Options.** (a) Keep today's actions and enforce the label "Excluded (organizer decision)", never "disqualified". (b) Add a rule-breach disqualification action with reason and co-sign. (c) Add a chair ruling record. (d) Add the NDCA "D" mark (NDCA ballroom adjudication scope).
- **Recommendation (engineering, NOT approved).** (a) now; (b) and (c) only if the owner scopes a body. The labelling rule protects against presenting an organizer action as a governing-body disqualification.
- **Blast radius.** Dark. (a) is wording (code); (b)-(d) are SQL/UI builds: owner-gated PROD SQL apply.
- **Decision.** Confirm organizer exclusion is DanceFlow policy, not "disqualification", and whether any DQ action is in scope for first activation.

### OD-21 Minimum couples, single-couple divisions, replacing a withdrawn finalist

- **Issue.** DanceFlow requires at least two eligible couples for a Final and forbids replacing a withdrawn finalist; NDCA is internally inconsistent on one couple and allows (permissively) the next couple to replace a withdrawn one.
- **Sources.** NDCA III.D.6: at least two couples for a bona fide competition (six for championships); III.D.8: a single entered couple is the de facto winner (the two items conflict); III.D.31: after a round, if a couple withdraws, the chairman may at discretion replace them with the next eligible couple. WSDC §3.1 item 4 (five Leaders and five Followers in finals for points) and §1.2 item 6 (150 entries, two skill levels per Registry Event). UCWDC: NOT SPECIFIED IN PROVIDED SOURCE.
- **Today.** A4/A4a/A0 start guard, A6 `20270120095000_competition_cf1_a6_withdrawal.sql` (OD-15 A: below two → `COMP_ADVANCEMENT_BELOW_MINIMUM`; OD-18 A: no replacement); apply never inserts a heat entry for a withdrawn pair. Rows X-11, W-09 (RI); W-10 (unsupported).
- **Options.** (a) Keep OD-15/OD-18 as DanceFlow policy and record an NDCA source conflict. (b) Allow NDCA backfill (permissive) with chair approval.
- **Recommendation (engineering, NOT approved).** (a). Add the III.D.6 / III.D.8 conflict as a recorded source conflict (registry rule 3).
- **Blast radius.** Dark; (b) is SQL: owner-gated PROD SQL apply.
- **Decision.** May NDCA events backfill a withdrawn finalist, and are single-couple divisions allowed?

### OD-22 Withdrawing or hiding a published result

- **Issue.** A manager can withdraw a published result at any time and a correction hides the stale result from entrants; WSDC requires results open to all competitors for at least 30 days, UCWDC says decisions are final with post-event review.
- **Sources.** WSDC §3.1 item 9 (cited by the inventories as 3.1.9 p.12): results posted at the event and open to all competitors for at least 30 days; inaccurate results must be corrected. NDCA III.D.17 (p.21). UCWDC-C II.N.1 and II.N.3 (p.13); UCWDC-SF Rule #8.1 (p.4): if tied marks differ the scoring was in error and prior rules are recalculated.
- **Today.** F3 `20270122090000_competition_f3_publication.sql` `withdraw_competition_round_result`; `_compf3_live()`; K0 §4 (the superseding wording was already flagged for owner confirmation); INT5-SECFIX P2-2. Rows W-19, W-20, S-26U (RI).
- **Options.** (a) For WSDC-declared events require a "results inaccurate" reason code and re-post a corrected result within the reporting window; show "under review" while retaining the prior result. (b) Keep as is (DanceFlow policy). (c) For UCWDC decide whether post-publication manager corrections are allowed at all.
- **Recommendation (engineering, NOT approved).** (b) now via OD-01; (a) with a WSDC profile.
- **Blast radius.** Dark; (a) is SQL/UI: owner-gated PROD SQL apply.
- **Decision.** Confirm hide-during-correction, and whether post-publication correction is allowed on UCWDC events.

### OD-23 Score reports and default visibility

- **Issue.** Published results show placements only; no scrutineer sheets, DSA report or score report is ever published; default visibility is `entrants`, public by explicit choice.
- **Sources.** NDCA III.D.17 (p.21): digital scrutineer sheets made public after each day for completed events; III.D.16 (p.21) restricts originals meanwhile. UCWDC-SF General Information (p.8): the DSA report available to contestants, adjudicators and coordinators; Rule #3.4 step 1 (p.3): raw-score columns include each judge's name "so revealed". WSDC §3.1 item 9: results, rounds, placements and score reports posted at the event; judges may be listed anonymously.
- **Today.** `src/lib/competition/results/viewer.ts`, `publication.ts`; F3 `publish_competition_round_result`, `competition_my_results`, `competition_round_results_public`; K0 O3, P5, P10, `RESULT_READER_MATRIX`; public results hide judge names and letters. Rows S-27U, S-27N, S-27W, J-34U (inconsistent); O-08 (RI); O-09 (unsupported, "material").
- **Options.** (a) Per-body score-report views with judge identity optional (WSDC), scrutineer sheets (NDCA), DSA-style (UCWDC). (b) Keep placement-only as a labelled Studio decision, tell body-declared organizers they must produce the report themselves.
- **Recommendation (engineering, NOT approved).** (b) now (via OD-01); (a) per body later; default visibility unchanged.
- **Blast radius.** Dark; (a) is code plus SQL views: owner-gated PROD SQL apply.
- **Decision.** Placement-only for Studio events and no score reports until a body is supported?

### OD-24 Which bodies' scoring is in scope, and missing source text

- **Issue.** Only two Studio methods exist; the NDCA Skating System algorithm and the WSDC Relative Placement text are not in the supplied sources; UCWDC Majority Rules is fully defined but not built.
- **Sources.** NDCA III.D.11 (p.21): Skating System required; its algorithm is NOT SPECIFIED IN PROVIDED SOURCE (III.B.2.a exam; III.C.3.b(1)(d)). WSDC 3.4.9 (p.20) requires Relative Placement; 3.4.9.d (p.21) defers the definition to the WSDC website; Section 5 (p.22-23): callback values and chief-judge tie-break; 3.4.7.a (p.20) per role; 3.4.9.c (p.21) unique raw scores. UCWDC-SF Rules #1-#11 (pp.1-8) full algorithm; Rule #2.4 (p.2) retire "plus ties".
- **Today.** `SCORING_REGISTRY`; `ndca_skating@unpinned`, `wsdc_relative_placement@unpinned`, `ucwdc_majority_rules@v16.9b` registered unavailable; `scoringReference.ts` (accurate except one page cite off by one, S-32W; REF wording S-32U2). Rows S-04, S-05, S-10, S-17, S-18N, S-18W, S-20W, S-32U2 (RI/inconsistent); S-03, S-16, S-22, S-28 (unsupported).
- **Options.** (a) Studio only for now (via OD-01). (b) Build UCWDC Majority Rules (source is supplied). (c) Pin the NDCA and WSDC website text first, then build per body.
- **Recommendation (engineering, NOT approved).** (a). If a body is wanted next, UCWDC is the only one with complete supplied text. Do not reconstruct the Skating System or Relative Placement from memory. Obtaining body text from a governing body is an outreach question for you, not me; the WSDC website text is public.
- **Blast radius.** Dark; (b)/(c) are engines + SQL recompute: owner-gated PROD SQL apply.
- **Decision.** Which body (if any) is next, and may I pin the public WSDC website text?

### OD-25 Heat rules per body

- **Issue.** Scoring-heat size is a free default of 8 (up to 100), first-fit rather than balanced, deterministic rather than randomized, with no contiguity check and no move-up after scratches.
- **Sources.** NDCA III.D.34: no more than eight couples judged together in Pro/Am events (up to ten under a stated exception; a split floor may hold eight per panel). UC-SF Heating Rules item 1: randomize each division by the scoring system; item 2: heat sizes differ by no more than one; item 3: a division's heats must run contiguously; item 4: smaller heat first so scratches can re-balance; items 5-7. WSDC: NOT SPECIFIED IN PROVIDED SOURCE.
- **Today.** `floorPlanner.ts` (`DEFAULT_SCORING_HEAT_CAPACITY`, first-fit bucket find, deterministic order), `heatPlanner.ts` (`balancedGroups`, `randomizedEntries`); `20261111090000_phase10d_heats_floor_schedule.sql`; `20270120090000_competition_cf1_callback_final_advancement.sql` (`target_capacity between 1 and 100`); product states the 8 is "a DanceFlow product default, not a sanctioning rule". Rows X-01, X-03, X-05 (inconsistent); X-06 (RI); X-04 (unsupported).
- **Options.** (a) Per-body profile rules (NDCA ceiling, UCWDC seeded recorded random order, balance, contiguity). (b) Keep the product default and mark everything policy.
- **Recommendation (engineering, NOT approved).** (b) now; (a) with a body profile. Note that randomization is a fairness control; a seeded, recorded order is cheap if you want it earlier.
- **Blast radius.** Dark; code (planner); NDCA ceiling guard is SQL if enforced in the database.
- **Decision.** Are per-body heat rules required, or is the DanceFlow default acceptable?

### OD-26 Mid-event running order and timetable limits

- **Issue.** The running order is frozen once any heat has run; the chair cannot alter the timetable, and nothing checks lateness or cut-off times.
- **Sources.** NDCA IV.C.3: the Chairman observes or alters the timetable; III.D.1 (p.19): within 30 minutes of schedule, last final before 1:00 a.m.; UC-SF Heating Rules item 4 (move up after scratches); UC-C II.P.1-P.3 report to the Floor Coordinator 30 minutes before.
- **Today.** `20270106090000_competition_o1_day_of.sql` (`_compo1_guard_publish_during_run`, `_compo1_guard_heat_status`, `COMPO1_RUN_IN_PROGRESS`); O1 open owner decision 3 (mid-event edits, unresolved). Rows O-04 (inconsistent); X-08, X-09, X-04 (unsupported).
- **Options.** (a) Controlled audited reorder with reason. (b) Leave frozen and treat timetable as organizer duty.
- **Recommendation (engineering, NOT approved).** (a); it also resolves an already-open O1 decision.
- **Blast radius.** Dark; SQL guard change: owner-gated PROD SQL apply.
- **Decision.** Allow audited mid-event running-order changes?

### OD-27 UCWDC gender and Mixed-Role structure

- **Issue.** UCWDC divisions also depend on gender/Mixed-Role and on role-keeping through a dance category; DanceFlow has no gender field and accepts any lead/follow combination.
- **Sources.** UCWDC-PA II.A.7 (p2), II.A.12 (p2), II.C.1-2 (p3); UCWDC-C II.A.7 (p2), II.A.12 (p2), II.C.1-2 (p3); NDCA II.A.7.a(1) (p5): partners may not switch roles during an event ("event" undefined); NDCA II.B.7.c (p7) gender splits; II.A.7.a defines a couple without regard to sex or gender.
- **Today.** `studioCustomV3.ts` `.divisionSchemes.country_*` (axes skill_level, age_group only); ROLES `participantShapeErrors`; `event_competition_entry_participants.dance_role`; no gender column. Rows FD-27, RP-06 (inconsistent); RP-07 (RI); FD-20 (unsupported).
- **Options.** (a) Add a Mixed-Role axis (and optionally gender) with per-dance-category role lock. (b) State in the organizer UI that UCWDC gender/Mixed-Role is not enforced.
- **Recommendation (engineering, NOT approved).** (b) now. Collecting gender is a privacy decision (shared with OD-02) and should be made once.
- **Blast radius.** Dark; (a) needs a column/migration: owner-gated PROD SQL apply.
- **Decision.** Collect gender and model Mixed-Role, or declare the limitation?

### OD-28 Team structure

- **Issue.** Team entries accept 2-100 members with no couple structure; NDCA Formation and UCWDC Team divisions have their own sizes, couples and once-only rules.
- **Sources.** NDCA XII.D (p49): formation teams of four to eight couples, "one boy and one girl", conflicting with II.A.7.a (p5) (recorded NDCA conflict, CL-11); XII.C (p48): age/school grade categories, substitutes (XII.C.7), once per style (XII.C.6); I.G.1.e (p3): Team Match; UCWDC-T II.E (p3): Teams divisions are for 3 or more members; II.F.1.a (p3) once per division; II.G.1.c, II.G.1.d (p3); II.C.2 (p3); UCWDC-T II.D.1 (p3) no age rules; NDCA III.D.10 (p21).
- **Today.** `studioCustomV3.ts` `.categoryTypes.ndca_formation / ndca_team_match / team / studio_team` (min 2, max 100); `_comp10c_quote` team name check. Rows FD-18, FD-32, RP-03 (inconsistent); CL-11 (RI); RP-13, RP-14, RP-15 (unsupported); J-15N depends.
- **Options.** (a) Constrain sizes and structure per offering. (b) Relabel Formation/Team Match/Team as Studio/Custom team offerings.
- **Recommendation (engineering, NOT approved).** (b) now; revisit (a) when a body profile is built. Formation is also outside the Studio scoring engines.
- **Blast radius.** Dark; (b) is labels; (a) is code plus SQL: owner-gated PROD SQL apply.
- **Decision.** Relabel team offerings as Studio/Custom?

### OD-29 Personal devices and remote judging

- **Issue.** The judge ballot is a web page on the judge's own device; NDCA forbids unauthorized devices; WSDC forbids virtual judging; the software cannot tell remote from on-site.
- **Sources.** NDCA IV.B.9 (p.26) and IV.D.1.a(3) (p.28): no mobile phones or other unauthorized electronic devices while judging (invigilators excepted); IV.A.12: no device transmitting video or images of judging. WSDC 3.4.7.d (p.20): virtual judging is not permitted.
- **Today.** E2 judge ballot pages; `judgingAccess.ts` (K0 P8). Rows J-35N, J-35W (RI).
- **Options.** (a) Organizer-attested "authorized judging devices" statement for body-declared events; document that remote judging is out of policy. (b) Do nothing.
- **Recommendation (engineering, NOT approved).** (a). It is an organizer-authorization question, not a software defect (judging finding F7).
- **Blast radius.** Dark; wording/attestation: code, no SQL.
- **Decision.** Add the attestation?

### OD-30 Rulebook edition, effective date and age reference

- **Issue.** A profile pins documents but there is no event-level effective date, edition switch, or per-body age reference rule.
- **Sources.** Editions only (NDCA June 2026; UCWDC v1-26-2026; Scoring Format "2026-2028 Rules"; WSDC 2026.1C; WSDC 2027 draft "not current"). Age basis: NDCA X.A.1, X.A.6 (p42-43); UCWDC-PA/C II.D.1 (p3); WSDC Definitions (p3). Effective-date handling: NOT SPECIFIED IN PROVIDED SOURCE.
- **Today.** `governing-body-source-registry.md`; profile tables `20261108090000_phase10b_competition_profiles.sql` (pinned, immutable); `studio_simple@3`. Rows X-23, AE-17 (RI); FD-39 (RI: organizer-defined divisions, NDCA III.C.3 p17, X.A.2-3 p42).
- **Options.** (a) Add edition and effective date to each profile row and show it on the event; per-body `age_basis` before any age check. (b) Record only.
- **Recommendation (engineering, NOT approved).** (a). This is governance prerequisite work for OD-03.
- **Blast radius.** Dark; profile table columns: owner-gated PROD SQL apply.
- **Decision.** Who approves moving an event to a new edition?

### OD-31 Audit baseline: U18 / U18-S guards

- **Issue.** The status guards that stop clients writing `danced`/`disqualified` or scratching without the audited workflow are not on this branch, and no in-app scratch workflow exists here.
- **Sources.** None: integrity guard, no rulebook basis (NOT SPECIFIED IN PROVIDED SOURCE). **"U18" here is a QA gate id, not an under-18 rule** (under-18 is OD-02).
- **Today.** `cf1_u18_guard_heat_entry_status`, `cf1_u18s_guard_heat_entry_scratch` exist only on other lines (`baa01ce40`, `c8b9a979d`, in `origin/release/competition-cf1-app-candidate`); `change_competition_entry_lifecycle` (`20260620_competition_generation_operations_v1.sql`); `dayOf.ts` `scratchHref` links to a page that returns 404 until SC1. Rows W-12, W-11 (RI).
- **Options.** (a) Re-run the affected rows on the release line that carries U18/U18-S before audit sign-off. (b) Declare this line the baseline and treat guards as a release prerequisite.
- **Recommendation (engineering, NOT approved).** (a).
- **Blast radius.** None (process); evidence only.
- **Decision.** Which line is the audit baseline?

### OD-32 Low-risk corrections (batch)

- **Issue.** Small wording and documentation corrections with no behavioral effect: UCWDC Couples "Masters" note omits the 16-and-over partner exception (AE-08); `scoringReference.ts` semi-final wording (S-32U2) and one page cite (S-32W); labelling "Excluded (organizer decision)" (W-01); WSDC bias note needs no action (J-17W); WSDC certification launch tracked as future (J-05W).
- **Sources.** UCWDC-C II.D.3.b (p3); UCWDC-SF Rule #2.4 (p.2); WSDC 3.4.6.a.i (p.19); WSDC Section 7 (p.24).
- **Today.** `studioCustomV3.ts` `.divisionSchemes.country_couples` value masters; `scoringReference.ts`.
- **Options.** Approve as a single documentation/label PR, or defer.
- **Recommendation (engineering, NOT approved).** Approve as one docs/label PR; no SQL.
- **Blast radius.** Code/docs only; none.
- **Decision.** Approve the batch?

---

## 4. Rows classified unsupported: summary and DanceFlow-policy ratifications

82 rows are `unsupported`. They do **not** need row-by-row decisions. By theme:

| Theme | Rows (examples) | Treatment |
|---|---|---|
| Material GAPs promoted to decisions above | X-12, RP-12, O-07, O-09, W-02, W-05, W-06, X-10, RP-11, AE-22..25, CL-01..03, CL-07, CL-08, CL-12, CL-13 | OD-02, 03, 05, 15, 18, 20, 23 |
| Body-specific features not modelled (a body must be built first) | AE-12..AE-15, AE-18, RP-10, RP-13..16, FD-19, FD-34, FD-36, J-10..J-18X (subset), S-03, S-16, S-22, S-28 | Latent while FD-01 holds (Studio only); recorded for the build of any body profile (OD-01, OD-24) |
| Organizer operational duties not modelled | O-12, X-24 late-entry fee; X-07 venue; X-08 timetable limits; X-09 report times; X-13 code of conduct; X-14 meetings; X-15 reporting to bodies; X-20 entry caps; X-21 music; X-22 costume | Ratify R-14: organizers, not the software, carry these duties; DanceFlow does not claim to enforce them |
| DanceFlow vocabulary and defaults (rulebook silent or n/a) | CL-14, CL-15, FD-01, FD-17, FD-26, FD-31, FD-37, FD-38, FD-40, AE-26, RP-17, RP-18, J-07, J-20, J-21X, S-02, S-07, S-15, S-19, S-23, S-24 | Ratify below |

Rulebook silence is recorded as **NOT SPECIFIED IN PROVIDED SOURCE** and is never presented as a governing-body rule (RULEBOOK_GOVERNANCE.md, "When the rulebook is silent"). Please ratify the following **as DanceFlow policy / organizer policy** in one pass (R-01 to R-16). Any "no" turns that line into an open item.

1. **R-01** The only selectable profile is Studio/Custom (`studio_simple@3`) with no sanction claim; body names are visible but not selectable. (FD-01)
2. **R-02** Studio/Custom partnership formats and "Other / Studio-defined" styles carry no governing-body claim. (CL-15, FD-38)
3. **R-03** One open Studio division for Mixed Amateur, Mixed Professional, Showdance, Cabaret, Theatre Arts, Pro/Am Theatrical, Pro/Am Exhibition, Formation, Team Match; Studio levels and age groups (Youth, Adult, Senior) have no thresholds. (FD-10, FD-13, FD-17, FD-26, FD-37, AE-26)
4. **R-04** Roster person types and entry relationship roles are DanceFlow vocabulary; "instructor" and "alternate" have no body definition. (CL-14)
5. **R-05** Multi-Dance is a prescribed set of two or more dances in the style's listed order; no 9/10-dance events; country "Solo routine (Studio)" is not UCWDC. (FD-07, FD-31)
6. **R-06** Draft setup limits (4 programs, 60 categories, 80 divisions per format, 300 per draft, 20 dances per category, 60 per program, 200-character names) are engineering limits. (FD-40)
7. **R-07** Only two scoring methods are selectable; legacy scoring keys fail closed; ballot format `ordinal_rank@1`; multi-dance gives one result per dance with no combined result. (S-02, S-07, S-16, S-28)
8. **R-08** Scratched and no-show entries are excluded from calculation and never placed last (subject to OD-08). (S-15, W-03)
9. **R-09** The callback target T is set by the organizer; one callback round then a Final; not-called-back entries get no placement and the label "Semi-final"; the database recomputes every result in SQL (PV-1). (S-19, S-22, S-23, S-24, W-16)
10. **R-10** Panel readiness default is at least `min_panel_judges`; ballot lock needs an odd panel of at least 3; an outside guest judge must first be a team member. (J-20, J-21X, J-07)
11. **R-11** Approval needs a second manager or an audited override reason; no override exists for the minimum-two-couples rule, withdrawal window, exclusion co-sign separation or approval of a stale result. (W-15, O-13)
12. **R-12** Organizer exclusion, correction recovery, refund-driven withdrawal, reopen of ballots, cancel a round, publication blocked by a refund exception: all DanceFlow policy. (W-01, W-07, W-08, W-18, W-21, W-23, O-02)
13. **R-13** Refund authority and policy (owner/admin only; per-entry cap is net paid; fee lines separate), desk balance after refunds, event-detail edit rights, organizer-configured entry fees and early-bird. (O-10, O-11, O-17, O-12)
14. **R-14** Organizer operational duties (venue, timetable limits, report times, code of conduct, meetings, body reporting, entry caps, music, costume, late-entry fee, registration cut-off) are not enforced and not claimed. (X-07..X-09, X-13..X-15, X-20..X-22, X-24)
15. **R-15** Registration identity and payment mechanics, one competitor row per professional across Pro/Am entries with no student limit, and the eligibility workflow statuses are DanceFlow design. (RP-17, RP-18, AE-21)
16. **R-16** Default publication visibility is `entrants`, public by explicit choice (subject to OD-23). (O-08)

## 5. Cross-cutting findings needing engineering follow-up regardless

These need follow-up whatever you decide above (they are defects or missing controls, not policy choices). I have not changed anything.

| # | Finding | Citations | Decision |
|---|---|---|---|
| X1 | **No conflict-of-interest or recusal mechanism.** Officials are linked to the event by user account, entries to competitors, and nothing relates the two. | NDCA IV.A.1, IV.A.2, IV.A.8, III.D.21 (pp.25, 22); WSDC 3.4.2, 3.4.6 (pp.18-19); UCWDC-C II.F.6.e (p.5) | OD-05 |
| X2 | **An owner/manager can be both judge and approver.** | WSDC 3.4.1, 3.4.3 (pp.18-19) | OD-06 |
| X3 | **Panel minimums below the bodies' minimums** (3 odd versus NDCA 5 or 7 and WSDC 5 odd for finals; E1 panel "ready" defaults to 1). | NDCA III.B.1.a,c,d (p.14); WSDC 3.4.7 (p.20) | OD-16 |
| X4 | **No judge or scrutineer qualification model.** | NDCA III.B.1.e, III.B.2, III.B.3, III.B.4, IV.A.6; UCWDC-C II.B.1.b (p.3); UCWDC-SF p.1, p.8 | OD-15 |
| X5 | **Managers and scorers read ballots before publication.** | NDCA III.D.16 (p.21) | OD-10 |
| X6 | **Paper-ballot transcription has no independent check.** | WSDC 3.4.9.b.i (p.20); NDCA IV.C.5-6 (p.27) | OD-12 |
| X7 | **Web ballot on personal devices.** | NDCA IV.B.9 (p.26), IV.D.1.a(3) (p.28); WSDC 3.4.7.d (p.20) | OD-29 |
| X8 | **Event deletion not blocked once ballots exist** (contract claims it is). | NDCA III.E item 2 | OD-04 |
| X9 | **The NDCA rule book is internally inconsistent** on "immediate family" (IV.A.1 versus IV.D.1.a(2)), on one-couple divisions (III.D.6 versus III.D.8), on formation couples (XII.D versus II.A.7.a), on youth Student/Student (II.A.6.b versus II.B.8) and on final size with ties (IV.C.1.f versus IV.C.2). Each should be recorded as a source conflict (registry rule 3) before any NDCA profile. | as listed | OD-05, 19, 21, 14, 28 |
| X10 | **Missing source text**: NDCA Skating System algorithm, WSDC Relative Placement definition (website), UCWDC Judge Certification Code of Conduct. | NDCA III.D.11; WSDC 3.4.9.d; UCWDC-C II.N.3 | OD-24, OD-15 |

**PR #783 (judging design brief) is NOT approved.** Its recommendations may be re-opened only after this decision list is answered. The findings above on which they depend: X1 (conflict mechanism) and X2 (role separation) are the evidence base for any conflict-of-interest recommendation; X3 (panel minimums) for panel-size recommendations; X4 (qualifications) for eligibility-to-judge recommendations; X5, X6 and X7 for ballot-visibility, paper-ballot and device recommendations; OD-01 for whether any of them bind DanceFlow-run events at all. Until then #783 stays "recommendation, not approved" under RULEBOOK_GOVERNANCE.md ("No self-certifying decisions").

## 6. Verification and caveats

- Recount: parsed all nine tables (section 1). Citations in section 3 were copied from the inventories after confirming each against the inventory's own source table (document, edition, SHA prefix). An independent subagent that did not see these conclusions spot-checked 15 citations against the inventory source tables and the cited PDFs (SHA-256 verified against the registry before use) and 10 "Today" references against the code. Its results are recorded in the PR description and in section 7 below.
- This file proposes nothing as approved. No PROD, SQL, Stripe, deployment or outsider contact was made or implied; contact with any governing body or organizer remains the owner's call (see OD-15, OD-24).
- The inventories are unmerged and may change; the decision ids here map to inventory row ids so a later change can be traced.

## 7. Independent verification results

An independent subagent (which did not see these conclusions) verified PDF SHA-256 against the registry (NDCA, UCWDC-SF, UCWDC-C, UCWDC-PA, WSDC all matched) and checked 18 citations across NDCA, WSDC and UCWDC and 14 code references. All code references were confirmed; 16 of 18 citations were confirmed. Findings fixed here: NDCA III.D.16 and III.D.17 are on printed p.21, not p.22 (corrected in OD-10, OD-23, X5); the callback-target error string lives in the A4a migration (OD-09 wording corrected). **Errata for the inventory PR author (#790, scoring file):** row S-27N cites III.D.17 as p.22; it is p.21. Judging J-31N cites III.D.16 as p.22; it is p.21. The reference to a missing event-delete guard (X-18 / OD-04) was additionally confirmed in this consolidation by a migration search, not by the subagent.
