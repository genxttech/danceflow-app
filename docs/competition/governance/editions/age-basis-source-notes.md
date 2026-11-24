# OD-30: age-reference rules by body (verified source notes)

Design input for the versioned `age_basis` model in [OD-30-rulebook-editions-design.md](OD-30-rulebook-editions-design.md).
Nothing here is implemented, and nothing here specifies a calculation. Each body is documented **separately**; no
body's reference rule is applied to another body, and no universal reference date is assumed (owner decision OD-30
item 11/12).

**How these notes were verified (2026-11-23).** Each pinned PDF was hashed (all four match the
[source registry](../../governing-body-source-registry.md)) and read with `pdftotext -layout`; every passage cited
below was re-read in the text, not taken from the audit. Page numbers are the **printed** page numbers of the cited
edition. Quotes are short phrases only.

| Body | Pinned document (SHA-256 prefix) | Edition label in the document |
|---|---|---|
| NDCA | `2026 June - Compiled Rule Book Master v1 - reduced size.pdf` (`d1b73e1f504d`) | "June 2026 EDITION" |
| UCWDC | `2026-UCWDC-Rules_Couples_v1-26-2026-1.pdf` (`8a45ee58d189`), `2026-UCWDC-Rules_ProPro-ProAm_v1-26-2026.pdf` (`d6257b659151`) | cover: "2026 - 2028"; "COPYRIGHT 1987, REVISED 2025" |
| WSDC | `Revised-WSDC-Registry-Event-Rules-Updated-Jan172026-V2026.1B.pdf` (`140caae75a8d`) | page footers: "Version 2026.1C" |

## 1. NDCA (June 2026 edition, pinned)

| Item | Section / page | What the rule book says (short) | Status of our reading |
|---|---|---|---|
| Classes take effect on the birthday | X.A.1, p.42 | Classes "a" through "e" and "g" "will become effective on the individual's actual birthday". | Verified wording. |
| 60-day window | X.A.1, p.42 | A competitor moving up "may make this change anytime during a 60-day period that begins 30 days prior to their birthday and ends 30 days following their birthday". | Verified. The text is a permission to change, not a computed result; whether the change is a per-event election that must be recorded is **not specified** (see unresolved U-N1). |
| Multi-day extension | X.A.1, p.42 | For Multi-Day Competitions and Championships, if the 30-day mark falls after competitive events have begun, the 30-day rule extends to the last day of the Sanctioned multi-day competition. | Verified. "Competitive events have begun" is not defined (U-N2). |
| Under 21 has no grace | X.A.1, p.42 | Class "f" (Under 21) "does not have a 60-day grace period". | Verified. |
| Under 21 reference | X.A.1.f, p.42 | "On the day of the competition" one partner has reached 16 and neither has reached 21. This is a **different** reference (the competition day) from the birthday rule for the other classes. | Verified. "Day of the competition" for a multi-day event is not defined (U-N2). |
| Youth / Adult thresholds | X.A.1.e, g, p.42 | Youth is the 16th, 17th or 18th birthday; Adult is the 19th birthday or greater. | Verified. Note: an 18-year-old is NDCA Youth, not Adult (the OD-02 18+ rule is DanceFlow policy, not an NDCA category). |
| Senior I-IV | X.A.1.g(1)-(4), p.42 | Two thresholds, one per partner: 35/30, 45/40, 55/50, 65/60. | Verified. |
| Couple age | X.A.6, p.43 | The older partner's age defines the class for Pre-Teen I through Youth and Adult; the younger partner's age for Senior. | Verified. |
| Combining / extra categories | X.A.2-3, p.42 | Organizers may combine listed classes and may offer additional age categories. | Verified. The extra-category rule means an organizer-defined division has no body reference rule (audit row FD-39): it is **organizer policy**. |
| Dancing up/down, age gap | X.A.4-5, pp.42-43; II.B.8.d, p.8 | Dance-up limits and a two-classification age-gap limit with written permission from the NDCA Ballroom Department. | Verified exist; **permissions come from NDCA, not the organizer** (not modelled here). |
| Pro/Am Student age divisions | II.B.7.f, p.7 | Divisions A 19+, B 36+, C 51+, S1 61+, S2 71+, S3 76+, S4 81+; June: "shall be as listed below". | Verified in June. **Changed in July** (see section 4). |
| Pro/Am window | II.B.7.g, p.8 | Same 60-day window (30 before, 30 after birthday) for Pro/Am competitors moving to the next classification. | Verified. Separate rule from X.A.1, same shape. |
| Amateur/professional status date | II.A.1.d, p.4 | Status "should be determined as of the closing date for entries". | **A status reference, not an age reference.** Recorded to prevent confusing the two (an event can have an entry-closing reference for status and a different one for age). |
| Effective date of the edition | Introduction, section F "Application of Competition Rules", p.2 | Amendments "shall take effect upon publication". | Verified wording. The **publication date of the June edition is not stated in the PDF** (cover says only "June 2026 EDITION"), so the effective date is **UNKNOWN**. |

Unresolved (NDCA):

- **U-N1.** Whether the 60-day window is a competitor's per-event election that must be recorded, or an automatic acceptance of either class. Not specified.
- **U-N2.** "Competitive events have begun" and "the day of the competition" for multi-day Sanctioned events. Not defined.
- **U-N3.** The Pro/Am Student rules (II.B.7) name ages but not whose age counts when the Pro/Am couple has different ages; X.A.6 is written for amateur couples. Whether X.A.6 applies to Pro/Am Student partnerships is an interpretation (shares AE-16).

## 2. UCWDC (2026 rules, pinned)

| Item | Section / page | What the rules say (short) | Status of our reading |
|---|---|---|---|
| Season-based age | Couples II.D.1, p.3; ProPro/ProAm II.D.1, p.3 | "A competitor's age for the entire Dance Season" is "the age they will be on the last day of that Dance Season". | Verified in both documents. |
| Dance Season | II.A.4 (Couples p.1; ProPro/ProAm p.2) | A year beginning January 16th and continuing up to January 15th of the following year. | Verified. Which season an **event** belongs to is a DanceFlow derivation from the event date; it is not stated, and a multi-day event spanning January 15-16 is unresolved (U-U1). |
| Juniors | II.D.2, p.3 | Less than 18 years of age; Primary under 10, Youth 10 to under 14, Teen 14 to under 18. | Verified. |
| Junior couples | Couples II.D.2.a, p.3 | "All Junior Couples must dance in the older partner's age group". | Verified for **Couples only**; the ProPro/ProAm document has no such sub-item. |
| Open / Masters adult exception | Couples II.D.3.a-b, p.3 | Adults, "except in couples where an Adult may dance with a partner who is 16 years of age or above". | Verified for **Couples only**; ProPro/ProAm II.D.3.a has no exception. |
| Age-restricted minimums | II.D.3.c (Couples, p.3) / II.D.3.b (ProPro/ProAm, pp.3-4) | Per-division minimum ages (Crystal 30, Diamond 40, Silver 50, Gold 60, Platinum 70, and others). | Verified. The lists differ between the two documents (Couples adds Masters Plus, Crown, Crown Plus; ProPro/ProAm adds Pearl 80). Per-document, per-division. |
| Whose age counts in ProAm | ProPro/ProAm II.D | **Not specified.** The section speaks of "a competitor's age" and says nothing about a ProAm student-teacher pair. | `NOT SPECIFIED IN PROVIDED SOURCE`. **AE-16 stays unresolved.** |
| Whose age counts in Couples (non-Junior) | Couples II.D | Only the Junior older-partner rule (II.D.2.a) and the 16+ partner exceptions (II.D.3.a-b) are stated. For Age-Restricted divisions the text says competitors "must be at least" the minimum and does not say whether both partners must qualify. | Unresolved (U-U2). |
| Effective date of the edition | cover | "2026 - 2028" and "REVISED 2025". The file name carries "v1-26-2026". | **No effective date stated.** The file-name token is not evidence (OD-30 item 7). |

Unresolved (UCWDC): **U-U1** season membership of multi-day events spanning January 15-16; **U-U2** whose age counts in non-Junior Couples Age-Restricted divisions; **AE-16** ProAm (and ProPro) whose age.

## 3. WSDC (Registry Event Rules, version 2026.1C, pinned)

| Item | Section / page | What the rules say (short) | Status of our reading |
|---|---|---|---|
| Age-based contest definitions | Definitions, "Age-based Contests", p.3 | Juniors are "younger than 18 years of age by close of the event"; Sophisticated 35 or older and Masters 50 or older, each "by the close of the event". | Verified. |
| One per event, open to all skill levels | 3.1.3 and 3.1.3.a, p.10 | One Junior, one Sophisticated and one Masters contest per event record points; age-based Jack and Jill contests are open to all skill levels who "meet the age-based requirement". | Verified. |
| Minimum age | 3.1.2.e, p.10 | Events "may set a minimum age requirement for contestants", which must be published in the Event's rules. | Verified. This is **organizer discretion with mandatory publication**, not a WSDC age number. |
| Several age-based contests | 3.2.4, p.12 | Competitors may compete in multiple age-based Jack and Jill contests for which they qualify. | Verified. |
| Edition identity | page footers | "Version 2026.1C"; the file name says 2026.1B and contains "Jan172026". | **No effective date stated.** The file-name date is not evidence. |
| 2027 draft | `2027-Draft-WSDC-Registry-Event-Rules1.pdf`, footer "Version 2027.V.3 6.27.2026" | Same age definitions in wording ("by the close of the event"); `not current`. | Informational only; never used as current behavior. |

Unresolved (WSDC): **U-W1** what instant "close of the event" is (event end date, the contest's own end, local time zone), and for events whose contests close on different days. Not defined. The WSDC age definition speaks of the age of "individuals" in age-based Jack and Jill contests and states no pair or whose-age rule; Pro-Am contests are mentioned elsewhere in the rules (for example the conflict-of-interest exceptions) but no age rule for them was found, so none is claimed.

## 4. NDCA June versus July 2026, Pro/Am age divisions (II.B.7.f)

Both PDFs were read for this note. The July candidate was re-fetched from the official NDCA URL recorded in PR 840
into a new empty directory, hashed (`b52800958d22c8499876dbe14c74b4dd8539a43dff9e686d1a275a698999a32e`, 1,776,097
bytes, matching the PR 840 record) and only text-extracted; nothing in it was executed.

| | June 2026 Master v1 (pinned, authoritative) | July 2026 Master v3 (CANDIDATE, unreviewed) |
|---|---|---|
| Location | II.B.7.f, printed p.7 | II.B.7.f, printed p.7 |
| Wording | divisions "shall be as listed below" | divisions "are listed below, although an organizer is not required to offer all of the age divisions that are listed" |
| Age thresholds (A 19+, B 36+, C 51+, S1 61+, S2 71+, S3 76+, S4 81+) | as above | **identical** |
| Modal effect | mandatory list | the list stays the only permitted set of divisions, but **offering each division becomes organizer discretion** |
| 60-day window II.B.7.g | present | present, unchanged |

A word-level comparison of the whole of both texts (page numbers, running headers, table-of-contents and hyphenation
differences normalized away) reproduces the PR 840 finding that only three substantive differences exist:
II.B.7.f (above), IX.A.1.f(1)(a) (Theatre Arts Compulsory rotation) and IX.A.1.f(1)(c) (music release date). Nothing
in X.A, III.D, IV or V differs. Neither edition states when it takes effect, and no July change log is published on
NDCA's change-log page (per PR 840). Therefore: the July edition stays an **UNREVIEWED CANDIDATE**, the June row is
unchanged, no register entry cites July, and the effective date of **both** editions remains UNKNOWN until verified
from a publisher-stated source.

## 5. What an `age_basis` record may and may not contain

It records **which rule applies and what is unresolved**, with source references; it does not hold a formula that has
not been independently verified. Where the text gives a reference (NDCA birthday and competition day, UCWDC end of the
Dance Season, WSDC close of the event) the record names it; where the text is silent or ambiguous it carries
`UNRESOLVED` and fails closed (no automatic age-division determination; the OD-03 organizer determination remains the
only path). See the design for the field list.
