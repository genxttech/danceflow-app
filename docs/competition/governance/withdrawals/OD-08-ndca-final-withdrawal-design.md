# OD-08 design: NDCA injury/illness withdrawal after the Final has started

Status: **design only (docs). Nothing is implemented, applied, merged, deployed or activated.** No scoring engine, SQL or migration file is added.
Owner decision: OD-08, 2026-11-23, **Option A (NDCA-specific exception, future verified NDCA profile only)**, recorded in the retrospective audit decision list
(PR #795, `docs/competition/governance/audit/OWNER-DECISIONS.md` on `claude/comp-audit-owner-decisions`).
Base: `origin/release/website-embeds` at `49dbaee1b`. Governance: [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md); rule register entries `OD08-*`.

**Bottom line.**

1. The *record* side (who may withdraw a couple, reason codes, independent confirmation, audit, per-dance "not performed" evidence) can be designed completely now (sections 5-6).
2. The *placement arithmetic* cannot be finished. The NDCA rule book requires the Skating System but does not contain its algorithm (III.D.11; `NOT SPECIFIED IN PROVIDED SOURCE`), and III.D.30 does not say how several withdrawn couples are ordered or how a "last place" enters multi-dance totals. OD-24 stays a **blocker** for any NDCA engine; section 7 lists exactly which engine functions need which verified inputs.
3. The July 2026 NDCA edition (the one NDCA's official page lists today) leaves III.D.30, III.D.31, III.D.11, X.A and IV unchanged in wording; it differs from the pinned June edition in three small places and in pagination (section 3). Adoption of July is **not** proposed here; it is a separate owner decision under OD-30.
4. Studio/Custom behavior (X-5, "scratched / no-show excluded, never placed last") is **unchanged**. Engines `@1` are never edited.

---

## 1. Owner requirements (traceability)

| # | Requirement (OD-08 decision) | Where addressed |
|---|---|---|
| 1 | Preserve current Studio/Custom Scratch behavior | 4, 6.6 (separate action, separate engine, `@1` untouched) |
| 2 | For an applicable NDCA Final, allow a documented injury/illness withdrawal after the Final begins | 5, 6 |
| 3 | Last place for EACH dance not performed, never automatically last across all dances or overall | 5.3, 7 |
| 4 | Authorized official's recorded reason + independent confirmation as DanceFlow policy; no unnecessary medical detail | 5.2, 5.4 (reason codes only, no free text) |
| 5 | Immutable audit evidence; coordinate with OD-07 correction/versioning | 6.4, 8.1 |
| 6 | OD-21 replacement-couple handling stays separate | 8.2 |
| 7 | Do not invent Skating System arithmetic; state what is unresolved and which engine function needs it | 7 |
| 8 | Compare pinned June 2026 against the July 2026 edition on NDCA's site (III.D.30, III.D.31, X.A, IV, III.D.11, OD-30 effective date) | 3 |
| 9 | Design level: versioned engine changes, SQL changes (A6 refusal, PV-1, record shape, audit), tests, rollback, dependencies, open questions | 6, 7, 9, 10, 11 |

## 2. Rule evidence

Re-read in the pinned June 2026 PDF on 2026-11-23. File `2026 June - Compiled Rule Book Master v1 - reduced size.pdf`, SHA-256
`d1b73e1f504d2f84b610fc489695dc2cb68e60c224970b03dd3f9f280cecdaa6` (verified against the source registry; 1,772,820 bytes). Page numbers are the printed footer numbers; the PDF page index is in brackets.
Quotes are short phrases only.

| Rule | Edition | What it says (own words) | What it does NOT say |
|---|---|---|---|
| NDCA III.D.30 (printed p.23 [PDF 30]) | June 2026 Master v1 | Once a final round commences, a couple that must withdraw "due to injury or illness" is "awarded last place for any dances in which they did not dance". | No definition of "commences"; no instruction for two or more couples withdrawing; no treatment of a couple that leaves in the middle of a dance; how a last place feeds the Skating System totals; who decides that a withdrawal is necessary; any evidence or confirmation duty. |
| NDCA III.D.31 (p.23 [30]) | same | If a couple withdraws after any round and before the next one starts, the chairman may at discretion replace it with the next eligible couple. | Permissive and a different moment (between rounds). Out of scope here (OD-21). |
| NDCA III.D.11 (p.21 [28]) | same | The Skating System of score evaluation is required in all NDCA Sanctioned events (Formation Teams and Team Matches excepted); Repechage is not permitted. | **The Skating System algorithm is not in the source** (also III.B.2.a exam, III.C.3.b(1)(d) only mention it). |
| NDCA X.A.1 (p.42 [49]) | same | Age classifications take effect on the actual birthday, with a 60-day window (30 days before to 30 days after) for classes a-e and g, and no window for "Under 21". | No event-date reference rule beyond that; no statement about which rule-book edition applies on a given date. |
| NDCA IV.C items 1.b, 2, 5-7 (PDF 34) | same | At most eight couples dance in any Final; the chairman verifies marks and transcription, sends a card needing correction to the adjudicator, and decides conduct questions finally. | The chairman is not given a role in approving a withdrawal. Whether DanceFlow's `chair` role equals the NDCA Chairman is **not approved** (OD-06/OD-15, audit row J-01). |

Other bodies: UCWDC and WSDC have no equivalent rule in the pinned sources (audit OD-08 text), so nothing here applies to them; do not apply III.D.30 to them (governance rule 7).

**Effective date.** The June document states an edition label only, no effective date (OD-30). The register entries below use `effective_from 2026-06-01` as a **placeholder convention shared with the OD-07 entries**, not a statement made by NDCA.

## 3. June 2026 vs July 2026 edition (item 8)

### 3.1 What was compared, and how

| | June (pinned, authoritative) | July (candidate, unreviewed) |
|---|---|---|
| Label | "June 2026 EDITION"; registry label "June 2026, Master v1" | "JULY 2026 EDITION"; file name "2026 July - Compiled Rule Book Master v3 - reduced size" |
| Source | `C:\Users\mcurt\Downloads\...` (registry-pinned copy) | `https://www.ndca.org/pdf/2026%20July%20-%20Compiled%20Rule%20Book%20Master%20v3%20-%20reduced%20size.pdf`, linked as "the current NDCA Rule Book" from NDCA's own "NDCA Rule Book" page (`https://www.ndca.org/pages/ndca_rule_book/Default.asp`) |
| SHA-256 | `d1b73e1f504d2f84b610fc489695dc2cb68e60c224970b03dd3f9f280cecdaa6` | `b52800958d22c8499876dbe14c74b4dd8539a43dff9e686d1a275a698999a32e` |
| Size | 1,772,820 bytes | 1,776,097 bytes (HTTP `Content-Length`; `Last-Modified: Fri, 10 Jul 2026 17:54:22 GMT`) |
| Retrieved | n/a | 2026-11-23, plain HTTP GET, saved in a new empty directory, text extracted with `pdftotext -layout` from another directory; nothing inside it was executed or opened |
| Text length | 123 PDF pages | 121 PDF pages |

NDCA's official "Log of Rule Book Changes" page lists only `Rule Change Log - NDCA Rule Book - 2026_06` (SHA-256 `a97d6301bbab6cd9c68db3d8c5e45d4de3e1b6961966839eaec6f7204bdb1b18`); **no July change log is listed**, so the July differences below come from the text comparison, not from NDCA's own statement. A web search also showed files named "June 2026 ... Master v2" on ndca.org; v2 was not retrieved or analyzed.

Method: both texts were normalized (line numbers, page headers and dot leaders removed, whitespace collapsed) and compared word by word; every difference was then reviewed. Pagination differs throughout (the July rule book is two pages shorter), so printed page numbers below differ between editions.

### 3.2 Version-difference table

| Area asked | June 2026 Master v1 | July 2026 Master v3 | Difference |
|---|---|---|---|
| **III.D.30** (final-round withdrawal; last place per dance not danced) | printed p.23 | printed p.22 | **None in wording.** Same rule, same position (item 30). |
| **III.D.31** (replacement between rounds) | p.23 | p.22 | **None.** |
| **III.D.11** (Skating System required; Repechage not permitted) | p.21 | p.20 | **None.** Still no algorithm. |
| **X.A age classes** (X.A.1 effective on the birthday, 60-day window; classes a-g; combining; dancing up/down) | p.42 | p.41 | **None in wording.** |
| **IV judging** (adjudicators, chairman of adjudicators, scrutineers) | section IV (printed pp.23-31 in June; shifted by one page in July) | same section | **None in wording.** |
| II.B.7.f (Pro/Am Student Competitor Multi-Dance age divisions A, B, C, S1-S4) | divisions "shall be as listed below" | divisions "are listed below, although an organizer is not required to offer all of the age divisions" | **Changed** (relaxes a mandatory list to optional; outside the OD-08 scope, relevant to the age/division audit rows and OD-03/OD-30). |
| IX.A.1.f(1)(a) Theatre Arts Compulsory music rotation | "Year 1 - Waltz ... Year 6 - Paso Doble" (no calendar years) | "Year 1 (2026) - Tango ... Year 6 (2031) - Waltz" (calendar years added; the order starts at Tango) | **Changed** (outside scope; matters only to a Theatre Arts Compulsory profile). |
| IX.A.1.f(1)(c) release date of selected music | beginning of December each year | beginning of October each year | **Changed** (outside scope). |
| Cover / table of contents | "June 2026 EDITION" | "JULY 2026 EDITION" | Edition label and TOC page numbers only. |

No other textual difference was found. In particular nothing in sections III.D, IV, X.A or V changed, and the rules that OD-08 depends on are identical.

**Effective-date uncertainty (OD-30).** Neither document states when it takes effect. NDCA's page calls July "the current NDCA Rule Book", but gives no date from which it governs an event. The governance rule evaluates an event against the edition applicable to its date, not the newest one. The product has no event-level edition or effective date today (OD-30 option a). Consequence for OD-08: because the relevant wording is identical in June and July, the withdrawal design does not depend on which edition an event uses, **as long as the profile records the edition**; if a later edition changes III.D.30, a new profile version and new register entries are needed (new engine version, never an edit of an old one).

### 3.3 Candidate status of the July edition

The July 2026 edition is recorded as a **candidate, unreviewed** document in a note under the source registry (`governing-body-source-registry.md`, section "Candidate editions"). It is **not** added to the registry table, **not** `authoritative`, and the June row is unchanged. No register entry cites it. Adopting it (a new registry row, status change, new profile version) is a reviewed owner decision under OD-30.

## 4. What the product does today

- **A6** (`20270120095000_competition_cf1_a6_withdrawal.sql`): withdrawal/reinstatement of an advanced couple is two-step (requester with verified email and `manager` round role, then a distinct co-signer; `cosigned_by <> requested_by`). `_cf1_a6_precheck` refuses with `COMP_ADVANCEMENT_FINAL_STARTED` once the round is not `draft`/`scheduled` or any Final heat is `staging`/`active`/`complete`; `COMP_WITHDRAWAL_BALLOTS` once ballots exist; `COMP_ADVANCEMENT_BELOW_MINIMUM` below two eligible couples (OD-15 A); no replacement (OD-18 A). It is a **pre-start roster change** for callback Finals and is deliberately left as is.
- **Engines `@1`** (`studioCallbackTally.ts`, `studioOrdinalMajority.ts`; `engine-spec-ordinal-majority.md` V13, K1 X-5): scratched, no-show (and CF1 A3 "excluded") entries are in `context.excludedEntries`, removed before ranking, listed in the trace and warnings, **never placed last**; a ballot that still ranks an excluded entry fails V7/V8. The engine runs **once per dance** (X-6); a combined multi-dance result is not supported and fails closed (Multi-Dance hold).
- **PV-1** (`20270215090000_competition_pv1_result_recompute.sql`): `_comppv1_verify` recomputes every result in SQL from the evidence document and refuses `COMP_RESULT_RECOMPUTE_UNSUPPORTED` when the pinned engine has no SQL port. Therefore **a new engine without an exact SQL port cannot store results at all**.
- **Scoring registry** (`scoring/registry.ts`, SQL registry table): `ndca_skating@unpinned` is `unavailable`, `engineId: null` ("No authoritative algorithm source"). Entries are frozen; a change is a new version.
- Heat entry statuses today: `scheduled`, `checked_in`, `scratched`, `danced`, `disqualified` (+ NS1 no-show); nothing records *which dance* of a multi-dance heat a couple did or did not perform.

## 5. Policy design

### 5.1 Scope and gating

- Applies only to a round of an event whose rules profile is a **verified NDCA scoring profile** (does not exist; prerequisites in section 9) and whose round is a **Final** in `active`/`ballots_locked` with at least one Final heat started. Studio/Custom, UCWDC and WSDC events never see the action; calling it fails closed (`COMP_NDCA_WITHDRAWAL_PROFILE`).
- DanceFlow definition of "final round commences" (**DanceFlow policy**, because III.D.30 does not define it): the first Final heat has left `scheduled` (reaches `staging`/`active`), matching A6's "started" test. Before that moment A6 remains the route.

### 5.2 Withdrawal record (reason codes, no medical data)

A withdrawal is a **recorded official action**, not a heat-entry status edit and not a scratch.

- `reason_code` (closed list, DanceFlow policy): `injury`, `illness`. No free text; no diagnosis, body part, symptoms, medical document or note field exists. III.D.30 names only "injury or illness"; any other reason is not a III.D.30 withdrawal and is refused (it stays a scratch/no-show under Studio-style handling or is not allowed for an NDCA Final, see Q5).
- `declared_dances_not_performed`: derived by the system, not typed (5.3).
- Actors: **requester** (authorized official, DanceFlow policy; proposed: event `manager`, verified email, exactly the A6 requester check) and an **independent confirmer** (a different person, verified email; `confirmed_by <> requested_by`, mirroring A6 `cosign_check`). Who may confirm (an NDCA Chairman mapping, a designated official, or any other manager) is Q2; the `chair` role is not assumed equal to the NDCA Chairman.
- Both halves are recorded; the withdrawal takes effect **only at confirmation**; a pending request can be cancelled by either actor with a recorded code (A6 cancellation pattern); a request goes stale if the round state it was bound to changes.

### 5.3 "Dances not performed" (requirement 3)

Per-dance scoping is the core of the requirement: a couple that dances dances 1-2 of 5 and then withdraws keeps its marks and placements for 1-2 and receives last place for 3-5 only.

- The system takes the ordered list of dances of the Final from the heat's dance sequence (10D heat dances) and records, at confirmation, the **first dance not performed** (`first_unperformed_sequence`) chosen by the requester from that list and confirmed by the confirmer. The unperformed set is that dance and every later dance of the round. The set is stored as a snapshot (dance ids), never recomputed.
- A couple is never marked unperformed for a dance whose heat has completed with that couple on the floor (`danced`); the confirmation refuses a first-unperformed dance that precedes any dance already completed with the couple (`COMP_NDCA_WITHDRAWAL_DANCE_ALREADY_DANCED`).
- III.D.30 gives no rule for leaving **during** a dance. Proposed DanceFlow policy (Q3, not approved): a dance the couple did not complete is treated as not performed, and the dance counts as performed only if the couple finished it; the official records which.

### 5.4 Audit fields

Each action stores: event, round, entry, requested/confirmed by (user ids) and their roles at the time, reason code, first unperformed dance + snapshot, the dances already performed, the result version/evidence hash in force, request id (idempotent), transaction id, timestamps. Rows are insert-only evidence under `protect_competition_history_evidence()` (RLS on, no grants), like A6.

## 6. SQL design (no file added; proposed shape, names provisional)

### 6.1 New objects (new migration block, number not reserved; coordinate with OD-04/OD-05/OD-07 blocks)

- `event_competition_final_dance_withdrawals` (insert-only): `id`, `event_id`, `round_id`, `entry_id`, `reason_code` (check in `'injury','illness'`), `first_unperformed_dance_id`, `unperformed_dance_ids uuid[]` (snapshot), `performed_dance_ids uuid[]`, `requested_by`, `confirmed_by` with `check (confirmed_by <> requested_by)`, `confirmed_role`, `request_id unique`, `evidence_hash_at_confirm`, `transaction_id`, `at`. Unique `(round_id, entry_id)` for an active row. FKs `(round_id, event_id)` and `(entry_id, event_id)` as A6; `on delete cascade` via the event, and added to the OD-04 `_compod04_evidence_tables()` list.
- A pending-request table and a cancellation table cloned from A6's pattern (`..._requests`, `..._request_cancellations`), same protection triggers.
- Writer RPCs (security definer, `lock_timeout`, same lock order as A6): `request_ndca_final_withdrawal(round, entry, reason_code, first_unperformed_dance, request_id)`, `confirm_ndca_final_withdrawal(request_id)`, `cancel_ndca_final_withdrawal_request(...)`; reader `ndca_final_withdrawal_state(round)`. Authorization helpers reuse `_compe2_round_role` and `_cf1_a6_can_manage`-style checks; the role map for the confirmer is Q2.
- A guard like `cf1_guard_withdrawn_heat_entry` so a withdrawn couple cannot get a new heat entry in the round and a later `scheduled`/`checked_in` write cannot revive it.

### 6.2 A6 refusal `COMP_ADVANCEMENT_FINAL_STARTED`

**Left unchanged.** A6 stays "a roster change before the start, Studio-compatible, OD-15/OD-18". The NDCA after-start withdrawal is a **different action** with its own functions and codes; no relaxation of A6, no new branch inside `_cf1_a6_precheck`. A6 additionally refuses `COMP_WITHDRAWAL_NOT_CALLBACK_FINAL` for a non-callback Final, while an NDCA Final may not be a callback Final (OD-09 undecided); the new action must not depend on `_cf1_is_callback_final`.

The new action must not apply OD-15's "fewer than two eligible couples" refusal in the same way: the withdrawn couple stays in the placement pool (it receives last places), so the number of ranked couples does not fall by the withdrawal. What to do if every other couple also withdraws, or only one couple danced a dance, is Q4.

### 6.3 PV-1 recompute

The database must be able to recompute the NDCA result including the withdrawal rule; otherwise `COMP_RESULT_RECOMPUTE_UNSUPPORTED` correctly blocks storage.

- New SQL port function(s) for the new engine key/version (see 7), e.g. `_comppv1_ndca_final(p_ev jsonb)`, dispatched from `_comppv1_run` by exact `engine_key@version` (the existing dispatch is by engine pin; a new key is a new branch, existing branches are not edited beyond the dispatch exact-fragment insert pattern PV-1 already used, with an md5-pinned preflight).
- The evidence document (`_compf2_evidence`) gets a new, additive, optional section `withdrawals: [{entryId, reasonCode, unperformedDanceIds[], confirmedAt}]` carried in the evidence hash. Evidence schema `@1` stays valid for Studio rounds (section absent); the NDCA engine requires it present (possibly empty). Because the evidence hash covers it, a result cannot be calculated with a withdrawal that is not in the audited table and vice versa.
- Equivalence evidence required before use: TypeScript engine and SQL port agree on golden fixtures and a seeded random corpus (the PV-1 pv1 harness pattern).

### 6.4 Audit and OD-07 coordination

- Withdrawal confirmations write a `competition_audit_log` event kind (`ndca_final_withdrawal_confirmed`, `..._requested`, `..._cancelled`) in the same transaction, like A6/F2.
- A withdrawal **after** a result is calculated/approved is a *new evidence input*: the existing result becomes stale (F2 invalidation) and a new version is calculated; it never edits a stored row. After completion, any change to the withdrawal or to the resulting placements is handled by the OD-07 correction case (`correction opened -> calculated -> approved -> published`), which already preserves prior versions, links `corrects_version_id`, and keeps the prior publication live. OD-08 adds no new correction mechanism. Open interlock (Q6): whether a recorded withdrawal can be *annulled* (for example recorded in error) only through an OD-07 case, with the original withdrawal row retained.
- Every new table is added to the OD-04 `_compod04_evidence_tables()` list (its test fails otherwise); the OD-07 body gate (`COMP_CORRECTION_BODY_ROLES_UNMAPPED`) already makes an NDCA correction wait for the chairman mapping; OD-08 inherits that.

### 6.5 What the app shows

Plain-language copy: "Recorded as an injury/illness withdrawal. DanceFlow records the reason code only; no medical information is collected." The result trace lists, per dance, `placed_by_withdrawal` with the withdrawal id, never a medical reason. Copy never claims the result is an official NDCA result until the NDCA profile is verified.

### 6.6 Studio/Custom preserved

No change to `studio_callback_tally@1`, `studio_ordinal_majority@1`, X-5, A6, NS1 no-show, scratch handling. A Studio-scored event with `competition_sanctioning = 'ndca'` is still governed by the OD-01 body gate and never gets the action, because the action requires the verified NDCA profile.

## 7. Versioned engine changes and the unresolved Skating System arithmetic (requirement 7)

The owner-approved behavior is NDCA-only, so it belongs in a **new** engine family, not in a Studio engine version:

- `studio_ordinal_majority@1` and `studio_callback_tally@1`: **never edited**; no `studio_*@2` is created for this.
- Registry: a **new** entry `ndca_skating` with a new version label (proposed form `<edition-pin>`, e.g. tied to the pinned edition and OD-30; **not** `unpinned`, which stays frozen, `unavailable`). `status` stays `unavailable` until every blocker in section 9 is closed.
- New engine module `results/engines/ndcaSkating.ts` (new file) with a new engine id (for example `ndca_skating@<edition-pin>`), its SQL port (6.3), its engine spec, fixtures and register entries.

Within that engine the withdrawal rule is one small, isolated step. What it needs, and what is **NOT SPECIFIED IN PROVIDED SOURCE**:

| Engine function (new, provisional name) | Purpose | What is missing (not invented here) |
|---|---|---|
| `rankDance(dance, marks, excluded)` | Per-dance final placement of the couples that danced (Skating rules for one dance) | The NDCA Skating System single-dance algorithm (majority, tie-break rules). III.D.11 only requires it. **OD-24 blocker.** |
| `placeWithdrawnLast(dancePlacements, withdrawnForDance)` | Assign last place to each couple withdrawn for that dance | Exact placement value (N, where N = number of couples that started the Final per IV.C.2?) and, for **two or more** withdrawn couples in one dance, whether they take N, N-1, ... (by what order: withdrawal time, entry order) or share a tied last place. III.D.30 is silent. Q1. |
| `combineDancesOverall(dancePlacements[])` | Overall result for the Final (the Skating multi-dance rules) | The Skating System's multi-dance total/tie rules, and whether a "last place by withdrawal" counts as an ordinary placement in them. Also **the product's Multi-Dance hold** (X-6): a combined result is not supported at all today. **OD-24 + Multi-Dance hold.** |
| `splitMarksForWithdrawn(ballots, unperformedDanceIds)` | Allow ballots of the dances a couple did not dance to omit that couple without V7/V8 failing | None from the rule book; DanceFlow design: the excluded set becomes **per dance** (today `excludedEntries` is round-wide). |

Required engine contract changes (new version only): `context.excludedEntries` gains a per-dance variant (`withdrawnByDance: {danceId -> entryIds}`), the trace lists each withdrawn couple and dance with `placed_by_withdrawal`, and the warnings include `withdrawn_last_place:<dance>:<entry>`. A couple withdrawn for a dance is still in the entry set for that dance (it gets a row with a placement), unlike scratched/no-show/excluded entries which receive no row.

No placement arithmetic in this document is derived from memory. Where the table says "missing", the implementation PR is blocked until the source text is obtained and pinned (OD-24 option c; contact with NDCA is an owner decision, not made here) or the owner approves an explicitly labelled DanceFlow policy for the gap.

## 8. Separation and boundaries

1. **OD-07** (corrections): see 6.4; design branch `claude/od07-corrections-design` read-only (case model, `corrects_version_id`, body gate, OD-04 list).
2. **OD-21** (III.D.31 replacement between rounds, minimum couples, single-couple divisions): not designed here. This action never inserts a replacement couple, never reads a "next eligible couple", and does not change A6/OD-18. A withdrawal between rounds stays an A6/OD-21 matter, and the new action refuses before the Final starts (`COMP_NDCA_WITHDRAWAL_NOT_STARTED`).
3. **OD-24, OD-01, OD-03, OD-06, OD-09, OD-30**: prerequisites, section 9.
4. **Disqualification** (`disqualified` status, IV/other NDCA rules) is a different outcome and is not routed through this action.

## 9. Dependencies and blockers

1. **OD-24**: NDCA Skating System text pinned, or an owner-approved labelled policy. Without it the new engine cannot exist (blocker for implementation, not for this design).
2. **A verified NDCA profile concept**: today `competition_sanctioning` is a disclosure the organizer sets; "verified" does not exist. The action needs an explicit profile flag (profile version, edition pin, effective date). OD-30.
3. **OD-09** (NDCA advancement structure) and the Multi-Dance hold (X-6): a withdrawn couple's dance-by-dance last places only become an overall result under multi-dance scoring.
4. **OD-06 / OD-15 role designations**: who may request and confirm; no mapping of `chair` to NDCA Chairman is assumed.
5. **OD-01** body gate and **OD-04** evidence-table list (merge order), **OD-07** correction case.
6. **PV-1 SQL port** of the new engine (6.3) and the evidence-schema addition.
7. **Owner decision on edition adoption** (OD-30): July candidate recorded only.

## 10. Test plan (for the later implementation PR)

- **Engine unit tests (golden fixtures from a pinned source only):** withdraw before dance 1 (last in all dances), after dance 2 of 5 (marks kept for 1-2, last in 3-5), two withdrawals in one dance (per Q1), withdrawal in the last dance, no withdrawal (output equals the plain NDCA engine), ballots that omit the withdrawn couple in unperformed dances accepted, ballots that rank it in a dance it did not perform rejected, determinism and trace stability. No fixture asserts arithmetic that the source does not give.
- **Equivalence:** TypeScript engine vs SQL port on fixtures plus a seeded random corpus (pv1 pattern, `scripts/qa/pv1/`).
- **SQL suites:** requester without verified email, non-manager, self-confirm, same user both halves, confirmer role missing, profile not NDCA (Studio event, UCWDC, WSDC), Final not started (refused, A6 route), reason code outside the list, any free-text field absent, first-unperformed before an already-danced dance, duplicate/idempotent request id, stale request after the round state changed, concurrent confirmations, cancellation, insert-only protection (update/delete/truncate refused), guard against reviving the heat entry, event delete cascade and OD-04 list membership, audit rows present and consistent, calculate before and after a withdrawal (new evidence hash; PV-1 refuses fabricated placements).
- **Regression:** Studio/Custom X-5 fixtures F1/F2 unchanged and green; A6 suite unchanged (still refuses `COMP_ADVANCEMENT_FINAL_STARTED`); `registry.test.ts` (`@1` frozen, `ndca_skating@unpinned` still unavailable).
- **Lifecycle (OD-07):** corrected result after a withdrawal creates a linked new version; prior versions and publication events retained.
- **E2E (Playwright, autonomous QA policy):** request, confirm, result shows per-dance placements and the copy; Studio event shows no such action.
- **Rule register:** entries `OD08-*` move from `requires_interpretation`/`unsupported` to `verified_compliant` only when implementation paths and tests exist.

## 11. Rollback

- SQL before app; rollback app first, then SQL. The rollback file drops the new RPCs, guard, tables and the `_comppv1_*` additions and restores the md5-pinned `_comppv1_run`; it **refuses while any withdrawal, request or cancellation row exists** (evidence is never destroyed), like A6.
- The registry entry stays `unavailable`; setting it back is the feature-off switch together with the profile flag. Existing Studio paths never reference the new objects, so an app-only rollback leaves them unaffected.
- Nothing hosted is touched by this PR; the design itself is revertable with the PR.

## 12. Questions for the owner (exact)

- **Q1.** Placement of withdrawn couples for a dance: if two or more couples withdraw for the same dance, do they take consecutive last places (ordered by what: withdrawal time, entry number?) or share one tied last place? III.D.30 is silent; nothing may be invented. Provide the NDCA text or approve a labelled DanceFlow policy.
- **Q2.** Who may **request** and who may **confirm** a withdrawal for an NDCA event (proposal: manager requests; a distinct, designated official confirms)? Do you approve mapping `chair` to NDCA Chairman duties for this confirmation (OD-06/OD-15, J-01)?
- **Q3.** Leaving mid-dance: a dance is performed only if the couple completed it (proposal), or is the official's recording authoritative?
- **Q4.** If all but one couple withdraw, or only one couple remains for a dance, what happens (refuse, allow, record only)? Is the OD-15 minimum of two eligible couples relevant after the start?
- **Q5.** A withdrawal after the start for a reason other than injury/illness: refuse (proposal), or route to the existing scratch behavior?
- **Q6.** May an incorrectly recorded withdrawal be annulled, and only through an OD-07 correction case?
- **Q7.** Should the unperformed dance be chosen by the official (proposal, confirmed by the second person) or derived from heat progress that does not exist today?
- **Q8.** OD-30: who approves moving NDCA events from the June to the July 2026 edition, and from what date? (The text OD-08 depends on is identical.)
- **Q9.** NDCA Skating System text (OD-24): obtain and pin it, approve a labelled DanceFlow policy, or leave NDCA scoring unavailable?

## 13. Rule-register entries

Added with this PR: `OD08-NDCA-0001` (III.D.30, `requires_interpretation`), `OD08-NDCA-0002` (III.D.31, separate, `requires_interpretation`, OD-21), `OD08-DF-0001` (reason codes and independent confirmation, DanceFlow policy), `OD08-SILENT-0001` (rulebook silent: ordering of several withdrawals, mid-dance, "commences", arithmetic). All say design only; none claims compliance.

## 14. Verified vs not verified

Verified: June PDF SHA-256 matches the registry; III.D.11, III.D.30, III.D.31, X.A.1 and IV.C items 1.b, 2, 5-7 re-read in the June text; the July file was retrieved from NDCA's own rule-book page, hashed, and compared; code paths cited (A6, engines, PV-1, registry) were read on the base commit. Not verified: any NDCA effective date; whether July is final (v3 label; v2 of June seen in a search result only); NDCA's Skating System; how NDCA scrutineers treat a withdrawn couple's last place in totals; the DanceFlow heat-dance table names at implementation time (provisional here); the OD-07 branch is read-only and unmerged, so its names may change.
