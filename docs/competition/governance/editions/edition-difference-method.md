# OD-30: edition-difference method, review checklist and promotion gate

Design only. This is the procedure by which a candidate rulebook edition may move into the platform's verified
registry (owner decision OD-30 items 1, 6-10). Nothing here is executed by software today; it is a reviewed human
process whose outputs are recorded in the structures described in
[OD-30-rulebook-editions-design.md](OD-30-rulebook-editions-design.md).

## 1. Edition lifecycle (statuses)

| Status | Meaning | May be selected by an event? | Maps to today's registry status |
|---|---|---|---|
| `candidate` | Retrieved and hashed; nothing reviewed. | Never | not a row (candidate note only) |
| `under_review` | A review record is open (section 4). | Never | `not current` |
| `approved` | Promotion gate passed; platform owner admitted it. Applicability evidence per body/format is attached. | Yes, where the applicability record says so | `authoritative` |
| `superseded` | A newer approved edition exists for the same body/format. Kept; never edited. | Yes, **only** for events whose existing binding already names it, or where its applicability window still covers the event and the organizer chooses it (no automatic movement) | `authoritative` (kept) until deliberately changed |
| `rejected` / `withdrawn` | Failed review or removed by the platform owner. | Never for new selections; existing bindings keep their evidence | `not current` |

Transitions are made only by the platform owner's admission action, are append-only history, and are never
inferred from dates.

## 2. Source integrity record (required before `under_review`)

For every edition the record carries: governing body; document title; edition identifier **as printed in the
document**; source version label; **SHA-256 of the exact bytes reviewed**; byte length; retrieval URL and timestamp
(or the file name and who supplied it); the publisher's own publication information **when the document or the
publisher's page states it** (with a `publication_date_basis` of `stated_in_document`, `stated_on_publisher_page`,
or `observed_http_metadata`; the last is evidence of a fetch, not of publication, and is never an effective date).

**Effective date.** A date is recorded as verified only when a publisher statement (the document, a publisher
change log or notice, or the body's written confirmation obtained through an owner-authorized channel) says when the
edition governs events. Otherwise `effective_date_status = unknown`. A filename ("v1-26-2026", "Jan172026"), a
cover month ("June 2026 EDITION"), a revision year ("REVISED 2025"), a server `Last-Modified` header or a page
footer version label is **never** an effective date. Where a rule defines effectivity by reference to an event (NDCA:
amendments "take effect upon publication", Introduction F, p.2) the **rule** is recorded (`effective_rule_ref`) and
the date stays unknown until the publication date it points to is verified.

The four dates are always distinct fields and never merged: **publication date** (publisher), **effective date**
(publisher-stated applicability), **event date** (the event's own dates), **organizer declaration** (what the
organizer asserts, with who and when). An organizer declaration is an input to selection, not evidence of
applicability.

## 3. Edition-difference method

Run on every candidate against the currently approved edition of the same body and document. Reproducible by any
reviewer; the record stores the commands' inputs and outputs' hashes.

1. **Fix the inputs.** Hash both files; confirm the approved edition's hash equals the registry row. Retrieve a
   candidate only from the publisher's official URL into a **new empty directory**; never execute anything from it;
   extract text with `pdftotext -layout` from a different directory.
2. **Normalize.** Remove line numbers, running headers/footers, page numbers, table-of-contents lines and dot
   leaders; collapse whitespace; join hyphenated line breaks that differ.
3. **Compare word by word** (`git diff --no-index --word-diff`, or an equivalent) and keep the raw hunks.
4. **Classify every hunk**: substantive wording change; reference change (renumbering, page shift); layout noise
   (header, hyphenation, TOC); added/removed section. Layout noise is listed with a count and sampled, never silently
   dropped.
5. **For each substantive hunk record**: section and printed page in both editions; the short before/after
   phrases; the **modal classification** before and after (mandatory / recommended / permitted exception / organizer
   discretion); whether it changes a **citation** already used by a register entry; whether it touches **scoring
   rules** or **eligibility** (age, status, level, role, partner) rules; and the register entries and profile fields
   affected.
6. **Cross-check against the publisher's own change log**, if any; a difference not in the log, or a log item
   with no text difference, is a finding. If no log exists, say so; the comparison then rests on the text alone.
7. **Write the compatibility assessment**: for each profile version, scoring-method version and age basis that cites
   the approved edition, state *unaffected / needs a new version / blocked*.

**Worked example (verified 2026-11-23, NDCA June 2026 Master v1 versus July 2026 Master v3, candidate).** Normalized
word comparison of the two texts yields three substantive hunks: II.B.7.f (Pro/Am Student age divisions: mandatory
list becomes "not required to offer all" at the organizer's discretion; age thresholds unchanged; modal change
mandatory → organizer discretion), IX.A.1.f(1)(a) (Theatre Arts rotation gains calendar years and a different
starting dance) and IX.A.1.f(1)(c) (music release date, December → October). Everything else is layout noise.
Sections X.A, III.D, IV and V show no wording change. NDCA publishes no July change log (per PR 840), so the result
rests on text alone. Details: [age-basis-source-notes.md](age-basis-source-notes.md) section 4. Result: the July
edition stays `candidate`.

## 4. Independent review checklist

The reviewer must be a different person (or independent reviewer) from the one who retrieved and compared the
edition, and must re-read the cited passages in the **document itself**, not in extracts.

- [ ] A. Source: URL/provenance is the publisher's own; hash recomputed by the reviewer; bytes length recorded.
- [ ] B. Edition identity: identifier, version label and cover/footers agree, or the disagreement is recorded (for
      example WSDC: footers say 2026.1C, the file name says 2026.1B).
- [ ] C. Effective-date evidence: each date field has evidence or is `unknown`; no date derived from a filename,
      publication month, revision year or HTTP metadata.
- [ ] D. Difference analysis (section 3) re-run independently; counts match; every substantive hunk classified.
- [ ] E. **Affected citations**: every register entry, profile `sources` item and UI source label citing the previous
      edition is listed with *unchanged / changed / not found*.
- [ ] F. **Mandatory/advisory classification**: every changed rule's modal class before and after; any "shall" ↔
      "may/not required" change flagged for owner attention.
- [ ] G. **Scoring rules**: any change to a scoring system, callback, placement, tie or tabulation rule is listed,
      with the scoring-method versions that depend on it. A reviewed edition does **not** authorize a scoring engine
      and establishes no certification (section 6).
- [ ] H. **Eligibility rules**: age basis (per body and category), status, level, role and partner rules diffed, with
      `age_basis` versions that cite them (see [age-basis-source-notes.md](age-basis-source-notes.md)).
- [ ] I. **Applicability**: for each body/format the edition applies to, the evidence (publisher statement) is cited
      or the status is `unknown`; unknown blocks selection for body-declared events.
- [ ] J. Compatibility assessment (step 7) complete; profile versions that need a new version are named.
- [ ] K. No leakage: no long rulebook text in the repository; short phrases and section/page references only.
- [ ] L. Registry/register consequences enumerated (new row, status changes, entries with `effective_to`, new
      entries), none yet applied.

## 5. Promotion gate (candidate → `approved`)

All must hold, recorded in an append-only review record; the platform owner then makes the admission decision:

1. Checklist A-L complete with a named independent reviewer and date; reviewer ≠ retriever ≠ approver.
2. No open `requires_interpretation` item whose resolution a profile depends on, **or** each such item recorded as an
   explicit blocker with the profiles it blocks.
3. Compatibility assessment shows no existing event is silently changed: existing bindings remain on their edition;
   nothing is upgraded.
4. Applicability per body/format is `verified_applicable` for every use the owner wants enabled; everything else stays
   `unknown`. `unknown` never enables selection for a body-declared event.
5. The governing-body registry row is added (new row; the previous row kept and its status changed deliberately, in
   a reviewed change), with the pinned SHA-256.
6. The platform owner (not the reviewer) signs the admission. Admission authorizes **selection of the edition by
   organizers**; it authorizes nothing else.

## 6. What a reviewed edition does not do

A reviewed, approved edition establishes that DanceFlow has the governing body's text and has compared it. It does
**not** authorize a scoring engine, a body scoring profile, any claim that a result complies with a body's rules, or
any external certification or approval (for example WSDC scoring-system approval, UCWDC authorized-system
designation, NDCA scrutineer requirements). Those remain separate, independently verified dependencies under OD-01,
OD-09 and OD-24.
