# Judging-integrity design: OD-05 conflicts and recusal (slices 1-4) and OD-06 WSDC role separation, with OD-15 / OD-16 placeholders

**Status: DESIGN ONLY (PR-A, docs).** No SQL, no code, nothing applied, merged, deployed or activated. Competition OS is dark.
Governed by [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md). Owner decision OD-05 (2026-11-23, Option D, BLOCK, with panel-level
safeguards) is recorded in the audit owner-decision list (PR #795, `OWNER-DECISIONS.md`, branch `claude/comp-audit-owner-decisions`).

**OD-06 was decided on 2026-11-23 (owner): Option A, enforce WSDC separation of duties** for WSDC-declared events, with explicit event-level
designations (section 6A). It is designed here in the same coordinated block as OD-05.

**What this document does not do:** it invents no rule, claims no body compliance, and does not decide OD-15 or OD-16.
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
| WSDC Definitions: Event Director(s) and/or Owner(s) (p.1) | same | An Event Director is anyone involved in deciding the hiring of judges and/or scoring staff, or identified as the Event Director. An Owner is anyone with a vested financial/ownership interest (e.g., shareholder). Non-profit shareholders or board members are not Owners but may fall under Event Director restrictions depending on their role. | definitions |
| WSDC Definitions: Chief Judge, Secondary Chief Judge, Raw Score Judge (p.3) | same | The Chief Judge oversees the event's contests, has extensive experience and cannot compete. The Secondary Chief Judge has the same restrictions. A Raw Score Judge is separate from the panel, may compete in other contests, and has no access to scores and no contest-structure duties. | definitions |
| WSDC 2.3 (p.9) | same | The Event Director and/or the Chief Judge shall verify contest results and the number of contestants. Verification is expressly given to these roles, so it is **not** itself a prohibited scoring function. | mandatory (OD-06 interaction) |
| WSDC 3.4.9.b.i (p.20) | same | Transfer of paper score sheets into the computerized system must be audited by the Chief Judge or a scoring team the Chief Judge approves, verified by someone other than the score person inputting the data. | mandatory (adjacent; section 6A.8) |
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
| Tier 2, the official competes anywhere in the event | block for judge, chair, scorer (III.D.21) | block for the **designated** persons only (event owners, event directors, their spouses and children, chief judge, secondary chief judge, score person; section 6A); exceptions via documented resolution only; with no designation the operation fails closed | block only for Crown/SuperStars same Dance Type (II.F.6.e) once Dance Type is modelled; otherwise info | **not blocked**, recorded as an info finding (baseline is direct conflicts only) |
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
2. `_compoc_blockers_roles`: **OD-06 (decided: Option A)**, WSDC-declared events only. Missing or unverified designations; a designated owner/director/family member or chief judge seated in a restricted function; chair and scorer the same account; see section 6A.
3. `_compoc_blockers_qualifications`: **OD-15 placeholder, not yet decided.** Body credential / attestation readiness.
4. `_compoc_blockers_panel_size`: **OD-16 placeholder, not yet decided.** Per-body minimum panel, chair requirement, non-voting chair.

Validators 2-4 ship as functions returning `[]` until their decisions land, so the guard point, its error (`COMP_PANEL_BLOCKED` with the jsonb list)
and the readiness UI contract are fixed once and the three later decisions plug in without a second trigger, a second error vocabulary
or contradictory ordering. E1's `competition_round_panel_status/ready` are read by the UI beside this list and are not modified.

## 6. OD-06 / OD-15 / OD-16 touchpoints (OD-06 decided; OD-15 and OD-16 placeholders only)

| Decision | Status | Touchpoint with OD-05 | Reserved |
|---|---|---|---|
| OD-06 role separation | **decided 2026-11-23, Option A**; designed in section 6A | event-level designations replace guessing; the WSDC tier-2 list in OD-05 reads them. | designations table; `_compoc_blockers_roles` |
| OD-15 qualifications | **not yet decided, design placeholder only** | credential fields would be new columns on `event_competition_officials` plus a validator; UCWDC tiers wait for the Code of Conduct (open gap). No OD-05 table depends on them. | migration slot; `_compoc_blockers_qualifications` |
| OD-16 panel size / chair | **not yet decided, design placeholder only** | heat-scope recusal (Q3) shrinks a heat's judge count and must satisfy OD-16 minimums; the chief-judge substitution (WSDC 3.4.6.b.iv) belongs here, not in OD-05. | migration slot; `_compoc_blockers_panel_size` |
| OD-17 appointment / substitution | outside this task | a chair "excuse" (NDCA IV.C.8) would be a resolution kind; the panel freeze (`COMP_PANEL_FROZEN`) interacts with late recusal. Flagged only. | none |

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
| Anyone who decides who is hired as judges or scoring staff (for example the manager who adds officials) | **May be an Event Director by the WSDC definition** (p.1) whether or not anyone wrote that down. The system cannot know, which is why designation is an explicit, attested step and the unattested state fails closed. |

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

## 7. Migration block, ordering, rollback

Latest migration on `origin/release/website-embeds` is `20270218090000`. Proposed block for the coordinator to confirm
(Q6): **`20270220090000` to `20270220097000`**, one file per step, applied strictly in order, each with
`rollback/<name>_rollback.sql`, a header stating **"PROD apply needs separate owner approval; not applied to any database"**,
LF-only function bodies (Phase 10D CRLF lesson), and an md5 pin plus preflight for anything redefined.

| Timestamp | File (proposed) | Slice | Redefines an existing function? |
|---|---|---|---|
| `20270220090000` | `competition_oc_s0_role_designations` | OD-06 data | no (designations + attestations tables, RPCs, RLS, audit; no enforcement) |
| `20270220091000` | `competition_oc_s1_identity_guard` | OD-05 s1 | no (new triggers, functions, findings and events tables) |
| `20270220092000` | `competition_oc_s2_declarations` | OD-05 s2 | no |
| `20270220093000` | `competition_oc_s3_enforcement_resolutions` | OD-05 s3 | no (owns `_compoc_conflict_state`) |
| `20270220094000` | `competition_oc_s4_panel_lock` | OD-05 s4 | no (trigger on rounds, aggregator, validators 2-4 return `[]`) |
| `20270220095000` | `competition_oc_s5_wsdc_separation_guards` | OD-06 enforcement | no (G1-G7 triggers on officials, designations, result versions; fills `_compoc_blockers_roles`) |
| `20270220096000` | reserved OD-15 | placeholder | adds columns to `event_competition_officials` |
| `20270220097000` | reserved OD-16 | placeholder | fills `_compoc_blockers_panel_size` |

Order rationale: designations (s0) must exist before the OD-05 tier-2 lookup reads them (s1); enforcement of OD-06 (s5) comes after the shared guard
point (s4) it plugs into. The block is now `20270220090000` to `20270220097000`.

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
  blocks; `wsdc` tier 2 blocks only designated owner/director/family/chief judge/scoring operator; no designation or attestation fails closed); anchor completed after assignment is caught at ballot time; `scorer_paper` entering
  scorer checked; a refused attempt leaves zero assignment/ballot/mark rows; refusal evidence written by the separate transaction;
  unrelated judge and unrelated round unaffected.
- Slice 2: scope CHECKs; judge declares own only; read isolation per matrix; withdrawal audited; no relationship text in list RPC.
- Slice 3: exception codes validated by sanctioning; subject cannot resolve self; NDCA tier-2 match cannot be cleared; resolutions immutable.
- Slice 4: guard fires only on the activation edge; blocker order stable; OD-15 and OD-16 placeholder validators return `[]`.
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
- **Q6:** confirm migration block `20270220090000`-`20270220097000` is free.
- **Q7 (OD-06):** who may attest the designation set (6A.3)? Recommended: a manager other than the last designator; for a one-manager event an explicit, recorded single-person acknowledgement.
- **Q8 (OD-06):** is the chief judge's finalist-review record (3.4.4) a hard start blocker for WSDC-declared final rounds (recommended: yes, it is mandatory text) or advisory?
- **Q9 (OD-06):** G4 lets an attested-undesignated manager calculate results. Confirm that reading (6A.5) of 3.4.1/3.4.3, versus requiring a designated scoring operator for every calculation.

## 10. Decision on PR-B

Slice 1 code and migration (PR-B) is **not started**: slice 1 depends on **Q1** (and reads the OD-06 designations from s0 for WSDC tier 2), which decides whether it also needs the resolution table
and a resolver surface (a different migration shape). Everything else slice 1 needs is settled above. With the recommended answer to Q1,
PR-B is a bounded follow-up: findings and events tables, rule-set function, three triggers, preview RPC, refusal-evidence RPC, rollback,
negative tests, independent review.
