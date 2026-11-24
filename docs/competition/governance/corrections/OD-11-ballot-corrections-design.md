# OD-11 design: judge-confirmed corrections of a judge's ballot

Status: **design only (docs only). Nothing is implemented, applied, merged, deployed or activated.**
Owner decision: OD-11, 2026-11-23, Option A (judge-confirmed ballot corrections), recorded in the retrospective audit decision list
(PR #795, `docs/competition/governance/audit/OWNER-DECISIONS.md` on `claude/comp-audit-owner-decisions`).
Base: `origin/release/website-embeds` at `49dbaee1b`. Governance: [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md); register entries `OD11-*`.

**Bottom line.**
1. Today a scorer or manager can replace a judge's marks on their own authority (section 3, G1-G4). The design closes every writer path with
   one database rule: **no ballot version 2 or higher exists unless a confirmation by the original adjudicator is bound to that exact version and to a
   hash of those exact marks.**
2. A scorer or manager can only **propose**. The chair can **authorize the workflow** but never confirm. Only the original adjudicator's own
   authenticated session confirms (sections 4.3-4.6).
3. Judge unavailable means **HOLD**; there is no override path. What "authorized resolution" can mean without inventing a bypass is limited to
   three outcomes (4.7). Whether any body-specific alternative may exist when the judge never confirms is an **owner question** (Q2), not decided here.
4. Tabulation/scoring errors never touch a ballot; they go to the OD-07 correction case (4.8).
5. Independent review findings (section 12, normative) amend sections 4-6. Implementation is **not started**. Blockers and ordering are in section 9; exact SQL dependencies in section 5; negative tests in section 6.

---

## 1. Owner requirements (traceability)

| # | Requirement (OD-11 decision text, abbreviated) | Where addressed |
|---|---|---|
| 1 | Any alteration of a judge's actual marks needs authenticated confirmation from the ORIGINAL adjudicator, linked to the precise replacement version | 4.5, 4.6, 5.1 |
| 2 | Scorer/manager may propose; cannot independently replace marks | 4.3, 4.4 |
| 3 | Chairman may review, refer, authorize the workflow; cannot substitute confirmation | 4.3, 4.4 |
| 4 | Judge unavailable: HOLD, no emergency override, no silent substitution; define held state, visibility, "authorized resolution" | 4.7, Q2 |
| 5 | Reasons distinguished: (a) transcription vs original evidence, (b) judge-confirmed marking/entry correction, (c) tabulation/evaluation handled by OD-07 without changing the ballot | 4.2, 4.8 |
| 6 | Preserve originals, replacement versions, reasons, identities, timestamps, confirmations as immutable evidence | 4.12, 5.1 |
| 7 | Independent review and role authorization for every replacement; no self-approval; no bypass of OD-05/06 | 4.3, 4.10 |
| 8 | Baseline for ALL events; NDCA requirements identified separately from DanceFlow policy | 2, 8 |
| 9 | Respect OD-10 confidentiality | 4.9 |
| 10 | Design first: exact SQL dependencies, role mappings, negative tests; coordinate with OD-07 and OD-12 | 5, 6, 4.8, 4.11 |

## 2. Rule evidence (re-read in the pinned PDFs on 2026-11-23; SHA-256 prefixes verified against the source registry)

Verified hashes: NDCA Rule Book June 2026 Master v1 `d1b73e1f...daa6`; WSDC Registry Event Rules 2026.1C `140caae7...d3b5`; UCWDC Couples v1-26-2026 `8a45ee58...4904`;
UCWDC ProPro/ProAm v1-26-2026 `d6257b65...db84`; UCWDC Scoring Format v16.9b `44290a06...b02f`. NDCA page numbers are PDF page indexes (the printed footer
numbers differ; where the audit's printed number is known it is given in brackets). Text was read from `pdftotext` output of the files themselves.

| Rule | What it says (own words) | What it does NOT say | Class |
|---|---|---|---|
| NDCA IV.C item 5 (PDF p.34, printed p.27) | The Chairman inspects marks after each heat and verifies they were correctly transcribed. | No procedure for who fixes a wrong transcription. | body rule |
| NDCA IV.C item 6 (PDF p.34) | The Chairman refers any score card requiring correction **to the adjudicator concerned**. | Does not say a scorer, manager or the Chairman may change the card. | body rule |
| NDCA IV.C item 7 (PDF p.34) | In matters of conduct of the competition, including questions on adjudicators' marking, the Chairman's decision is final. | Does not say the Chairman may alter a mark. Owner decision (3) is **stricter** than this text (see register `OD11-NDCA-0001`, `requires_interpretation`). | body rule + tension |
| NDCA **IV.B.6** (PDF p.33) | Adjudicators mark and sign score cards in ink and initial all alterations. | The audit list cites this as III.D.6; the text read is in **IV.B item 6** (Adjudicators' Conduct). | body rule |
| NDCA IV.D.1.c(10) (PDF p.36) | Judges mark and sign score sheets in ink and shall initial every alteration. | Defines no electronic equivalent of "initial". The audit list's IV.D.1.c(10) is correct (item 10 sits under IV.D.1.c "While judging"); an earlier draft of this design wrongly changed it. | body rule (paper) |
| NDCA V.B.4 (PDF p.38) | Competitors accept the markings as final; appeal only where the actual markings were incorrectly **evaluated**. | Does not define who corrects an incorrect evaluation. Anchor for class (c). | body rule |
| NDCA III.D.16 (PDF p.28), III.E item 2 (PDF p.32) | Only the Chairman and Scrutineer have direct access to the original marking sheets until the end of the competition; organizers keep the originals 30 days after the close for a discrepancy in the scrutineers' final markings. | These are the paper-original rules that class (a) evidence relies on; their enforcement belongs to OD-10 / OD-04 / OD-12. | body rule |
| WSDC 1.1 item 6 (PDF p.4) | Professional Members (event owners) must provide fair, unbiased and untampered competitions, judging and scoring. | An owner obligation, not a correction procedure. | body rule (general) |
| WSDC 3.4.5.b (PDF p.19, in the contest oversight list) | Judges decide independently; tampering with or altering contest scores is not allowed. | Does not say whether a judge's own later correction is "altering". Treated as `requires_interpretation`. | body rule |
| WSDC 3.4.9.b.i (PDF p.20) | Transfer of judges' paper score sheet results into the computer system must be audited by the Chief Judge and/or an approved scoring team, verified by a person other than the one inputting. | Does not define a post-entry correction. | body rule |
| WSDC Section 6 item 10 (PDF p.23) | A computerized scoring system should prevent tampering and/or changes to results by unauthorized users. | "Should": a recommendation. | recommended |
| UCWDC Couples / ProPro-ProAm II.N.1, II.N.3 (printed p.13) | Decisions of the judges, Contest Coordinator and Event Director are final; a challenge to a panel's results is made after the event to the Judge Review Board. | **No correction or alteration procedure.** | body rule |
| UCWDC Scoring Format Rule #8 part 1 (p.4) | When a tie proof fails, a scoring error occurred and earlier rules are re-calculated. | An in-contest tabulation check, not a ballot correction rule. Supports class (c) being a recalculation. | body rule |

**Searches that found nothing (stated honestly, marked unconfirmed).** In the UCWDC Couples, ProPro/ProAm and Scoring Format texts and in the WSDC text,
searches for correct/alteration/initial/erase/amend/tamper/re-tabulate found **no procedure for correcting a judge's ballot** (the only hits are the rows above).
For UCWDC and WSDC the absence is recorded as **NOT SPECIFIED IN PROVIDED SOURCE** (register `OD11-UCWDC-0001`). The UCWDC Judge Certification Code of Conduct is
not provided; it may contain one. Nothing in this design is a UCWDC or WSDC requirement unless this table says so.

**Separation of body requirements from DanceFlow policy.**

| Behavior | Source | Label |
|---|---|---|
| Original adjudicator is the one who owns every alteration of their own marks | NDCA IV.C.6, IV.B.6 / IV.D.1.c(10) (paper form) | NDCA-grounded; the electronic confirmation is DanceFlow's **electronic analogue**, not a rule text |
| Judge confirmation applies to **every** event, every body, Studio/Custom included | Owner decision OD-11 (8) | **DanceFlow policy** (baseline) |
| Chairman cannot confirm in the judge's place | Owner decision OD-11 (3) | **DanceFlow policy**, stricter than NDCA IV.C.7 |
| Independent transcription verifier (class a) | WSDC 3.4.9.b.i for WSDC paper transfers; NDCA IV.C.5 (chairman verifies) | body-grounded for WSDC/NDCA; **DanceFlow policy** for others |
| Hash binding, step-up authentication, hold state, no expiry | none | **DanceFlow policy** |

## 3. What the code allows today (traced on the base branch)

Paths are in `src/lib/supabase/migrations/` unless noted.

| ID | Code path | What it allows | Violates |
|---|---|---|---|
| G1 | E2 `enter_competition_paper_ballot` (`20270102090000_competition_e2_ballots.sql`, ~L1009) -> `_compe2_insert_ballot` (L799) | A **manager or scorer** enters ballot version n+1 for ANY assigned judge while the round is `active` or `ballots_locked` with `correction_open`; the only control is a free-text reason of 1-500 characters. `entered_by_official_id` is null when a manager does it. | OD-11 (1), (2) |
| G2 | A7 `_cf1_check_correction_ballot` (`20270120095500_..._a7_od13_correction_integrity.sql`, L335) | Applies only to `callback_yes@1`. For every other format (`ordinal_rank`, i.e. all heat ballots, finals included; `three_band` is not an approved format) it **returns null**: no cause, no co-sign, any valid replacement. | OD-11 (1), (7) |
| G3 | A7 `cosign_competition_correction` (L489) | For `judge_entry_error` any valid replacement ballot is allowed after a co-sign by a **chair or manager** (verified email, a person other than the opener). The judge is not asked. A manager can co-sign. | OD-11 (1), (3) |
| G4 | A7 `_cf1_a7_rule` (L285), cause `entry_exclusion` | The excluded pick is swapped for another couple. The choice of the replacement couple is a mark of the judge, yet the filer may be a scorer. | OD-11 (1) |
| G5 | E2 `_compe2_insert_ballot` | Reason is free text only; no reason class; judge self-corrections in an `active` round carry no classification. | OD-11 (5) |
| G6 | E2 audit `ballot_corrected` (`refs.fp`) | `fp = md5(marks text | reason | source)`: a weak, unsalted fingerprint, not a binding to an identity. | OD-11 (1) |
| G7 | E2 RLS `competition_ballots_manager_read`, `competition_ballots_scorer_read`; E2 `competition_marks_read` (L934-942) | Any manager and scorer reads every ballot's marks (OD-10 is changing this). A correction UI built on these reads exposes marks to non-authorized staff. | OD-11 (9) |
| G8 | F2 `open_competition_round_correction` (manager, reason) | Opening a correction is manager-only with a free reason; with A7 it is the gate for post-lock ballot replacement. | OD-11 (2), (7) |
| G9 | App `src/app/app/events/[id]/competition/ballots/actions.ts` (`enter_competition_paper_ballot` call, `reason` form field), `.../results/[roundId]/page.tsx` + `src/lib/competition/results/correction.ts` (co-sign panel) | UI and server actions expose the paper replacement and the manager/chair co-sign as the correction path. | follows G1-G3 |

What already protects evidence (kept): ballots and marks are insert-only with history triggers; a correction is a new version (`supersedes_id`, `version + 1`,
`COMP_BALLOT_IMMUTABLE` guard in `_compe2_guard_ballot_insert`); A7 stores original/replacement picks and a diff in `event_competition_ballot_corrections`;
every officials row has a non-null `user_id` with a verified email (E1), so **every adjudicator has an account that can authenticate**.
Hosted state of A7 (applied to DEV/PROD or not) was **not verified** by this session (no hosted access); the migration must preflight it.

## 4. Design

### 4.1 Principles

1. The **ballot of record is never edited**. A correction is a new version, created only through a bound, confirmed path.
2. **Content authority:** replacement marks are authored either by the original adjudicator (class b) or transcribed from the adjudicator's signed paper original (class a). In both, **the adjudicator's authenticated confirmation of the exact marks is what makes the version admissible.**
3. **Role authority is never content authority.** Chair/scorer/manager actions authorize and route; none of them supplies a confirmation, and the system never accepts "confirmed on behalf of".
4. **Fail closed and no expiry that applies something.** A proposal never auto-applies, never auto-expires into an alteration; time only produces visibility (ageing), not state change.
5. **Marks stay out of general views and logs.** Proposals and audit rows carry ids, codes, hashes and roles, never marks (4.9).

### 4.2 Reason classes (requirement 5)

| Class | Code | Meaning | Marks change? | Evidence required | Path |
|---|---|---|---|---|---|
| (a) | `transcription_error` | The recorded ballot does not match the adjudicator's signed **paper original** because of an entry error. Only for ballots with `source = 'scorer_paper'`; unavailable for `judge_web` (no paper original exists). | yes, to match the paper | paper-original reference, independent verifier who compared staged marks with the retained original (OD-12 contract, 4.11) | proposal with staged marks -> review -> authorize -> **judge confirms** |
| (b) | `judge_correction` (sub-codes `marking_correction`, `entry_correction`, `exclusion_repick`) | The adjudicator changes a mark or fixes their own entry; `exclusion_repick` is A7's `entry_exclusion` swap. | yes | none beyond the reason code (the judge is the evidence) | judge authors replacement under a proposal (post-lock) or self-corrects (pre-lock) |
| (c) | `tabulation_error` | Wrong calculation, ranking, tie-break, engine defect, wrong evaluation of correct marks (NDCA V.B.4 "incorrectly evaluated"). | **never** | n/a | **referral to the OD-07 correction case**; this workflow records the link only and can never produce a ballot version |

The classification is stored as a code (never inferred from the free-text reason). Code (c) is structurally unable to link to a replacement ballot, a staged
marks row or a confirmation (check constraint + trigger, 5.1). A mis-classified (a) cannot launder a substitution: class (a) needs `source = 'scorer_paper'`, a
paper-original reference, a verifier who is neither proposer nor judge, **and** the judge's own confirmation of the exact marks.

### 4.3 Roles and what each may do

Role names are the existing E1/E2 ones (`manager` = `can_manage_event_competition`; `chair`, `scorer`, `judge` = active officials rows; `_compe2_round_role`
returns the first match manager > chair > scorer).

| Action | Original adjudicator | Chair (official role `chair`) | Scorer (assigned to the round) | Manager (non-judge) | Anyone else |
|---|---|---|---|---|---|
| Self-correct own ballot while round `active` (class b) | **yes** (own session, step 4.6 level 1) | only if also that judge | no | no | no |
| **Propose** a correction | no (self-correct or ask the chair) | yes | yes | yes | no |
| Stage replacement marks (class a only) | no | yes **only if** also OD-10-authorized to read marks | yes (the transcriber role) | **no** (OD-10: no automatic ballot access) | no |
| Independent review | no | yes, different person from proposer | yes, different from proposer | yes, different from proposer; for class (a) only a person OD-10-authorized to see marks | no |
| **Authorize the workflow** (refer to the judge) | no | **yes** (event `chair` official) | no | **no** (see Q3) | no |
| **Confirm** replacement marks | **only the original adjudicator** (`officials.user_id = auth.uid()` of the ballot's official) | **never** | **never** | **never** | never |
| Place / lift a hold, withdraw a proposal | withdraw/decline own | yes | proposer only | yes | no |
| Apply a confirmed correction | yes (the confirm call applies atomically when the round state allows) | no | yes (deferred apply, supplies no content) | yes (deferred apply, supplies no content) | no |

Separation rules enforced in SQL: proposer != reviewer != authorizer where the roles are distinct duties of one proposal (one account may not hold two of
`proposer`, `reviewer`; the authorizer may equal the reviewer for class (a) only when that account is the `chair`, because NDCA IV.C.5 gives the Chairman the
transcription check; the authorizer is never the proposer); **none of proposer, reviewer, authorizer, applier may be the original adjudicator** except as the
adjudicator's own act; a person who is the original adjudicator's spouse/family/conflicted official under OD-05 states cannot act as reviewer or authorizer
(4.10). A person cannot act in two duties on one proposal even through different officials rows (identity is `auth.uid()`).

### 4.4 Workflow (state is derived from an append-only events table)

```
proposed ──review_passed──> reviewed ──chair_authorized──> awaiting_judge ──judge_confirmed──> confirmed ──applied──> applied   (terminal)
   │                           │                               │  │                              │
   └─withdrawn (terminal)      └─withdrawn                     │  └─judge_declined (terminal: original stands)
                                                               └─held <-> awaiting_judge (hold_placed / hold_lifted)
   any non-terminal state ──superseded──> (stale: the base ballot version changed; a new proposal is required)
```

- Class (b) after the lock: the judge, not the proposer, supplies the marks. `awaiting_judge` means "the judge may now submit a replacement under this
  proposal"; the judge's submission **is** the confirmation (bound at insert, `method = 'judge_authored'`).
- Class (a): staged marks exist from `proposed`; the judge sees the staged marks (own ballot only) and confirms or declines (`method = 'judge_confirmed_staged'`).
- Pre-lock (round `active`): the judge may self-correct without a proposal, with a reason code (class b); the confirmation row is created in the same
  transaction (`method = 'self_submission'`). A scorer or manager cannot replace a ballot in this window either (G1 closed).
- `applied` is allowed only while the round is `active`, or `ballots_locked` **and** `correction_open` (the existing E2/F2 gate; nothing here changes
  round status). If the round is calculated/approved/published, the manager opens the F2 correction **after** the judge's confirmation, so a published
  result is hidden only for the apply-and-recalculate window (the F2/F3 hiding rule is unchanged and is OD-07 Q4 / OD-22, flagged).
  After the round is `complete` the ballots stay immutable; see Q5.
- A proposal blocks **approval and publication** of its round while non-terminal (`COMP_BALLOT_CORRECTION_PENDING`, a blocker alongside `_compe2_round_blockers`
  and the F2 approve/publish pre-checks). Recommendation, owner decision Q4.
- At most one non-terminal proposal per (round, official, heat) (partial unique index on the proposals table's once-only terminal stamp).

### 4.5 What is bound and signed (requirement 1)

One row `event_competition_ballot_correction_confirmations` per replacement version (insert-only):

| Field | Content |
|---|---|
| `id`, `event_id` | ids |
| `proposal_id` | null only for `self_submission` |
| `original_ballot_id`, `base_version` | the ballot being replaced and its version (the one nothing supersedes at confirmation time) |
| `replacement_ballot_id`, `replacement_version` | the new row; `replacement_version = base_version + 1` (the E2 guard already requires version + 1) |
| `replacement_hash` | `sha256` over a canonical document: domain tag `df.ballot.replacement.v1`, `ballot_format@version`, `round_id`, `heat_id`, `official_id`, `replacement_version`, `base_version`, the proposal's `nonce`, and the marks sorted by `entry_id` (reuses `_compf2_canon` / `_compf2_sha256`) |
| `judge_user_id`, `official_id` | the confirming account, which must equal `officials.user_id` of the ballot's official (checked, not supplied) |
| `confirmed_at` | server `clock_timestamp()` |
| `auth_level`, `auth_at`, `session_ref` | how the session was authenticated (4.6), derived from the JWT/session, never supplied by the caller |
| `statement_code` | version id of the on-screen attestation text the judge accepted ("I confirm these are my marks for this heat and round"); the text itself lives in app code and is hashed into `statement_hash` |
| `method` | `self_submission` / `judge_authored` / `judge_confirmed_staged` |
| `request_id` | idempotency key (unique) |

Rules: the hash is **recomputed server-side** at the insert of the replacement ballot from the actual marks rows; a mismatch raises
`COMP_CORRECTION_HASH_MISMATCH` and the whole transaction rolls back. The staged marks are insert-only, so a change needs a new proposal (the old one becomes
`superseded`). **The per-proposal random `nonce`** (stored with the staged marks, never in an audit/log row) means a hash exposed in logs cannot be brute-forced
back to the marks (the mark space is small). The audit and event tables carry the hash and ids only, never marks, free text or the nonce.

### 4.6 Authentication strength

| Level | Used for | Requirement (derived in SQL from the JWT, not accepted from the client) |
|---|---|---|
| 1 | `self_submission` pre-lock (the same act as the first ballot) | Existing: `auth.uid()` is the official's `user_id`; active official; verified email (`verified_email_for_user`). |
| 2 | `judge_confirmed_staged` and every `judge_authored` post-lock submission | Level 1 **plus** a fresh authentication: `auth.jwt()->>'aal' = 'aal2'` (a second factor) **or**, for judges with no enrolled factor, a sign-in whose `amr` timestamp is within `N` minutes (proposed 10, owner-tunable constant `_cf11_fresh_seconds()`), pattern as `_tw4price_*` in `20270210090000_twilio_price_dual_control.sql` and `20261231090000_twilio_platform_admin_aal2.sql`. Refusal code `COMP_CONFIRMATION_REAUTH_REQUIRED`; the page offers re-sign-in. |

Two-factor enrollment as a **requirement** for every judge is not assumed (it would change officiating onboarding); Q7 asks. Where a judge cannot reach level 2 the
proposal stays `awaiting_judge` / `held`; there is no lower-strength alternative.

### 4.7 Held state, visibility, and "authorized resolution" (requirement 4)

**When a proposal is held.** An authorized person (chair, manager, or the proposer) records `hold_placed` with a code: `judge_unreachable`, `judge_not_present`,
`judge_cannot_reauthenticate`, `judge_considering`. A proposal also shows as **held-by-age** (display only) after a configurable number of days; ageing never changes state.
While held: **no ballot version is created**, the original stays the ballot of record, results are computed on it, and the round's approval/publication stays blocked (4.4).

**Who sees what.**

| Viewer | Sees |
|---|---|
| Original adjudicator | their own proposal in full, including staged marks (class a) and the free-text reason |
| Chair | proposal list with code, class, status, hold code, ages, proposer/reviewer ids; **marks only if OD-10-authorized**; free text only if authorized |
| Manager, other scorers | ballot id and heat label, reason **code**, status, hold code, ages; **no marks, no staged marks, no free text** (OD-10) |
| Proposer, reviewer | what they staged/reviewed (scorer transcriber sees staged marks); not the judge's original marks unless OD-10-authorized |
| Entrants, public | nothing |

**What "authorized resolution" means: exactly these three outcomes, and no others.**

1. **R1: the original adjudicator confirms or declines** through their own authenticated session (level 2). Confirm leads to `applied`; decline ends the proposal and the original stands.
2. **R2: the proposal is withdrawn** (by the proposer, or by the chair/manager with a recorded reason). No ballot changes; the original stands.
3. **R3: the proposal is superseded** because the base version changed or the proposal was wrong; a new proposal starts the workflow again from the beginning.

There is **no** emergency override, no "chair confirms in absentia", no manager/owner confirmation, no break-glass role and no database function that inserts a
version-2 ballot without a bound confirmation (5.1 backstop). If the judge can **never** confirm (unreachable, refuses contact, unavailable permanently) the
original ballot remains final under this design. Whether a body-specific alternative may exist for that case (for example the NDCA Chairman's final decision
under IV.C.7, a WSDC Chief Judge decision, or the UCWDC Judge Review Board after the event) is **not answered by the rulebooks supplied and is not
invented here: Q2**.

### 4.8 Class (c): boundary with OD-07 (PR #838) (requirement 5c, 10)

- A `tabulation_error` proposal has **no staged marks**, no confirmation and no apply step; its only outcome is `referred_to_correction_case` with an
  `od07_case_ref uuid` (nullable, **no foreign key** until OD-07's table exists; a later migration adds it). It is a pointer for the audit trail.
- OD-07's invariant stays: its recalculation must use the **unchanged locked ballots** (`COMP_CORRECTION_BALLOTS_CHANGED`). A ballot version created by this
  workflow after an OD-07 case exists is exactly what that tripwire refuses; OD-07's case pre-checks list "no open OD-11 proposal for the round" (a requirement this design places on OD-07; its draft does not yet list it).
- OD-07 left "ballot alteration" unbuilt and said so (its section 4.5, Q9). This design is that missing piece **for the pre-completion window only**.
  The post-completion combination is Q5.
- Direction of travel the owner should know: for the common real-world cause, a judge's entry or transcription error, OD-07 alone has narrow use (its own
  finding); this workflow gives it a path before completion.

### 4.9 OD-10 confidentiality contract (requirement 9)

The OD-10 design (session `od10-ballot-visibility`) was **not yet published** when this was written; this design states what it needs, to be aligned when OD-10 lands.

- Needs from OD-10: one predicate `can_read_ballot_marks(round_id)` (name to be fixed by OD-10) and an audited retrieval RPC. Until it exists, the OD-11
  policies fail closed: staged marks are readable only by the original adjudicator.
- Proposal rows (header, events) contain **no marks and no free text**. They are readable by managers, chairs and scorers of the event through a **column-restricted read RPC**
  (`list_ballot_corrections(p_round_id)`) returning ids, codes, statuses, roles and ages. The table has no direct `SELECT` grant to `authenticated`.
- Staged marks table and the free-text reason are readable only by: the original adjudicator, the proposer and reviewer for class (a), and OD-10-authorized
  roles; every read of staged marks goes through `get_ballot_correction_marks(p_proposal_id)` (security definer) which writes an OD-10 retrieval audit row
  (actor, event, scope, timestamp, purpose `correction_review`), no marks copied.
- A manager who is not OD-10-authorized proposes class (b)/(c) by ballot id and code only; they never need the marks. This is why class (b) puts the marks in the judge's hands.
- Direct-SELECT bypass: because the OD-11 tables have no `SELECT` grant and no permissive RLS policy, the only read routes are the audited RPCs above (the same
  bypass-closing approach OD-10 requires for ballots).
- Notifications to the judge ("a correction was proposed for your ballot") carry the heat label and reason code, never marks.

### 4.10 OD-05 / OD-06 controls (requirement 7)

- Reviewer and authorizer must each pass the OD-05 conflict check for the round (`_compoc_conflict_state`, PR #834) and must not be the subject of an open
  conflict declaration for the judge's panel; a reviewer who is the judge's relative, student or partner (as OD-05 detects/declares them) is refused (`COMP_CORRECTION_CONFLICT`).
- WSDC-declared events: the same OD-06 designations (`event_competition_role_designations`, PR #834 section 6A) apply: a designated Event Owner/Event Director
  cannot propose-with-marks, review or stage (scoring functions, 3.4.1); the Chief Judge may authorize and may verify a paper transfer (3.4.9.b.i, 2.3) but cannot be
  the person who stages the marks (3.4.3). Without a valid attestation the operation fails closed (`COMP_WSDC_DESIGNATIONS_REQUIRED`, reused code).
- NDCA/UCWDC-declared events: the authorizer is the event's `chair`. The NDCA Chairman = DanceFlow `chair` mapping and the UCWDC Contest Coordinator mapping are
  **not approved** (audit row J-01, OD-06/OD-15, OD-07 Q8). Until mapping is approved, body-declared events fail closed
  (`COMP_CORRECTION_BODY_ROLES_UNMAPPED`, the same code and reason as OD-07 section 5). Studio/Custom (`none`/`other`): authorizer is the `chair` official; with no
  chair the workflow cannot proceed (Q3 asks whether OD-07's "designated independent reviewer" may stand in).
- No self-approval anywhere: SQL checks compare `auth.uid()` across proposer, reviewer, authorizer, applier and judge on the same proposal.

### 4.11 OD-12 coordination (paper ballots)

No OD-12 design was available when this was written. The class (a) contract this design **needs and defines for OD-12 to align with**:

- Proposal field: `paper_original_ref text` (a retention locator, no marks). Verification identity and time live only in the OD-12 verification table (OD-12 section 11, finding 2), not on the proposal.
- The reviewer compares staged marks with the retained signed original (NDCA III.D.16 access is limited to the Chairman and Scrutineer until the end of the
  competition, so for NDCA events the reviewer is the Chairman/Scrutineer role; for others a scorer or chair different from the transcriber).
- If OD-12 adds a "verified by" column to first-time paper ballots (WSDC 3.4.9.b.i), class (a) reuses the same person rule (verifier != inputter) and the same
  retention checklist; the two migrations must agree on one naming. **Ordering: OD-12's migration, if it adds columns to `event_competition_ballots`,
  lands before the OD-11 enforcement migration (section 9).**
- A paper ballot whose original was destroyed or never retained cannot use class (a); it can use class (b) (judge confirms) or stay as is.

### 4.12 Audit and immutability (requirement 6)

- New insert-only tables use the existing `protect_competition_history_evidence` triggers (ENABLE ALWAYS, plus truncate guards) exactly as A7's three tables.
  Every state change writes one row in `event_competition_ballot_correction_events` (kinds: `proposed, reviewed, authorized, hold_placed, hold_lifted,
  judge_confirmed, judge_declined, applied, withdrawn, superseded, referred_to_case`) with ids, roles-at-the-time, codes, hashes and timestamps, **no marks and no free text**, in the same transaction.
- `competition_audit_log` (F2 unified read) gains the new kinds so one timeline shows ballot v1, proposal, review, authorization, hold, confirmation, v2.
- Original ballot rows, every version, A7 `event_competition_ballot_corrections` (diff rows) and the new rows are preserved and never updated; the only mutable
  stamp is the proposal's once-only terminal outcome (the F3 publications precedent).
- The new tables must be added to OD-04's `_compod04_evidence_tables()` list (PR in worktree `od04-event-delete-guard`, migration `20270219090000`), whose own suite fails for an unlisted table reachable from `events`.

## 5. Exact SQL dependencies (design level; nothing written, nothing applied)

### 5.1 New objects (one migration block; proposed numbers in section 9)

| Object | Notes |
|---|---|
| `event_competition_ballot_correction_proposals` | id, event_id, round_id, heat_id null, official_id, ballot_id (the ballot being corrected), base_version, reason_class (`transcription_error` / `judge_correction` / `tabulation_error`), reason_code, reason_text (<=500, restricted read), proposed_by, proposed_role, paper_original_ref null, nonce (restricted), od07_case_ref null, request_id unique, once-only terminal stamp (`outcome`, `outcome_at`) allowed by the history trigger exception. CHECKs: class (c) forbids staged marks; class (a) requires the source ballot `source = 'scorer_paper'` and `paper_original_ref`. Partial unique: one open proposal per (round, official, heat). |
| `event_competition_ballot_correction_staged_marks` | insert-only (proposal_id, entry_id, mark jsonb); exists only for class (a); no grants, restricted RPC read; marks validated by the **existing** `_compe2_validate_marks` / `_compe2_validate_callback` at staging time so an invalid staged ballot is refused early. |
| `event_competition_ballot_correction_events` | insert-only lifecycle log (4.12); the proposal's state is the latest non-hold event. |
| `event_competition_ballot_correction_confirmations` | insert-only binding (4.5); unique(`replacement_ballot_id`), unique(`request_id`), unique(`proposal_id`) where not null. |
| RPCs (security definer, pinned `search_path`, request-id idempotent, `authenticated` only, verified email) | `propose_ballot_correction`, `review_ballot_correction`, `authorize_ballot_correction`, `place_ballot_correction_hold`, `lift_ballot_correction_hold`, `withdraw_ballot_correction`, `confirm_ballot_correction` (judge, level 2; applies atomically when the round state allows), `apply_confirmed_ballot_correction(proposal_id, request_id)` (deferred apply; **takes no marks**), `submit_competition_ballot_correction(proposal_id, marks, request_id)` (judge-authored class b, level 2), `list_ballot_corrections(round_id)`, `get_ballot_correction_marks(proposal_id)` (audited, OD-10), `record_ballot_correction_referral(proposal_id, od07_case_ref)`. |
| Helper functions (no grants) | `_cf11_replacement_hash(...)` (uses `_compf2_canon`, `_compf2_sha256`), `_cf11_session_level()`, `_cf11_fresh_seconds()`, `_cf11_may_act(proposal_id, duty)` (role + separation + OD-05/06 checks), `_cf11_check_replacement(...)`, `_cf11_bind_replacement(...)`. |
| Backstop trigger | DEFERRED constraint trigger `cf11_backstop_ballot` AFTER INSERT on `event_competition_ballots`: every row with `supersedes_id is not null` must have exactly one confirmation row with matching `replacement_ballot_id`, `replacement_version`, hash recomputed from the stored marks, and `judge_user_id = officials.user_id`; ENABLE ALWAYS. Same shape as A7's `cf1_a7_backstop_ballot`, so **no writer (RPC, service role, import) can create a version >= 2 without a confirmation.** |
| Rollback | drops new objects in reverse; **refuses while any proposal or confirmation row exists** (A7 rollback precedent) and states what it cannot undo. |

### 5.2 Existing functions and objects that change

| Object | Change | Why |
|---|---|---|
| `_compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)` | One more md5-pinned anchor insertion on top of A7's three (technique `pg_temp.cf1a7_pin_replace`): after the `v_prior` block call `_cf11_check_replacement(...)` (early, readable errors); after the marks INSERT call `_cf11_bind_replacement(ballot_id, request_id, ...)`, which writes the confirmation row (self-submission) or matches the staged confirmation. The pin must be taken from the **applied** chain and fail the preflight if the md5 differs. Correlation key is the existing `p_request_id`; no signature change. | single writer of ballots |
| `enter_competition_paper_ballot` | Refuse with `COMP_BALLOT_CORRECTION_USE_PROPOSAL` when a current ballot exists for that judge/heat (version >= 2 is never created here); first-time paper entry unchanged (OD-12 owns that). | closes G1 |
| `submit_competition_ballot` | Require `p_reason_code` for version >= 2; pre-lock self-correction allowed; when `ballots_locked`, require an authorized proposal id (`submit_competition_ballot_correction`). | closes G5, partial G2 |
| A7 `_cf1_check_correction_ballot` / `_cf1_a7_rule` | Remove the "any valid ballot after a co-sign" option (G3); keep the `entry_exclusion` content restriction (excluded picks only); extend the correction rule to **every** format so G2 closes (non-callback formats now require the same bound confirmation). | G2, G3, G4 |
| A7 `cosign_competition_correction` | Narrow allowed roles from `chair`/`manager` to `chair` (the authorization step above); it no longer unlocks replacement filing by itself. Existing rows are history and stay. | OD-11 (3) |
| A7 `_cf1_a7_filers` / opener-conflict rules | Keep: the opener of the F2 correction never files its replacement. | OD-05/06 |
| F2 `open_competition_round_correction` | Optional `p_proposal_id` (default null keeps today's behavior for OD-07-style/exclusion corrections); when given it checks the proposal is `confirmed`. No signature change if implemented as a separate wrapper. | sequencing 4.4 |
| E2 `_compe2_round_blockers`, F2 approve/publish pre-checks | New blocker `COMP_BALLOT_CORRECTION_PENDING` for non-terminal proposals (per Q4). | 4.4 |
| `competition_audit_log` | Union the new events table. | 4.12 |
| `event_competition_ballots` | **No column added** by this design (binding lives in the confirmation table), so OD-12/OD-10 can alter the table without a conflict. | ordering |

### 5.3 RLS and grants

- All four new tables: RLS enabled, **no policies, no grants** to `anon`/`authenticated`/`service_role` (A7's pattern); reads only via the RPCs above.
- Functions: `revoke all ... from public, anon, authenticated, service_role` on helpers; `grant execute ... to authenticated` only on the named RPCs.
- A negative test per table asserts `select` as `authenticated`, `anon` and `service_role` returns permission denied (see the QA-DB quirk noted in team memory: never call a revoked function as anon/service through PostgREST on the local QA database; use a dedicated Postgres container).

### 5.4 App layer (no SQL)

`src/app/app/events/[id]/competition/ballots/actions.ts` (replace the paper correction form with a proposal form; judge confirmation screen),
`.../results/[roundId]/page.tsx` and `src/lib/competition/results/correction.ts` (co-sign panel becomes the authorization panel, chair only; hold and pending panels),
`src/lib/competition/results/contract.ts` (`RESULT_READER_MATRIX`: new `ballot_corrections` reader row), message/code map. Copy rule: wherever the flow is shown,
state that the system records a judge's confirmation as an **electronic analogue** and that DanceFlow does not decide formal challenges.

## 6. Negative-test requirements (all required; positive controls alongside)

Each as a SQL suite on an isolated local Postgres under the heavy lock when implemented; **none run for this docs PR.**

1. **No bypass writer:** direct `insert` of a version-2 ballot as `postgres`/`service_role` without a confirmation row fails at commit (`cf11_backstop_ballot`). Same for a confirmation whose hash, version or judge does not match.
2. **Scorer cannot replace:** `enter_competition_paper_ballot` with an existing ballot raises `COMP_BALLOT_CORRECTION_USE_PROPOSAL` for scorer and manager, in `active` and in `ballots_locked + correction_open`, for `ordinal_rank`, `three_band` and `callback_yes`.
3. **Chair cannot confirm:** `confirm_ballot_correction` as chair, manager, scorer, event owner, platform admin: refused; as the judge's account: allowed. Also a chair who is **also a judge on another ballot** cannot confirm someone else's.
4. **Wrong judge:** another judge on the same panel cannot confirm; a judge whose `officials.status` is not active cannot confirm; a deactivated and re-added official row (different id, same user) is checked by the ballot's `official_id`.
5. **Self-approval matrix:** proposer = reviewer, proposer = authorizer, reviewer = judge, authorizer = judge, applier supplying marks: each refused with its code; same `auth.uid()` through two officials rows still refused.
6. **Hash binding:** staged marks edited after confirmation (impossible: insert-only; attempt via service role fails), replacement submitted with different marks than confirmed, replacement of a different heat/round/version, confirmation replayed against another ballot: each fails with `COMP_CORRECTION_HASH_MISMATCH` or the base-version check.
7. **Stale base:** base ballot superseded between proposal and confirmation: confirmation refused, proposal `superseded`.
8. **Reauthentication:** confirmation without aal2 and with an old `amr` timestamp: `COMP_CONFIRMATION_REAUTH_REQUIRED`; with a fresh one: succeeds. `auth_level` is derived from the JWT (a client-supplied value is ignored).
9. **Class (c):** a `tabulation_error` proposal can never have staged marks, a confirmation or an applied ballot (check constraint + trigger); OD-07's tripwire stays green.
10. **Class (a) laundering:** class (a) on a `judge_web` ballot refused; without `paper_original_ref` refused; verifier = transcriber refused; verifier not OD-10-authorized refused.
11. **Hold:** while held no version is created; hold cannot be lifted by the proposer into an apply without the judge's confirmation; no function path creates a version from a held proposal; round approval/publication blocked while the proposal is open.
12. **Confidentiality:** a manager/scorer who is not OD-10-authorized sees proposals only as ids and codes (`list_ballot_corrections`), cannot read `staged_marks` (permission denied), cannot read free text; no audit/event row contains a mark value, free text or the nonce (a canary mark value is searched for in every new table and in `competition_audit_log` output).
13. **OD-05/06:** a conflicted reviewer/authorizer refused; WSDC designated Event Owner/Director refused as stager/reviewer; chief judge refused as stager; body-declared event without approved role mapping refused.
14. **Pre-lock self-correction:** judge corrects own ballot in an active round with reason code: allowed, bound, hash recorded; without reason code refused; scorer attempt refused.
15. **Concurrency:** two open proposals for one (round, official, heat) refused; judge confirming while the proposer withdraws (deterministic outcome by lock order); two applies of one proposal create exactly one version; the lock order is documented next to the E2 pair lock and the F2 round lock.
16. **Rollback:** refused while rows exist; clean on an empty schema; schema fingerprint equals baseline.
17. **A7 regression:** the existing A7 suite still passes for `entry_exclusion` (now additionally requiring judge binding) and fails closed for formats without a rule.

## 7. NDCA requirements versus DanceFlow policy (summary)

- **NDCA text we rely on:** the Chairman verifies transcription and refers a card needing correction to the adjudicator concerned (IV.C.5-6); judges initial every alteration on paper (IV.B.6, IV.D.1.c(10)); markings are final unless incorrectly evaluated (V.B.4); original sheets are controlled and retained (III.D.16, III.E.2).
- **DanceFlow policy, not NDCA:** electronic confirmation as the analogue of "initial"; confirmation for **every** body and Studio/Custom; the chair cannot confirm even though IV.C.7 makes the Chairman's decision on marking questions final; hash binding; step-up authentication; hold state; pending-correction blockers.
- **Not found in WSDC or UCWDC** (as supplied): any correction procedure. Nothing here is presented as a WSDC or UCWDC requirement.

## 8. Rule register entries (this PR; all `requires_interpretation` / `unsupported`; nothing built, no compliance claimed)

`OD11-NDCA-0001` (IV.C.5-7), `OD11-NDCA-0002` (IV.B.6, IV.D.1.c(10)), `OD11-NDCA-0003` (V.B.4, class c), `OD11-WSDC-0001` (1.1 item 6 and 3.4.5.b),
`OD11-WSDC-0002` (3.4.9.b.i), `OD11-UCWDC-0001` (silent: no correction procedure found; II.N finality is OD07-UCWDC-0001), `OD11-DF-0001` (DanceFlow baseline policy).
Files in `docs/competition/governance/rule-register/rules/`. The `quote_free_summary` fields are paraphrases.

## 9. Migration ordering and unresolved dependencies

Latest migration on base: `20270218090000`. Claimed by sibling work (read-only): OD-04 `20270219090000` (local worktree); OD-05/06 `20270220090000-097000` (PR #834); OD-07
proposed `20270221090000-093000` (PR #838). **Proposed OD-11 block: `20270222090000`-`20270222093000` (not reserved; the Competition coordinator confirms; OD-10 has not claimed a block).**

| Proposed file | Content |
|---|---|
| `20270222090000_competition_od11_s0_tables` | four tables, RLS, history triggers, constraints; no behavior change |
| `20270222091000_competition_od11_s1_workflow_rpcs` | propose/review/authorize/hold/withdraw/list/referral RPCs, helpers, audit-log union |
| `20270222092000_competition_od11_s2_confirm_apply` | confirm/apply/judge-authored RPCs, session-level helper, hash helper |
| `20270222093000_competition_od11_s3_enforcement` | `_compe2_insert_ballot` pinned anchors, `enter_competition_paper_ballot` refusal, A7 narrowing, deferred backstop, pending blocker |

Hard order (amended by OD-12 section 11, finding 3): **OD-04, OD-05/06, OD-10, OD-12 s0-s1 (tables and helpers only, no ballot column), OD-11 s0-s3, then OD-12 s2 (blocker and lock/approve/publish anchors)**.
OD-07 is a soft dependency (the `od07_case_ref` has no foreign key). If OD-10 or OD-12 cannot land first, s3 does not ship (the fail-closed confidentiality default in 4.9 is acceptable only for dark events).
**Unresolved before PR-B:** (1) OD-10 and OD-12 designs; (2) the NDCA Chairman / UCWDC Contest Coordinator / WSDC Chief Judge role mappings (J-01, OD-06, OD-15); (3) answers Q1-Q8; (4) the hosted state of A7 and of PV-1; (5) the apply-while-published hiding behavior (OD-07 Q4 / OD-22).

## 10. Questions for the owner (exact)

- **Q1.** Class (a), a pure transcription error against a signed paper original, verified by an independent person: should the judge's confirmation be **required** (this design; recommended) or may the verified original itself suffice when the judge is unavailable? Allowing the latter creates an alteration without the judge's confirmation, which OD-11 (1) forbids; it is listed only because the NDCA Chairman checks transcription (IV.C.5).
- **Q2.** If the original adjudicator can **never** confirm (permanently unreachable, refuses, or the event is long over): is the original ballot permanently final (this design), or may a defined body-specific resolution exist (NDCA IV.C.7 Chairman's final decision, WSDC Chief Judge, UCWDC Judge Review Board referral)? The supplied rulebooks do not answer it and none is invented here.
- **Q3.** Who may authorize the workflow: the `chair` official only (this design)? For Studio/Custom events with no chair, may OD-07's "designated independent reviewer" stand in, and may a manager ever authorize (listed in A7 today, not in OD-11 (3))?
- **Q4.** Should a pending or held proposal block **approval and publication** of its round (recommended), or may a manager approve on the original ballot with an acknowledgement?
- **Q5.** After a round is `complete`, ballots stay immutable. If a judge's entry error is found then, do you want a combined design (OD-07 case carrying a bound OD-11 confirmation and a re-calculation) as a later step, or is post-completion alteration out of scope?
- **Q6.** Confirm the pre-lock rule: a judge may self-correct their own ballot while the round is `active` with a reason code, with the confirmation recorded automatically (the analogue of initialling an alteration), and a scorer or manager may not replace it in that window.
- **Q7.** Authentication strength: second factor (aal2) or a fresh sign-in within 10 minutes (this design), or require two-factor enrollment for every judge?
- **Q8.** Confirm that body-declared events (NDCA/UCWDC/WSDC) fail closed for this workflow until the role mappings (J-01, OD-06, OD-15) are approved, the same as OD-07.

## 11. Not verified / not done

No SQL was written or run, nothing was applied anywhere, no test was run (docs only), no hosted state was read. The OD-10 and OD-12 designs and the OD-04 migration (local, uncommitted in its worktree)
were read only as far as available; sibling PRs (#834, #838) were read as drafts and may change. The UCWDC Judge Certification Code of Conduct was not provided. NDCA page numbers are PDF indexes.

## 12. Independent review (a fresh reviewer that had not seen the conclusions): findings and resolutions

The reviewer read the staged design against E2, F2, A7, the app code, the pinned PDFs, PRs #834/#838 and the local OD-04 migration. It confirmed G1, G3, G4, G6, G8 and the rule paraphrases, and
found the defects below. **Section 12 is normative: where it differs from sections 4-6, section 12 wins** (earlier text is kept so the review trail is visible).

| # | Sev | Finding | Resolution (binding on PR-B) |
|---|---|---|---|
| 1 | blocker | A deferred apply cannot write an insert-only confirmation that carries the replacement ballot id and the judge's session facts; `request_id` correlation fails (the applier's id differs). | The confirmation is written **in the judge's own transaction** at confirm time, bound to (`proposal_id`, `original_ballot_id`, `base_version`, `replacement_version`, `replacement_hash`) with **no replacement ballot id**, auth facts taken there. At apply, the pinned anchor and the backstop match on `supersedes_id` = original ballot + version + recomputed hash; the ballot link is recorded in the `applied` event row. Correlation by `request_id` is dropped; 4.5's `replacement_ballot_id` and `request_id` fields change accordingly. |
| 2 | major | Confirmations prove only internal consistency, so "no writer can" in 5.1 overclaims: a superuser can forge both rows, and the service-role key can mint a judge session through the auth admin API, which would satisfy a "fresh sign-in" path; the cited `_tw4price` precedent requires aal2 with TOTP and a live-session check. | A BEFORE INSERT guard on confirmations requires `judge_user_id = auth.uid()` and derives the level inside the trigger. **Every confirmation requires aal2 plus a live-session check (the `_tw4price_session_actor` pattern); the "fresh sign-in without a factor" option is removed**, so second-factor enrollment becomes a requirement for judges who confirm. Residuals the owner must accept: superuser SQL and auth-admin impersonation cannot be blocked in the database, only detected by audit. 5.1 is reworded: no application or RPC path can create the version. |
| 3 | major | Marks and free text leak: `p_reason` is copied to `ballots.correction_reason`, `ballot_events.reason` and A7 `ballot_corrections.reason`; A7 `competition_round_correction` returns reason and pick diff to managers/chairs; E2 `refs.fp = md5(marks, reason, source)` is unsalted so managers can brute-force marks; self-submission has no nonce; A7 error details include picks. | Pass **only the reason code** as `p_reason` for every version >= 2; free text lives only in the restricted proposals table. A server-generated **nonce of at least 128 bits for every method** (self-submission included). New OD-10 dependency items: salt or drop E2 `fp`; restrict A7's read RPC to ids/codes; remove picks from `COMP_CORRECTION_BALLOT_RESTRICTED` details (counts only). Test 12 covers these. |
| 4 | major | `reopen_competition_round_ballots` returns `ballots_locked` to `active`, so a post-lock alteration could become an unreviewed level-1 self-correction; self-submission has no reviewer, against "every replacement". | **Self-submission is allowed only before the round's first lock** (a round that has ever been `ballots_locked` counts as post-lock even after a reopen; read from the E2 lock events). After any lock every replacement needs proposal, review, authorization and a level-2 confirmation. Negative test: lock, reopen, self-correct is refused. Pre-lock self-correction needs no reviewer because it is the judge's own act while the judge may still revise; flagged in Q6. |
| 5 | major | One-open-proposal index is wrong when `heat_id` is null; derived `superseded` never sets the terminal stamp and would block the replacement proposal. | Two partial unique indexes (heat scope, round scope) as E2 does; `superseded` and every other terminal outcome **write the once-only stamp** inside the E2 pair lock. |
| 6 | major | Lock order undefined; deadlock risk. | Fixed order: `_compe2_lock_pair`, then the proposal row `FOR UPDATE`, then the round `FOR SHARE`; the event advisory lock and round `FOR UPDATE` only in F2/A7 paths and never after the pair lock. Documented beside the A7/F2 orders; race test 15 must exercise it. |
| 7 | major | `_compe2_round_role` returns manager before chair, so a chair who is also a manager cannot authorize; a chair can judge, so the chair's own ballots could never be corrected; one active chair per event. | Authorization checks the **officials row** (`role = 'chair'`, active, `user_id = auth.uid()`), not `_compe2_round_role`. A chair cannot authorize a correction of their own ballot (self-approval): it stays `held` unless the owner approves a second authorizer (added to Q3). |
| 8 | major | OD-05 has no official-to-official relation, so "reviewer is the judge's relative" was invented. | Withdrawn as a claimed OD-05 behavior. It is a **new requirement for OD-05/06** (new owner question Q9). Until then only identity equality and OD-05's official-vs-competitor checks apply. |
| 9 | major | A7 cause `entry_exclusion` restricts apply to exclusion swaps if any exclusion occurred after the baseline; O5 refuses to open a correction once a later round has ballots; the A7 opener conflict applies; completing the round silently ends a proposal; A7 co-sign versus OD-11 authorization unclear. | New terminal outcome `unappliable` (codes `cause_restricts`, `later_round_ballots`, `round_completed`) recorded by the apply attempt, never silently. The A7 co-sign **is** the OD-11 authorization step (narrowed to the chair officials row); the A7 opener conflict is kept. `complete_competition_round` and starting a later round are blocked while a proposal is open. Known limitation reported to the owner: an exclusion swap and a judge's own correction cannot be combined in one F2 correction. |
| 10 | minor | Withdrawal rules contradict (diagram vs R2); a chair/manager could veto a judge-confirmed correction. | Withdrawal is allowed in `proposed`, `reviewed`, `awaiting_judge`, `held`, by the proposer or by chair/manager with a reason; **not after `confirmed`** (then only `applied` or `unappliable`). Every withdrawal and hold is an audited event. |
| 11 | major (rulebook) | The design wrongly changed the audit's IV.D.1.c(10) to IV.D.1.a(10); item (10) sits under c "While judging" (PDF p.36). | Corrected in sections 2 and 7 and in `OD11-NDCA-0002`; the audit's citation stands (checked in `pdftotext` headings: a Conduct at the event, b Dress code, c While judging). |
| 12 | minor | IV.C.5 applied to every body without a README step-3 justification; "Scrutineer" has no DanceFlow role; III.D.16 also limits the staging scorer; WSDC 3.4.1.a omitted. | The authorizer = reviewer allowance applies to **NDCA-declared** events only (body-grounded); elsewhere a separate reviewer is required (DanceFlow policy). The Scrutineer has no mapped role: an open mapping (J-01/OD-06/OD-15), not assumed. For NDCA-declared events the staging scorer must also be OD-10-authorized. 4.10 adds WSDC 3.4.1.a (spouses/family of the Event Director/Owner may not do chief-judge or scoring functions). |
| 13 | minor | `OD07-UCWDC-0001` exists only on PR 838's branch; the WSDC silence claim; no entry for WSDC Section 6 item 10; `governing_body: silent`. | Reference reworded to "PR 838". `silent` is kept because the integrity test requires it for `rulebook_silent` (the README's body-selection step is noted for the owner). WSDC Section 6 item 10 is a "should" that no behavior here relies on, so no entry is added (stated, not hidden). |
| 14 | minor | OD-04's guard filters every listed table by `event_id`; the staged-marks table has none; `_compod04_evidence_tables` is IMMUTABLE; the claim that OD-07 lists the pre-check was false. | **Every new table carries `event_id`**; listing them needs a pinned redefinition of `_compod04_evidence_tables`. 4.8 corrected: the pre-check is a requirement this design places on OD-07. |
| 15 | minor | The A7 SQL test and rollback pin a post-A7 md5; s3 breaks test 17 and rollback order; A7 helpers need pins; `p_reason_code` changes a signature. | The s3 rollback restores the A7 text first; the A7 suite is updated in the same PR-B; the new `submit_competition_ballot` overload is declared as a signature change; A7 helpers get their own pins. |
| 16 | nit | `three_band` unapproved; scorers read only assigned rounds; `results/actions.ts` omitted; F3 vs F2 wording. | G2 corrected; `results/actions.ts` (open and cosign RPC calls) is in the app-change list; publication is F3. |

New owner question **Q9:** OD-05 has no official-to-official relationship check (reviewer/authorizer related to the judge); should OD-05/06 add one, or is the proposer's declaration enough?
Q6 is now: pre-lock self-correction only before the first lock, with no reviewer; confirm. Q7 is now: confirm second-factor (aal2) enrollment as a requirement for judges (the fresh-sign-in alternative was removed).
