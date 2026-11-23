# Judging-integrity design: OD-05 conflicts and recusal (slices 1-4), with OD-06 / OD-15 / OD-16 touchpoints

**Status: DESIGN ONLY (PR-A, docs).** No SQL, no code, nothing applied, merged, deployed or activated. Competition OS is dark.
Governed by [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md). Owner decision OD-05 (2026-11-23, Option D, BLOCK, with panel-level
safeguards) is recorded in the audit owner-decision list (PR #795, `OWNER-DECISIONS.md`, branch `claude/comp-audit-owner-decisions`).

**What this document does not do:** it invents no rule, claims no body compliance, and does not decide OD-06, OD-15 or OD-16.
Those three are **not yet decided: design placeholder only** wherever they appear below. Where a source is silent or conflicting
the text says so and the behavior is labelled DanceFlow policy.

## 1. Rule evidence (re-read in the pinned PDFs on 2026-11-23)

SHA-256 of each file was recomputed and equals the [source registry](../../governing-body-source-registry.md) value.
Short phrases only; section numbers are the citation. Page numbers are the printed page footers of the PDF.

| Ref | Document / edition | What it says (own words) | Class |
|---|---|---|---|
| NDCA IV.A.1 (p.25) | Rule Book June 2026, Master v1 | An adjudicator must excuse themselves from a panel when an immediate-family or same-household member is dancing in a particular heat. Defines "immediate family" by a list: spouse, children, parent, sibling, grand-parent, grand-child, niece, nephew, in-law, first cousin. | mandatory |
| NDCA IV.D.1.a(2) (p.28) | same | Same duty, restated in the Judges and Officials Handbook ethics section, but "immediate family" is defined as "first cousin or above", and the judge should notify the organizer or chairman beforehand if possible. | mandatory; **conflicts with IV.A.1 on the definition** |
| NDCA IV.A.2 (p.25) | same | At Sanctioned Championships two members of an immediate family and/or household may not sit on the same panel of an Open Adult Amateur "A" event or any Professional event. | mandatory (panel level) |
| NDCA IV.A.8 (p.25) | same | An adjudicator who is also an active Pro/Am professional may judge Pro/Am but "should excuse" themselves from heats where their active Pro/Am student partner dances. | recommended (advisory wording; audit J-13N asks whether it binds) |
| NDCA III.D.21 (p.22) | same | At NDCA events owners, organizers, chairmen of judges, adjudicators, MCs, scrutineers, music directors and demonstrators may not compete in any competition. | mandatory (event-wide) |
| WSDC 3.4.1, 3.4.1.a (p.18) | Registry Event Rules v2026.1C | Event director(s)/owner(s) must not perform chief judge, judge or scoring functions; their spouses and immediate family may not perform chief judge or scoring duties. | mandatory (OD-06) |
| WSDC 3.4.2 (p.18-19) | same | Event director/owner (and their spouses and children), chief judge, secondary chief judge and score person (or contest administrator) must not compete in any swing contest at the event, except non-judged contests and certain separate-organization / different-genre contests (Board-authorized two months ahead; UCWDC Pro-Am WCS carve-out). Ordinary judges are not named. | mandatory with exceptions |
| WSDC 3.4.3 (p.19) | same | Chief judge and scoring/tabulation must be separate people. | mandatory (OD-06) |
| WSDC 3.4.6, 3.4.6.a (p.19) | same | All conflicts must be identified and avoided (responsibility of directors, chief judge, judges). A conflict is only: a judge/chief judge judging an immediate family member, current spouse/significant other, established dance partner, or current business partner. | mandatory |
| WSDC 3.4.6.a.i (p.19) | same | General bias is a recommendation only; WSDC enforces only the 3.4.6.a definition. Staff are responsible for providing conflicts to the chief judge and/or directors. | recommended; **supports declarations** |
| WSDC 3.4.6.b (p.19) | same | Assignments must prevent conflicts; judges/chief judges recuse from the panel. **Four** listed exceptions (the audit says three): (i) Pro-Am Jack and Jill / Strictly Swing, judging the Amateurs only where the conflict is with the Pro; (ii) opposite role to the competitor in Jack and Jill *preliminary* rounds; (iii) self-judging, only in Champions and invitational contests; (iv) chief judge replaced by the secondary chief judge when necessary (a substitution, not a conflict exception). | permitted exceptions |
| UCWDC-C II.F.6.e (p.5) | UCWDC Couples 2026 (v1-26-2026) | Crown competitors entering Classic Open I or Showcase Open may not judge that Dance Type while dancing it. UCWDC-L II.F.5.d is the Line Dance equivalent (not re-read in this pass; carried from the audit). | mandatory (narrow) |
| UCWDC-C II.N.3 (p.13) | same | Panel-composition complaints are post-event to the Judge Review Board; the Judge Certification Code of Conduct (website) governs. **Not provided.** | open source gap |

Correction to carry forward: the audit and owner list say "three exceptions" for WSDC 3.4.6.b; the pinned text has four sub-items (i-iv),
of which only i-iii relate to conflicts. Exception modelling (slice 3) uses i-iii only.

### Source conflict to record (not resolve)

NDCA IV.A.1 (p.25) and IV.D.1.a(2) (p.28) define "immediate family" differently (an enumerated list versus "first cousin or above").
They cannot both be applied as written, and "or above" is undefined. Per registry rule 3 this is a source conflict:
**any NDCA family/household rule that depends on the definition fails closed**, and **no NDCA family-definition compliance is claimed**
until the owner resolves it. This PR records the conflict in the registry and rule register (entries `OD05-NDCA-0001`, `OD05-NDCA-0002`).

### Silent-source and gap list

- UCWDC has no general conflict-of-interest rule in the supplied rules; the Judge Certification Code of Conduct is **not provided**
  (open gap, listed in the registry "Known gaps"). **Requesting it is the owner's decision; this work contacts no one.**
  Until supplied, any general UCWDC conflict behavior is organizer policy / DanceFlow policy, never a UCWDC requirement.
- NDCA IV.A.8 and WSDC 3.4.6.a.i are advisory under their wording; DanceFlow must not present them as mandatory.
- NDCA IV.A.2 names "Open Adult Amateur A" and "Professional" events. DanceFlow has no source-grounded mapping from its
  division labels (`age_label`, `skill_label`) to those NDCA classes. Until a profile exists IV.A.2 cannot be evaluated per division (Q4).

## 2. Body-specific versus DanceFlow policy

Body selection reads `events.competition_sanctioning` (`none | ucwdc | ndca | wsdc | other`, migration `20270113090000`), an
unverified declaration. (OD-01, PR #832, separately blocks results approval/publication for declared bodies until scoring is verified.)

| Check | NDCA declared | WSDC declared | UCWDC declared | none / other (Studio, Custom) |
|---|---|---|---|---|
| Tier 1, direct identity: the official is a participant of an entry in the contest being judged | block (self-judging is not allowed by any NDCA text read; family/household is IV.A.1) | block; self-judging is allowed only in Champions/invitational (3.4.6.b.iii), which slice 1 does **not** model, so block with no override | block as **DanceFlow policy** (UCWDC silent) | block as **DanceFlow policy** (slice 5) |
| Tier 2, the official competes anywhere in the event | block for judge, chair, scorer (III.D.21) | block for chair, secondary chief judge and score person only (3.4.2); exceptions not modelled, so block | block only for Crown/SuperStars same Dance Type (II.F.6.e) once Dance Type is modelled; otherwise info | **not blocked**, recorded as an info finding (baseline is direct conflicts only) |
| Declared family / household / partner / business conflicts (slice 2) | categories per IV.A.1 (definition unresolved) | exactly the four categories of 3.4.6.a | organizer policy categories only | DanceFlow baseline categories (4.3) |
| Panel relatedness (slice 4) | IV.A.2 for the classes it names; unevaluable until Q4 | not a WSDC rule | none | none |
| Pro/Am professional who is the judge, in their own student's heat | IV.A.8 is advisory: DanceFlow blocks as policy and labels it so | covered by tier 1; exception i concerns *other* judges and is modelled later | policy | policy |

Principle: DanceFlow policy may be **stricter** than a body's rule (never claimed as the body's requirement) but never looser for
a declared body. Exceptions (WSDC 3.4.6.b.i-iii, WSDC 3.4.2 carve-outs; none stated for NDCA III.D.21) are body-specific, need a
documented resolution row (slice 3), and are unavailable in slice 1.

## 3. What automatic detection can and cannot do (copy rule)

Automatic checks relate **accounts and identity anchors only**. They **cannot detect family, household, partner or business
relationships**: only a declaration (slice 2) or a panel-relatedness entry (slice 4) can carry those. Every UI string, error and
readiness message must say so. A clean automatic check is never described as "no conflicts"; it is "no identity match found".

### 3.1 Identity model used (existing, unchanged)

- `event_competition_officials(user_id, role judge|scorer|chair, status)`: one account per official per event.
- `event_competition_competitors(user_id, client_id, instructor_id, email, ...)`: anchors are per-event unique and immutable once set (Phase 10C).
- `event_competition_entry_participants(competitor_id, participant_role, entry_id)`, `event_competition_entries(division_id, status)`,
  `event_competition_heat_entries(heat_id, entry_id, status)`, `event_competition_rounds(division_id, status)`.
- `client_account_links(client_id, user_id, status, relationship_type self|guardian|billing_contact|dependent)`.
- `instructors(user_id, studio_id)`.

### 3.2 Match classes

| Class | Basis (`basis_code`) | Outcome |
|---|---|---|
| **DEFINITE** | `competitor.user_id = official.user_id` (`user_anchor`); competitor's instructor row has `user_id = official.user_id` (`instructor_account`); competitor's client has a `client_account_links` row `status = 'linked'`, `relationship_type = 'self'`, `user_id = official.user_id` (`client_self_link`) | block (per section 2 tier rules) |
| **REVIEW** | the competitor's client is linked to the official's account as guardian, billing_contact or dependent (`client_shared_link`); an un-anchored competitor whose normalized email equals the official's verified email (`email_equal`) | never "proof of a prohibited relationship"; creates a review finding (Q1: whether it blocks) |
| none | name similarity, address, phone, same studio, shared payer | **never used.** Names and emails are never used to merge people (Phase 10C rule) |

A guardian or billing link may mean family or a shared studio account; the system cannot tell, so it is REVIEW and organizers see
"shared account", not a relationship claim.

### 3.3 Where it runs (server-side, three points, all database level)

1. **Assignment**: `BEFORE INSERT` trigger on `event_competition_panel_assignments`, firing after E1's `guard_competition_panel_assignment`
   (name order; that guard is not redefined). Evaluates tier 1 against the round's division/heat entries and tier 2 per section 2. A trigger,
   not a redefinition of `assign_competition_panel_member`, so no md5-pin collision with other sessions.
2. **Ballot acceptance**: `BEFORE INSERT` triggers on `event_competition_ballots` (heat ballots: all non-scratched heat entries) and
   `event_competition_marks` (per entry, which covers round-level callback ballots), named to fire after the E2 guards
   (`compe2_guard_ballot_insert`, `compe2_guard_mark_insert`), which are not redefined. For `scorer_paper` ballots the entering scorer
   (`entered_by_official_id`) is evaluated too.
3. **Panel lock / round start**: slice 4 (section 5).

Re-check at ballot time matters: anchors can be completed after assignment, late entries can join a heat, an official can be re-added.
The check reads current data each time (no cached verdict).

### 3.4 Evidence of a refusal

A raising trigger rolls back its own inserts, so an audit row written inside it would vanish. Design: the trigger raises a
structured error (`COMP_CONFLICT_IDENTITY`, `COMP_CONFLICT_REVIEW`); the server action catches it and calls
`record_competition_conflict_refusal(...)` in a **separate transaction** (best-effort evidence; the block itself is transactional and
never depends on it). A REVIEW that does not block is written in the same transaction as the accepted operation.

## 4. Data model (one migration block; nothing applied)

All new tables: `event_id` first-class, composite FKs `(x_id, event_id)`, RLS on, `revoke all` from `public, anon, authenticated`
then narrow grants, `security definer` functions with `set search_path = public, pg_temp`, evidence tables protected by
`protect_competition_history_evidence()` (append-only, truncate-proof) exactly like E1/E2.

### 4.1 `event_competition_conflict_findings` (slice 1; immutable evidence)

`id, event_id, official_id, round_id null, heat_id null, entry_id null, competitor_id null, tier (1|2), class ('definite'|'review'|'info'),
basis_code, rule_code (e.g. DF-DIRECT-1, NDCA-III-D-21, WSDC-3-4-2), rule_set_version, detected_via ('assignment'|'ballot'|'start'|'scan'|'refusal'),
request_id, detected_at, detected_by`. Ids and codes only; no personal data copied.

### 4.2 Rule set as code, not config

`_compoc_rule_set(p_sanctioning text) returns jsonb` is an immutable SQL function returning the section 2 matrix with a version string
(`oc-v1`). Rule changes are a new function version in a new migration; findings store `rule_set_version`. There is deliberately no
organizer-editable rule table (it would let an organizer weaken a body rule); exceptions go through resolutions (4.4).

### 4.3 `event_competition_conflict_declarations` (slice 2)

`id, event_id, official_id, declared_by, subject_competitor_id null | subject_entry_id null`, `scope_type ('event'|'division'|'round'|'heat')`
with exactly the matching id column non-null (CHECK), `category` from a closed set (`immediate_family, household_member,
spouse_or_significant_other, established_dance_partner, business_partner, pro_am_student_partner, team_coaching, other_declared`),
`status ('active'|'withdrawn'|'resolved')`, `declared_at`, `note text (<=500, restricted)`, `request_id`.
Categories map to body definitions through the rule set (WSDC 3.4.6.a uses four; NDCA waits for the source conflict; UCWDC and
Studio use organizer/DanceFlow categories). A judge declares for themselves; a manager or the chair may declare on a judge's behalf
(labelled). Status changes only via RPC, each adds an events row.

### 4.4 `event_competition_conflict_resolutions` (slice 3; immutable)

`id, event_id, finding_id null, declaration_id null, decision ('recused','not_a_conflict','exception_applied','review_cleared','review_upheld'),
exception_code null (closed set: WSDC-3.4.6.b.i, WSDC-3.4.6.b.ii, WSDC-3.4.6.b.iii, WSDC-3.4.2-carveout), reason (1-500), decided_by,
decided_role ('chair'|'manager'), decided_at`. Rules: `exception_applied` accepted only if the event's sanctioning body defines that
exception; nobody can clear a DEFINITE tier-2 NDCA III.D.21 match (no exception is stated in the supplied text); a judge cannot resolve
their own conflict; the resolver must differ from the subject official.

### 4.5 `event_competition_conflict_events` (audit log, immutable)

Kinds: `finding_recorded, declaration_created, declaration_withdrawn, resolution_recorded, assignment_blocked, ballot_blocked,
panel_lock_blocked, panel_relation_recorded`. E1 idempotency pattern (`request_id` unique per event, fingerprint replay).

### 4.6 `event_competition_panel_relations` (slice 4)

Organizer-entered relatedness between two **officials** of the same event: `(official_a_id, official_b_id, basis 'immediate_family'|'household',
entered_by, entered_at)`, unordered-unique. Used only for the panel-level restriction (NDCA IV.A.2) and unusable until Q4 and the
family definition are resolved. Visible to managers and chair only.

### 4.7 Enforcement function (slice 3)

`_compoc_conflict_state(p_official_id, p_round_id, p_heat_id, p_entry_id)` = live identity matches (slice 1) + active declarations whose
scope covers the target (slice 2) - valid resolutions, filtered by the rule set. The assignment and ballot/marks triggers call it.
A blocked result blocks **only** that official's assignment to that round or that official's ballot for that heat (callback ballot:
that round); other judges, other rounds, other heats, registration, payments are untouched.

**Round granularity (Q3):** E1 assignment is round-scoped, so an identity conflict with one entry blocks the judge from the whole round,
which is stricter than NDCA's per-heat wording. A heat-scoped recusal inside an assigned panel leaves that heat with one fewer ballot;
the scoring engines and OD-16 panel-size rules must be shown to accept that before it is built. Slice 3 starts with round-level blocking.

### 4.8 RPCs (security definer, pinned search_path, request-id idempotent, executable only by `authenticated`)

| RPC | Slice | Caller | Notes |
|---|---|---|---|
| `competition_check_official_conflicts(p_round_id, p_official_id)` | 1 | manager / chair | read-only preview for the assignment UI; class, codes, scope; no personal data |
| `record_competition_conflict_refusal(...)` | 1 | server actions only | separate-transaction evidence of a blocked attempt |
| `declare_competition_conflict(...)`, `withdraw_competition_conflict(...)` | 2 | judge (own), manager/chair (on behalf) | scope CHECKs; no relationship free text in list views |
| `list_competition_conflicts(p_event_id)` | 2 | manager / chair | category + scope + status; detail RPC separate |
| `resolve_competition_conflict(...)` | 3 | chair or manager, not the subject | documented resolution; exception codes validated by sanctioning |
| `competition_round_conflict_blockers(p_round_id)` | 4 | manager / chair | jsonb blocker list for the readiness panel |
| `set_competition_panel_relation(...)`, `clear_competition_panel_relation(...)` | 4 | manager | audited |

### 4.9 RLS and confidentiality matrix (slice 7)

| Role | Findings | Declarations | Resolutions | Panel relations | Ballots / marks |
|---|---|---|---|---|---|
| manager (`can_manage_event_competition`) | all | read all, create on behalf | read, create | read, write | unchanged |
| chair official (active, team member per OJ-1) | codes + scope only | category + scope + status; note only for panels they chair | read, create (not their own) | read | unchanged |
| judge / scorer | none (generic refusal only) | own only | own subject only, read | none | own ballot only (unchanged) |
| competitor, other staff, anon | none | none | none | none | none |

Judge-facing refusals say "you cannot score this contest: a conflict is recorded; contact the chair" and never name the competitor,
basis or category. Conflict checks read only ids from `marks`/`ballots`, never another judge's mark values (ballot confidentiality).

## 5. Slice 4: panel-lock validation and the shared guard point (the OD-05 / 06 / 15 / 16 overlap risk)

One new `BEFORE UPDATE OF status` trigger on `event_competition_rounds` (`compoc_guard_round_activation`, separate from the E2 edge guard
`compe2_guard_round_lock_edges`, which is not redefined) fires on the edge into active and into locked. It calls **one** aggregator,
`_compoc_round_panel_blockers(p_round_id) returns jsonb`, which concatenates validator results in fixed order, each item
`{code, severity, source, ...}`:

1. `_compoc_blockers_conflicts`: OD-05 (this design). Unresolved definite findings on seated officials; active declarations covering the round;
   panel relations (once Q4 is resolved); unresolved REVIEW findings if Q1 = block.
2. `_compoc_blockers_roles`: **OD-06 placeholder, not yet decided.** WSDC 3.4.1 / 3.4.3 role separation.
3. `_compoc_blockers_qualifications`: **OD-15 placeholder, not yet decided.** Body credential / attestation readiness.
4. `_compoc_blockers_panel_size`: **OD-16 placeholder, not yet decided.** Per-body minimum panel, chair requirement, non-voting chair.

Validators 2-4 ship as functions returning `[]` until their decisions land, so the guard point, its error (`COMP_PANEL_BLOCKED` with the jsonb list)
and the readiness UI contract are fixed once and the three later decisions plug in without a second trigger, a second error vocabulary
or contradictory ordering. E1's `competition_round_panel_status/ready` are read by the UI beside this list and are not modified.

## 6. OD-06 / OD-15 / OD-16 touchpoints (placeholders only)

| Decision | Status | Touchpoint with OD-05 | Reserved |
|---|---|---|---|
| OD-06 role separation | **not yet decided, design placeholder only** | needs one shared definition of "event director / owner" (today only the manager role exists); OD-05 WSDC tier 2 must read that definition, not invent another. A guard in `add_competition_official` would redefine a pinned E1 function. | migration slot; `_compoc_blockers_roles` |
| OD-15 qualifications | **not yet decided, design placeholder only** | credential fields would be new columns on `event_competition_officials` plus a validator; UCWDC tiers wait for the Code of Conduct (open gap). No OD-05 table depends on them. | migration slot; `_compoc_blockers_qualifications` |
| OD-16 panel size / chair | **not yet decided, design placeholder only** | heat-scope recusal (Q3) shrinks a heat's judge count and must satisfy OD-16 minimums; the chief-judge substitution (WSDC 3.4.6.b.iv) belongs here, not in OD-05. | migration slot; `_compoc_blockers_panel_size` |
| OD-17 appointment / substitution | outside this task | a chair "excuse" (NDCA IV.C.8) would be a resolution kind; the panel freeze (`COMP_PANEL_FROZEN`) interacts with late recusal. Flagged only. | none |

## 7. Migration block, ordering, rollback

Latest migration on `origin/release/website-embeds` is `20270218090000`. Proposed block for the coordinator to confirm
(Q6): **`20270220090000` to `20270220096000`**, one file per step, applied strictly in order, each with
`rollback/<name>_rollback.sql`, a header stating **"PROD apply needs separate owner approval; not applied to any database"**,
LF-only function bodies (Phase 10D CRLF lesson), and an md5 pin plus preflight for anything redefined.

| Timestamp | File (proposed) | Slice | Redefines an existing function? |
|---|---|---|---|
| `20270220090000` | `competition_oc_s1_identity_guard` | 1 | no (new triggers, functions, findings and events tables) |
| `20270220091000` | `competition_oc_s2_declarations` | 2 | no |
| `20270220092000` | `competition_oc_s3_enforcement_resolutions` | 3 | no (extends `_compoc_conflict_state`, owned by this block) |
| `20270220093000` | `competition_oc_s4_panel_lock` | 4 | no (new trigger on rounds, new aggregator, empty OD-06/15/16 validators) |
| `20270220094000` | reserved OD-06 | placeholder | would redefine `add_competition_official` (pinned) |
| `20270220095000` | reserved OD-15 | placeholder | adds columns to `event_competition_officials` |
| `20270220096000` | reserved OD-16 | placeholder | fills `_compoc_blockers_panel_size` |

No overlap with other sessions: OD-05 redefines none of `submit_competition_ballot`, `assign_competition_panel_member`,
`add_competition_official`, `_compe2_guard_*` or the scoring/results functions (OD-01 in PR #832 is app-layer). Everything attaches by
triggers named after the existing guards; preflight checks that every referenced trigger and signature exists and fails closed.

**Rollback:** each file's rollback drops triggers, then functions, then policies, then tables, in reverse order. Evidence tables are
append-only by design, so the rollback refuses to drop a table that holds rows unless the operator exports them and sets a session
setting acknowledging the loss; on an empty database (the only state before activation) it is clean. Verification is mechanical:
apply all, run the suite, roll back in reverse order, assert the schema fingerprint equals the pre-migration baseline
(runner pattern: `scripts/qa/cf1-db-settlement.mjs`).

## 8. Test plan (negative-first; local isolated Postgres under the heavy lock; NOT RUN for this docs PR)

- Slice 1: each DEFINITE basis (`user_anchor`, `instructor_account`, `client_self_link`) blocks assignment and ballot; REVIEW bases never
  block as proof and always write a finding; names/emails alone never produce DEFINITE; scratched/withdrawn entries ignored; same user
  in another event does not match; cross-tenant attempts refused; sanctioning matrix rows (`none/other` tier 2 info only; `ndca` tier 2
  blocks; `wsdc` tier 2 blocks only chair/scorer); anchor completed after assignment is caught at ballot time; `scorer_paper` entering
  scorer checked; a refused attempt leaves zero assignment/ballot/mark rows; refusal evidence written by the separate transaction;
  unrelated judge and unrelated round unaffected.
- Slice 2: scope CHECKs; judge declares own only; read isolation per matrix; withdrawal audited; no relationship text in list RPC.
- Slice 3: exception codes validated by sanctioning; subject cannot resolve self; NDCA tier-2 match cannot be cleared; resolutions immutable.
- Slice 4: guard fires only on the activation edge; blocker order stable; placeholder validators return `[]`.
- Cross-cutting: rollback verification; `ruleRegister.integrity.test.ts`; privilege test that no new function is executable by `anon`/`public`.

## 9. Open questions

- **Q1 (blocks PR-B / slice 1):** does an unresolved **REVIEW** match (guardian/billing/dependent shared-account link, or email-only match)
  **block** ballot acceptance and panel lock until a documented resolution exists, or is it **recorded and surfaced to the organizer/chair
  without blocking**? "Block until resolved" needs the slice 3 resolution table and a resolver UI in the same release (else a day-of judge
  is locked out with no way back); "record and surface" lets slice 1 ship alone. *Recommended: record and surface in slice 1; block until
  resolved from slice 3 for declared NDCA/WSDC events only.* The owner's wording ("review cases, not proof") does not say which.
- **Q2:** for `none/other/UCWDC` events, is tier 2 (official competes elsewhere in the same event, not in the contest they judge) info-only
  (recommended; matches "direct-conflict" in slice 5) or a block?
- **Q3:** round-level recusal first (recommended) versus heat-level recusal inside an assigned panel (needs engines and OD-16 to accept a heat with fewer ballots).
- **Q4:** NDCA IV.A.2 needs division classification and the family definition (source conflict). Confirm NDCA panel relatedness stays
  unimplemented, and not relied on for an NDCA-declared event, until both exist.
- **Q5:** who is "event director / owner" for WSDC 3.4.2 in DanceFlow (OD-06 dependency)? Slice 1 uses chair and scorer only for WSDC tier 2.
- **Q6:** confirm migration block `20270220090000`-`20270220096000` is free.

## 10. Decision on PR-B

Slice 1 code and migration (PR-B) is **not started**: slice 1 depends on **Q1**, which decides whether it also needs the resolution table
and a resolver surface (a different migration shape). Everything else slice 1 needs is settled above. With the recommended answer to Q1,
PR-B is a bounded follow-up: findings and events tables, rule-set function, three triggers, preview RPC, refusal-evidence RPC, rollback,
negative tests, independent review.
