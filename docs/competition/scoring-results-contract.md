# Competition OS — Scoring → Results Contract (K0)

Status: **DRAFT for owner/Opus review** · Baseline: origin/main `973f36da` · Owner decisions D1–D4 of 2026-10-23 and O1–O5 of 2026-10-24 applied.

This contract fixes the boundaries every later slice builds against: officials (E1), ballots (E2), engines (F1),
results lifecycle (F2), publication and portal delivery (F3), closeout (C1) and the full simulated-event E2E (Q1).
It defines states, writers, readers, invariants and audit. It does **not** define any scoring algorithm: engine
behaviour is owned by the K1 engine specs (`docs/competition/engine-spec-*.md`) and needs owner sign-off before
engine code exists. Machine-readable mirror: `src/lib/competition/results/contract.ts` (tests in
`src/lib/competition/results/__tests__/contract.k0.test.ts`). The doc and the module change together.

## 1. Principles (from approved decisions)

| # | Principle | Source |
|---|---|---|
| P1 | Submitted ballots are immutable; a correction creates a new version that supersedes the old one. | Roadmap v2.21 architecture |
| P2 | Engines are deterministic and preserve a trace; the same input yields the same output and trace hash. | Roadmap v2.21 architecture |
| P3 | Rules profile, engine key and configuration are frozen at publish (`event_competition_program_locks.snapshot`). A calculation uses the locked values, never live configuration. | 10B |
| P4 | Publication is versioned; a published version is never edited, only superseded or withdrawn. | Roadmap v2.21 architecture |
| P5 | **Draft, calculated or approved-but-unpublished results are never readable outside result managers.** | Lifecycle requirement |
| P6 | Feedback never becomes a placement, ranking, advancement, medal threshold or official result. Non-Adjudicated offerings produce no official result. | 10C.5 §Adjudication |
| P7 | Medal Marks are judge input; placement is the result; never `cumulative_points`. | 10C.5 §Scoring metadata |
| P8 | Judges use authenticated DanceFlow accounts; a scorer may enter paper ballots; no anonymous or tablet links in v1. | Roadmap §LOCKED DECISIONS |
| P9 | Approval requires a second person: the account that ran the calculation cannot approve it. A single-staff override exists, requires a reason, and is audited. | Owner D3 |
| P10 | Published results always reach entrants' portals; the public results page is an opt-in per program. | Owner D4 |
| P11 | Identity is never matched by name or email. A dancer sees results only through a verified competitor anchor. | 10C §1 |
| P12 | A silent source is recorded `NOT SPECIFIED IN PROVIDED SOURCE`; no gap is filled from general knowledge. | Source registry rule 2 |
| P13 | Financial settlement state and competitive participation state are separate. A refund never silently rewrites a locked, danced or certified heat; an unresolved competitive-affecting exception blocks publication of the affected round only. | Owner §4.1, Q1, Q2 (2026-10-23) |

## 2. Unit of scoring

The **round** (`event_competition_rounds`) is the unit that is scored, approved and published. Heats
(`event_competition_heats`) are the units that are danced and balloted; a round's result is calculated across all
of its heats. A multi-dance overall result (10H) is out of v1 scope and is held by the existing Multi-Dance hold.

Everything below carries `event_id`, `program_id` and the round's `division_id`, and uses composite foreign keys
`(id, event_id)` exactly like the 10A–10D tables, so no row can point across events. `studio_id` / `organizer_id`
are resolved from the program (set by `set_event_competition_program_tenant`), never trusted from the caller.

## 3. Logical entities (names reserved for the owning migrations)

| Entity (table) | Owner | Key columns | Mutability |
|---|---|---|---|
| `event_competition_officials` | E1 | event_id, user_id (required), role (`judge`, `scorer`, `chair`), status | Managers edit; deactivation instead of delete once any ballot references it |
| `event_competition_panel_assignments` | E1 | event_id, round_id (or heat_id), official_id, judge_letter | Frozen once the round leaves `scheduled` |
| `event_competition_ballots` | E2 | event_id, round_id, heat_id, official_id, version, source (`judge_web`, `scorer_paper`), submitted_by, submitted_at, supersedes_id, correction_reason | Insert-only. Never UPDATE/DELETE (trigger) |
| `event_competition_marks` | E2 | ballot_id, entry_id, role (nullable, for role-scored), mark (jsonb, validated against the locked `MarkScheme`) | Insert-only, created with the ballot |
| `event_competition_result_versions` | F2 | event_id, round_id, version, engine_key, engine_version, rules_profile_key/version, input_hash, trace_hash, trace (jsonb), calculated_by, calculated_at, status | Insert-only except `status` transitions via RPC |
| `event_competition_result_rows` | F2 | result_version_id, entry_id, placement, tie_group, advanced (bool), rating_band, output (jsonb) | Insert-only with its version |
| `event_competition_result_approvals` | F2 | result_version_id, approved_by, approved_at, override_reason (nullable) | Insert-only |
| `event_competition_result_publications` | F3 | event_id, round_id, result_version_id, publication_version, visibility, published_by, published_at, withdrawn_at/by/reason, superseded_by | Insert-only except withdraw/supersede stamps |
| `event_competition_result_events` | F2 (shared by F3) | event_id, round_id, kind, actor, at, from_state, to_state, refs (jsonb), reason | Append-only audit (trigger, like `protect_competition_history_evidence`) |

Existing columns reused, not duplicated: `event_competition_rounds.status`, `scoring_method`,
`target_advancement_count`, `advancement_method`; heat `lock_state` (`open/locked/certified`) and the heat
lock ledger `event_competition_heat_lock_events`.

## 4. Round result state machine

The round `status` check constraint already contains every state needed:
`draft, scheduled, active, ballots_locked, calculated, approved, published, complete, cancelled`.
The contract assigns each transition **exactly one writer RPC** (SECURITY DEFINER, row lock on the round,
idempotent on a client request id, writes one `result_events` row).

| From → To | Writer RPC (owner) | Actor | Preconditions |
|---|---|---|---|
| draft → scheduled | `schedule_competition_round` (O1) | manager | every heat of the round is in the live published schedule version (no SQL writes round status at `973f36da`) |
| scheduled → active | `start_competition_round` (O1) | manager | panel assigned (E1); at least one heat |
| active → ballots_locked | `lock_competition_round_ballots` (E2) | manager or chair | every assigned judge has a current submitted ballot for every heat, or a recorded absence; all heats `locked` |
| ballots_locked → active | `reopen_competition_round_ballots` (E2) | manager | reason required; no result version is `approved` |
| ballots_locked → calculated | `calculate_competition_round` (F2) | manager or scorer | engine implemented and spec approved for the locked `scoring_method`; writes a new result version with input and trace hashes |
| calculated → approved | `approve_competition_round_result` (F2) | manager ≠ calculator, or override with reason | result version is the round's latest; input hash still matches the current ballots |
| approved → published | `publish_competition_round_result` (F3) | manager | approval exists for this exact result version; **no unresolved competitive-affecting exception is scoped to this round** (§4.1) |
| published → complete | `complete_competition_round` (F2) | manager | advancement (if any) applied |
| any non-terminal → cancelled | `cancel_competition_round` (O1) | manager | no publication exists |

**Corrections (P1, P4).** A correction never edits rows. It runs:
`submit corrected ballot (new version, reason)` → round returns to `ballots_locked` via
`open_competition_round_correction` (F2, manager, reason) → recalculate (new result version) → approve → publish.
The new publication supersedes the old one (`publication_version + 1`); the old one stays readable to managers
with its audit trail. A correction after publication does **not** hide the published result until the new version is
published, unless a manager withdraws it (`withdraw_competition_round_result`, reason required), which hides it from
all non-manager readers immediately.

**Invalidation.** Any new ballot version after calculation makes every unpublished result version of that round
stale: `approve` and `publish` refuse when the stored `input_hash` no longer matches the canonical input built from
the current ballots.

### 4.1 Exceptions that block publication (owner Q2, 2026-10-23)

An unresolved operational exception that affects competitive participation, placements, advancement or result
integrity blocks publication of **the affected round only**. `publish_competition_round_result` refuses with
`COMP_PUBLICATION_BLOCKED_BY_EXCEPTION` while any such exception references an entry with a placement in that
round. Unrelated rounds and results publish normally. Financial-only exceptions stay visible for reconciliation and
closeout but never block publication.

| Exception (owner) | Effect | Scope |
|---|---|---|
| `competition_refund_entry_locked_heat` E-L (R2) — refund on an entry in a locked heat, or in a heat already danced (owner Q1) | competitive | rounds holding the entry's placements |
| `competition_refund_entry_certified_heat` E-C (R2) | competitive | rounds holding the entry's placements |
| `competition_refund_unattributed` (R2, D6) | financial-only unless it holds an entry in a locked/danced heat | — |
| `competition_refund_reversed` E-R (R2) | financial-only unless it holds an entry in a locked/danced heat | — |

Exception rows therefore carry a queryable round scope and a `competitive_effect` flag, in R2's
`event_competition_refund_exception_scopes` (migration `20270103090000`, PR #292). The F3 publish RPC's precondition
is exactly: `exists (select 1 from event_competition_refund_exception_scopes s where s.round_id = <round> and
s.competitive_effect and s.resolved_at is null)` → refuse. A `result_events` row written while resolving a refund
exception (correction opened, recalculated, approved, published) carries `refs.refund_exception_id`.
Resolution is by an authorized official (the D5 set) and is audited; resolving an E-C by changing the competitive
outcome goes through the correction path below, never by editing a certified heat. An exception raised **after** a
round is published does not unpublish it; it blocks the next publication (correction) of that round until resolved.
Program `complete` and event closeout refuse while any `competition_refund_*` exception is unresolved (§10).

**Danced heats (owner Q1).** Once a heat has been danced, no refund, cancellation or registration trigger withdraws
its entries automatically, even if the heat is not yet `locked`; the change goes through the audited
official-resolution process.

**Heat certification.** A heat moves to `certified` only when the round reaches `approved`; certified heats can
never be reopened (existing 10A rule), so certification is a consequence of approval, not a separate gate.

## 5. Engine boundary (F1 implements, K1 specifies)

```
EngineInput  = { engine_key, engine_version, profile {key, version}, round {id, round_type, target_advancement_count,
                 advancement_method}, mark_scheme, tie_break_chain, entries[{entry_id}], judges[{official_id, letter}],
                 marks[{official_id, entry_id, role?, value}] }
EngineOutput = { rows[{entry_id, placement?, tie_group?, advanced?, rating_band?, output}], trace[...], warnings[] }
```

- Engines are pure TypeScript in `src/lib/competition/scoring/**`: no database, network, clock or randomness.
- `canonicalJson(input)` (sorted keys, entries sorted by entry_id, marks by (official_id, entry_id, role)) is the
  only serialization that is hashed. `input_hash = sha256(canonicalJson(input))`,
  `trace_hash = sha256(canonicalJson(trace))`. The server computes and stores both; the calculate RPC stores the
  output and refuses a version whose input hash differs from the one it rebuilds from current ballots.
- The engine key comes from `event_competition_rounds.scoring_method` as locked at publish. v1 keys:
  `ordinal_majority`, `proficiency_rating`, `callback_tally`. Any other key, or a key whose K1 spec is not
  owner-approved, makes `calculate` fail closed with `COMP_ENGINE_NOT_AVAILABLE`.
- Unspecified behaviour inside an engine (per K1) fails closed with `COMP_ENGINE_UNSPECIFIED_CASE` and a trace entry,
  never a guessed result.
- Feedback marks (`FeedbackMode`) are not engine input (P6).

## 6. Advancement / recalls

- An advancement stage produces `advanced = true/false` per entry; the count target is `target_advancement_count`.
- Next-round heats are created **only** from a round in `approved` or later, by `apply_competition_round_advancement`
  (F2), which writes the next round's entries and heat entries through the existing 10D floor-heat integrity triggers.
- Re-approval of a corrected earlier round after the next round has started requires a manager reason and is
  blocked if the next round already has submitted ballots (fail closed; rule O5, approved 2026-10-24).

## 7. Reader matrix (RLS must equal `RESULT_READER_MATRIX` in `contract.ts`)

| Reader | Ballots / marks | Calculated / approved (unpublished) | Published (current) | Superseded / withdrawn publications |
|---|---|---|---|---|
| Result manager (`can_manage_event_competition`) | all in event | yes | yes | yes |
| Assigned judge | own ballots only | no | only through the public rule (or the entrant rule if also an entrant) | no |
| Scorer | all in assigned rounds | yes (to verify) | yes | no |
| Entrant dancer (verified competitor anchor) | no | **no** | own entries + placements of the same round | no |
| Public (anon / any user) | no | **no** | only if program `public_results = true` | no |
| Other studio / organizer / event | no | no | only through the public rule | no |

Rules:
- "Entrant" means `auth.uid()` equals `event_competition_competitors.user_id`, or the competitor's `client_id` is the
  caller's linked self client (`client_account_links.status = 'linked'`), and the competitor is a participant of an
  entry in the round. Guests without an anchor see results only through the public rule.
- Non-manager reads go through SECURITY DEFINER read RPCs owned by F3 (`competition_round_results_public`,
  `competition_my_results`), never direct table SELECT grants, so RLS cannot accidentally widen.
- Withdrawn publications disappear from every non-manager reader immediately.
- Judges' identities on public results: **NOT SPECIFIED IN PROVIDED SOURCE** → default hidden (owner decision O3, approved 2026-10-24).

## 8. Audit

Every state transition, ballot submission or correction, absence record, approval (incl. override and reason),
publication, supersede and withdrawal writes one `event_competition_result_events` row with actor, time, from/to
state and references. The table is append-only (UPDATE/DELETE trigger refuses, as in 10A). Change-type labels are
fixed in the contract (`RESULT_EVENT_KINDS`), not supplied by callers — this closes the 10A carry-forward
"audit change-type labels are supplied by callers" for results.

## 9. Isolation invariants (each becomes a SQL test)

1. A ballot's official, round, heat and entries all share one `event_id` (composite FKs).
2. An official can submit only for heats of rounds they are assigned to.
3. A result row's entry belongs to the result version's round.
4. Read RPCs filter by event first; no RPC accepts a list of events.
5. No non-manager reader can see a result version without a current, non-withdrawn publication.
6. Cross-tenant: a manager of studio A gets zero rows for any event of studio B.

## 10. Closeout coupling (C1)

- Program `complete` requires every non-cancelled round `complete` and no unresolved `competition_refund_*`
  exception (financial-only ones included, so refunded entries cannot remain unresolved at closeout).
- Refund accounting: each succeeded Stripe refund is its own accounting entry dated at success; locked accounting
  periods are never rewritten (owner C1, implemented by R2).
- Event deletion is blocked once any ballot exists (carry-forward from 10A), and program/round deletion likewise.
- Exports read published results only, through the F3 read layer, using the Phase 9D formula-safe CSV helper.

## 11. Owner decisions (O1–O5 APPROVED 2026-10-24)

| ID | Question | Rule (owner approved 2026-10-24: accept the fail-safe default) |
|---|---|---|
| O1 | Absent judge: may a round lock with fewer ballots than assigned judges? | Fail closed: lock refused without every assigned ballot |
| O2 | Who may lock ballots: manager only, or also a designated chair? | Manager or chair |
| O3 | Are judge names/letters shown on public results? | Hidden |
| O4 | Is a withdrawn publication explained publicly ("results under review")? | Generic notice, no reason shown |
| O5 | Relaxing §6 (correcting an earlier round after the next round has ballots) | Blocked |

Owner words (2026-10-24): "K0 O1–O5: Accept all five proposed fail-safe defaults, including complete assigned ballots before locking, manager/designated-chair locking, hidden public judge identities, generic under-review notices, and blocking earlier-round corrections once later-round ballots exist." `contract.ts` already encodes these (lock actors `manager`/`chair`; no pending flags), so it is unchanged.

## 12. Ownership and migration slots

| Slot | Owner | Contract sections |
|---|---|---|
| `20270101090000` | E1 officials | §3 officials, panels; §9 #2 |
| `20270102090000` | E2 ballots | §3 ballots/marks; §4 lock/reopen; §9 #1 |
| `20270104090000` | F2 results lifecycle | §3 results/approvals/events; §4 calculate/approve/correct/complete; §6; §8 |
| `20270105090000` | F3 publication + read RPCs | §3 publications; §4 publish/withdraw; §7; §9 #4–#6 |
| `20270106090000` | O1 day-of | §4 schedule/start/cancel round |
| `20270107090000` | C1 closeout | §10 |

`20270103090000` is held by R2 (CI-D refunds). Changes to this contract after approval go through the Competition
coordinator and update `contract.ts` in the same commit.
