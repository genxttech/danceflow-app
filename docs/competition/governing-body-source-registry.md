# Governing-body source registry

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

## Known gaps

- **Undefined algorithms.** The NDCA rule book requires the Skating System but does not define the algorithm, and the WSDC rules refer to their website for Relative Placement. Scoring engines (10F) need authoritative specifications for both.
- **No NASDE source.** None was supplied, so WCS Classic / Showcase routine divisions have no source-grounded metadata.

## Rules for using a source

1. Read the rule in the document itself. A summary or extraction can point to a section, but the citation is only valid once the section text has been read.
2. If a source is silent, record `NOT SPECIFIED IN PROVIDED SOURCE`; never fill the gap from general knowledge.
3. If two sections of a source disagree, record a source conflict (`source_conflicts`). A conflict that affects eligibility fails closed: the wizard does not offer the disputed option until the conflict is reviewed.
4. Studio / Custom conveniences and owner operational knowledge are labelled as such and never presented as governing-body rules.
