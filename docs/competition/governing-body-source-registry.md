# Governing-body source registry

> **Permanent governance:** all rule-dependent Competition OS decisions are governed by
> [RULEBOOK_GOVERNANCE.md](RULEBOOK_GOVERNANCE.md); rules are traced in the
> [rule register](governance/rule-register/README.md). Every register entry must cite a SHA-256 listed below.

Every governing-body fact in a Competition OS rules profile must cite a document listed here. The source
files are kept outside the repository (they are the governing bodies' publications). Their SHA-256 values
pin exactly which edition was read, so a later edition is a deliberate, reviewed change.

Status values:

- **authoritative** — the current edition used for source-grounded metadata.
- **reference** — an explanatory or secondary document; never sufficient on its own for a rule.
- **not current** — must not be used as current behavior.

| Body | Document | Edition / version | File | SHA-256 | Status |
|---|---|---|---|---|---|
| UCWDC | Scoring Format | 2026 v16.9b | `2026-Scoring-Format-v16.9b-1.pdf` | `44290a06d14c308087039bce8d57258629ae103734cce08eb21f41bdb667b02f` | authoritative |
| UCWDC | Rules, Contest Procedures and Scoring Format — Couples | 2026 (v1-26-2026) | `2026-UCWDC-Rules_Couples_v1-26-2026-1.pdf` | `8a45ee58d189e65dbda142a261dd311a3404138bcf75b7a533be7b0ef8974904` | authoritative |
| UCWDC | Rules, Contest Procedures and Scoring Format — ProPro/ProAm | 2026 (v1-26-2026) | `2026-UCWDC-Rules_ProPro-ProAm_v1-26-2026.pdf` | `d6257b65915151ab8aa50a952b60166cf5abfe6ef70cf8be292f9044e704db84` | authoritative |
| UCWDC | Rules, Contest Procedures and Scoring Format — Line Dance | 2026 (v1-26-2026) | `2026-UCWDC-Rules_Line-Dance_V_1-26-2026-1.pdf` | `98e9001113108eaf9b72e4c8c530a2a3fe7d53edc4dcb12118f67dc068b97fb7` | authoritative |
| UCWDC | Rules, Contest Procedures and Scoring Format — Teams | 2026 (v1-26-2026) | `2026-UCWDC-Rules_Teams_V_1-26-2026-1.pdf` | `7e71fdce55b0eade037c9c6df2a041a3f8a8390b4fc6274a0552e09d25cdb41a` | authoritative |
| WSDC | Registry Event Rules | Version 2026.1C (page footers; the file name says 2026.1B) | `Revised-WSDC-Registry-Event-Rules-Updated-Jan172026-V2026.1B.pdf` | `140caae75a8dd3378268e3d353fedf44911c1c2adb981fa4e81650f4e856d3b5` | authoritative |
| WSDC | Registry Event Rules — 2027 draft | 2027 draft | `2027-Draft-WSDC-Registry-Event-Rules1.pdf` | `c0bd5bdcded5f522369f8706134ef9c6f987118d7e5eb1d1f0c3b68e2f815754` | not current |
| — | Relative Placement explanation (Tigges) | updated 12.20.2021 | `Relative-Placement-12-20-20-Rev-5-1-10-1.pdf` | `573cb005fc4f6ba0335b8fe237cd44eb989306dfbb2bb9f3e24e584400f3bc30` | reference (not WSDC rule text) |
| NDCA | Rule Book (compiled) | June 2026, Master v1 | `2026 June - Compiled Rule Book Master v1 - reduced size.pdf` | `d1b73e1f504d2f84b610fc489695dc2cb68e60c224970b03dd3f9f280cecdaa6` | authoritative |

## Rules profiles built from these sources

A profile version is immutable once a program references it; a correction is published as a new version.

| Profile | Status | Notes |
|---|---|---|
| `studio_simple@1` | released | 10B Studio / Custom profile (schema 1). |
| `studio_simple@2` | superseded, kept | Seeded by `20261113090000`. Referenced by a DEV walkthrough draft, so it is kept unchanged; new setups cannot use it. |
| `studio_simple@3` | current | Seeded by `20261114090000`. Cites the documents above; see [phase10c5-source-to-ui-matrix.md](phase10c5-source-to-ui-matrix.md). |

## Known gaps

- **Undefined algorithms.** The NDCA rule book requires the Skating System but does not define the algorithm, and the WSDC rules refer to their website for Relative Placement. Scoring engines (10F) need authoritative specifications for both.
- **No NASDE source.** None was supplied, so WCS Classic / Showcase routine divisions have no source-grounded metadata.

- **Missing UCWDC Judge Certification Code of Conduct** (website, `www.ucwdc.org/judge-certification`; referenced by UCWDC-C II.N.3, p.13, and the UCWDC-PA/-L/-T equivalents). Not provided. UCWDC has no general judge conflict-of-interest rule in the supplied rules, so any UCWDC conflict behavior is organizer policy until it is supplied. Whether to request it is the owner's decision; nobody has been contacted (OD-05, OD-15).

- **Body panel-size and chair rules are NOT IMPLEMENTED** (OD-16): NDCA III.B.1.a-d, XII.N.1; WSDC 3.4.7; UCWDC states no minimum (Scoring Format Rule #3.4). Each mandatory provision is a blocker to activating that body's profile; advisory ones (NDCA III.B.4 non-voting chair, WSDC five per role in Tier 5-6 preliminaries) are warnings. Register entries `OD16-*`.

- **NDCA officials-list publication, change control and emergency substitution are NOT IMPLEMENTED** (OD-17): III.B.6 (30-day posting, NDCA approval of changes, Observer-approved substitute, ten-day written explanation), III.D.1, IV.C.8, III.C.6. Each is a blocker to activating an NDCA profile. UCWDC and WSDC: rulebook-silent in the supplied text (searched 2026-11-23). Register entries `OD17-*`.

## Source conflicts

Recorded per rule 3 below. Each one that affects eligibility or integrity fails closed until the owner resolves it.

| Body | Sections in conflict | Subject | Effect until resolved | Register entries |
|---|---|---|---|---|
| NDCA | Rule Book IV.A.1 (p.25) versus IV.D.1.a(2) (p.28) | Definition of "immediate family" for the excuse-yourself duty: IV.A.1 enumerates (spouse, children, parent, sibling, grand-parent, grand-child, niece, nephew, in-law, first cousin); IV.D.1.a(2) says "first cousin or above" (open-ended, undefined) | No NDCA family/household definition is implemented or claimed; automatic checks cover accounts only (OD-05) | `OD05-NDCA-0001`, `OD05-NDCA-0002`, `OD05-NDCA-0003` |
| NDCA | Rule Book III.B.4 (p.16) versus III.B.5 (p.16) and III.B.6 (p.16-17) | III.B.4 sends "substitute adjudicator" to III.B.5, which is the World Dance Council non-resident rule; substitution is in III.B.6 | Cross-reference not relied on; no NDCA substitution rule derived from it (OD-17) | `OD17-NDCA-0008` |

## Page-number convention

Citations use the **printed** page number of the document (NDCA and WSDC printed footers; UCWDC Couples "Page N of 17"). Printed and PDF page numbers differ for some files (for example UCWDC Couples II.B.1.b is printed p.3 and PDF page 5). The UCWDC Scoring Format text cited as p.3 is on PDF page 3; its printed page number was not extracted (neighbouring pages carry footers 2 and 4), so confirm visually before relying on the number.

## Rules for using a source

1. Read the rule in the document itself. A summary or extraction can point to a section, but the citation is only valid once the section text has been read.
2. If a source is silent, record `NOT SPECIFIED IN PROVIDED SOURCE`; never fill the gap from general knowledge.
3. If two sections of a source disagree, record a source conflict (`source_conflicts`). A conflict that affects eligibility fails closed: the wizard does not offer the disputed option until the conflict is reviewed.
4. Studio / Custom conveniences and owner operational knowledge are labelled as such and never presented as governing-body rules.
