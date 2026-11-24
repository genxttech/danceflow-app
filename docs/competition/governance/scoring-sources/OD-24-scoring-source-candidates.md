# OD-24: scoring sources, candidate documents and external dependencies

**Status:** docs only, DRAFT. Owner decision OD-24 (2026-11-23): **Option A, Studio/Custom scoring only for initial
activation**, plus authorized read-only retrieval of public WSDC Relative Placement documentation. Nothing here
authorizes or builds a scoring engine, SQL, a migration, a merge, a deployment, outreach or activation.

Governed by [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md) and
[governing-body-source-registry.md](../../governing-body-source-registry.md). Short cited phrases and section
references only; full documents stay outside the repository.

## 1. Three things that are never merged

| Question | Meaning | Established by |
|---|---|---|
| **Algorithm correctness** | Does an engine compute exactly what a specification says? | Verified specification + independent tests |
| **Body rule compliance** | Does a contest follow the body's rules (structure, roles, tie-breaks, records)? | Pinned official rulebook, rule register, independent review |
| **External certification / approval** | Has the body itself approved or authorized a system? | The body's own process (an external decision) |

None of the three implies another. A correct algorithm is not compliance; compliance is not approval. DanceFlow makes
**no** claim of any of the three for any body. The Studio methods remain DanceFlow policy (the OD-01 block, PR 832, is
preserved).

## 2. Retrieval log (public pages, read-only, UTC)

Fetched with `curl` (no browser, no accounts, no forms, nothing submitted, no contact with anyone), each file into its
own empty directory, hashed before opening, text extracted with `pdftotext -layout` from a different directory.
Nothing was executed. Retrieval window **2026-11-24 01:16Z to 01:26Z** (2026-11-23 local).

Pages visited: `https://www.worldsdc.com/` (redirects to `worldsdc.com`), `https://worldsdc.com/rules/`,
`https://worldsdc.com/rules-3/` (redirects to `/rules/`), `https://worldsdc.com/scoring-systems/`,
`https://www.worlddancesport.org/Rule/Official/Education/Judging-Systems` (redirects to `/Rules`),
`https://www.ndca.org/`, `https://www.ndca.org/pages/ndca_rule_book/Default.asp`,
`https://www.ndca.org/pages/log_rule_book_changes/Default.asp`, `https://www.ndca.org/pages/rules/rule_book.asp` (404).
Two web searches (World Dance Council / NDCA Skating System) were run to find public sources; only the URLs below were
then fetched, from the governing bodies' own sites. Third-party results (study guides, Wikipedia, academic papers) were
**not** retrieved or used.

## 3. Candidate sources (UNREVIEWED; not registry rows)

A candidate is **not authoritative**, is not in the registry table, and no register entry or profile may cite it.
"Stated date" is what the document says about itself. HTTP `Last-Modified` is not a document date (the WSDC files all
show 2026-05-17, apparently a site migration).

### 3.1 WSDC (official site: worldsdc.com, Rules & Info page)

The Rules & Info page presents, under "Prelim Scoring": **Announcement** and **Details**; under "Relative Placement":
**Details**, **Scoring Template**, **Scoring Example**. This is the location 3.4.9.d of the pinned rules points to.

| Doc | URL | Retrieved (UTC) | Stated date / version | SHA-256 | Bytes |
|---|---|---|---|---|---|
| Prelim Scoring: Announcement ("Callback Scoring Memorandum") | `https://worldsdc.com/wp-content/uploads/2020/12/Callback-Scoring-Memorandum.pdf` | 2026-11-24 01:19:57 | Memorandum dated December 7, 2019; valuations "effective January 1, 2020" | `5ef9478eeef054d4f435a590ae7895bc6f8d57debe5b50d229215490634b1e6b` | 139,324 |
| Prelim Scoring: Details ("Call-Back Scoring white paper") | `https://worldsdc.com/wp-content/uploads/2023/06/Call-Back-Scoring_white-paper.pdf` | 2026-11-24 01:20:04 | "CALLBACK SCORING UPDATE 12-7-2019" (5 pp.) | `c14a50ccb852e6baaadf85acf4fd261be5bde46d51c568bc139fd7547c39955a` | 98,415 |
| Relative Placement: Details ("Unraveling the Mystery of the Relative Placement Scoring System", J. Tigges) | `https://worldsdc.com/wp-content/uploads/2021/04/Relative-Placement-12-20-20-Rev-5-1-10-1.pdf` | 2026-11-24 01:20:09 | footers read "Updated 12.20.2021" on some pages and 12.20.2020 on others (file name says 12-20-20); 9 pp. | `573cb005fc4f6ba0335b8fe237cd44eb989306dfbb2bb9f3e24e584400f3bc30` | 510,370 |
| Relative Placement: Scoring Template (blank hand-scoring sheet) | linked as `http://www.worldsdc.com/wp-content/uploads/2021/04/Scoring-By-Hand_Template_12-20-20.pdf`; fetched over https at `https://worldsdc.com/` + same path | 2026-11-24 01:20:12 | Sheet text carries "12/27/20"; 1 p. | `7ba2b4988e2074791d02f4098d32f2889eb22c7f75c662598e831ef542e2870c` | 105,039 |
| Relative Placement: Scoring Example (filled sheet, 12 couples, 7 judges) | linked as `http://www.worldsdc.com/wp-content/uploads/2021/04/Scoring-By-Hand_Example_12-20-20.pdf`; fetched as above | 2026-11-24 01:20:17 | Contest line reads "Sept.1,'04"; 1 p. | `35b50754e4d19e6cf251b0afcc4f1653337a6ff2430be1d6a1c0aeed69bddee1` | 96,220 |

All five are PDFs (magic bytes `%PDF`); none was opened with anything but `pdftotext`. The template and example are
PDFs, not spreadsheets.

Related observations (not OD-24 scoring candidates):

| Doc | URL | Retrieved | Result |
|---|---|---|---|
| 2026 Rules PDF as linked on the same page | `https://worldsdc.com/wp-content/uploads/2026/03/Revised-WSDC-Registry-Event-Rules-Updated-Jan172026-V2026.1B.pdf` | 2026-11-24 01:20:21 | SHA-256 `140caae7...` = the pinned registry row (**match**); 378,929 bytes; the page says "2026 rules effective 1/1/2026" |
| "2027 DRAFT RULES PDF" | `https://worldsdc.com/wp-content/uploads/2026/11/2027-Draft-WSDC-Registry-Event-Rules-v4.pdf` | 2026-11-24 01:20:25 | SHA-256 `b74eebe5cf542df5bf0c6fe8e95ed53ba545a0b826a054f83e136807348332ad`, 568,562 bytes, "Version 2027.V.4 11.17.2026". **Differs from the pinned 2027 draft (`c0bd5bd...`).** Still a draft, `not current`, not read for behavior. |
| WSDC Scoring Systems page (HTML) | `https://worldsdc.com/scoring-systems/` | 2026-11-24 01:17:03 | See section 6. HTML hash `5d4b4318...` (the page carries per-request tokens; not stable) |

### 3.2 Relationship to the pinned WSDC Registry Event Rules v2026.1C (`140caae7...`)

- The pinned PDF is a rule document. 3.4.9.d (p.21) says additional information on the Callback system and Relative
  Placement "is available on the WSDC website under Rules, see Prelim Scoring and Relative Placement". The five files
  above are what that page links today. The pinned rules do **not** incorporate them as rule text.
- **Already registered:** the Relative Placement Details PDF is byte-identical (`573cb005...`) to the registry's existing
  "Relative Placement explanation (Tigges), reference (not WSDC rule text)" row. This retrieval adds provenance: the
  official site links it as "Relative Placement: Details". That row's status is **unchanged**.
- **Callback values:** the Announcement and white paper use the same numbers as pinned Section 5 (Yes 10; Alt 4.5, 4.3,
  4.2; No 0; at most three alternate levels) and explain the intent (three Alternates outweigh one Yes). They add no
  authority beyond the pinned text. The Announcement's own value line labels the 4.2 value "Alt 1" (apparent typo; the
  pinned rules and the white paper say Alt 3).
- **Hand-scoring template and example:** forms illustrating the Relative Placement process (the example reproduces the
  worked contest in the RP document). Illustrations, not specifications.
- **Authority is not established.** The RP document is an explanation by an individual (its author note names him as a
  WSDC Executive Board member in 2021). Nothing in the pinned rules or on the page states WSDC adopted its text as the
  rule. The Announcement is a memo on WSDC letterhead.
- **No document states which rules edition it applies to**, and none is dated 2026. Applicability to events under
  v2026.1C (effective 2026-01-01) is unestablished.

### 3.3 Independent review needed before any of these can be promoted

A reviewer who has not seen this note must establish, in a reviewed change (new registry row and a status decision):

1. **Applicability:** that the document applies to events run under v2026.1C (or the edition in force on the event
   date), and was not superseded.
2. **Completeness:** that the method covers every case a contest produces (for Relative Placement, for example: even
   panels, a Chief Judge score used as a panel slot, multi-way ties through every level, head-to-head re-visits,
   divisions run in several heats, scratches or missing scores, role-separated panels) with no gap filled from memory,
   and that the template and example agree with the text. This note does not find the RP document complete or
   incomplete; that is a review item.
3. **Authority and effective date:** that the document is WSDC's published rule or an adopted standard (not a personal
   explanation), with an effective date. Only the public record may be used; **no one is to be contacted**.
4. **Edition control:** a pinned hash, and a plan for the site replacing the file later.

Until then: not authoritative, not cited by any register entry or profile, and nothing is built from them.

## 4. What the pinned WSDC v2026.1C does and does not define

PDF page = printed page for this document. Verified against the pinned file (SHA `140caae7...`).

**Defined (preliminary callbacks; 3.4.9 and Section 5):**

- WSDC Jack and Jill contests "must use the WSDC-approved Callback system for preliminary competitions and Relative
  Placement scoring system for finals" (3.4.9, p.20); a computerized system is required, hand scoring only in
  emergencies, paper transfer audited (3.4.9.a-b, p.20).
- The Chief Judge assigns unique numerical raw scores to all competitors in preliminary rounds, and may split roles with
  a Secondary Chief Judge / Raw Score Judge (3.4.9.c, **p.21**).
- Values: Yes 10; Alt 1 4.5, Alt 2 4.3, Alt 3 4.2; No 0; not more than three Alternate levels; the Chief Judge may ask
  for Alt 1s, Alt 1s and 2s, or 1-2-3s per contest, and in larger contests two or more of a level (Section 5, pp.22-23).
- The outcome is "the sum of the values"; the Chief Judge's scores break the tie "only after the original calculations
  are complete" (Section 5, p.23).
- Section 6 (pp.23-24): twelve functions a computerized system "should" do, including tabulate and rank callbacks,
  tabulate and rank finals, restrict access, prevent tampering, and provide a WSDC scoring report.

**Not defined by the pinned text (NOT SPECIFIED IN PROVIDED SOURCE):**

- The **Relative Placement** final-scoring algorithm (3.4.9.d defers it to the website; the candidates above are
  unreviewed).
- How many couples are called back and how many Yes marks judges give (Definitions, p.3: decided by the Chief Judge).
- Whether an unmarked competitor counts as No (0), and what judges do when fewer than three alternate levels are used
  (only that the Chief Judge "may ask" for a subset; the formula does not change).
- Tie handling beyond the Chief Judge's raw score: the text does not state that the higher raw score wins (implied
  only), nor what happens when the Chief Judge's score is missing, or when one Chief Judge scores one role and a
  Secondary Chief Judge the other; nor how a tie at the cut is handled for competitors the Chief Judge did not score.
- Rounding or precision of sums, how per-role (Leader/Follower) callback lists are formed, multi-round callbacks.
- The score-sheet format and the content of the "WSDC scoring report" (Section 6, item 12).
- **A text defect:** 3.4.9.d and 3.4.9.e say the standardization and requirements "are listed in the Appendix"; the
  pinned PDF has **no Appendix**. The content is in Sections 5 and 6.

So the callback system **is** largely defined by the pinned text; the missing source text is the Relative Placement
algorithm (plus the gaps listed above).

## 5. Corrections to the audit's wording

The audit documents live on unmerged audit branches, so this PR cannot edit them. The exact replacement text is in
[audit-corrections.md](audit-corrections.md).

## 6. External authorization dependency: WSDC scoring-system approval (separate; not claimed)

Public facts only (no contact):

- Pinned rules: "WSDC-approved Callback system" (3.4.9, p.20); Trial Events must use a "WSDC approved Scoring System"
  (p.6); "Requirements for computerized scoring systems" (3.4.9.e; Section 6).
- The public page `https://worldsdc.com/scoring-systems/` (retrieved 2026-11-24 01:17Z; the page is **undated**, so its list may be stale) says a scoring audit is run on
  systems used at Registry Events: simulate scoring and data-security scenarios, evaluate against Section 6, determine
  compliance, recommend fixes, re-evaluate. Systems found compliant are listed as "vetted and approved by the WSDC", for
  **Jack and Jill contests only**. The page lists nine approved systems (public on the page; not reproduced here) and an
  **empty "pending approval" list**. It names no application route, fee, criteria beyond Section 6, or validity period.
- This is an **external authorization dependency**. DanceFlow is not on the list, has not applied, and **no claim is
  made** that it is or can be approved. How a new system is admitted is **unknown from public sources**; finding out
  would need contact, which is prohibited. It is an unresolved external gate, separate from algorithm correctness and
  from rule compliance.

## 7. UCWDC Majority Rules v16.9b (potential first future engine; unchanged)

- The supplied Scoring Format (`44290a06...`, v16.9b) fully specifies Rules #1-#11 (pp.1-8): callback values with up to
  five alternates, semi-final retire callbacks, medal marks, majority and the tie chain (#4-#8), overall and
  head-to-head (#9-#11). The OD-13 tie-chain gap is tracked in PR 841.
- `ucwdc_majority_rules@v16.9b` stays registered **unavailable**; nothing is built. Any implementation needs a
  separately versioned engine spec, independent verification of the arithmetic against the document, and separate owner
  authorization.
- The **"UCWDC-authorized Scoring System"** designation (Scoring Format p.1; General Information p.8: systems and staff
  trained, tested and authorized by a UCWDC Scoring Examiner) is an **unresolved external dependency**: a correct
  engine would still not be authorized. No contact is permitted.

## 8. NDCA Skating System (gaps and public candidates)

**In the pinned June 2026 Rule Book (`d1b73e1f...`):** requires the Skating System in all Sanctioned events
(III.D.11, p.21), requires scrutineers to pass an exam on it with 100% (III.B.2.a), and says to compute under it then
adjust for penalties (III.C.3.b(1)(d)). It **does not define the algorithm** (placement, tie-break, multi-dance).
Implementation gaps: no source text; recall and withdrawal interactions (PRs 839, 840); no NDCA-certified scrutineer
workflow; no NDCA Premier/CMPMGR export (III.E.1). The algorithm must **never** be rebuilt from memory.

Public NDCA/WDSF materials found (all UNREVIEWED candidates):

| Doc | URL | Retrieved (UTC) | Stated date / version | SHA-256 | Bytes | Note |
|---|---|---|---|---|---|---|
| NDCA Rule Book, June 2026, **Master v2** | `https://www.ndca.org/pdf/2026%20June%20-%20Compiled%20Rule%20Book%20Master%20v2%20-%20reduced%20size.pdf` | 2026-11-24 01:22:59 | "June" v2; HTTP Last-Modified 2026-07-08 | `0685c07f3018be3fa755540507e5ea69ac8c395099af8995bf99722c6827efdb` | 1,776,075 | Not linked from NDCA's rule-book page today (found via search). Same seven "Skating" lines as pinned v1 modulo layout; no algorithm. Not otherwise diffed. |
| NDCA Rule Change Log, 2026_06 | `https://www.ndca.org/pdf/Rule%20Change%20Log%20-%20NDCA%20Rule%20Book%20-%202026_06.pdf` | 2026-11-24 01:25:25 | HTTP Last-Modified 2026-06-19 | `a97d6301bbab6cd9c68db3d8c5e45d4de3e1b6961966839eaec6f7204bdb1b18` | 39,477 | Records no Skating System change. |
| NDCA Rule Book, July 2026, Master v3 | see PR 840 | not re-fetched here | per PR 840 | `b52800958d22...` | 1,776,097 | Recorded by PR 840; not re-verified here. |
| WDSF "The Skating System" | `https://www.worlddancesport.org/Document/99473179446/The-Skating-System.pdf` | 2026-11-24 01:22:36 | n/a | n/a | n/a | **Not retrieved:** it redirects to a third-party file-share page (HTML), not a PDF. WDSF is a different body from NDCA; relevance to NDCA events would itself need review. |

No retrieved public NDCA document defines the algorithm or names a manual as authoritative for NDCA events. The Skating
System stays a **source gap**. No NDCA or competition-director contact is made.

## 9. What could not be retrieved or established

- The WDSF "The Skating System" PDF (file-share redirect).
- Any public WSDC statement that the RP document is adopted rule text, or its effective date.
- WSDC's application route or criteria for approving a scoring system beyond Section 6.
- A re-fetch of the NDCA July 2026 edition (recorded by PR 840).

## 10. Register entries added

`OD24-WSDC-0001` (callback values, pinned, not implemented), `OD24-WSDC-0002` (WSDC-approved system, external
dependency), `OD24-SILENT-0001` (Relative Placement and Skating System text gaps). None claims compliance.
