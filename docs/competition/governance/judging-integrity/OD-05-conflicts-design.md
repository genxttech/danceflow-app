# Judging-integrity design: OD-05 conflicts and recusal (slices 1-4) and OD-06 WSDC role separation, with OD-15 qualifications, OD-16 panel and OD-17 panel-change design

**Status: DESIGN ONLY (PR-A, docs).** No SQL, no code, nothing applied, merged, deployed or activated. Competition OS is dark.
Governed by [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md). Owner decision OD-05 (2026-11-23, Option D, BLOCK, with panel-level
safeguards) is recorded in the audit owner-decision list (PR #795, `OWNER-DECISIONS.md`, branch `claude/comp-audit-owner-decisions`).

**OD-17 was decided on 2026-11-23 (owner): Option B now (Studio/Custom panel behavior unchanged), Option A required for a future NDCA profile** (section 6D, design only).

**OD-16 was decided on 2026-11-23 (owner): Option B now (Studio/Custom model kept, subject to fixing its internal panel-minimum inconsistency), Option A for future body profiles** (section 6C and the separate defect document).

**OD-15 was decided on 2026-11-23 (owner): Option B now (organizer attestation), Option A for future body profiles** (section 6B, design only, no credential SQL).

**OD-06 was decided on 2026-11-23 (owner): Option A, enforce WSDC separation of duties** for WSDC-declared events, with explicit event-level
designations (section 6A). It is designed here in the same coordinated block as OD-05.

**What this document does not do:** it invents no rule, claims no body compliance, and decides nothing beyond the owner decisions it records.
Those two are **not yet decided: design placeholder only** wherever they appear below. Where a source is silent or conflicting
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
| WSDC 3.4.3 (p.19) | same | Chief judge and scoring/tabulation functions must be provided by separate individuals. | mandatory (OD-06) |
| WSDC 3.4.4 (p.19) | same | A chief judge must review all finalists before finals are posted or started. This is a review duty, **not** a scoring or tabulation function. | mandatory (OD-06 interaction) |
| WSDC 3.4.5, 3.4.5.a (p.19) | same | Judges and scorekeepers may not take other roles (MC, DJ, contest team, photographer) during that contest. Exception: when a champion's or invitational division is self-judged, a contestant may hold more than one role in addition to being on the panel. | mandatory with exception |
| WSDC Definitions: Event Director(s) and/or Owner(s) (p.2) | same | An Event Director is anyone involved in deciding the hiring of judges and/or scoring staff, or identified as the Event Director. An Owner is anyone with a vested financial/ownership interest (e.g., shareholder). Non-profit shareholders or board members are not Owners but may fall under Event Director restrictions depending on their role. | definitions |
| WSDC Definitions: Chief Judge, Secondary Chief Judge, Raw Score Judge (p.3) | same | The Chief Judge oversees the event's contests, has extensive experience and cannot compete. The Secondary Chief Judge has the same restrictions. A Raw Score Judge is separate from the panel, may compete in other contests, and has no access to scores and no contest-structure duties. | definitions |
| WSDC 2.3 (p.9) | same | The Event Director and/or the Chief Judge shall verify contest results and the number of contestants. Verification is expressly given to these roles, so it is **not** itself a prohibited scoring function. | mandatory (OD-06 interaction) |
| WSDC 3.4.9.b.i (p.20) | same | Transfer of paper score sheets into the computerized system must be audited by the Chief Judge or a scoring team the Chief Judge approves, verified by someone other than the score person inputting the data. | mandatory (adjacent; section 6A.8) |
| WSDC 3.4.6, 3.4.6.a (p.19) | same | All conflicts must be identified and avoided (responsibility of directors, chief judge, judges). A conflict is only: a judge/chief judge judging an immediate family member, current spouse/significant other, established dance partner, or current business partner. | mandatory |
| WSDC 3.4.6.a.i (p.19) | same | General bias is a recommendation only; WSDC enforces only the 3.4.6.a definition. Staff are responsible for providing conflicts to the chief judge and/or directors. | recommended; **supports declarations** |
| WSDC 3.4.6.b (p.19-20) | same | Assignments must prevent conflicts; judges/chief judges recuse from the panel. **Four** listed exceptions (the audit says three): (i) Pro-Am Jack and Jill / Strictly Swing, judging the Amateurs only where the conflict is with the Pro; (ii) opposite role to the competitor in Jack and Jill *preliminary* rounds; (iii) self-judging, only in Champions and invitational contests; (iv) chief judge replaced by the secondary chief judge when necessary (a substitution, not a conflict exception). | permitted exceptions |
| UCWDC-C II.F.6.e (p.5) | UCWDC Couples 2026 (v1-26-2026) | Crown competitors entering Classic Open I or Showcase Open may not judge that Dance Type while dancing it. UCWDC-L II.F.5.d is the Line Dance equivalent (not re-read in this pass; carried from the audit). | mandatory (narrow) |
| UCWDC-C II.N.3 (p.13) | same | Panel-composition complaints are post-event to the Judge Review Board; the Judge Certification Code of Conduct (website) governs. **Not provided.** | open source gap |

Correction to carry forward: the audit and owner list say "three exceptions" for WSDC 3.4.6.b; the pinned text has four sub-items (i-iv),
of which only i-iii relate to conflicts. Exception modelling (slice 3) uses i-iii only.

### Source conflict to record (not resolve)

NDCA IV.A.1 (p.25) and IV.D.1.a(2) (p.28) define "immediate family" differently (an enumerated list versus "first cousin or above").
They cannot both be applied as written, and "or above" is undefined. Per registry rule 3 this is a source conflict:
**any NDCA family/household rule that depends on the definition fails closed**, and **no NDCA family-definition compliance is claimed**
until the owner resolves it. This PR records the conflict in the registry and rule register (entries `OD05-NDCA-0001`, `OD05-NDCA-0002`, `OD05-NDCA-0003`).

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
| Tier 1, direct identity: the official is a participant of an entry in the contest being judged | block (an adjudicator may not compete at the event (III.D.21), which covers judging one's own entry; family/household is IV.A.1) | block; self-judging is allowed only in Champions/invitational (3.4.6.b.iii), which slice 1 does **not** model, so block with no override | block as **DanceFlow policy** (UCWDC silent) | block as **DanceFlow policy** (slice 5) |
| Tier 2, the official competes anywhere in the event | block for judge, chair, scorer (III.D.21) | block for the **designated** persons only (event owners, event directors, their spouses and children, chief judge, secondary chief judge, score person; section 6A); exceptions via documented resolution only; with no designation the operation fails closed | block only for Crown competitors, same Dance Type, Classic Open I / Showcase Open (II.F.6.e) once Dance Type is modelled; otherwise info | **not blocked**, recorded as an info finding (baseline is direct conflicts only) |
| Declared family / household / partner / business conflicts (slice 2) | categories per IV.A.1 (definition unresolved) | exactly the four categories of 3.4.6.a | organizer policy categories only | DanceFlow baseline categories (4.3) |
| Panel relatedness (slice 4) | IV.A.2 for the classes it names; unevaluable until Q4 | not a WSDC rule | none | none |
| Pro/Am professional who is the judge, in their own student's heat | IV.A.8 is advisory: DanceFlow blocks as policy and labels it so | covered by tier 1; exception i concerns *other* judges and is modelled later | policy | policy |

Principle: DanceFlow policy may be **stricter** than a body's rule (never claimed as the body's requirement) but never looser for
a declared body. Exceptions (WSDC 3.4.6.b.i-iii, WSDC 3.4.2 carve-outs; none stated for NDCA III.D.21 beyond non-competing honor dances and similar; III.D.21 also applies on every day an official is not contracted to work) are body-specific, need a
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

1. **Assignment**: `BEFORE INSERT` trigger on `event_competition_panel_assignments`, named `zz_compoc_guard_assignment_conflict` so that it fires after E1's `guard_competition_panel_assignment_row` (triggers fire in name order and a `compoc_` prefix would sort BEFORE `guard_`, ahead of the round FOR SHARE lock; a test asserts the fire order from `pg_trigger`)
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
| `record_competition_conflict_refusal(...)` | 1 | `service_role` only, never `authenticated`; recomputes the conflict itself and ignores any caller-supplied class (section 11, F10) | separate-transaction evidence of a blocked attempt |
| `declare_competition_conflict(...)`, `withdraw_competition_conflict(...)` | 2 | judge (declare own only), manager/chair (declare on behalf); withdraw and resolve only by a non-subject, never after the judge has ballots (F16) | scope CHECKs; no relationship free text in list views |
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
2. `_compoc_blockers_roles`: **OD-06 (decided: Option A)**, WSDC-declared events only. Missing or unverified designations; a designated owner/director/family member or chief judge seated in a restricted function; chair and scorer the same account; see section 6A.
3. `_compoc_blockers_qualifications`: **OD-15 (decided: Option B now, A later; section 6B).** Declared-body events only: lists each mandatory body credential requirement as unverified (attestation never clears it); with a future profile, missing/expired credentials for restricted body roles.
4. `_compoc_blockers_panel_size`: **OD-16 (decided: Option B now, A later; section 6C).** Studio X-3 rule now (single source of truth with the corrected E1/E2 readiness); per-body minimums later, hard blockers for mandatory provisions, warnings for advisory.
5. `_compoc_blockers_panel_change`: **OD-17 (decided; section 6D).** NDCA-declared events only: officials list published and approved, post-approval change authorization, emergency-substitution records. Stub returning `[]` until the future NDCA profile slot.

Validators 2-5 ship as functions returning `[]` until their decisions land, so the guard point, its error (`COMP_PANEL_BLOCKED` with the jsonb list)
and the readiness UI contract are fixed once and the three later decisions plug in without a second trigger, a second error vocabulary
or contradictory ordering. E1's `competition_round_panel_status/ready` are read by the UI beside this list and are not modified.

## 6. OD-06 / OD-15 / OD-16 touchpoints (OD-06, OD-15, OD-16 and OD-17 decided)

| Decision | Status | Touchpoint with OD-05 | Reserved |
|---|---|---|---|
| OD-06 role separation | **decided 2026-11-23, Option A**; designed in section 6A | event-level designations replace guessing; the WSDC tier-2 list in OD-05 reads them. | designations table; `_compoc_blockers_roles` |
| OD-15 qualifications | **decided 2026-11-23** (Option B now, Option A for future profiles); designed in section 6B | attestation table and `qualification_attester` designation reuse the OD-06 tables; no column on `event_competition_officials`; UCWDC judge tiers wait for the Code of Conduct (open gap). | attestation migration slot; `_compoc_blockers_qualifications` |
| OD-16 panel size / chair | **decided 2026-11-23** (Option B now, Option A for future profiles); designed in section 6C | heat-scope recusal (Q3) shrinks a heat's judge count and must satisfy the Studio X-3 rule and later body rules; the chief-judge substitution (WSDC 3.4.6.b.iv) and 3.4.7.c shortage are documented resolutions. | `_compoc_blockers_panel_size` |
| OD-17 appointment / substitution | **decided 2026-11-23** (Option B now, Option A for a future NDCA profile); designed in section 6D | a recusal that empties a seat and an emergency substitution share one panel-change record; the Chairman excusal (NDCA IV.C.8) needs the OD-06 Chairman designation; panel freeze (`COMP_PANEL_FROZEN`) interacts with late recusal. | `_compoc_blockers_panel_change`, s9 slot |

## 6A. OD-06: WSDC separation of duties (decided: Option A)

Scope: **WSDC-declared events only** (`events.competition_sanctioning = 'wsdc'`). NDCA, UCWDC, Studio and Custom events get none of these
rules as if the body mandated them (NDCA and UCWDC do not forbid an owner judging in the sections read: NOT SPECIFIED IN PROVIDED
SOURCE; NDCA III.D.21 stays an OD-05 competing rule). Ordinary platform administration (registration, schedule, payments, check-in,
roster) is never restricted by this section; only the judging, scoring and tabulation functions named below are.

### 6A.1 Why designations: DanceFlow roles are not WSDC roles

| DanceFlow thing | Is it a WSDC role? |
|---|---|
| Studio/organizer account owner or manager (`can_manage_event_competition`) | **No.** Not an Event Owner, Event Director or Chief Judge by itself. May be one, or none. |
| E1 official role `chair` | **No, not by itself.** Becomes the WSDC Chief Judge only when designated as such for the event. |
| E1 official role `scorer` | **No, not by itself.** Becomes the score person / scoring-tabulation operator only when designated. |
| E1 official role `judge` | Judge. |
| Anyone who decides who is hired as judges or scoring staff (for example the manager who adds officials) | **May be an Event Director by the WSDC definition** (p.2) whether or not anyone wrote that down. The system cannot know, which is why designation is an explicit, attested step and the unattested state fails closed. |

### 6A.2 Table `event_competition_role_designations` (new; event-level; nothing applied)

`id, event_id, kind, user_id null, display_name text null, official_id null, relation_to_designation_id null, status ('active'|'ended'),
designated_by, designated_at, ended_by, ended_at, end_reason, evidence_ref text null (<=200), request_id`.
`kind` (closed set): `event_owner` (vested financial/ownership interest, incl. shareholders), `event_director` (involved in selecting judges
and/or scoring staff, or named Event Director), `owner_director_family` (spouse or immediate family of an owner/director, with
`relation_to_designation_id` pointing at that owner/director; children and spouses per 3.4.2, spouses and immediate family per 3.4.1.a),
`chief_judge`, `secondary_chief_judge`, `scoring_operator` (score person, or contest administrator with automated scoring),
`raw_score_judge` (optional: allowed to compete in other contests, 3.4.2 definitions; carries no scoring access).
Judges are the existing officials and need no designation. A designee may have no account (`user_id` null, name only): the
system **cannot** match such a person automatically (names are never used), so their separation rests on the attestation (6A.3) and
on the accounts the organizer lists. Rows are ended, never edited or deleted (`protect_competition_history_evidence`-style guard on identity
fields; status change via RPC only). Only ids, kind and an optional short evidence note: no ownership percentages, no relationship free text.

### 6A.3 Verification (fail closed)

Table `event_competition_role_attestations` (immutable): `id, event_id, attested_by, attested_at, designations_fingerprint, statements jsonb, request_id`.
An attestation is valid only while its fingerprint equals the md5 of the current active designation set; any designation change invalidates it.
Statements (each a yes/no the attester signs, labelled "attestation, not verified by DanceFlow"):
all event owners and directors (including anyone who decided judge or scoring hiring) are designated; owners' and directors' spouses and
immediate family are designated; the chief judge and scoring operator are designated and are different people; judges and scorekeepers hold no other role
in their contest (3.4.5; not detectable by the platform).
**Who may attest** is Q7 (recommended: a manager other than the one who last changed the designations; where the event has one manager, that
manager plus an explicit acknowledgement recorded as such, never silently). **WSDC-declared event with no valid attestation:**
adding or reactivating an official with role judge/chair/scorer, ballot acceptance, and calculation are refused (`COMP_WSDC_DESIGNATIONS_REQUIRED`).
Everything else works.

### 6A.4 Guards (database level, WSDC-declared events only; all via new triggers, no redefinition)

| # | Rule | Source | Trigger and test |
|---|---|---|---|
| G1 | An active `event_owner` or `event_director` designee's account cannot be an active official with role judge, chair or scorer, nor be designated chief judge, secondary chief judge or scoring operator. | 3.4.1 | `BEFORE INSERT/UPDATE` on `event_competition_officials` and on designations |
| G2 | An `owner_director_family` designee's account cannot be chair or scorer or designated chief judge / secondary chief judge / scoring operator. It **may** be an ordinary judge as far as 3.4.1.a goes; OD-05 conflict rules (3.4.6) still apply. | 3.4.1.a | same triggers |
| G3 | Chief judge and scoring operator are different accounts; the same account cannot hold official roles `chair` and `scorer`; the secondary chief judge counts as chief judge for G3. | 3.4.3 | same triggers |
| G4 | The calculating actor of a result version (`event_competition_result_versions.calculated_by`) must not be an owner, director, owner/director family member, chief judge or secondary chief judge. Scoring and tabulation is the scoring operator's (or an undesignated manager's, see 6A.5) function. | 3.4.1, 3.4.3 | `BEFORE INSERT` on `event_competition_result_versions` |
| G5 | **Approval and verification are not blocked for event director or chief judge.** The existing F2 rule (approver differs from the calculator, or an audited override) stays; WSDC 2.3 gives verification to these roles. A chief judge's finalist review (3.4.4) is a separate review step and is never treated as a scoring function. | 2.3, 3.4.4 | tests assert the chief judge can approve and review, cannot calculate |
| G6 | Tier 2 (OD-05 slice 1): a designated owner, director, their spouse/children, chief judge, secondary chief judge or scoring operator whose identity matches a competitor in the event is blocked from their judging/scoring function and shown as a panel-lock blocker. Exceptions (non-judged contests; separate-organization or different-genre contests authorized by the Board two months ahead; the UCWDC Pro-Am WCS carve-out) only through a documented resolution carrying `exception_code`, the body reference, and for the separate-organization case the Board authorization reference and date. | 3.4.2 | OD-05 tier-2 with designation list as input |
| G7 | Self-judged champion or invitational divisions (3.4.5.a, 3.4.6.b.iii): a contestant may sit on the panel only through an `exception_applied` resolution naming the division, with evidence; never automatic. Division type "champion/invitational" has no source-grounded attribute today, so the exception is a documented resolution, not an inferred property. | 3.4.5.a | same resolution table as OD-05 slice 3 |

Scope guard: nothing here ever blocks reading, registration, scheduling, payments, check-in, or any operation by a manager who holds no
designation and no judging/scoring role.

### 6A.5 Undesignated manager performing calculation

A manager with no designation may calculate or approve as today (F2 unchanged) **provided a valid attestation exists** that no designation covers them. This
preserves ordinary administration; the attestation is the safeguard for the hiring-decision Event Director definition that no data can reveal.

### 6A.6 Role-to-permission mapping (documented; WSDC-declared event)

| Capability | Owner / Director | Owner/Director family | Chief judge (Secondary) | Scoring operator | Judge | Undesignated manager |
|---|---|---|---|---|---|---|
| Be official judge | no | yes (OD-05 conflicts apply) | no | no | yes | no (if also an owner/director) |
| Be chair (official role) | no | no | yes, only if designated chief judge | no | no | no |
| Be scorer (official role) | no | no | no | yes, only if designated | no | no |
| Enter/ballot as judge | no | yes | n/a (chair marks only if also designated as judge: not allowed by G1/G3 combos) | no | yes | no |
| Calculate results | no | no | no | yes | no | yes if attested undesignated |
| Approve / verify results | yes (2.3) | no (not named) | yes (2.3) | yes, if different from the calculator (existing F2 rule) | no | yes |
| Review finalists (3.4.4) | n/a | n/a | yes (required) | no | no | no |
| Compete in the event | no (3.4.2, exceptions) | no (3.4.2 spouses/children; 3.4.1.a duties only) | no | no | allowed by 3.4.2 (ordinary judges not named); OD-05 conflicts apply | allowed unless designated |
| Registration, payments, schedule, check-in | unrestricted | unrestricted | unrestricted | unrestricted | n/a | unrestricted |

Cells marked "n/a" are not a rule; they mean the capability does not apply to that role. Cells are DanceFlow's reading of the cited text and are
reviewed independently before any implementation.

### 6A.7 Finalist review (3.4.4)

Proposed: a `finalist_review_recorded` event by the designated chief judge or secondary chief judge before a final round starts in a WSDC-declared
event, as a start blocker in `_compoc_blockers_roles`. Whether the platform should require it (mandatory under 3.4.4) at slice level is Q8.

### 6A.8 Out of scope here, flagged

WSDC 3.4.9.b.i (paper score sheet transfer verified by someone other than the data-entry score person): relates to `scorer_paper` ballots; to be designed
with the OD-01/OD-07 scoring work, not in this block. Raw-score-judge access limits (no access to scores) not modelled.

### 6A.9 Interaction with OD-05

- OD-05's WSDC tier-2 list is the set of active designations of kinds owner, director, family, chief judge, secondary chief judge, scoring operator (this
  replaces my earlier assumption of "chair and scorer only"; Q5 closed).
- One matcher function serves both: designations carry `user_id`; tier-2 uses the DEFINITE/REVIEW classes of section 3.2.
- One error vocabulary through the shared aggregator (`COMP_PANEL_BLOCKED`); OD-06 adds codes `COMP_WSDC_DESIGNATIONS_REQUIRED`, `COMP_WSDC_ROLE_SEPARATION`.

## 6B. OD-15: qualifications of officials (decided 2026-11-23: Option B now, Option A for future body profiles)

**Docs and design only.** No credential SQL, no migration file exists. Decision: the organizer (or an explicitly designated authorized administrator)
attests to officials' qualifications now (Option B); role-specific credential records with verification status, evidence, expiry and rulebook
version are designed for future NDCA/UCWDC/WSDC profiles (Option A). OD-01 (PR #832) body-scoring restrictions and every release gate are unchanged:
nothing in this section approves, publishes or enables a body-scored result.

### 6B.1 Rule evidence (re-read in the pinned PDFs on 2026-11-23)

| Ref | Document / edition | What it says (own words) | Class |
|---|---|---|---|
| NDCA III.B.4 (p.16) | Rule Book June 2026 | The Chairman of Adjudicators (any sanctioned event) must be a U.S. resident, on the current NDCA roster, with full membership in every category of the event; for a Championship also a Scrutineering Certificate. The Chairman should, if possible, be non-voting. A Scrutineer may not serve as Chairman and may serve only as a substitute adjudicator; the text cross-refers that to III.B.5, which is the WDC non-resident rule, so the reference looks mis-numbered (substitution wording is elsewhere; audit F8) and is not copied as fact. | mandatory; non-voting is **recommended** (OD-16) |
| NDCA III.B.4.a-b (p.16) | same | Chairman levels CH1, CH2, CH3 limit which events they may chair (CH1 and CH2 also require an active S1 Scrutineer License); high-ranking officials may chair special Championships without a Scrutineering Certificate if two Scrutineers are present and the Ballroom Committee approves. | mandatory with exception |
| NDCA III.B.1.b (p.14) | same | At least one qualified Chairman must officiate at every sanctioned event. | mandatory |
| NDCA III.B.1.e, III.B.1.f (p.14-15), III.B.2 (p.15) | same | At least one NDCA-certified Scrutineer must officiate; a back-up Scrutineer is required when only one is engaged; scrutineer levels S1-S3 are awarded on an NDCA exam, and an S1 may be hired only while an S2 or S3 works simultaneously. | mandatory |
| NDCA III.B.3, III.B.3.a (p.16) | same | Organizers select adjudicators from the Current Roster; all must be certified and qualified for the categories they judge; Sanctioned Championships use only adjudicators accepted as Championship Adjudicators. | mandatory |
| NDCA IV.A.6 (p.25) | same | Adjudicators must be qualified and certified in the type and style judged and hold an NDCA Adjudicator's License; Associate level or higher may judge all categories except Championships (Full Member or Fellow only). | mandatory |
| NDCA III.D.5 (p.20) | same | No organizer, chairman, adjudicator, scrutineer, registrar, MC or music director may officiate unless registered with the NDCA. | mandatory |
| NDCA III.B.5 (p.16) | same | Non-resident adjudicators or officials need a current World Dance Council license to officiate at NDCA sanctioned events. | mandatory |
| UCWDC-C II.B.1.b, II.B.2 (p.3) | UCWDC Couples 2026 | A current, dues-paid Associate Membership is mandatory for each Contest Coordinator, Judge, Scrutineer and Scoring Director working a UCWDC-sanctioned event; membership expires on the last day of the Dance Season (January 15). | mandatory |
| UCWDC-SF preamble (p.1), General Information (p.8) | UCWDC Scoring Format v16.9b | All contest procedures are supervised by a UCWDC "certified" Contest Coordinator, with "verified" Scoring Directors/Scrutineers and an "authorized" scoring system; scoring personnel are trained and tested by a UCWDC Scoring Examiner. How certification or verification is evidenced is not stated in the text read. | mandatory; evidence mechanism **NOT SPECIFIED IN PROVIDED SOURCE** |
| UCWDC-C II.N.3 (p.13) | UCWDC Couples 2026 | The UCWDC Judge Certification Code of Conduct (website) is **not provided**: open source gap (also listed in the registry). No UCWDC judge-certification tier is designed until it is supplied. | open source gap |
| WSDC Definitions: Chief Judge (p.3) | WSDC v2026.1C | The Chief Judge needs extensive judging experience with a proven record, may not compete, and may be appointed only from people who served as a judge at multiple registry events and showed proficiency. | mandatory; experience is **not machine-verifiable** |
| WSDC Trial Event requirements (p.5) | same | A Trial Event must use a "WSDC Certified Chief Judge" (and an approved scoring system). The text read does not define how that certification is evidenced. | mandatory (Trial Events only); evidence mechanism not specified |
| WSDC Section 7 (p.24) | same | A WSDC judges certification program launches January 1, 2027; WSDC "anticipates" initial guidelines of 30% to 50%; WSDC will list global-certified judging resources. | anticipated guidance (register class `recommended`, status **UNVERIFIED**) until effective rules are confirmed; not a current requirement |

NOT SPECIFIED IN PROVIDED SOURCE: NDCA/UCWDC/WSDC text on how an organizer must evidence an official's credentials, other than the NDCA roster supplied to organizers (III.B.1.a, III.B.3). UCWDC-C I.A.4 (p.1) says UCWDC "recruits, develops, certifies, and evaluates" judges into a pool for event directors to draw from; it supports the Code of Conduct gap but states no event requirement and is not relied on for one. NDCA III.B.6 (officials list posted ahead, changes need NDCA approval) is not modelled here (OD-17).

### 6B.2 Distinct body roles are not DanceFlow roles

| Body role | Source | Must not be treated as |
|---|---|---|
| NDCA Chairman of Adjudicators | III.B.4 | the DanceFlow `chair` official, nor a generic manager |
| NDCA Scrutineer (S1-S3; certified) | III.B.1.e, III.B.2 | the DanceFlow `scorer` official; and a Scrutineer cannot be the Chairman |
| NDCA Adjudicator | III.B.3, IV.A.6 | a DanceFlow `judge` with an attestation |
| UCWDC Contest Coordinator, Judge, Scrutineer, Scoring Director | II.B.1.b; SF preamble | `chair` / `judge` / `scorer`; no generic manager or scorer permission substitutes for the membership or certification |
| WSDC Chief Judge (and Secondary) | Definitions p.3 | the DanceFlow `chair`, unless designated as such under OD-06 and attested here |

Body roles live in the OD-06 event-level designations table as additional `kind` values added **with a future body profile** (not now). Until a
profile and a verified credential exist, a body-role designation is unavailable (`COMP_BODY_ROLE_UNAVAILABLE`): the platform never lets a generic
`chair` or `scorer` stand in for it.

### 6B.3 Option B now: organizer attestation (design)

New table `event_competition_official_attestations` (immutable; reuses OD-06 designations and events; placed in the reserved OD-15 migration slot, section 7):
``id, event_id, official_id, assigned_role ('judge'|'chair'|'scorer'), designation_id null (OD-06 row when the role is a designated one),
attested_by, attester_capacity ('organizer'|'authorized_administrator'), attested_at, declaration_code, declaration_version, copy_hash, status
`('active'|'superseded'|'withdrawn'), request_id`. A withdrawal or supersession is a new row or an events row, never an edit.
Reused: OD-06 `event_competition_role_designations` gains one kind, **`qualification_attester`** (the explicitly designated authorized administrator),
created by the event organizer account and ended with a reason like any designation; the OD-06 audit events table carries the new event kinds.
Rules: the attester must differ from the official; a designated attester cannot attest their own official row; assigned role must match the official's current role
(a role change supersedes); attesting is optional for Studio/Custom and never a precondition for registration, scheduling or payments.
The declaration text lives in a versioned rule-set function (like `_compoc_rule_set`), so each row records exactly what was signed.

**Mandatory copy (every surface: organizer UI, chair view, exports, support articles):**
- Attestation: "**Attested by organizer, not verified by DanceFlow or any governing body.**"
- Free-text credential or unverified document: "Entered by the organizer; not verified."
- Platform-reviewed evidence (future Option A only): "Evidence reviewed by DanceFlow on <date> against <document>. This is not a governing-body certification."
- The words "certified", "licensed", "approved by NDCA/UCWDC/WSDC" appear only for a record whose verification method is a governing-body source. None exists today.

### 6B.4 Option A, future body profiles: credential records (design only)

Not built until a body profile exists. Table `event_competition_official_credentials` (event-scoped; cross-event reuse is Q13):
``id, event_id, official_id, body, credential_code (closed set per body and role, e.g. ndca_roster_listing, ndca_adjudicator_license, ndca_membership_level,
ndca_scrutineer_s1..s3, ndca_scrutineering_certificate, ndca_chairman_ch1..ch3, ndca_us_residency_or_wdc_license, ucwdc_associate_membership,
ucwdc_contest_coordinator_certification, ucwdc_scoring_director_verification, wsdc_chief_judge_appointment), role_scope, level_code null,
identifier_ref (membership or roster id; restricted column), evidence_ref (code of an uploaded document or roster extract), valid_from, valid_to,
rulebook_registry_document, rulebook_edition, verification_status ('claimed'|'evidence_attached'|'verified'|'rejected'|'expired'),
`verification_method ('organizer_entry'|'platform_review'|'body_source'), verified_by, verified_at, request_id`. Status changes append rows; expiry is
evaluated against the **event date**, not today (UCWDC membership ends January 15; NDCA rosters change). Requirement catalog per body and role
(the table of 6B.1 expressed as data) is a versioned rule-set function, never organizer-editable.

Verification semantics: `verified` means a named DanceFlow reviewer checked the evidence against the cited official document, or a governing-body source
confirmed it; it never means "organizer says so". Requirements DanceFlow **cannot** verify (WSDC chief judge experience, NDCA "qualified" judgments) stay
`attested_unverified` and are listed as such; they are never displayed as met.

### 6B.5 Enforcement

- **Studio/Custom, `other`:** no credential or attestation obligation; readiness shows an optional "qualification attestation not recorded" note. No unsupported
  professional-certification demands.
- **Declared NDCA/UCWDC/WSDC, now (no profile):** the attestation is recorded and displayed with the mandatory copy; `_compoc_blockers_qualifications` lists,
  per assigned body role, each mandatory requirement from 6B.1 as `unverified` (not as met). **Attestation never clears a mandatory requirement.**
  Whether those unverified items are panel-lock *blockers* or *warnings* before profiles exist is Q12; OD-01 already blocks approval and publication of
  Studio-scored results for declared bodies, so this choice affects only round start and panel lock.
- **Declared body, with a future profile:** restricted body roles (Chairman, Scrutineer, Contest Coordinator, Scoring Director, WSDC Chief Judge) are
  assignable only with a `verified`, unexpired credential set for the event date; a missing, rejected or expired credential blocks that assignment and the
  operations that role gates, and nothing else. A Scrutineer may not serve as Chairman **at the same event** (III.B.4); a person holding both credentials is never blocked for holding them, only from being assigned both roles in one event. III.B.1.f lets a back-up Scrutineer be the chairman, adjudicator or organizer: a source tension, recorded and not resolved here.
- Ballots and marks carry no credential data; judges never see credential status of other officials (confidentiality unchanged).

### 6B.6 Roles and visibility

| Who | Attestations | Credential records |
|---|---|---|
| Organizer / manager | read, create (as organizer) | read, enter claims, attach evidence |
| Designated authorized administrator (`qualification_attester`) | create, read | read |
| Chair official | read status per official (no identifiers) | status only |
| The official | own attestation status | own records, may attach evidence; cannot verify |
| Platform reviewer (future) | none | verify or reject |
| Other staff, competitors, anon | none | none |

### 6B.7 WSDC certification (Section 7, p.24) tracking

Recorded as **UNVERIFIED future guidance**: launch date January 1, 2027 and an anticipated 30-50% guideline. No requirement, counter or readiness check is built on
it until WSDC publishes effective rules that are confirmed against the then-current registry edition. The register entry `OD15-WSDC-0002` carries status
`unverified`.

### 6B.8 OD-16 touchpoints (OD-16 not yet decided: placeholder only)

NDCA minimum judge counts (III.B.1.a-d), the Chairman's non-voting recommendation (III.B.4) and WSDC finals panel size (3.4.7) belong to OD-16 and
`_compoc_blockers_panel_size`. OD-15 adds no panel-size rule.

## 6B.9 Independent review of 6B: resolutions (this subsection governs where it conflicts with 6B.1-6B.8)

The reviewer re-read every cited passage and confirmed them except where fixed inline (III.B.4.a-b is wholly on p.16; Scrutineer/Chairman wording; Section 7 labelling; I.A.4 added; III.B.6 flagged). It found no cross-body application. Design resolutions:

- **Designation kind (R3).** `qualification_attester` is in the s0 closed-set CHECK from the start (no later ALTER). It is **excluded from the OD-06 designation-set fingerprint**, so creating or ending an attester never invalidates the WSDC role attestation (6A.3). G1-G3 ignore it. It is readable by managers and the chair like other designations (F18).
- **Attester independence (R4).** The attester must hold no official role, no other OD-06 designation, and no identity match to a competitor in the event. `attester_capacity` is **derived server-side** (team ownership of the event versus the `qualification_attester` designation), never client-supplied. The row stores a named-person snapshot (display name at attestation time). An authorized administrator without manager rights reads and writes only through a scoped RPC (`competition_attestation_scope`), never through manager policies.
- **Copy (R5).** Organizer: "Attested by organizer, not verified by DanceFlow or any governing body." Authorized administrator: "Attested by <name>, designated administrator of the event organizer, not verified by DanceFlow or any governing body." Other states: "Attestation withdrawn on <date>", "Attestation replaced on <date>". Unverified validator item: "Not verified: <requirement>. Organizer attestation only." These strings accompany any attestation shown on **any** surface, including competitor-facing or public pages, emails, PDFs and marketing; otherwise it is not shown there. The words certified, licensed, approved, verified, qualified and credentialed may not describe an organizer attestation or an unverified claim; "Verified by DanceFlow review (not a governing-body certification)" is allowed only for an Option A `platform_review` record. No free-text credential field exists in Option B; the "Entered by the organizer; not verified." string applies only if one is ever added.
- **Pre-profile default (R6).** Recommended default, for owner decision in Q12: before body profiles exist, unverified mandatory requirements for an official **declared to act in a body role** are shown as **warnings** on panel lock, not blockers, because OD-01 already blocks approval and publication of Studio-scored results and body-role designations are unavailable. The organizer's attestation declaration names the body role the official is attested for; that is how requirements map to a generic `judge`/`chair`/`scorer`. The Option A restricted list also includes **NDCA Adjudicator** (IV.A.6 licence, III.B.3 roster) and **UCWDC Judge** (II.B.1.b membership). If the owner chooses "blocker", every declared-body event is locked out of panel lock until profiles exist, which is stated as the consequence.
- **Immutability and status (R7).** The attestation table has **no mutable status column**. Withdrawal and supersession are rows in the events table (kinds `attestation_withdrawn` with a reason of 1-500 characters, `attestation_superseded`), and "current" is the latest by a unique successor chain (as for ballots). Credential `verification_status` gains `attested_unverified`.
- **Privacy (R8).** `identifier_ref` and uploaded evidence are personal data: restricted columns, excluded from exports and general views, private tenant-scoped storage, reviewer access only through audited tenant-scoped RPCs, retention rule is Q15. `body_source` is used only when a governing body itself publishes or confirms the credential; a DanceFlow reviewer checking an organizer-supplied extract stays `platform_review`. The credential row is bound to the official's account and stores the name on the document; the reviewer attests the match, nothing is matched automatically.
- **Stubs (R9).** s4 creates `_compoc_blockers_conflicts` (real) and stubs `_compoc_blockers_roles`, `_compoc_blockers_qualifications`, `_compoc_blockers_panel_size` and `_compoc_blockers_panel_change` returning `[]`. s5 redefines roles, s6 redefines qualifications (attestation list), the future s7 (credential records) redefines qualifications again, the OD-16 slot redefines panel size; each redefinition is md5-pinned. Between s4 and s6 a declared-body event shows an empty qualification list; nothing is active (Competition OS is dark).
- **Register (R10).** `OD15-DF-0001` is reworded to DanceFlow policy only; NDCA/UCWDC `requirement` fields are labelled DanceFlow's implementation requirement for the body rule; `OD15-UCWDC-0003` cites I.A.4 (p.1).

New question **Q15**: retention and deletion period for credential evidence and identifiers.

## 6C. OD-16: panel size, chair requirement, non-voting chair (decided 2026-11-23: Option B now, Option A for future body profiles)

**Docs and design only.** No panel SQL, no engine change, no migration file. Decision: keep the Studio/Custom judging model for initial activation **subject to fixing
its internal panel-minimum inconsistency** (Option B); future body profiles carry body-specific panel models (Option A). The Studio defect is investigated read-only in
[OD-16-studio-panel-minimum-defect.md](OD-16-studio-panel-minimum-defect.md), with a bounded correction recommendation (not implemented).

### 6C.1 Rule evidence (re-read in the pinned PDFs on 2026-11-23)

| Ref | Document / edition | What it says (own words) | Class |
|---|---|---|---|
| NDCA III.B.1.a (p.14) | Rule Book June 2026 | Non-Championship events: at least three adjudicators; if the first-place prize money for a Non-Championship professional event is $1,000 or more, five must officiate. | mandatory |
| NDCA III.B.1.b (p.14) | same | At least one qualified Chairman of Adjudicators at every sanctioned event. | mandatory (qualification side: OD-15) |
| NDCA III.B.1.c (p.14) | same | Professional and Adult Amateur Championship events: at least seven adjudicators. | mandatory |
| NDCA III.B.1.d (p.14) | same | Open multiple-dance Pro/Am Championship events: at least five adjudicators. | mandatory |
| NDCA III.B.4 (p.16) | same | "If possible, the Chairman should be a non-voting Chairman." | **advisory** |
| NDCA XII.L.1 and XII.M.4 (p.51) | same | For formation events a **non-voting** Chairman of the Board of Adjudicators must be appointed (and must attend rehearsals). Unlike III.B.4 this is not "if possible". | **mandatory** (formation only) |
| NDCA Team Match definition (p.3) | same | A Team Match has a maximum of three adjudicators. A maximum, not a minimum; recorded, not modelled. | mandatory (cap; formation/team) |
| NDCA XII.N.1 (p.51) | same | Formation events are judged by at least three adjudicators qualified and certified in the style. | mandatory |
| WSDC 3.4.7.a, a.i (p.20) | WSDC v2026.1C | Preliminary Jack and Jill: at least four judges **per role** plus the Chief Judge; exception: in Tiers 1-3 an event may have judges score both roles, still four scores per role; five per role in larger Tier 5-6 preliminaries is strongly recommended. | mandatory; the five-per-role is **advisory** |
| WSDC 3.4.7.b (p.20) | same | Finals: at least five judges plus the Chief Judge; an even number of judges shall not be used; seven judges are required for Tier 5-6 finals. | mandatory |
| WSDC 3.4.7.c, d (p.20) | same | The Chief Judge may join the general panel only on an unforeseen or unavoidable shortage of general judges; virtual judging is not permitted. | mandatory (narrow exception) |
| UCWDC-SF Rule #3, item 4 (p.3) | UCWDC Scoring Format v16.9b | The majority mark is the middle mark with an odd number of judges; an even number may be used "for contingency or emergency purposes", and then the majority mark is one mark more than half. | odd is the norm; even is a permitted contingency; **no minimum count is stated**; odd-panel preference beyond "the norm" is not stated either |

NOT SPECIFIED IN PROVIDED SOURCE: any UCWDC minimum panel size, and any UCWDC chair or non-voting-chair requirement. Do not invent one. The UCWDC Judge Certification
Code of Conduct (not provided) remains an open source gap. NDCA III.B.1.a-d use the word "adjudicators"; the DanceFlow mapping of "adjudicator" to a voting judge (the chair
counting or not) is an interpretation, not stated in the rule.

### 6C.2 Model: separate panel rule sets, never one blended rule

`_compoc_panel_rules(p_profile text, p_inputs jsonb) returns jsonb` (versioned, code, not organizer-editable) returns, per body profile, a list of
`{requirement_code, severity, minimum, parity, source_ref}`. Severity is data: **`blocker`** for mandatory provisions, **`warning`** for advisory ones.

| Profile | Blockers (mandatory) | Warnings (advisory) | Inputs DanceFlow does not record today |
|---|---|---|---|
| Studio / Custom (DanceFlow policy, K1 X-3) | ordinal and callback: at least 3 present judges, odd; proficiency: at least 1 | none | none |
| NDCA | III.B.1.a (3; 5 when the prize threshold applies), III.B.1.c (7), III.B.1.d (5), XII.N.1 (3), XII.L.1 and XII.M.4 (formation: a non-voting Chairman must be appointed), III.B.1.b (a qualified Chairman exists) | III.B.4 non-voting Chairman outside formation events | event classification (Non-Championship / Professional / Adult Amateur Championship / open multiple-dance Pro/Am Championship), first-place prize money of professional events, formation flag, qualified-Chairman credential (OD-15) |
| WSDC | 3.4.7.a per-role minimum 4 plus Chief Judge (a.i narrow exception for Tiers 1-3), 3.4.7.b finals minimum 5 plus Chief Judge, odd, 7 for Tier 5-6, 3.4.7.c Chief Judge joins panel only with a recorded shortage, 3.4.7.d no virtual judging | five per role in Tier 5-6 preliminaries | contest type (Jack and Jill prelim/final), tier, per-role judging, judging mode (in person/virtual), recorded shortage reason |
| UCWDC | none stated | odd panel preferred (even only for contingency/emergency) | none |

### 6C.3 Roles, voting, shortage exception

- A **non-voting chair**: NDCA III.B.4 is advisory ("if possible"), so outside formation events it is a per-round option and a warning when absent, never a blocker. **For NDCA formation events XII.L.1 and XII.M.4 make it mandatory**, so it is a hard blocker there (the missing input is the formation flag, which fails closed). It changes whether the chair's ballot counts, so engine and ballot
  rules must support it first. **Not designed in detail here; no engine change.**
- **WSDC Chief Judge joining the panel** (3.4.7.c) is a documented resolution (same mechanism as OD-05 slice 3 and OD-06 6A): recorded reason of an unforeseen or unavoidable shortage,
  who decided, when; never automatic, and it does not satisfy the "separate Chief Judge" requirement of 3.4.7.a-b for counting purposes unless the owner says so (Q16).
- **Per-role counts (WSDC)**: the Studio engines do not score roles separately (`scoreRolesSeparately` fails closed, X-3 flags), so the WSDC per-role requirement **cannot be satisfied or validated today**.

### 6C.4 Enforcement design (future; hard blockers and warnings)

Plugs into the shared panel-lock guard of section 5: `_compoc_blockers_panel_size` (reserved OD-16 slot, section 7) calls `_compoc_panel_rules` for the event's declared body and
the round's inputs, and emits items with `severity`. **Hard blockers block round start and ballot lock** with `COMP_PANEL_BLOCKED`; **warnings** are shown, never block. For Studio/Custom
the function delegates to the corrected E1/E2 rule so there is one source of truth for the X-3 minimum (defect doc, section 4). Every missing input (classification, prize, tier,
judging mode) is itself a blocker for a declared-body profile, never defaulted (fail closed); a profile that is not implemented keeps its body requirements as BLOCKERS to that profile's activation.

### 6C.5 NOT IMPLEMENTED: blockers to each body profile's activation

| Profile | Not implemented (each is a blocker to activating that profile) |
|---|---|
| NDCA | adjudicator count rules III.B.1.a/c/d; qualified Chairman III.B.1.b; formation minimum XII.N.1 and the mandatory non-voting Chairman of formation events (XII.L.1, XII.M.4); event classification and prize inputs; non-voting chair (advisory); family-definition source conflict (OD-05) |
| WSDC | per-role judge counts 3.4.7.a; finals minimum, odd, Tier 5-6 count 3.4.7.b; Chief Judge shortage exception 3.4.7.c; virtual-judging flag 3.4.7.d; per-role scoring in the engines |
| UCWDC | nothing mandatory to count (no minimum stated); contingency even-panel handling must follow Rule #3.4's majority mark (one more than half), which the Studio engines do not implement (they fail closed on even panels) |
| Studio/Custom | the internal inconsistency in the defect document must be fixed before initial activation |

OD-01 (PR #832) is unchanged: declared-body results approval and publication stay blocked. These blockers are also recorded in the rule register (`OD16-*`, status
`unsupported`) and in the registry "Known gaps". The audit TRACKER is deliberately **not** edited here to avoid a merge overlap with PR #832; the coordinator can add a pointer row.

### 6C.6 Interaction with the other decisions

OD-05: a recusal shrinks a panel; the shared aggregator evaluates conflicts first, then panel size. OD-06: Chief Judge separation (3.4.3) and the OD-16 shortage resolution
must not contradict: a Chief Judge who joins the panel under 3.4.7.c is an explicit resolution, never silently permitted by role. OD-15: the qualified-Chairman requirement
(III.B.1.b) is the OD-15 credential side of the same item. **OD-17 (panel appointment, publication, substitution) is decided (section 6D; Option B now, Option A for a future NDCA profile)**; substitution would
interact with panel minimums and the frozen panel; nothing is designed here.

Dependency on OD-17: when NDCA III.B.6 lets the remaining officials act because no substitute is found, the panel minimum above must be met or the round does not run; the emergency path of section 6D is the only audited way to change the panel.

New question **Q16**: when the Chief Judge joins the panel under WSDC 3.4.7.c, do they count toward the 3.4.7 minimum or must the minimum be met without them (the text says "plus the Chief Judge")?

## 6D. OD-17: panel appointment, publication and substitution (decided 2026-11-23: Option B now, Option A required for a FUTURE NDCA profile)

**Docs and design only.** No substitution SQL, no migration file. Decision: Studio/Custom panel appointment and substitution behavior is **unchanged** (Option B). A future NDCA profile
must implement the NDCA change-control procedure (Option A). Nothing here is applied to UCWDC, WSDC or Studio/Custom.

### 6D.1 Rule evidence (re-read in the pinned PDFs on 2026-11-23)

| Ref | Document / edition | What it says (own words) | Class |
|---|---|---|---|
| NDCA III.B.6 (p.16-17) | Rule Book June 2026 | The proposed list of all officials must be posted on the competition website at least thirty days before the competition. Once the Ballroom Department has approved the list, no additions or changes may be made without NDCA approval. | mandatory |
| NDCA III.B.6 (p.17) | same | If, for an unforeseen reason on the night of the event, a listed official cannot officiate, a substitute may be appointed for the competitions, subject to the approval of the NDCA Observer and a proper announcement made before the affected competition. | permitted exception (conditions mandatory) |
| NDCA III.B.6 (p.17) | same | If no substitute can be found, the remaining officials act and the organizer sends a written explanation of the incident to the Ballroom Department within ten days. | mandatory (organizer duty) |
| NDCA III.D.9 (p.19) | same | The **complete** list of officials (organizers, chairmen of judges, adjudicators, scrutineers, registrars, MCs, music directors), each category in alphabetical order by last name, must be posted on a website at least thirty days before the competition, together with the total prize money. (III.B.6 calls the list "proposed"; III.D.9 requires the complete list.) | mandatory (wider role scope than panel judges) |
| NDCA III.D.1 (p.19), appointment | same | Organizers must appoint all adjudicating panels before the event commences. | mandatory |
| NDCA III.D.1 (p.19), adherence | same | Panels "should be strictly adhered to" except in cases of emergency. | **recommended** (should) |
| NDCA III.C.6, III.C.6.a (p.19) | same | The Observer is the Chairman (unless the Chairman is the organizer); the Ballroom Director appoints two observers for competitions with over 4,000 entries or lasting four or more days; the observer submits a report at the end of the event (a separate obligation from the III.B.6 written explanation). | mandatory |
| NDCA IV.C.8 (p.27) | same | Among the Chairman's duties: excusing an adjudicator from officiating when the Chairman feels that adjudicator's sound judgment may be impaired. | chairman power (discretionary) |
| NDCA III.C.6 (p.19) | same | The NDCA Observer is the Chairman of Adjudicators (except when the Chairman is also the Competition Organizer); the Observer's name is posted on the competition website. | mandatory |
| NDCA III.B.4 (p.16) | same | A Scrutineer may serve only "as a substitute adjudicator as per Rule III.B.5". III.B.5 is the World Dance Council non-resident rule and says nothing of substitutes; the substitution text is in III.B.6. | **source inconsistency**: cross-reference looks mis-numbered; not resolved, not relied on |

**NOT SPECIFIED IN PROVIDED SOURCE (NDCA):** who acts as Observer when the Chairman is also the organizer; whether "ten days" are calendar days; what a substitute may be mid-competition after ballots exist
(the text speaks of a substitute "for the competitions" announced "before the affected competition"); what the Ballroom Department's "approval" artifact looks like.

**UCWDC and WSDC: searched, nothing found.** I searched the extracted text of UCWDC Couples, Pro/Pro-Pro/Am, Line Dance, Teams and the Scoring Format for "substitut", replacement of judges, judge lists, announcement of
panels, and "panel": the only panel text is UCWDC-C II.N.3 (post-event complaints to the Judge Review Board). WSDC Registry Event Rules v2026.1C: no advance-publication or general substitution rule; the only
replacement or shortage text is 3.4.6.b.iv (Chief Judge replaced by the Secondary Chief Judge for a specific contest; already in OD-05/OD-06), 3.4.7.c (p.20: the Chief Judge may join the general panel only on an unforeseen or unavoidable shortage of judges; already in OD-16) and 3.1.1 (events must hire sufficient judging staff and avoid conflicts).
These are **rulebook-silent** for this topic. NDCA procedures are therefore **not** applied to UCWDC, WSDC or Studio/Custom.

### 6D.2 Today (unchanged for Studio/Custom, UCWDC, WSDC)

E1 `assign_competition_panel_member` / `unassign_competition_panel_member` / `guard_competition_panel_assignment`: the panel is editable while the round is draft or scheduled and frozen from the start
(`COMP_PANEL_FROZEN`). E2 `record_competition_judge_attendance` records an audited absence with a reason (1-500), refused once the judge has ballots. There is no officials-list publication, no change
authorization, and no mid-round replacement. These stay as they are; this section changes none of them.

### 6D.3 Future NDCA profile (Option A): requirements as hard blockers, NOT IMPLEMENTED

| # | Requirement | Source | Design (future, NDCA-declared events only) |
|---|---|---|---|
| N1 | Officials list posted at least 30 days before | III.B.6, III.D.9 | record `list_published_at`, a publication reference (URL) and the approval reference/date the organizer states from the Ballroom Department. DanceFlow cannot verify website posting or the approval: **attested by organizer, not verified by DanceFlow or NDCA**. The publication record covers the **complete** list of officials of every III.D.9 category (not only panel judges), in alphabetical order by last name, and stores a fingerprint of the list as published. Hard blocker to NDCA-profile activation of a round until recorded and at least 30 days before the event date. |
| N2 | No change after approval without NDCA approval | III.B.6 | any add, remove or letter change of a seated official after the list approval requires a recorded change authorization (reference, date, who at NDCA approved as stated by the organizer, reason). Without it the change is refused. |
| N3 | Emergency substitute: Observer approval, announcement, before the affected competition | III.B.6 | audited emergency-substitution record: the unavailable official, the substitute, reason, Observer approval (reference and the Observer's identity as designated), announcement time and reference, round the substitute is for, all timestamps. The substitute may be seated only while the affected round is still scheduled (before it starts). |
| N4 | No substitute: remaining officials act; written explanation in ten days | III.B.6 | record the incident and create a **follow-up obligation** (below). The remaining panel must still satisfy the panel rule (OD-16, section 6C); if it does not, the round does not start/lock. |
| N5 | Panels appointed before the event (mandatory); adherence except in emergencies (recommended) | III.D.1 | a round of an NDCA-declared event cannot start with an unappointed or unapproved panel (mandatory half). Routing later changes through N2/N3 with a reason is DanceFlow policy for the recommended adherence half, not an NDCA requirement. |
| N6 | Chairman may excuse an adjudicator whose judgment may be impaired | IV.C.8 | excusal record by the **designated Chairman** (OD-06 event-level designation of an NDCA Chairman; credential per OD-15), with reason, scope and time. |
| N7 | Observer identity | III.C.6, III.C.6.a | the Observer is the designated Chairman, or, when the Chairman is the organizer, an explicitly designated Observer (kind added with the NDCA profile); events over 4,000 entries or four or more days have two Observers, so the designation allows more than one; the Observer report is a separate obligation and is not tracked as the III.B.6 explanation; who that is, is NOT SPECIFIED, so the organizer designates it and it is attested. |

### 6D.4 Proposed tables (future slot, NDCA profile only; same conventions as sections 4 and 6A)

All immutable evidence (`protect_competition_history_evidence()`), RLS managers and the designated Chairman/Observer only, request-id idempotent, tenant keyed by `event_id`.

- `event_competition_officials_list_records`: `id, event_id, kind ('published'|'ballroom_approved'), occurred_on, reference_code (validated, not free text), recorded_by, recorded_at, attestation_code, request_id`.
- `event_competition_panel_changes`: `id, event_id, round_id, kind ('post_approval_change'|'emergency_substitution'|'chairman_excusal'|'remaining_officials_act'), official_from_id null, official_to_id null, reason (1-500), authorization_ref null, authorizing_role ('ballroom_department'|'ndca_observer'|'chairman' as stated), announcement_at null, announcement_ref null, decided_by, decided_at, request_id`.
- `event_competition_panel_change_applications`: `change_id unique, assignment_id, applied_at`: insert-only link proving which change authorized which assignment row (no update of evidence).
- `event_competition_followups`: `id, event_id, source_change_id, kind ('ndca_written_explanation'), incident_at, due_at (incident_at + 10 days, calendar interpretation = Q17), status ('open'|'organizer_marked_sent'), marked_by, marked_at, sent_reference null`. Status changes are event rows; the current state is derived.

**Follow-up copy (mandatory):** "NDCA requires the organizer to send a written explanation to the Ballroom Department within ten days. DanceFlow does not send it and does not verify that it was sent." Overdue items show to the organizer and managers; a mark as sent is an organizer attestation ("marked as sent by organizer, not verified by DanceFlow or NDCA"). DanceFlow never claims to have submitted anything.

### 6D.5 Minimal changes to existing functions (no redefinition)

- `assign_competition_panel_member`, `unassign_competition_panel_member`, `guard_competition_panel_assignment`: **not redefined**. A new `BEFORE INSERT OR UPDATE OR DELETE` trigger on `event_competition_panel_assignments` (UPDATE covers a letter change; it keeps the same cascade bypasses as E1's guard, returning when the round or event is already gone, so deleting a draft round or event is not refused) (name sorted after E1's guard and after the OD-05 assignment trigger `zz_compoc_guard_assignment_conflict`) applies only to NDCA-declared events with a recorded Ballroom approval and requires an authorizing `panel_changes` row not yet applied **that matches the specific round, `official_from_id`, `official_to_id` and kind** (any unapplied row can no longer authorize any change); it records the application link. The list is locked from the **publication** record (not only from the Ballroom approval), and `officials_list_records` stores a fingerprint (md5 of sorted official ids and roles) of the list as published and as approved, so a panel swapped before the approval is recorded is still a change after publication. The same authorization is required by a second trigger on `event_competition_officials` for NDCA-declared events (add, deactivate or reactivate, `set_competition_chair` / `clear_competition_chair`), because III.B.6 speaks of changes to the "Officials List", not only to seats. `deactivate_competition_official` deletes seated assignments directly: after publication it is refused with `COMP_PANEL_CHANGE_NOT_AUTHORIZED` unless an authorization exists, with a clear message (that RPC is not redefined). Independence (OD-15 rule): the substitute, the approver recorded and the person recording the approval cannot be one person; when the Chairman, the Observer and the organizer are the same person (Q18) the record is flagged "single-person attestation" and does not count as an independent approval. Studio/Custom, UCWDC and WSDC events never reach this branch.
- `record_competition_judge_attendance`: **unchanged** (absence audited, refused once the judge has ballots). For N4, a new RPC records the incident and the follow-up; it does not edit attendance or ballots.
- Round start gate: one more validator in the shared aggregator of section 5 (`_compoc_blockers_panel_change`), so list publication, approval and change authorization appear in the same `COMP_PANEL_BLOCKED` list as conflicts, roles, qualifications and panel size. It runs only for NDCA-declared events.
- OD-05 recusal and OD-17 substitution share the audit vocabulary: a recusal that empties a seat is handled by the same panel-change record (kind `post_approval_change` or `emergency_substitution`), never by an unaudited assignment edit.

### 6D.6 Ballot and audit preservation (coordination with OD-04, OD-10, OD-11)

By construction OD-17 adds **no writer to ballots, marks, attendance or result tables**: a substitute gets a new assignment (own official row and letter) before the round starts, when no ballots exist; the
replaced official's assignment and any ballots are never transferred, overwritten or invalidated. After a round starts the E1 freeze still applies and E2 still refuses an absence once a judge has ballots,
so prior markings remain intact. A substitution or excusal **after ballots exist** (a judge becomes unable mid-round) cannot be represented today: it needs per-heat panel membership and engines/readiness that
evaluate each heat's panel, the same dependency as OD-05 heat-level recusal (Q3) and the OD-16 panel rule. It is **not designed here** and fails closed (the round cannot be silently re-paneled; it is cancelled or
handled by the organizer outside DanceFlow, and the incident record is still kept). Coordination: OD-11 (PR #843, judge-confirmed corrections) owns changes to ballots; OD-10 (PR #842, ballot visibility) owns who may read
them; OD-04 (PR #844, event delete guard) protects scoring evidence from hard deletion: the new evidence tables must be added to its protected set if it enumerates tables (not verified here).

### 6D.7 Attestation versus verification

Every external reference above (list posting, Ballroom Department approval, NDCA approval of a change, Observer approval, announcement, explanation sent) is entered by the organizer or the designated
Chairman/Observer and shown with the OD-15 copy: "Entered by organizer; not verified by DanceFlow or NDCA." Only a governing-body source could make it verified; none exists. An organizer attestation never
substitutes for a mandatory requirement: without the reference the NDCA-profile blocker stays.

### 6D.8 NOT IMPLEMENTED: blockers to the future NDCA profile

N1-N7 above are each **NOT IMPLEMENTED and a blocker to activating an NDCA profile**; they are in the rule register as `OD17-NDCA-*` entries (status `unsupported`). The III.B.4/III.B.5 cross-reference is recorded as a source inconsistency.

New questions: **Q17** is "within ten days" calendar days, and from what instant (incident or event end)? **Q18** who acts as NDCA Observer when the Chairman is also the organizer (the text read is silent)? **Q19** may a substitute or excusal be modelled after ballots exist, and if so with which per-heat panel semantics (depends on Q3/OD-16)?

## 7. Migration block, ordering, rollback

Latest migration on `origin/release/website-embeds` is `20270218090000`. Proposed block for the coordinator to confirm
(Q6): **`20270220090000` to `20270220099000`**, one file per step, applied strictly in order, each with
`rollback/<name>_rollback.sql`, a header stating **"PROD apply needs separate owner approval; not applied to any database"**,
LF-only function bodies (Phase 10D CRLF lesson), and an md5 pin plus preflight for anything redefined.

| Timestamp | File (proposed) | Slice | Redefines an existing function? |
|---|---|---|---|
| `20270220090000` | `competition_oc_s0_role_designations` | OD-06 data | no (designations + attestations tables, RPCs, RLS, audit; no enforcement) |
| `20270220091000` | `competition_oc_s1_identity_guard` | OD-05 s1 | no (new triggers, functions, findings and events tables) |
| `20270220092000` | `competition_oc_s2_declarations` | OD-05 s2 | no |
| `20270220093000` | `competition_oc_s3_enforcement_resolutions` | OD-05 s3 | REDEFINES the s1 stub of `_compoc_conflict_state` inside this block (md5-pinned) |
| `20270220094000` | `competition_oc_s4_panel_lock` | OD-05 s4 | no (trigger on rounds, aggregator, stub validators 2-5 (roles, qualifications, panel size, panel change) return `[]`; s5 and the reserved OD-16 slot later redefine stubs, md5-pinned) |
| `20270220095000` | `competition_oc_s5_wsdc_separation_guards` | OD-06 enforcement | no (G1-G7 triggers on officials, designations, result versions; REDEFINES the s4 stub `_compoc_blockers_roles`, md5-pinned) |
| `20270220096000` | `competition_oc_s6_official_attestations` (OD-15, design only) | OD-15 Option B | no (new attestation table and events kinds; adds designation kind `qualification_attester`; REDEFINES the s4 stub `_compoc_blockers_qualifications`, md5-pinned) |
| `20270220097000` | reserved OD-16 (`competition_oc_s8_panel_rules`, design only) | OD-16 | REDEFINES the s4 stub `_compoc_blockers_panel_size`, md5-pinned; adds `_compoc_panel_rules`. The Studio E1/E2 readiness correction is a **separate** bounded change (defect document), not part of this block |
| `20270220098000` | reserved OD-15 Option A: `competition_oc_s7_credential_records` | future, **not before a body profile exists** | REDEFINES `_compoc_blockers_qualifications` again, md5-pinned (credential table, rule-set catalog) |
| `20270220099000` | reserved OD-17 Option A: `competition_oc_s9_ndca_panel_change_control` | future, **NDCA profile only, not before a profile exists** | no (list records, panel changes, applications, follow-ups; new assignment trigger; REDEFINES the s4 stub `_compoc_blockers_panel_change`, md5-pinned) |

Order rationale: designations (s0) must exist before the OD-05 tier-2 lookup reads them (s1); enforcement of OD-06 (s5) comes after the shared guard
point (s4) it plugs into. The block is now `20270220090000` to `20270220099000`.

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
  blocks; `wsdc` tier 2 blocks only the designated owner/director/family/chief judge/scoring operator already present at s1; attestation fail-closed is s5, see OD-06 tests); anchor completed after assignment is caught at ballot time; `scorer_paper` entering
  scorer checked; a refused attempt leaves zero assignment/ballot/mark rows; refusal evidence written by the separate transaction;
  unrelated judge and unrelated round unaffected.
- Slice 2: scope CHECKs; judge declares own only; read isolation per matrix; withdrawal audited; no relationship text in list RPC.
- Slice 3: exception codes validated by sanctioning; subject cannot resolve self; NDCA tier-2 match cannot be cleared; resolutions immutable.
- Slice 4: guard fires only on the activation edge; blocker order stable; OD-15 and OD-16 placeholder validators return `[]`.
- OD-15: attestation row records actor, event, official, role, time, declaration version and copy hash; attester cannot be the attestee; Studio/Custom has no obligation; declared-body events list mandatory requirements as unverified and attestation never clears one; the mandatory copy strings appear verbatim on every surface; no governing-body wording ("certified", "licensed") without a body-source verification method; credential expiry evaluated at the event date (future Option A).
- OD-06: G1-G7 each with a negative test and a positive control (chief judge CAN approve and review finalists but CANNOT calculate; owner CANNOT be judge, chair or scorer; family CAN be an ordinary judge, CANNOT be chair or scorer; chair and scorer cannot be one account; NDCA, UCWDC, Studio and Custom events never get these blocks; WSDC event without a valid attestation refuses official add, ballot and calculation but still allows registration, scheduling and payments; a designation change invalidates the attestation; exception resolutions require body reference and Board authorization reference where 3.4.2.b applies).
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
- **Q5 (closed by OD-06):** WSDC roles come from explicit event-level designations (6A), not from DanceFlow roles.
- **Q16 (OD-16):** does the Chief Judge count toward the WSDC 3.4.7 judge minimum when joining the panel under 3.4.7.c, or must the minimum be met without them?
- **Q17-Q19 (OD-17):** see section 6D.8 (ten-day count; Observer when the Chairman is the organizer; modelling after ballots exist).
- **Q6:** confirm migration block `20270220090000`-`20270220099000` is free.
- **Q7 (OD-06):** who may attest the designation set (6A.3)? Recommended: a manager other than the last designator; for a one-manager event an explicit, recorded single-person acknowledgement.
- **Q8 (OD-06):** is the chief judge's finalist-review record (3.4.4) a hard start blocker for WSDC-declared final rounds (recommended: yes, it is mandatory text) or advisory?
- **Q9 (OD-06):** G4 lets an attested-undesignated manager calculate results. Confirm that reading (6A.5) of 3.4.1/3.4.3, versus requiring a designated scoring operator for every calculation.

## 11. Independent review (subagent that had not seen the conclusions): findings and resolutions

The reviewer re-read every cited rule in the pinned PDFs and the existing E1/E2/F2/10C SQL. All cited passages, classes and pages were confirmed
except the points fixed inline above (SuperStars wording, definition page p.2, 3.4.6.b spans p.19-20, entry list, III.D.21 basis). The remaining
findings are resolved below; **where this section conflicts with earlier text, this section governs.**

**Rulebook**
- F4: WSDC 3.4 opens with "unless otherwise approved by the Board". A general Board-approval route for oversight requirements exists; it is **not modelled**, and no exception exists in DanceFlow without a documented resolution carrying the Board approval reference.
- F7: 3.4.2 covers owners/directors "or their spouses and children". Kind `owner_director_family` is split by a flag `is_spouse_or_child`: the **competing ban (G6)** applies only to spouses/children; the **duty ban (chief judge, scoring; 3.4.1.a)** applies to all immediate family. Other immediate family may compete as far as 3.4.2 goes.
- F8: G4 (the chief judge may not calculate) is **DanceFlow policy stricter than WSDC**: 3.4.9.b lets "Score person and/or Chief Judge" hand-calculate in emergencies, and 3.4.7.c (p.20) lets the chief judge join the panel on an unforeseen shortage. The 6A.6 cell for the chief judge as judge reads "only through the documented 3.4.7.c shortage path, as a resolution with reason", and calculation by the chief judge is allowed only as a documented emergency resolution (3.4.9.b), never silently.
- F19: NDCA and the other bodies rely on account matching with no attestation. Residual risk stated: a person with two accounts is not detected; each non-WSDC event shows the "accounts only" copy of section 3, and an optional attestation step for NDCA-declared events is a future question (Q10).

**Security and data**
- F10 (blocker): `record_competition_conflict_refusal` is granted to `service_role` only and recomputes the conflict from live data; no caller supplies a class, so no authenticated user can forge a finding.
- F11 (blocker): the assignment trigger gets an explicit later name (section 3.3). Ballot, marks and round triggers keep `compoc_` names (they sort after `compe2_`). Fire order is a required test.
- F12 (blocker): E2 round readiness (`_compe2_round_blockers`) lists a missing ballot for every non-absent assigned judge and heat, and absence is round-level. Therefore **block at assignment only** (round-level) until E2 and OD-16 accept a heat-level recusal. Ballot-time detection is a **backstop**: it raises, the judge is shown the generic refusal, and the organizer is told in the panel-lock blocker list that the judge must be unassigned or the entry resolved; it does not create a heat-level recusal. The Q3 claim that a recusal "simply leaves one fewer ballot" is withdrawn.
- F13: judges call `submit_competition_ballot` through PostgREST, so a trigger's text reaches them. Both identity outcomes raise **one generic message** ("this ballot cannot be accepted; contact the chair") with a single code; the class, basis and rule code exist only in server-side evidence.
- F14: blockers are **computed live**; findings are evidence of what was seen when, never inputs to a blocker. A stale finding therefore cannot hold a round.
- F15: DEFINITE tier-1 findings can be resolved only as `recused` or a body-defined `exception_applied`; `not_a_conflict` and `review_cleared` apply to REVIEW findings and declarations only. No manager can clear self-judging on an NDCA or WSDC event.
- F16: only a non-subject withdraws or resolves a declaration; nothing is withdrawn or resolved after the judge has ballots in scope (supersede with a new declaration instead).
- F17: designation rules: retroactive designation of an existing judge/chair/scorer is **recorded and becomes a panel-lock blocker, not rejected** (truthful recording must not be blocked); ending a designation requires a reason and writes an events row; any change invalidates the attestation; on event day an invalidated attestation halts **new** assignments and calculation but ballots already in progress are not discarded, and a break-glass is a recorded re-attestation by a manager other than the designator (Q7 covers the one-manager case).
- F18: the matrix in 4.9 gains rows: designations, attestations and role events are readable by managers and the chair only; `evidence_ref` is a reference code, validated (letters, digits, hyphen, 40 chars), never free text; designee names are shown only to managers. **Open (Q11):** every manager can already read all ballots and marks through `can_manage_event_competition`; whether a designated owner/director reading marks conflicts with 3.4.1's "scoring functions" is an interpretation for the owner, not decided here.
- F20: G3's "same account holds chair and scorer" is already impossible (`unique(event_id, user_id)`); only the designation-level check is kept. Every writer of `event_competition_result_versions` (F2 calculate, PV-1 recompute, CF1 advancement) must be listed and covered by G4; the implementation PR lists each writer and tests it.

**Consistency**
- F21: stubs and redefinitions are explicit in section 7 and md5-pinned. `COMP_WSDC_DESIGNATIONS_REQUIRED` ships in **s5**, so s1 tests cover no WSDC attestation behavior; before s5 a WSDC-declared event gets the s1 tier checks only, and the design states this interim gap (nothing is active; Competition OS is dark, and OD-01 already blocks WSDC results publication).
- F22: "no designation fails closed" is an s5 behavior; remove it from the s1 test list in section 8.

**OD-15 questions:** **Q12** before body profiles exist, are unverified mandatory body requirements panel-lock *blockers* or *warnings* (6B.5; OD-01 already blocks result approval/publication)? **Q13** may a credential record be reused across events of the same organizer (privacy, tenant isolation) or stays event-scoped? **Q14** who verifies Option A evidence (named DanceFlow reviewer, or organizer-entered only) and what is the evidence standard?

New open questions: **Q10** attestation for NDCA-declared events (accounts-only residual risk); **Q11** designated owner/director reading ballots and marks via the manager policy.

## 10. Decision on PR-B

Slice 1 code and migration (PR-B) is **not started**: slice 1 depends on **Q1** (and reads the OD-06 designations from s0 for WSDC tier 2), which decides whether it also needs the resolution table
and a resolver surface (a different migration shape). Everything else slice 1 needs is settled above. With the recommended answer to Q1,
PR-B is a bounded follow-up: findings and events tables, rule-set function, three triggers, preview RPC, refusal-evidence RPC, rollback,
negative tests, independent review.
