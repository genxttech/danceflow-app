# OD-10 design: ballot visibility before publication, designated ballot access, and an audited read path

**Status: DESIGN ONLY (docs).** Nothing is implemented, no migration file exists, nothing is applied or deployed, no compliance is
claimed. Owner decision OD-10 of 2026-11-23 (retrospective audit, PR #795): *Options A + C, with audit logging for all Competition OS
events*. Governed by [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md). Every rule citation below was re-read in the pinned PDFs on
2026-11-23 (SHA-256 of all five documents compared with the [source registry](../../governing-body-source-registry.md): match).

## 1. Owner requirements and where this document answers them

| # | Requirement (OD-10) | Section |
|---|---|---|
| 1 | NDCA-declared events: before the end of the competition, original adjudicator marking sheets and their sensitive electronic equivalents only for explicitly designated Chairman of Adjudicators and Scrutineer | 4, 5 |
| 2 | A generic scorer is not an NDCA-certified Scrutineer; a studio owner/manager is not the Chairman; designation is event-level (OD-06 model) | 5, 7 |
| 3 | Least-privilege baseline for Studio/Custom, WSDC, UCWDC, labelled DanceFlow policy; re-search the pinned WSDC/UCWDC text | 2, 4 |
| 4 | Owners/managers keep appropriate aggregated results without automatic individual-ballot access | 4.3 |
| 5 | Audit every authorized ballot retrieval, all competition types; no ballot contents in audit records | 6 |
| 6 | Enforcement across RLS, RPCs, routes, exports, admin paths; list reads that cannot be audited and close them | 8, 9 |
| 7 | Preserve immutable ballot evidence; coordinate with OD-04, OD-05/06, OD-07; list migration order and shared tables | 10, 11 |
| 8 | Record the NDCA original-copies rule versus DanceFlow's own electronic-ballot confidentiality policy | 3 |
| 9 | Design first, then an independent security review, findings and fixes recorded; exact role and SQL dependencies | 12, 13, 15 |

## 2. Rule evidence (pinned PDFs, re-read 2026-11-23)

Quote-free summaries; short phrases only. Page numbers are printed page numbers.

### NDCA (Rule Book June 2026, Master v1, SHA-256 `d1b73e1f…cdaa6`, authoritative)

- **III.D.16 (p.21)** [mandatory]: only the Chairman of Adjudicators and the Scrutineer have "direct access" to the original copies of the
  judges' marking sheets "until the end of the competition". It says nothing about managers, organizers, owners or other staff; it is
  silent on electronic ballots, and does not define "end of the competition".
- **III.D.12 (p.21)** [mandatory]: each adjudicator marks and signs a score card per heat; an organizer-appointed steward collects the
  cards and delivers them to the Scrutineer. The paper chain of custody runs judge, steward, Scrutineer.
- **III.D.17 (p.21)**: digital scrutineer sheets are made public after each day for completed events with announced results. That is a
  *publication* rule for a different artifact (scrutineer sheets, completed events), tracked by OD-23. This design does not implement or
  weaken it; the access model must leave room for it (section 4.5).
- **III.E.2 (p.25)**: the organizer retains the original score sheets 30 days after the event closes (OD-04 owns retention).
- **III.B.1.e (p.14)**: at every sanctioned event at least one NDCA-certified Scrutineer must officiate. **III.B.4 (p.16)**: the Scrutineer
  may not serve as Chairman of Adjudicators. So the two roles are distinct people.
- Reference only (nesting in the text extraction looks odd; confirm visually before relying on it): a clause on p.17 under III.C.3 says the
  Scrutineer performs the calculations for multi-dance events.

### WSDC (Registry Event Rules, version 2026.1C, SHA-256 `140caae7…d3b5`, authoritative)

- **Definitions, Raw Score Judge (p.3)** [mandatory role limit]: a Raw Score Judge "does not have access to scores" and makes no structural
  decisions. This is the only access limit found.
- **3.1 item 9 (p.12)**: results (rounds, placements, score reports) are posted at the event and open to competitors for at least 30 days;
  judges may be listed anonymously. A publication rule, OD-23.
- **3.4.9.b.i (p.20)**: transfer of paper score sheets into the computer system is audited by the Chief Judge or an approved scoring team,
  by a person other than the one inputting (OD-12). It implies those roles must read what was entered.
- **No clause found** that restricts who may read individual judge scores or ballots before results are posted.

### UCWDC (Couples 2026 v1-26-2026, SHA-256 `8a45ee58…7904`; ProPro/ProAm 2026 SHA-256 `d6257b65…04db84`; Scoring Format 2026 v16.9b SHA-256 `44290a06…b02f`)

- Full-text searches of the Couples, ProPro/ProAm and Scoring Format texts (terms: confidential, secret, privacy, disclose, reveal, access to
  scores/ballots, score sheet, judges' sheets/cards, anonymous, inspect) found **no clause restricting access to individual ballots before
  results**. Hits were unrelated (song reveal, costume, competitor data and privacy).
- **Scoring Format, General Information (p.8)**: the Divisional Scoring Analysis (DSA) report "must be available" to contestants for their
  divisions, adjudicators for the divisions they judge, contest coordinators for the divisions they coordinate, and named UCWDC officers
  for every event. The DSA is a derived, results-time report whose timing is not stated. It is a possible later body exception (OD-23),
  not a pre-publication ballot right. Rule #3.4 step 1 (p.3) shows judge names in a raw-score column "so revealed".
- Couples II.N.3 (p.13): challenges to panel composition or results are post-event, to the Judge Review Board. No access clause.

**Consequence.** Only NDCA has a body rule on ballot access, and it is about *original copies of marking sheets*. For Studio/Custom, WSDC and
UCWDC the pinned text is silent (`rulebook_silent`), so everything those events get is DanceFlow policy and is labelled so.

## 3. Rule versus policy (requirement 8)

| Layer | What it is | Class | Claimed as body rule? |
|---|---|---|---|
| NDCA III.D.16 | Original copies of marking sheets: direct access only for Chairman and Scrutineer until end of competition | `mandatory`, NDCA only | yes, for NDCA events |
| Reading III.D.16 onto an electronic ballot | The owner's decision treats a submitted electronic ballot (and derived stored copies) as a "sensitive electronic equivalent" of the original. The rule was drafted for paper. | `requires_interpretation`: DanceFlow applies the stricter reading by owner decision; not claimed as NDCA-mandated | **no** |
| Electronic-ballot confidentiality for ALL bodies | Least-privilege reads, designation, purpose, audit | `dance_flow_policy` | **no**, never shown as NDCA/WSDC/UCWDC text |
| Raw Score Judge has no access | WSDC role limit | `mandatory`, WSDC only | yes, for WSDC events with that designation |

UI, docs and tests must never describe the baseline as a governing-body requirement, and an NDCA event gets the NDCA behavior *in addition*.

## 4. Access model

### 4.1 Vocabulary

- **Ballot content**: marks, callback selections, judge drafts, and any stored derivative that carries per-judge attribution (the F2
  `evidence` document stored in `event_competition_result_versions.input`, and `trace`). Metadata (existence, version, source,
  submitted_at, lock state, counts) is *not* content.
- **Access classes of a database read**: **A** content retrieval (content returned to a caller); **B** derivation (content consumed inside a
  function to create or verify a stored or returned derivative, nothing raw returned: calculate, approve re-verify, recompute,
  advancement apply, correction co-sign checks); **C** integrity or metadata (triggers, version-chain guards, lock blockers, status
  counts). A and B are **audited retrievals**; C is exempt and must be on a reviewed exemption list (section 9.3).
- **Designation**: an event-level, attested assignment of a person (account required, verified email) to a ballot-relevant role. It is the
  OD-06 mechanism; a DanceFlow account role never confers it.

### 4.2 Who may read content (matrix)

"Designated" means an *active* designation of that kind on the event. Every granted read is logged (section 6) with a purpose.
"Window" = until the end of the competition (section 4.4).

| Actor | NDCA-declared | WSDC-declared | UCWDC-declared | Studio / Custom / other |
|---|---|---|---|---|
| Assigned judge (own ballot, own sheet) | own only | own only | own only | own only |
| Account owner / manager | **no content**, aggregates only | no content, aggregates only | no content, aggregates only | no content by account role; may be *designated* (4.3) |
| Generic scorer official (`role = scorer`) | **no content** (not a Scrutineer) | no content unless designated `scoring_operator` | no content unless designated `scoring_operator` | no content unless designated `scoring_operator` |
| Chair official (`role = chair`) | **no content** unless designated Chairman of Adjudicators | no content unless designated Chief Judge | no content unless designated reviewer | no content unless designated reviewer |
| Designated Chairman of Adjudicators (NDCA) | content, all rounds, purposes in 6.2 | n/a | n/a | n/a |
| Designated Scrutineer (NDCA) | content, all rounds | n/a | n/a | n/a |
| Designated Chief Judge / Secondary Chief Judge / scoring operator (WSDC, OD-06 kinds) | n/a | content (calculation, paper audit, finalist review) | n/a | n/a |
| Designated `scoring_operator`, `ballot_reviewer` (new, DanceFlow policy) | not applicable (NDCA uses its own roles) | scoring operator only (OD-06 kind) | content | content |
| WSDC Event Owner / Director / family designee | n/a | **no content, ever** (this also answers #834 Q11 as policy) | n/a | n/a |
| WSDC Raw Score Judge designee | n/a | **no content** (body limit) | n/a | n/a |
| Entrant, public, other tenant | none | none | none | none |

Fail closed: an NDCA-declared event with no active Chairman/Scrutineer designation allows **no** content read by anyone but the judge for
their own ballot; calculation is blocked (consistent with OD-01, which already blocks NDCA approval and publication, and OD-09, which keeps
an NDCA profile blocked).

### 4.3 Aggregates for owners and managers (requirement 4)

Always available to managers: ballot **status** (who has submitted, version, source, time, lock state, blockers), calculated/approved
result rows and placements, callback counts per entry *after* a result version exists, publication state. Managers may calculate and approve
via the existing RPCs (class B) **only** where the operation's own permission allows it; they never receive raw marks. A manager who needs
content (small studio event, dispute) designates themselves or a reviewer through an RPC that writes an immutable designation row and an
audit row. This is *not* automatic and is visible; it is allowed for Studio/Custom/UCWDC as DanceFlow policy, and refused for NDCA events
and for WSDC kinds that OD-06 separates (G1, G3).

### 4.4 "End of the competition" (open)

NDCA does not define it. Recommendation (DanceFlow policy): an event-level `competition_closed_at`, set once by an authorized actor
(NDCA: the designated Chairman; others: a manager) through an RPC, never inferred from the calendar, and not settable while any round is
not terminal. Until then the NDCA window applies. After it, NDCA events fall back to the baseline (designated, purpose-bound, audited,
no account-role access); the 30-day retention (III.E.2, OD-04) is unaffected. Q1.

### 4.5 Room for publication (OD-23) and body exceptions

Published results continue through the F3 readers unchanged. Scrutineer sheets (NDCA III.D.17), WSDC score reports and the UCWDC DSA are
*derived publication artifacts* generated by a future audited reader (purpose `publication_report`) and are body exceptions to be added
**only after verification** (timing of the DSA is not stated in the source). UCWDC Contest Coordinator is not mapped here (OD-15 pending;
the Judge Certification Code of Conduct is a missing source).

## 5. Roles and designations (requirement 2)

| Kind | Meaning | Source | Existing? |
|---|---|---|---|
| `ndca_chairman` | Chairman of Adjudicators for an NDCA-declared event | NDCA III.B.4, III.D.16 | **new** (this design) |
| `ndca_scrutineer` | NDCA-certified Scrutineer officiating the event | NDCA III.B.1.e, III.B.2, III.D.16 | **new** |
| `scoring_operator` | Person who tabulates or administers scoring | OD-06 (WSDC score person), generalized to a body-agnostic DanceFlow tabulator | OD-06 s0 kind; scope widened here |
| `ballot_reviewer` | Independent person who may read ballot content for correction or dispute review | DanceFlow policy; also OD-07's "independent designated reviewer" | **new**; recommended to be the single concept OD-07 uses |
| `chief_judge`, `secondary_chief_judge` | WSDC | OD-06 | OD-06 s0 |
| `raw_score_judge` | carries no scoring access | WSDC p.3 | OD-06 s0 |

Rules (DanceFlow design, all enforced in SQL, none inferred from names):

1. A designation needs `user_id` (an account), a verified email (`verified_email_for_user`), a recorded designating manager and an
   `evidence_ref` code (OD-06 style, 40 chars, no free text). Designations are ended, never edited; ending needs a reason.
2. `ndca_chairman` and `ndca_scrutineer` cannot be one account (III.B.4 says the Scrutineer may not serve as Chairman). The same account
   may not be a judge on a round it holds `ndca_*` content access for, unless OD-05/OD-15 later allows it with a recorded resolution.
3. Neither NDCA kind is derivable from `event_competition_officials.role` (`chair`, `scorer`) or from `can_manage_event_competition`. A
   manager who is also designated Chairman acts under the *designation*, and the audit row records `actor_basis = designation`.
4. Certification (the S1/S2/S3 levels, III.B.2) is **not verified** by DanceFlow. The designation is an organizer attestation, labelled so.
   OD-15 owns credential verification.
5. **Every content designation (all bodies) needs a second approver**: a person other than the designating manager and other than the designee.
   A lone manager therefore cannot self-designate as `ndca_chairman` (requirement 2) or instantly as reviewer mid-event. A designation made after
   the first ballot of the event takes effect only after a delay (default 30 minutes, DanceFlow policy, owner may tune) and is visible to the
   other managers. Designees who are competitors in, or staff of a studio that has competitors in, the event are blocked using the OD-05 identity checks.
6. **One-person events (deadlock).** A single-manager event cannot find a second approver. The recorded alternative is an explicit single-person
   break-glass designation for Studio/Custom only, logged as such and shown on the ledger; NDCA events refuse it and fail closed (no content readers,
   no calculation) until a second person exists. Q3 asks the owner to decide.
7. **Several concurrent `ndca_scrutineer` designations are allowed** (NDCA requires a back-up Scrutineer and more for larger panels; III.B.1.e-f). No one-active-per-kind key.
8. **Voting Chairman.** III.B.4 says the Chairman should be non-voting "if possible", so a judging Chairman can exist. Rule 2 then removes content access
   from that person for rounds they judge; the Scrutineer alone carries access there. Intended, and stated.
9. **Small panels.** With 1-2 judges an aggregate equals the ballot. Aggregate-only access is not confidentiality there, and calculation by a designee only (never
   a database-side path an actor can steer by marking other judges absent) remains the rule. Documented, not solved.

## 6. Audit ledger (requirement 5)

### 6.1 Table `event_competition_ballot_access_log` (new, append-only, nothing applied)

`id`, `event_id` (not null, first-class), `occurred_at`, `actor_user_id`, `actor_basis` (`designation` | `own_ballot` | `system_derivation`),
`designation_id` null, `official_id` null, `access_class` (`A` | `B`), `scope` (`ballot` | `heat` | `round` | `event` | `own_sheet`),
`round_id` null, `heat_id` null, `purpose` (closed list, 6.2), `purpose_ref` uuid null (an id such as a correction case, never text),
`channel` (closed list of reader function names), `ballot_count` int, `ballot_ids` uuid[] (capped 500, references only), `outcome`
(`granted` | `denied`), `denial_code` text null, `request_id` uuid, `transaction_id`.

- **No ballot contents, ever**: no marks, selections, placements, judge letters in the row, no free-text notes. `purpose_ref` and
  `ballot_ids` are references. A CHECK and a type-level allow-list keep it so; a test asserts the table has no jsonb or free-text column.
- Append-only: a trigger refuses UPDATE and DELETE (same pattern as `protect_competition_history_evidence`), and truncation is revoked.
- RLS: read by managers of the event (the log is operational evidence, not ballot content) and by the actor for their own rows; no writes
  except through the gate function. A manager sees *who read what*, never the marks.

### 6.2 Closed purpose list

`calculate`, `approve_verify`, `recompute`, `advancement_apply`, `lock_validation` (only if content, normally class C), `paper_verification`
(OD-12), `correction_review` (OD-07), `dispute_review`, `chair_review`, `post_event_audit`, `publication_report` (OD-23), `own_sheet`.
The purpose is bound by the *function*: each purpose is valid only for specific designation kinds and round/event states, and `purpose_ref` is validated against the event, round, open state and actor. A reader that takes `purpose` as an argument (`competition_round_ballots_review`) accepts only the values its caller's designation permits; a free-text reason is never a purpose. For round scope with no heat the log records the heat list.

### 6.3 Gate and atomicity

One internal function `_compob_ballot_read_gate(event, round, scope, purpose, purpose_ref, channel)` (security definer, pinned
`search_path`, revoked from every client role) decides, inserts the log row **in the same transaction as the read**, and returns the log id.
Every class A or B reader calls it first. If the insert fails the read fails: **no read without a log row**.

Constraints that shape the implementation:
- `competition_round_calculation_input` is declared `stable`; a function that inserts must be `volatile`. It is called through
  `supabase.rpc` (POST), so no GET/read-only-transaction conflict, but the redefinition is a behavior change to flag.
- A raised exception rolls back the log insert, so **denials cannot be logged by raising**. Readers return a structured denial
  (`{"denied": true, "code": ...}`) for the cases we want to record (wrong designation, window closed, round not locked) and write the
  `denied` row; only structural failures (no session) raise and are unlogged. EXECUTE-privilege refusals are logged by nobody; that is
  acceptable because those callers cannot reach the data.
- **Denied rows need standing.** A denied row is written only when the caller has standing on that event (manager, official or designee); any other caller gets an unlogged error. Otherwise any authenticated user could flood another tenant's ledger and, with a restrictive foreign key, make their event undeletable (conflict with OD-04). The ledger is also listed in OD-04's `_compod04_evidence_tables()` explicitly (it will fail that suite until it is), and denied rows are rate-limited.
- **Read and log are one statement.** Log `ballot_ids` from the same statement that reads (a CTE or `INSERT ... SELECT` returning the ids), lock the designation row `FOR SHARE`, so a concurrent correction cannot make the logged set differ from the returned set. The 500-id cap becomes a chunked log (several rows per read), never truncation.
- **No dedupe of reader rows by `request_id`.** Class B writers are idempotent by `request_id`; class A readers log every call, or one logged id would cover unlimited reads.
- **Availability.** Content-read gates fail closed. `own_sheet` logging is best-effort (queued or swallowed on ledger lock), so a ledger outage cannot stop live judging.
- Volume: judge sheet reads (`own_sheet`) occur per heat per judge. They are logged (every retrieval) as a distinct scope so reviewers can
  filter; expected volume is thousands of small rows per event.

## 7. Role-to-permission dependency on sibling designs

OD-10 reads the **same** designation table OD-06 defines in PR #834 section 6A.2 (`event_competition_role_designations`). It must not create a
parallel role table. Dependencies (exact):

| Dependency | Needed for | Status | Owner of change |
|---|---|---|---|
| `event_competition_role_designations` + `_compoc_` helper to find an active designation | everything in section 4 | design only (#834 s0, migration `20270220090000`) | OD-06 |
| `kind` check constraint extended with `ndca_chairman`, `ndca_scrutineer`, `ballot_reviewer` | NDCA and policy designees | not in #834's closed set | **C-1: add to s0 now, or alter the constraint in an OD-10 migration after s0** |
| `designations_fingerprint` (md5 of the *active designation set*) used for the WSDC attestation | WSDC attestation validity | #834 6A.3 | **C-2: the fingerprint must cover only WSDC kinds, or adding an NDCA/policy designee would silently invalidate a WSDC attestation** |
| `events.competition_sanctioning` (`none|ucwdc|ndca|wsdc|other`, migration `20270113090000`) | body selection | exists | n/a |
| `verified_email_for_user`, `can_manage_event_competition`, `_compe2_round_role` | identity and manager check | exist | unchanged; `_compe2_round_role` stays for operations, but content reads stop using it |
| OD-07 correction case and co-sign | purpose `correction_review` | design only (#838) | OD-07 PR-B must call the gate; its "independent designated reviewer" should be `ballot_reviewer` (**C-3**) |
| OD-04 `_compod04_evidence_tables()` | new ledger must be listed as protected evidence | in progress in the OD-04 worktree (`20270219090000`) | add `event_competition_ballot_access_log` when that function exists |

## 8. Enforcement design by surface (requirement 6)

### 8.1 Inventory of every ballot read path found (re-verified in code, base `origin/release/website-embeds`)

| # | Path | Returns | Auditable today? | Closes by |
|---|---|---|---|---|
| R1 | Direct `SELECT` on `event_competition_ballots`: policies `competition_ballots_manager_read` (`can_manage_event_competition`), `competition_ballots_own_read`, `competition_ballots_scorer_read` (E2 `20270102090000`, lines 934-940); grant `select` to `authenticated`, `service_role` | metadata + via R2 contents | **No** (RLS SELECT cannot log) | revoke SELECT; drop three policies |
| R2 | Direct `SELECT` on `event_competition_marks` (`competition_marks_read`, follows R1) | marks | **No** | revoke SELECT; drop policy |
| R3 | Direct `SELECT` on `event_competition_ballot_drafts` (`own_read`, `manager_read`); callback selections before submission | content | **No** | revoke SELECT; drop policies; only the judge's own draft through the audited sheet reader |
| R4 | Direct `SELECT` on `event_competition_result_versions` columns **`input`** (the full evidence document including every judge's marks, `_compf2_evidence`) and **`trace`** (per-judge detail), policies `competition_result_versions_manager_read`, `..._scorer_read` (F2 `20270114090000`, lines 716-718, grant to `authenticated`) | a **persistent copy of all ballot content**, readable after ballots are locked, by manager and scorer | **No** | revoke table SELECT; column-level SELECT grant on non-content columns only; content columns only through the audited reader (purpose `post_event_audit` / `correction_review`) |
| R5 | RPC `competition_round_calculation_input(p_round_id)` (F2): security definer, `stable`, allowed roles `manager`, `scorer`, returns `evidence` (all marks) to the caller | content | **No** (and returns content to a role that should not hold it) | gate + designation; see 8.2 |
| R6 | RPC `competition_judge_ballot_sheet` (E2): own sheet including callback `ballot.marks` and draft | own content | No | gate, scope `own_sheet` |
| R7 | `calculate_competition_round`, `approve_competition_round_result`, PV-1 `_comppv1_verify` paths, `_compf2_input_hash` inside `competition_round_results_review` (computes `stale`) | derived only | No | class B: log once per operation inside the writer |
| R8 | A7 `cosign_competition_correction`, `_cf1_check_correction_ballot`, `_cf1_record_ballot_correction`, `_cf1_a7_picks`, `_cf1_a7_backstop`; A5 `_a5_cf1_filed_replacement_ballot`; A6 `_cf1_a6_precheck`; U66 `_cf1_u66_blockers`; CF1 advancement apply | derived/compared | No | class B or C; each listed and classified in the implementation PR |
| R9 | Service-role (admin) client (note: `service_role` has SELECT on R1/R2 only; F2 granted `result_versions` to `authenticated` only): `createAdminClient` is used in competition routes (`checkout`, `release`, `resume`, `settlement-repair`, `refundActions`, `checkin/actions`); **none read ballot tables today** (search of `src` for `.from("event_competition_ballots|marks|…")` finds no application read). But `service_role` holds SELECT on R1/R2 | any | **No** | revoke from `service_role`; add a CI test that fails if application code references ballot/marks tables outside the migration set |
| R16 | **`event_competition_ballot_events.refs.fp`** (E2 line 831, 906): an **unsalted md5 of the raw marks**, in a table managers read directly (`competition_ballot_events_manager_read`) and via the F2 audit log reader. Marks are low-entropy (a callback of T picks over N entries, or a 6-couple final has 720 orderings), so a manager can match the md5 offline and recover a judge's marks. | derived content | **No** | revoke direct SELECT on `ballot_events`; replace the fingerprint with an HMAC under a server-only secret (new rows) and hide `fp` from every reader; existing rows are immutable evidence, so the migration records the old values as content-equivalent (unreadable, not rewritten). `input_hash`/`trace_hash` returned by `competition_round_results_review` are the same class for 1-3 judge events: expose only `stale`, not the hashes, to non-designees |
| R17 | **`event_competition_ballot_corrections`** (A7, columns `original_picks`, `replacement_picks`, `diff`) and RPC `competition_round_correction(p_round_id)`, readable by `manager` and `chair` | each judge's callback picks before and after | **No** | class A: gate the RPC, revoke table SELECT, add the table to the content set; OD-07 owns the co-sign UI that must call the same gate |
| R10 | CSV/PDF/XLSX export | none exist for ballots or marks | n/a | rule: any future export is an audited reader (class A), reviewed by the designation matrix, and its file is not stored with contents in a public bucket |
| R11 | Realtime subscriptions / publications | no competition table is in `supabase_realtime` in the migrations, and `src` opens no channel on them | n/a | rule + test: assert the ballot, marks, drafts, result-version and ledger tables are never in the publication |
| R12 | Views | none over ballots/marks | n/a | rule: no view over R1-R4 without security_invoker and the same gate |
| R13 | Status RPCs `competition_round_ballot_status`, `competition_round_floor_entries`, `competition_final_withdrawal_state`, advancement preview, exclusions | metadata, counts, derived callbacks | n/a (class C) | exempt list; callback counts per entry are derived aggregates and appear only after calculation |
| R14 | Database-level actors outside the app: `postgres`/superuser, Supabase SQL editor/Studio, `pg_dump`/backups, logical replication, point-in-time restore | everything | **cannot be audited by this design** | residual, 8.4 |
| R15 | Application logs, error reporting, traces | possibly args of `submit_competition_ballot` / paper entry on the *write* path | n/a | rule: marks are never logged; to be tested by a log-scrubbing test, not designed here |

### 8.1a Direct application reads found by the review

The results page reads `event_competition_result_versions.input->finalCapacity` and `event_competition_result_rows.output` **as the user**
(`src/app/app/events/[id]/competition/results/[roundId]/page.tsx`, lines 139-140, the unresolved-tie view). A column grant that excludes `input`
would break that page, so the contract step is blocked until `finalCapacity` and the tie data are served by an RPC or a non-content column.
An implementation gate: a source-grep test for `result_versions` and `result_rows` outside migrations, in addition to the ballots/marks/drafts one.

### 8.2 RPC redesign

- **Calculation (R5/R7).** Two options, recommendation first.
  1. **Keep the app-side engine, gate and audit the content read.** `competition_round_calculation_input` becomes volatile, requires a
     designation that allows purpose `calculate` (NDCA: `ndca_scrutineer`; WSDC: `scoring_operator`; others: `scoring_operator`), writes a
     class A log row, and the server action never returns marks to the browser (`calculate.ts` already returns only version id, number and a
     replay flag). **Gating the reader alone does not gate calculation** (review finding 2): `calculate_competition_round` accepts `manager` or `scorer`
     and checks only the caller-supplied `p_input_hash` against the database hash. When ballots are unchanged since an earlier version a
     manager can reuse that version's readable `input_hash` and rows and supply a trace with a matching hash. Therefore **every writer
     (`calculate`, `approve`, recompute, advancement apply) must call the gate itself** and require the operation's designation, not rely on
     the reader. Until then a manager can still start a calculation.
  2. **Move calculation fully into the database** (class B, nothing returned). PV-1 already ports both Studio engines to SQL and verifies
     rows and warnings, but **not `trace`**; this needs a SQL trace generator and a parity suite, a larger slice. Defer.
- **Approve / recompute / advancement (R7, R8).** Keep as class B with one log row per operation written inside the writer; the actor needs
  the operation's existing permission, not content permission.
- **Judge sheet (R6).** Keep, add the `own_sheet` log row.
- **`competition_round_results_review`** returns rows, hashes and warnings only; unchanged, but its `stale` calculation reads ballots
  internally (class C, hash only). Listed.
- A new reader `competition_round_ballots_review(round, heat?, purpose, purpose_ref?)` for designated humans (Chairman, Scrutineer, Chief
  Judge, reviewer) returns marks in a stable shape; there is **no** wildcard "all ballots in event" call for the UI.

### 8.3 What breaks when direct SELECT is revoked

- **Application code:** no `src` file reads ballots, marks or drafts directly (checked), but the results page reads `result_versions.input` and `result_rows.output` (8.1a), which must be served another way first. Managers otherwise lose only the never-rendered ability to read raw rows.
- **Database tests:** the SQL suites that assert "manager can read ballots / marks / result versions through RLS" (K0 §7 matrix, E2/F2 RLS
  tests) are rewritten to assert *denial* and to test the reader RPCs. `RESULT_READER_MATRIX` in
  `src/lib/competition/results/contract.ts` and K0 §7 change (manager and scorer `ballots: "all"` becomes `ballots: "designated"`); the test that pins the
  matrix to RLS is updated in the same change.
- **Functions and triggers** run as their owner (security definer): unaffected by revoking grants from `authenticated`/`service_role`. The guard
  triggers that read ballots (`_compe2_guard_*`) stay.
- **Operations:** a support engineer can no longer inspect a ballot through the Supabase API with a service key; they use the audited
  reader or the database role (residual 8.4). That is intended.
- **Rollback:** re-granting SELECT and re-creating the three policies restores the previous behavior; the ledger is retained.

### 8.4 Residual unauditable access (accepted, documented)

`postgres`, Supabase dashboard/SQL editor, backups and replicas, and a leaked service-role key *via RPC* (still passes the gate: service
role has no `auth.uid()`, so the gate denies it and logs `denied` with `actor_basis = system`, unless a function is explicitly designed for
service use). Mitigations (operational, outside this slice): ops tooling policy (hosted SQL only through `sb.sh`), no ad-hoc SELECT on these
tables, and database audit logging if the platform offers it. The ledger cannot claim to cover them and the UI/docs must not say it does.

## 9. Preserving ballot evidence

1. Ballots, marks and the version chain remain immutable (E2 triggers `_compe2_guard_*`, `supersedes_id`, no UPDATE/DELETE). OD-10 adds no
   write path on them. The ledger is separate and append-only.
2. Revoking SELECT does not remove or alter rows. The `ON DELETE CASCADE` hazard on `events` is OD-04's; the ledger table is listed there
   and created with `on delete restrict` against `events`.
3. Exemption list (class C) is part of the implementation PR, enumerated function by function, and a test fails if a new function that
   selects from ballots/marks/drafts/`result_versions.input` exists that is in neither the audited set nor the exemption list.
4. `result_versions.input` and `trace` stay stored (they are the reproducibility evidence); only *who may read them* changes.

## 10. Migration ordering and shared objects (requirement 7)

Observed latest migration on the base: `20270218090000` (rows touching Competition: see sibling docs).

| Block | Owner | State |
|---|---|---|
| `20270219090000` | OD-04 event delete guard (`_compod04_evidence_tables()`) | worktree, uncommitted, not a PR yet |
| `20270220090000`-`097000` | OD-05/06 (#834, docs only): `s0` designations + attestations first | proposed |
| `20270221090000`-`093000` | OD-07 correction cases (#838, docs only) | proposed, unconfirmed |
| **`20270220098000`-`099500` (this design, proposal, after OD-06 s0..s5 and BEFORE OD-07)** | OD-10 | proposed; Q6 (the review found that a `…222…` block would sort after OD-07 and invert the required order) |

The OD-10 block must also re-pin md5 fragments broken by signature/body changes (NS1 pins `competition_round_ballot_status`; A3/A7 pin `_compf2_evidence`; list each in the implementation PR) and drop any old overload when a signature changes. New functions explicitly `revoke ... from service_role` (Supabase default grants EXECUTE to it).

Proposed OD-10 files (each with rollback, applied strictly in order):
`…220098000` s0 ledger table, gate function in *log-only/permissive* mode, designation kinds (needs OD-06 s0) | `…098500` s1 audited reader
RPCs added, class B logging added to approve/recompute/advancement writers | `…099000` s2 calculation reader redefined (md5-pinned fragment
replacement as this repo does), `stable` becomes `volatile`, designation required | *(app release switches nothing the UI uses, but ships the
messages and the manager "request access" flow)* | `…099300` s3 **contract step**: revoke SELECT on the content tables and `service_role`, drop
policies, column grants on `result_versions` | `…099500` s4 NDCA enforcement (fail-closed without designation), `competition_closed_at`.

Order rule: expand, release the app, then contract. SQL before app for s0-s2; s3 only after the app is live and a smoke check proves no
direct reads (the repo's search shows none). `s3` is the destructive-looking one and the only one that can break an unknown caller, so it
ships alone.

**Conflict checks with siblings.** (a) OD-07's A7 co-sign functions and OD-10's class B logging both redefine
`cosign_competition_correction`/`_cf1_check_correction_ballot`: sequence OD-10 s1 before OD-07 PR-B, and OD-07's redefinition must start from
the md5 of the OD-10 text (**C-4**). (b) OD-05 adds triggers on ballot insert, no read; no conflict. (c) OD-05 s3/s5 redefine `_compoc_*` stubs
only. (d) `designations_fingerprint` scope (C-2). (e) The constraint on `kind` (C-1). (g) OD-05 6A.5 lets an *undesignated* manager calculate and approve "as today"; OD-10 requires a `scoring_operator` designation, and OD-05 G1/G4 bar a WSDC owner/director from that role, so a one-person WSDC event cannot calculate: OD-05 6A.5 must be reconciled (owner question). (h) OD-07 plans its own designated-reviewer tables; use the single `ballot_reviewer` kind (C-3). (f) OD-08/09 (NDCA withdrawal, advancement) both
introduce NDCA role checks: they must use the `ndca_chairman`/`ndca_scrutineer` kinds defined here, not new tables.

## 11. Test plan (design only; not run; heavy QA only under the lock when implemented)

Negative-first. NDCA: manager, owner, generic scorer, chair official, and an unrelated designee each get a structured denial and a `denied`
row for content; Chairman and Scrutineer each succeed and write one `A` row with purpose, no contents; the same account cannot hold both
kinds; no designation means no reads; reads after `competition_closed_at` follow the baseline. WSDC: owner/director/family/raw-score-judge
denied; chief judge and scoring operator succeed. Studio/UCWDC: manager denied until a recorded designation exists. Every path R1-R8:
direct SELECT as `authenticated`/`service_role` fails after s3; reader functions log in the same transaction (kill the insert and the read
returns nothing). Ledger: no content columns; UPDATE/DELETE/TRUNCATE refused; `ballot_ids` cap. Every writer class B logs exactly once on
replay (idempotent by `request_id`). Realtime-publication and "no application read" static tests. Rollback restores the schema fingerprint;
rollback refuses to drop a non-empty ledger. Privilege test: nothing new executable by `anon`/`public`. `ruleRegister.integrity.test.ts`.

## 12. Independent security review

See section 14.

## 13. Open questions for the owner (exact)

- **Q1.** Define "end of the competition" as an explicit `competition_closed_at` stamp (4.4)?
- **Q2.** "Audit logging for ALL Competition OS events": confirmed here as *all competition events and types for ballot retrievals*. Did you also mean logging
  every other Competition OS action (writes are already logged in `ballot_events` and `result_events`)?
- **Q3.** May a small Studio/Custom event let a manager designate themselves as `scoring_operator`/`ballot_reviewer` (recorded, visible), as proposed?
- **Q4.** Log judges' own-sheet reads (`own_sheet`) as well? Recommended yes, separate scope.
- **Q5.** For NDCA, must the Scrutineer perform calculation even when DanceFlow's engine would (the reference text on p.17)? Fail-closed until the NDCA profile exists either way.
- **Q6.** Confirm migration block `20270220098000`-`099500` is free, and that OD-06 s0 lands first (C-1, C-2).
- **Q7.** Post-window: should baseline ballot access for a manager ever be possible without a designation? Recommended no.

## 14. Independent review: findings and fixes

A review subagent first enumerated read paths from the code without this document, then attacked the design. Severity as reported; all
P1 findings changed the design; the reviewer's claims were spot-checked in code (md5 fingerprint, results-page direct read, corrections table) before acceptance.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | P1 | `ballot_events.refs.fp` is an unsalted md5 of the marks, manager-readable; same concern for `input_hash`/`trace_hash` on tiny panels | Added R16: revoke SELECT, HMAC for new rows, expose only `stale` |
| 2 | P1 | Gating the calculation *reader* does not gate `calculate_competition_round` (hash reuse plus forged trace) | 8.2: every writer calls the gate |
| 3 | P1 | `event_competition_ballot_corrections` and `competition_round_correction` missing | Added R17 (class A) |
| 4 | P1 | Results page reads `result_versions.input` / `result_rows.output` directly; R9 wrongly says `service_role` reads `result_versions` | 8.1a, 8.3 and R9 corrected |
| 5 | P1 | Ledger FK restrict plus denied rows enable cross-tenant griefing and conflict with OD-04 | 6.3: standing required, rate limit, explicit OD-04 list entry |
| 6 | P1 | Manager self-designation contradicts requirement 2 | Section 5 rules 5-6: second approver, delay, competitor exclusion, single-person break-glass for Studio only |
| 7 | P2 | UCWDC "no access clause" overstated (Scoring Format p.8: personnel who see or touch scoring must be trained and tested by a UCWDC Scoring Examiner; p.1 supervision by a certified Coordinator) | OD10-UCWDC-0001 and -0002 now `requires_interpretation`; UCWDC designees are an attested qualification |
| 8 | P2 | Migration order inverted against OD-07; OD-05 6A.5 and OD-07 reviewer tables conflict | Block renumbered before OD-07; items (g), (h) in section 10 |
| 9 | P2 | Purpose self-declared by caller | 6.2 binding rules |
| 10 | P2 | TOCTOU, id cap, own-sheet availability, request_id dedupe | 6.3 |
| 11 | P2 | `_compf2_input_hash` class inconsistent | Class C; hash non-content (R16) |
| 12 | P2 | Deadlock, back-up Scrutineers, voting Chairman, absence-steering, small panels | Section 5 rules 6-9 |
| 13 | P3 | service_role EXECUTE default, old overload, `Prefer: tx=rollback`, warnings content, md5 pins, policy line 942 | Section 10 notes; implementation checklist: verify PostgREST tx handling (default `db-tx-end=commit`), content-check `warnings` |

Confirmed correct by the reviewer: E2/F2 policies and grants, own-sheet and status readers, no app read of ballots/marks/drafts, volatile gate
atomicity, structured denials, citations (NDCA III.D.12/16/17, III.B.1.e, III.B.4, III.E.2 p.25; WSDC p.3, p.12, p.20). The review is a document review; no SQL was run.

## 15. Not authorized / not done

No SQL apply, merge, deployment, activation, outreach. No implementation. No QA run (docs only).
