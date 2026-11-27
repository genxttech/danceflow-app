# OD-09: NDCA advancement support, compliance gaps

Owner decision **OD-09, 2026-11-23: Option C now; Option A is required for a future NDCA scoring profile.**
Studio/Custom advancement is unchanged for initial activation. This file is the gap list for that decision. It is
documentation only: no code, SQL, engine work or activation is authorized or included.

## Status

**NDCA advancement support is NOT IMPLEMENTED and is a BLOCKER to enabling any NDCA scoring profile.**
Nothing here claims NDCA, WSDC or UCWDC compliance. Until the gaps below are closed and independently verified,
the OD-01 restriction stands: results for body-declared events are not published as body-compliant (PR 832).

Source: NDCA Rule Book June 2026, Master v1 (SHA-256 `d1b73e1f…`, see the
[source registry](../../governing-body-source-registry.md)), IV.C.1 and IV.C.2 (printed p.27), III.D.34. Passages
were re-read in the pinned PDF on 2026-11-23; only short phrases are quoted. Register entries:
`OD09-NDCA-0001` to `-0005`, `OD09-WSDC-0001`, `OD09-UCWDC-0001`, `OD09-DF-0001`
(chain: rule → requirement → implementation → test → verification; implementation and tests are empty, so every
body entry is `unsupported` or `requires_interpretation`, never `verified_compliant`).

## Current behavior (Studio/Custom, preserved)

An organizer-set callback target T (2 ≤ T ≤ round capacity ≤ 100; `start_competition_round`, A4a guard,
`finalCapacity.ts`), one callback round, then a Final. This is DanceFlow policy (`OD09-DF-0001`), not an NDCA rule.

## Prerequisite gaps (each mandatory before an NDCA scoring profile is enabled)

| Gap | Prerequisite (OD-09 item) | NDCA source | Register | Owner / dependency | Status |
|---|---|---|---|---|---|
| G-OD09-1 | Chairman of Adjudicators sets or explicitly authorizes the callback count through a verified event-level role (item 1) | IV.C.1 ("responsible for determining the number of couples to be recalled"); IV.C.1.d consult organizer | `OD09-NDCA-0001` | Competition coordinator; depends on OD-05/OD-06 role designation (PR 834) | NOT IMPLEMENTED; no Chairman role exists |
| G-OD09-2 | Enforce the 50% minimum recall per round with verified exceptions and carry-forward (item 2) | IV.C.1.a | `OD09-NDCA-0002` | Competition coordinator; exception semantics to be confirmed at engine design; needs OD-24 for scoring | NOT IMPLEMENTED; only T ≥ 2 and ≤ capacity |
| G-OD09-3 | Quarterfinal and semifinal structures (item 3) | IV.C.1.c required for professional and championship adult amateur (semi at 8+, quarter at 15+ pre-registered); Pro/Am only recommended; IV.C.1.e split is advisory | `OD09-NDCA-0003`, `-0005` | Competition coordinator; depends on division inventory (audit domain 1) and multi-round engine (S-22) | NOT IMPLEMENTED; one callback round only |
| G-OD09-4 | Eight-couple Final cap, only after reconciling the source conflict (item 4) | IV.C.1.b, IV.C.1.f (tie), IV.C.2, IV.C.1.g (Cabaret/Formation), III.D.34 and III.D.34.c (up to ten) | `OD09-NDCA-0004` | **Owner**: resolve the source conflict; tie handling depends on OD-24 | SOURCE CONFLICT recorded; cap not enforced and not chosen |
| G-OD09-5 | Keep WSDC Chief Judge and UCWDC Contest Coordinator mappings separate; never impose NDCA advancement rules on them (item 5) | WSDC Definitions p.3; UCWDC Scoring Format Heating Rules 1-3 | `OD09-WSDC-0001`, `OD09-UCWDC-0001` | Competition coordinator; WSDC roles via OD-06 | Constraint recorded; no WSDC/UCWDC advancement support |
| G-OD09-6 | Record decision-maker, callback target, applicable rule version, exceptions and audit history (item 6) | all of the above | `OD09-NDCA-0001`, `-0002` | Competition coordinator; immutable audit shared with OD-07 | NOT IMPLEMENTED |
| G-OD09-7 | Coordinate role enforcement with OD-05/OD-06 and scoring calculations with OD-24 (item 7) | n/a | n/a | Competition coordinator | Open dependency; OD-24 (Skating System algorithm text) is itself unresolved |
| G-OD09-8 | Preserve the OD-01 restriction on publishing unverified body-compliant results (item 8) | n/a | n/a | Competition coordinator | Holds (OD-01 guard, PR 832, unmerged at time of writing) |

## Source conflict (registry rule 3)

NDCA IV.C.1.b and IV.C.2 read as a hard cap of eight couples in any Final round, while IV.C.1.f lets more than the
selected number dance "in the case of a tie". IV.C.1.g (Amateur Cabaret and Formation) and III.D.34 (Pro/Am
multi-competition floors, with a limited allowance of up to ten) add event-format exceptions. Fail-closed effect:
the cap is not enforced and not claimed. Recorded in the source registry's *Source conflicts* table and in
`OD09-NDCA-0004`; also listed as finding X9 in the owner decision list.

## Not decided or not verified here

- WSDC and UCWDC rules beyond the two cited passages were not re-read for this PR.
- The NDCA July 2026 edition (OD-08/OD-30 comparison) is not reflected; this PR cites only the pinned June 2026 book.
- No test or engine exists for any gap; this PR proves nothing about behavior.
