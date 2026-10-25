# K1-U re-verification (aaffc9f5): owner disposition

The owner pasted this into the reviewer session. Reviewer report: `k1u-reverification-aaffc9f5.md` (this folder).

**Status:** NOT PASS stands. K1-U specification verification is not marked complete. No official scoring implementation is authorized.

## R-1: owner-approved interpretations

These apply to the explicitly supported scope only. They are owner-approved interpretations, NOT independently verified UCWDC rules.

1. **(G-1)** On complete, valid callback ballots, callback points are totalled across all eligible judges. An unmarked contestant receives zero.
2. **(G-3)** All contestants tied at the promotion cutoff advance **when capacity and competition structure permit; otherwise fail closed.**
   - Reviewer note: this condition is new. The spec must state what "capacity / structure permit" means operationally, for example a Finals capacity input. It must not invent a limit.
3. **(G-8)** Couples-style medal-and-rank marks convert to each judge's complete ordinal ranking 1..N **only where the conversion is unambiguous and supported by the documented format.** Ambiguous ranking or ties fail closed.

## Remaining defects

| Defect | Owner direction |
|---|---|
| R-2 | Correct F-U-14 to match the supported Prelims → Finals scope |
| R-3 | Remove the unsupported source-confirmed claim about Semi-Finals retirement-cut ties |
| R-4 | Explicitly classify unresolved Rule 11 cases as refused / fail-closed |
| R-5 | Establish whether the Coordinator's configured alternate count is a mandatory ballot-completeness requirement. Do not invent a UCWDC rule. If unresolved: fail closed and document the question |
| R-6 | Replace the unreachable F-U-15(d) with the reviewer's concrete inputs (J=7: A [14,14,13,12,14,12,11], B [12,13,14,14,11,14,12], C [14,12,13,12,11,14,14]), with the expected result checked independently |
| Nits | Resolve the three wording nits without broadening scope |

## Constraints

- Keep four things separate:
  - source-confirmed statements;
  - owner-approved interpretations;
  - unsupported structures;
  - open UCWDC questions.
- Official UCWDC compliance and panel eligibility stay **UNVERIFIED**. All existing release holds are preserved.
- W6 makes bounded Git-only corrections, then sends the exact commit to the same independent reviewer for another full check.
- **Not authorized:** merges, deployments, hosted migrations, scoring-release approval.
