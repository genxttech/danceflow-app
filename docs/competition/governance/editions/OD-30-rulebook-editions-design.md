# OD-30: versioned rulebook editions, effective dates and body-specific age rules (design only)

**Status: DESIGN ONLY, draft.** Owner decision OD-30, 2026-11-23, **Option A** (full text in
`docs/competition/governance/audit/OWNER-DECISIONS.md` in PR #795; not yet on this base). Authorized: design, rule-register documentation, source
comparison, independent review. **Not authorized and not done:** SQL, migration files, implementation, merge,
deployment, activation, outreach. Every table, column, function and test below is **proposed**; none exists. No
migration number is reserved by this document (section 8).

OD-30 is the foundational prerequisite for any future governing-body profile (NDCA, UCWDC, WSDC). It does not make
any body profile available, does not authorize a scoring engine, and establishes no external certification (section 12).

Companion documents: [edition-difference-method.md](edition-difference-method.md) (lifecycle, review checklist,
promotion gate) and [age-basis-source-notes.md](age-basis-source-notes.md) (verified age-reference rules per body).
Register entries: `OD30-*` in [rules/](../rule-register/rules/).

## 1. What was verified, and the one thing no source says

All four pinned documents were hashed on 2026-11-23 and match the
[source registry](../../governing-body-source-registry.md); every passage used was re-read with
`pdftotext -layout`.

| Fact | Evidence |
|---|---|
| No pinned document states an **effective date** for its edition | NDCA cover: "June 2026 EDITION"; UCWDC cover "2026 - 2028", "REVISED 2025"; WSDC footers "Version 2026.1C". |
| NDCA defines effectivity by **reference**: amendments "shall take effect upon publication" | NDCA Introduction F "Application of Competition Rules", p.2. The publication date of an edition is not in the PDF. |
| Dates that **look** like effective dates are file-name tokens | `v1-26-2026` (UCWDC), `Jan172026` (WSDC). OD-30 item 7 forbids inferring from them. |
| The register and its schema require a **date** in `source.effective_from` | `register.schema.json`; `ruleRegister.integrity.test.ts` fails an entry without it. There is no way to say UNKNOWN. |
| Some existing or proposed entries therefore carry inferred dates | `EXAMPLE-0001` (2026-01-26, which matches the UCWDC file-name token `v1-26-2026`; it is an exempt template); in open PR #837 the OD-03 entries use 2026-06-01 (NDCA June) and 2026-01-17 (WSDC file name). **Finding F-1** (section 11). |
| The July 2026 NDCA edition is a candidate with the same gap | Retrieved and hashed (`b52800958d22...a32e`, matches PR #840); no effective date, no change log. |

Consequence: with today's sources, **every** edition's effective date is `unknown`. The design must work with
`unknown` as a first-class value, never fill it in, and fail closed for body-declared events.

## 2. Principles

1. **Platform admits, organizer selects, nobody auto-upgrades.** The DanceFlow platform owner decides which editions
   enter the verified registry; an authorized organizer selects among admitted editions for an event; nothing ever
   moves an event to another edition by itself (item 3).
2. **Unknown is a value.** Applicability, effective date and age-reference interpretation each have an explicit
   `unknown` / `UNRESOLVED` state that blocks, never defaults.
3. **Evidence is append-only.** Bindings, amendments, reviews and exceptions are insert-only history; a change is a
   new row that points at what it supersedes.
4. **Four different dates, never merged:** publication date, effective date, event date, organizer declaration.
5. **Policy is labelled.** Edition lifecycle rules and the launch minimum age are DanceFlow policy, not body rules.
6. **Studio/Custom is unchanged.** A Studio/Custom event binds the explicit value `studio_custom` (no governing-body
   edition); it never needs an approved edition and is never labelled as bound to one.

## 3. Data model (proposed)

### 3.1 Edition registry (platform-owned, global, append-only)

`competition_rulebook_editions` (one row per body + document + edition; the machine form of a row of
[governing-body-source-registry.md](../../governing-body-source-registry.md)):

| Field | Notes |
|---|---|
| `id`, `governing_body` | body names as in the registry (`NDCA`, `UCWDC`, `WSDC`, extensible). |
| `document_key`, `edition_label`, `source_version_label` | label **as printed in the document**; where footers and file name disagree (WSDC 2026.1C vs 2026.1B) both are recorded. |
| `sha256`, `byte_length`, `retrieval_source`, `retrieved_at` | exact bytes reviewed. SHA-256 is unique per row. |
| `publication_date`, `publication_date_basis` | `stated_in_document` / `stated_on_publisher_page` / `observed_http_metadata` / `unknown`. HTTP metadata never feeds an effective date. |
| `effective_from`, `effective_to`, `effective_date_status`, `effective_evidence_ref`, `effective_rule_ref` | `status in (verified, unknown)`; `unknown` ⇒ both dates null. `effective_rule_ref` holds e.g. "NDCA Introduction F p.2: effective upon publication" and is not a date. |
| `lifecycle_status` | `candidate`, `under_review`, `approved`, `superseded`, `rejected`, `withdrawn` ([method, section 1](edition-difference-method.md#1-edition-lifecycle-statuses)). |
| `supersedes_edition_id` | the edition it follows, if any. |

Child tables, all append-only:

- `competition_rulebook_edition_reviews`: one row per review run: reviewer, retriever, checklist A-L answers,
  difference-analysis hash and counts, compatibility assessment, outcome, timestamps.
- `competition_rulebook_edition_applicability`: per `(edition, body-format)`: `applicability_status in
  (verified_applicable, verified_not_applicable, unknown)`, `valid_from`/`valid_to` (nullable, only with
  `verified_applicable` and a publisher-statement `evidence_ref`; an applicability window, **not** an effective date and never a substitute for one), `evidence_ref`, reviewer. A missing row is `unknown`.
- `competition_rulebook_edition_approvals`: admission decisions (`admitted`, `status_changed`, `withdrawn`) by the
  platform owner, with reason; the approval history OD-30 item 6 asks for.

### 3.2 Age basis (versioned, per body and category)

`competition_age_basis_versions`: `(governing_body, edition_id, category_key, basis_version)` unique; immutable;
a correction is a new `basis_version`. Fields describe **which rule applies and what is unresolved**; they hold no
formula that has not been independently verified.

| Field | Values / notes |
|---|---|
| `category_key` | the body's age category or division group (for example NDCA `amateur_age_classes`, `pro_am_student_age_divisions`; NDCA `under_21` (its own category: different reference from the other amateur classes); UCWDC `junior`, `adult_open_masters`, `adult_age_restricted`; WSDC `age_based_jack_and_jill`). Organizer-defined divisions (NDCA X.A.3) have **no** body basis: they are `organizer_policy` and carry `basis_kind = organizer_defined`. |
| `basis_kind` | `birthday_with_window` (NDCA X.A.1), `competition_day` (NDCA X.A.1.f), `dance_season_end` (UCWDC II.D.1), `close_of_event` (WSDC Definitions), `organizer_defined`, `unresolved`. Extensible; no universal default. |
| `parameters` | only values the source states: NDCA `window_days_before = 30`, `window_days_after = 30`, `under_21_grace = none`, `multi_day_extension = true`; UCWDC season boundaries (Jan 16 - Jan 15); WSDC thresholds (<18, 35+, 50+). |
| `subject_rule` | whose age counts: `each_participant`, `older_partner`, `younger_partner`, `both_partners_thresholds` (NDCA Senior), `partnership_thresholds` (NDCA Under 21: one partner reached 16, neither 21), `junior_older_partner` (UCWDC Couples II.D.2.a), `UNRESOLVED` (UCWDC ProAm/ProPro AE-16; UCWDC non-Junior Couples). |
| `interpretation_status` | `verified_text`, `requires_interpretation`, `unresolved`. Anything not `verified_text` blocks automatic determination. |
| `source_refs`, `register_entry_ids` | section/page and `OD30-*` entries. |
| `exceptions` | listed, not computed: NDCA dance-up/age-gap permissions (X.A.4-5; granted by the NDCA Ballroom Department, not the organizer), the NDCA Youth high-school extension (X.A.5.f) and the Pre-Teen/Junior Adult bars (X.A.5.d-e), the NDCA rule that Pre-Teen/Junior/Youth Pro/Am Student events use the amateur age divisions (II.B.8.a), UCWDC 16+ partner exception (Couples II.D.3.a-b). |

Resolved facts and unresolved questions per body are in [age-basis-source-notes.md](age-basis-source-notes.md).
**Not specified here:** any calculation, rounding, time-zone or leap-day handling, or what instant "close of the
event" or "day of the competition" means. Those need verified interpretations first; until then `basis_kind` records
the rule and `interpretation_status` blocks automatic use.

### 3.3 Event binding (organizer's selection, append-only history)

`event_competition_edition_bindings`: `id`, `event_id`, `program_id`, `binding_seq`, `rulebook_edition_id` (nullable
only when `binding_kind = studio_custom`), `binding_kind in (body_edition, studio_custom)`, `age_basis_versions jsonb`
(the versions in force, copied), `selected_by`, `selected_at`, `organizer_declaration jsonb` (what the organizer
asserted and when; stored as a declaration, never as evidence), `applicability_snapshot jsonb` (the applicability
rows and event date evaluation at selection), `supersedes_binding_id`, `change_kind in (initial, ordinary_correction,
controlled_amendment, exceptional_correction)`, `request_id`. A unique partial index guarantees **one current binding
per program** (the row not superseded). Rows are never updated or deleted (cascade only when the competition itself
is deleted, matching `event_competition_program_locks`).

`competition_profile_edition_compat`: `(profile_key, profile_version, edition_id, assessed_by, assessed_at,
assessment)` records which approved editions a rules-profile version may be combined with, written only from the
compatibility assessment (method, step 7). A profile version stays immutable (`protect_competition_rules_profile`);
the binding, not the profile, carries the edition.

### 3.4 Amendments and exceptions (separate, versioned)

- `event_competition_edition_amendments`: controlled amendment after registrations begin (section 5.2): requester,
  authorizer (distinct, mirroring the A6 cosign pattern: `cosigned_by <> requested_by`), `impact_assessment jsonb`
  (counts and ids of entries, divisions, schedule slots, eligibility determinations affected; **no birthdates**),
  `revalidation jsonb` (per affected item: required, done by, outcome), status `requested`, `authorized`,
  `revalidated`, `applied`, `cancelled`, `stale`.
- `event_competition_edition_exceptions`: the separate exceptional correction after competition activity begins
  (section 5.3), also two-person, versioned, with the original binding and evidence referenced and never altered.

## 4. Who may do what (permissions)

| Action | Actor | Mechanism (proposed) |
|---|---|---|
| Retrieve, compare, review a candidate | engineering + an **independent** reviewer | review record (method, section 4) |
| **Admit** an edition (`candidate` → `approved`), change its status, record applicability | **Platform owner**, never the reviewer; existing `is_platform_admin()` is the only platform-level check in the schema today, so the role mapping "platform admin = platform owner" is open (Q1) | `SECURITY DEFINER` RPC, `revoke all` from `public`/`anon`/`authenticated`, execute by owner path only; admitter ≠ reviewer enforced in the function |
| Select an admitted edition (before registration opens) | authorized organizer (`can_manage_event_competition(event_id)` with the event-manager role) | RPC; cannot choose an edition that is not `approved`/`superseded`-selectable, whose applicability for the event's body/format is not `verified_applicable`, or whose window excludes the event date (when dates are verified) |
| Controlled amendment (after registrations begin) | requester: event manager; authorizer: a second authorized person (and platform-owner notification; Q4 asks whether platform-owner approval is also required) | two-step RPC |
| Exceptional correction (after competition activity begins) | event manager request + platform owner authorization + independent confirmer | separate RPC; Q3 |
| Read editions, applicability, bindings | editions/applicability: any authenticated user (public registry data); bindings, amendments, exceptions: event managers (as `event_competition_program_locks`) | RLS select policies |

**Binding a body edition requires `verified_applicable` with publisher evidence for the event's body/format; an unknown effective date alone does not block, but with today's sources no applicability is verified, so no body edition is bindable at all (only `studio_custom`).** **Organizer choice never overrides a mandatory body rule.** The edition selection chooses *which text applies*; it
never disables a mandatory rule of that text, and a body-declared event with no verified applicability cannot be
bound at all.

## 5. State transitions

### 5.1 Phases (when each kind of change is allowed)

| Phase | Definition (existing signals) | Edition change |
|---|---|---|
| P0: registration not yet opened (before publish, or published but `registration_opened_at is null`) | `event_competition_programs.registration_opened_at is null` | **Ordinary selection/correction**, each with an audit row (`ordinary_correction`). |
| P1: registrations have begun, no competition activity | registration opened at least once, and no activity signal below | **Controlled amendment only** (section 5.2). |
| P2: competition activity begun | **any** of: a round has left `draft`/`scheduled`; a heat has been checked in or generated for scoring; a ballot, mark or judge attendance row exists; a `result_versions`, `approvals` or `publications` row exists; a result has been published | **No ordinary switching.** Only an exceptional correction (section 5.3). |

**Publish-time pins are not activity.** Today `pin_competition_program_scoring` writes a `scoring_pins` row for every
round when the program is published (`profile_locked_at` set), and `pin_competition_late_round` pins rounds added later;
pins are append-only (`protect_competition_scoring_pin`). A pin therefore exists long before registration opens and
**must not** be a P2 signal, and the design **does not stamp or re-pin pins**: the edition reference is a separate
dimension from the scoring-method pin and is stamped on the **result version** (section 6), so a P0/P1 change never
needs to touch a pin and no program mixes editions across rounds before activity.

**Binding versus publish.** A current binding must exist **before publish** (a Studio/Custom program gets
`studio_custom` automatically). The frozen lock snapshot (`event_competition_program_locks.snapshot.edition`) records the
binding **at publish** as publish-time evidence only; it is never "the current edition". Later P0 corrections and P1
amendments are recorded in the bindings history; the snapshot is not rewritten.

One SQL function, `competition_edition_activity_started(event_id)`, is the single definition; the application never
re-implements it. Whether this activity list is complete is Q2.

### 5.2 Controlled amendment (P1)

`requested` → (impact assessment generated by the system and frozen) → `authorized` (second person) →
`revalidated` (every affected entry, division and schedule item re-confirmed or released by an authorized person;
OD-03/OD-18 eligibility determinations referencing the old binding are marked `stale` and must be redone) → `applied`
(new binding row with `supersedes_binding_id`). A request goes `stale` if registrations, divisions or schedule change
after the assessment, and must be re-run. Nothing is applied automatically at any step. Entries already paid or
confirmed are not cancelled; they are listed in the impact assessment and the organizer decides per entry through the
existing workflows.

### 5.3 Exceptional correction (P2)

Not available as an ordinary action. A separately authorized, versioned process: request with stated reason →
platform-owner authorization → independent confirmation → a new binding of kind `exceptional_correction` **only
for future operations**. The original binding, every result version, publication and pin made under it keep their
original edition references and are **never recalculated, restated or re-labelled**. If a past result is wrong, the
OD-07 controlled-correction workflow produces a new linked result version, which **inherits the superseded version's
edition references** by default (section 6). A different edition for a corrected version is possible only if the
exception record names it explicitly and the extra authorization is recorded; it is never a silent recomputation.
(Q3 asks the owner who authorizes.)

### 5.4 No automatic upgrade (item 3), as invariants

- Admitting, superseding, withdrawing or re-statusing an edition **writes no binding** and updates none.
- No trigger, scheduled job or view derives an event's edition from "newest approved".
- A `superseded` or `withdrawn` edition keeps serving every binding that names it.
- The binding is the only source of "which edition applies to this event"; code never looks up "current edition".

## 6. Existing objects affected

| Object | Today | Proposed change |
|---|---|---|
| `competition_rules_profiles` (`20261108090000`) | immutable, `defaults jsonb` cites documents by name; trigger `protect_competition_rules_profile` | **No change.** New profile versions (never edits) only when a profile's content must change; edition carried by the binding. |
| `event_competition_programs.rules_profile_key/version`, `profile_locked_at`, `protect_competition_program_profile` | profile locked at publish | No column change. Publish function additionally requires a current binding (section 6.1). |
| `event_competition_program_locks.snapshot` (`protect_competition_program_lock`) | frozen JSON at publish | `snapshot` gains an `edition` object (binding id, edition id, sha256, effective status, age_basis versions). Additive; the existing snapshot CHECK only constrains `profile.key/version`. |
| `events.competition_sanctioning` (`protect_competition_sanctioning`, OD-01 PR #832) | unverified `none/ucwdc/ndca/wsdc/other` | **Unchanged and still a declaration.** The binding is separate: a declared body without a verified `body_edition` binding keeps OD-01's block. OD-30 never turns the declaration into verification. |
| `event_competition_scoring_pins` (`protect_competition_scoring_pin`, `pin_competition_program_scoring`, `pin_competition_late_round`) | method key/version, `sanctioning`; written at publish, append-only | **No change.** Pins stay a method-only record; they carry no edition (see section 5.1). |
| `event_competition_result_versions` (F2; `_compf2_guard_version_update` allows only `status` to change) | `engine_key/version`, `rules_profile_key/version`, `input_hash`, `trace_hash` | add `edition_ref_kind text not null default 'legacy_unrecorded'` (`body_edition`, `studio_custom`, `legacy_unrecorded`), nullable `edition_binding_id`, `rulebook_edition_id`, and `scoring_policy_ref jsonb` (method key/version from the round's pin **when one exists**, engine key/version from the row, panel rule, registry status). A `BEFORE INSERT` trigger stamps them from the program's current binding **at calculation time**; immutable afterwards. Corrected versions (OD-07) **inherit** the superseded version's references. Existing rows get the column default through `ADD COLUMN ... DEFAULT` (no UPDATE, so the immutability guard is not touched). |
| `event_competition_result_approvals`, `event_competition_result_publications` (F3) | FK to `result_versions` | **No column.** Evidence is transitive through `result_version_id`; a read view `competition_result_edition_evidence` joins pin → version → approval → publication. |
| `event_competition_entries` eligibility metadata (`parseEligibilityDetermination`, OD-03/OD-18) | organizer determination, no edition | the determination JSON gains `rulebook_edition_ref` and `age_basis_ref` (ids or `studio_custom`); no birthdate, no age. |
| `governing-body-source-registry.md` / register | date required; no UNKNOWN | proposal in section 11 (F-1). |

Stamping by trigger (not by patching each writer) means later migrations that create result versions (OD-07
corrections, OD-22/23) need no coordination with this one: every writer is stamped in the database.

### 6.1 Fail-closed rules

- A body-declared program cannot be published (`publish_competition_program`) without a current `body_edition` binding
  whose applicability is `verified_applicable` for the body/format. `unknown` blocks.
- A result version cannot be written for a program with no current binding. New Studio/Custom programs get an
  explicit `studio_custom` binding at publish; the migration **inserts** (never updates) a `studio_custom` binding
  with `change_kind = initial` for each existing program whose rules profile is `studio_simple` (a DanceFlow profile
  with no governing body, so nothing is inferred). No existing program uses a body profile; if one is ever found it
  gets no binding and its calculations stay refused until the owner decides.
- Result versions that exist before the migration keep `edition_ref_kind = 'legacy_unrecorded'` from the column
  default (an `ADD COLUMN` default, not an UPDATE). They are never presented as bound to an edition, and no edition is
  inferred for them. Result versions of rounds without a pin (programs locked before the scoring registry) are stamped
  the same way from the program binding; `scoring_policy_ref.method` is then null, never guessed.
- Ballots, marks and check-ins carry no edition column; they are covered transitively because the binding cannot change
  after the first of them exists (P2), and the bindings history timestamps any exceptional change.
- **Authorization boundary.** The OD-02 adult-only gate is verified at the application layer only (PR #835's own
  entry says the database RPCs still accept any date of birth). No new RPC in this design (binding, amendment,
  exception) accepts, derives or returns an eligibility or age result.

## 7. Audit reference for every operation (OD-30 item 14)

| Operation | Edition reference retained in | Scoring-policy reference retained in |
|---|---|---|
| Event created / profile published | `event_competition_program_locks.snapshot.edition`; bindings history | profile key/version in the lock |
| Scoring method pinned for a round | none (the pin is method-only; the program binding is already in the bindings history and the publish snapshot) | existing `scoring_pins.method_key/method_version` |
| Result calculated | `result_versions.edition_binding_id`, `rulebook_edition_id` | `result_versions.scoring_policy_ref`, existing `engine_key/version` |
| Result approved / published | through `result_version_id` (view) | same |
| Eligibility determination (OD-03/OD-18) | determination JSON `rulebook_edition_ref`, `age_basis_ref` | not applicable |
| Amendment / exception | amendment and exception rows (old and new binding ids) | not applicable |

"Scoring-policy version" is defined as the tuple (method key, method version, engine key, engine version, panel
rule id, registry status) already pinned today, plus the edition reference; OD-24 owns the content of those
methods. A recomputation (PV-1 `_comppv1_verify`) reads the stored references and never re-resolves them.

## 8. Migration ordering and slots

Existing hosted tail: `20270218090000`. Claimed or proposed by open PRs on 2026-11-23 (read from their diffs):
`20270219090000` (OD-04 file, #844); `20270220089000`-`20270220100000` (OD-05/06 design, #834); `20270220-0222`
(OD-07, OD-10, OD-11, OD-12 designs, #838, #842, #843, #845, up to `20270223092000`); Twilio dark migrations
`20270222190000` (#793), `20270223090000` (#797), `20270223091000` (#796, #811), `20270223130000` (#824).

**Proposed, not reserved: block `20270227090000` to `20270227095000`**, no overlap with any claim above (the last
claim found is `20270223130000`). Proposed order inside the block:

1. `…090000` editions + reviews + applicability + approvals + `age_basis` tables and guards (no existing table touched).
2. `…091000` bindings, amendments, exceptions, compat table, `competition_edition_activity_started`.
3. `…092000` additive columns on `result_versions` (defaults, no UPDATE) + stamp trigger + `studio_custom` binding
   inserts for existing Studio programs + evidence view.
4. `…093000` publish guard: `publish_competition_program` and result-version stamping require a binding (fail closed).
   Installed **disabled by default** behind a database setting: this is intentional, because no body profile exists and
   OD-01 already blocks body-declared publication; enabling it is a separate approved activation step and the
   activation checklist must verify it is on.

Other open designs overlap each other (not OD-30's collision, noted for the coordinator): #845 claims
`20270223090000`-`20270223092000`, which collide with Twilio #797 and #796/#811, and #842's `20270220098000` sits inside
#834's block.

Sequencing against other designs: nothing in OD-04/05/06/07/10/11/12/22/23 needs these tables to exist, because
stamping is by trigger. If the coordinator prefers OD-30 to land **before** OD-07's migration, only the timestamp
changes, not the design. Any PROD apply is owner-gated (existing process). Rollback below.

## 9. Rollback constraints

- Everything is additive: new tables, nullable columns, triggers. **App first, then SQL**, as in the existing process.
- Application rollback is a flag/flow rollback: stop reading the new tables; the binding and stamp triggers keep
  writing (harmless).
- Database rollback is allowed **only before the first binding/stamp row exists** in an environment (drop tables,
  triggers, columns). After that, columns and tables are **evidence** and are never dropped; rollback means disabling
  the guards (migration `…093000`) by setting, never by deleting rows. The rollback script refuses (like the
  existing `rollback/` scripts) when evidence rows exist.
- A bad edition admission is rolled back by a `withdrawn` status row, never by deleting.

## 10. Tests

### 10.1 Compatibility (must pass before any activation)

- Existing Studio/Custom programs keep working with automatic `studio_custom` bindings; `studio_simple@1`,`@2`,`@3`
  remain immutable and selectable as today.
- Existing `scoring_pins`, `result_versions` and publications read identically (no column becomes required); the column
  default marks `legacy_unrecorded` and invents nothing; the result-version immutability guard still rejects every
  UPDATE except status.
- PV-1 recompute (`_comppv1_verify`) and the registry guards are unchanged by the new columns.
- OD-01 block (PR #832), OD-02 adult-only gate (PR #835), OD-03/OD-18 organizer determination (PRs #837, #846) behave
  identically with and without bindings for Studio/Custom events.
- The register integrity test passes with the `OD30-*` entries.

### 10.2 Negative tests (each must fail closed with a distinct error)

Edition integrity: admit with an unreviewed or same-person review; admit a candidate with a hash differing from the
reviewed bytes; edit or delete an edition, review, approval or applicability row; set an effective date with
status `unknown`; set an effective date from `observed_http_metadata`; select a `candidate`/`under_review`/`rejected`/
`withdrawn` edition; select an edition whose applicability is `unknown` or `verified_not_applicable` for a body-declared
event; select an edition outside a verified window; organizer declaration used as evidence.

No drift: admitting a newer edition leaves every binding unchanged; marking an edition `superseded` or `withdrawn`
leaves bindings and results unchanged; a job or trigger attempting to update a binding is rejected; no code path
resolves "latest edition".

Phase rules: ordinary change at P1 and P2 refused; controlled amendment at P2 refused; amendment applied without
authorization, with self-authorization, with a stale impact assessment, or without revalidation of every affected
item; exceptional correction without platform-owner authorization or independent confirmation; a binding change
after activity touching any pin, result version, approval or publication (all stay as written).

History: UPDATE/DELETE/TRUNCATE on bindings, amendments, exceptions, pins and result versions' reference columns;
a result version whose edition columns differ from the binding in force at calculation; a declared
`competition_sanctioning` that does not match the bound edition's body (either direction, including a declaration
changed after binding and before publish); a race between applying an amendment or exception and the first activity
signal (the apply locks the program row, as `protect_competition_sanctioning` locks with `for share`, and re-checks the
phase); a `superseded` edition selected for an event that does not already name it unless its verified applicability
window covers the event date; any new RPC that returns or accepts an eligibility result; the activation checklist run
with the publish guard still disabled; a corrected (OD-07) version that does not inherit; a
recompute that changes stored references; legacy rows presented as bound.

Authorization: anon/authenticated direct writes; organizer of another event; reviewer admitting their own review.

Age basis (no calculation tested; model integrity only): an `age_basis` with `interpretation_status` other than
`verified_text` used for an automatic determination; a basis missing `source_refs`; a universal default basis; a
body's basis applied to another body; NDCA `birthday_with_window` basis applied to a WSDC category; AE-16
(ProAm whose age) resolved by code default.

OD-02: an `age_basis` result, an organizer attestation, an eligibility waiver, a body exception (UCWDC 16+ partner
exception, NDCA Junior/Youth classes, WSDC "Juniors") or any edition/age setting that would admit a registrant under 18
is refused by the OD-02 gate, which has no dependency on edition or basis.

## 11. Age rules: coordination, findings and boundaries

**Per-body, separate, no universal reference** (item 11-12): NDCA reference is the actual birthday with a window
(X.A.1) and the competition day for Under 21 (X.A.1.f); UCWDC the last day of the Dance Season (II.D.1); WSDC the
close of the event (Definitions). Details, exceptions and unresolved interpretations: [age-basis-source-notes.md](age-basis-source-notes.md).
**ProAm/Couples whose-age (AE-16) stays UNRESOLVED**; nothing here resolves it, and an `age_basis` whose `subject_rule`
is `UNRESOLVED` blocks automatic determination.

**OD-02 (adult-only, PR #835; Option A design PR #836).** The 18+ launch restriction is **DanceFlow policy** with its
own conservative reference (the registration moment) and no input from edition, body or `age_basis`. It is evaluated
first and cannot be loosened by an organizer, an attestation, a waiver, a body exception or a future age setting. Lifting it is a separate platform
decision (OD-02 Option A), recorded as a policy version, never as a property of an edition. NDCA classes below 18
(Pre-Teen, Junior, Youth up to the 18th birthday), UCWDC Juniors and WSDC "Juniors" exist in the rulebooks; none of
them is reachable while OD-02 stands.

**OD-03 / OD-18 (PRs #837, #846).** Organizer determinations stay the only path for age-division eligibility at first
activation. They gain the edition and basis references (section 7) and become `stale` after a controlled amendment.
No automatic per-body age computation is introduced; it remains a later, separately reviewed phase.

**OD-01 (#832).** Declaration versus binding: the declaration remains unverified; a body binding adds nothing to
compliance claims. **OD-08 (#840).** The NDCA withdrawal design depends on the edition only through the binding
(III.D.30 is identical in June and July); the June/July comparison is reproduced here. **OD-09 (#839).** The NDCA
advancement blocker is unaffected. **OD-24 (#851).** Source candidates for WSDC Relative Placement follow the same
lifecycle (`candidate` until independently reviewed); scoring-method versions are referenced, never created, here.

**Findings requiring owner direction**

- **F-1 (register date field).** The register cannot express an unknown effective date; entries must carry a date, and
  some existing/proposed ones use dates inferred from file names or months. Proposed (not applied): make
  `source.effective_from` nullable, add `source.effective_date_status` (`verified`/`unknown`), forbid evaluation of an
  `unknown` entry against an event date (manual interpretation required), and re-label existing entries. Until then the
  `OD30-*` entries carry **`2026-11-22` as a schema placeholder** (the date the governance registry was introduced), stated in each
  entry's notes as **not** an effective date. Not changed in this PR because the integrity test could not be run here.
- **F-2 (July II.B.7.f).** Documented separately; July remains an unreviewed candidate; no register entry cites it.

## 12. What a reviewed edition does not do

It does not authorize a scoring engine or a body scoring profile, does not make any result body-compliant, and is not
certification or approval by any governing body. UCWDC "authorized system" designation, WSDC scoring-system approval
and NDCA scrutineer requirements remain separate, independently verified dependencies (OD-01, OD-09, OD-24).

## 13. Open questions for the owner

1. **Q1.** Is "platform owner" operationally a specific person/role, and is `platform_admins` the right membership? (Proposed: a distinct, named admitter group, never the reviewer.)
2. **Q2.** Is the P2 activity list (section 5.1) the right definition of "competition activity begins"? In particular, should paid registrations alone ever count?
3. **Q3.** Who authorizes an exceptional correction at P2: platform owner plus event manager plus independent confirmer, as proposed?
4. **Q4.** Does a controlled amendment at P1 need platform-owner approval, or only a second authorized person at the event?
5. **Q5.** Approve the register change in F-1 (nullable effective date + status) as a follow-up governance PR?
6. **Q6.** May an organizer of a Studio/Custom event record an *informational* source edition label (never verified, never evidence)? Proposed: no, to avoid implied compliance.
7. **Q7.** UCWDC: for a multi-day event spanning January 15-16, which Dance Season applies (U-U1)? Needs verified interpretation, not a code default.
