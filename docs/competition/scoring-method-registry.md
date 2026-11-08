# Competition OS — Scoring-method registry (REG)

Status: **design + Git-only implementation, DRAFT PR.** Nothing applied to any hosted database; no method is enabled beyond the two the owner approved. Implements Stage 4 decisions S4-1…S4-7 (`scoring-architecture-decisions.md`, PR #293).

Code: `src/lib/competition/scoring/registry.ts` (+ `__tests__/registry.test.ts`). SQL: `20270113090000_competition_scoring_registry.sql`, rollback, `sql-tests/test_T_competition_scoring_registry.sql`.

Related: `engine-spec-callback-tally.md`, `engine-spec-ordinal-majority.md`, `engine-spec-ucwdc-majority-rules.md`, `engine-spec-proficiency-rating.md`, `scoring-results-contract.md` (K0), `src/lib/competition/ballots/formats.ts` (E2).

## 1. The five dimensions and the existing schema

| # | Dimension | Where it lives | REG change |
|---|---|---|---|
| 1 | Sanctioning | new `events.competition_sanctioning` (default `none`) | **new**, event-level, independent of everything else |
| 2 | Format / division type | `event_competition_programs.competition_mode`, contest `entry_format`, `rules_profile_key/version` (10B) | none |
| 3 | Scoring method + version | new `event_competition_divisions.scoring_method_key/_version`; optional `event_competition_rounds.scoring_override_key/_version` | **new**, from `competition_scoring_methods` |
| 4 | Ballot format + permitted marks | E2 `ballot_format`/`ballot_format_version` on ballots; `BALLOT_FORMATS` | none; the registry entry only *declares* which formats it accepts |
| 5 | Result purpose | derived: `feedback` / `placement` / `advancement` | the registry entry declares which purposes the method can produce |

The legacy `scoring_method` columns on programs and rounds (10B/10C.5 checks) are **not touched**. They remain the stored legacy value and are *interpreted* through an explicit map (§5).

### Why columns, not a new assignment table
A division already owns its rounds and its lock; one nullable pair on the division and one on the round expresses "per division, optional round override" with no join and keeps RLS/tenancy exactly as the existing tables. A separate assignment table would add a second place that has to be locked, pinned and tenancy-checked. The only new tables are the global registry (read-only data), the legacy map (read-only data) and the pin evidence table (required by "pinned at lock"). A single `version` column next to the existing `scoring_method` was **not** enough: the existing column is a check-constrained legacy vocabulary (`ordinal_majority`, …) that cannot name `ucwdc_majority_rules@v16.9b`, and widening it would blur "legacy value" with "registry selection".

## 2. Registry entry shape

| Field | Meaning |
|---|---|
| `key`, `version` | identity. Version is an opaque label (`1`, `v16.9b`) |
| `status` | `approved` / `draft` / `unavailable` / `rejected` |
| `sourcePins` | official source documents and sha256. Empty for studio methods |
| `acceptedBallotFormats` | E2 format keys (`callback_yes@1`, `ordinal_rank@1`) |
| `resultPurposes` | subset of feedback / placement / advancement |
| `panelRule` | `studio_x3` (≥3 and odd), `ucwdc_unverified`, `none_unverified` |
| `engineId` | F1 engine reference **by id only** (`studio_ordinal_majority@1`). REG never imports engine modules |
| `fixtureSet` | spec section holding the golden fixtures |
| `statusReason` | decision ids / pending questions |

Shape is enforced in both TypeScript and SQL: a non-approved entry has **no** engine id, ballot formats or purposes (`competition_scoring_methods_approved_shape_check`), so "unavailable" cannot be undone by data alone.

Seeded entries:

| Entry | Status | Notes |
|---|---|---|
| `studio_callback_tally@1` | approved | accepts `callback_yes@1`, purpose advancement, panel X-3 |
| `studio_ordinal_majority@1` | approved | accepts `ordinal_rank@1`, purpose placement, panel X-3 |
| `ucwdc_majority_rules@v16.9b` | **unavailable** | K1-U DRAFT; source `2026-Scoring-Format-v16.9b-1.pdf` sha `44290a06…`; pending UCWDC Q1–Q5; panel eligibility (Q4) unverified |
| `proficiency_rating@1` | **rejected** | Stage 4 §1.6; key kept so existing rows stay fail-closed |
| `ndca_skating@unpinned`, `wsdc_relative_placement@unpinned` | unavailable | placeholders, no authoritative source |

Registry rows are **append-only, including status**. Approving UCWDC later means a *new version row* in a reviewed migration after K1-U closes; the SQL trigger refuses every update/delete/truncate (S4-5, "exact or unavailable").

Engine ids are the F1 contract surface: F1 must register engines under the ids above (`studio_callback_tally@1`, `studio_ordinal_majority@1`) or REG's `engineId` column changes in the same PR. REG does not decide engine behaviour.

## 3. Resolver and fail-closed codes

`resolveMethod(key, version)` returns the entry **only if** `status = approved` and an engine id exists.

| Code | When |
|---|---|
| `COMP_METHOD_UNKNOWN` | key/version not in the registry |
| `COMP_ENGINE_NOT_AVAILABLE` | draft / unavailable / rejected (same code K0 §5 already defines) |
| `COMP_METHOD_BALLOT_FORMAT_MISMATCH` | ballot format not accepted by the method |
| `COMP_METHOD_PURPOSE_MISMATCH` | method cannot produce the requested purpose |
| `COMP_PANEL_SIZE_INVALID` | studio X-3: fewer than 3 or an even number |
| `COMP_PANEL_RULE_UNVERIFIED` | UCWDC and every method without a verified panel rule — refuses every size |
| `COMP_METHOD_LEGACY_UNMAPPED` | no selection and the legacy value has no mapping |
| `COMP_METHOD_LOCKED` / `COMP_SANCTIONING_LOCKED` | SQL only: change attempted after lock |

`resolveRoundMethod` order: **round override → division selection → explicit legacy map → fail closed**. A higher layer that is unavailable does **not** fall through to a lower layer (an unavailable override never silently becomes the division's method).

Panel rules are per method. Studio X-3 (`>=3 and odd`) is the approved rule for ordinal and callback. UCWDC returns `COMP_PANEL_RULE_UNVERIFIED` until Q4 is answered; nothing is guessed.

## 4. Selection, override and version pinning

- **Selection** is per division; **override** per round (for example callback round vs final). Both are nullable pairs with a pair check and a composite FK to the registry.
- **Guard trigger** (`guard_competition_scoring_selection`, security definer, fixed search_path) on both tables: a changed selection requires (a) the program row to exist in the same event, (b) the program to be an unlocked **draft** (`profile_locked_at is null and status = 'draft'`), and (c) the method to be `approved` with an engine id. It also fires for the table owner, so migrations and service-role code cannot bypass it. Unchanged selections pass through, so unrelated edits to a locked division are unaffected.
- **Pinning at lock.** The existing publish function is **not replaced**. An `AFTER UPDATE OF profile_locked_at` trigger on programs (fires only on the NULL → non-NULL transition) writes one append-only row per round to `event_competition_scoring_pins`: effective key/version, which layer decided it (`round_override` / `division` / `legacy_map` / `unmapped`), the legacy value seen, the registry status at that moment, and the sanctioning declared at that moment. A round inserted into an already locked program is pinned on insert.
- Locked selections can never change (the guard), and pins are insert-only (trigger; delete allowed only as the cascade of a deleted round, as for program locks).
- **Reader.** `competition_round_scoring_effective(round)` (managers only; unknown and inaccessible rounds are indistinguishable) returns the pin if there is one, otherwise a live read-only resolution with `pinned = false`. F2's `calculate` must use this reader and refuse when `selectable` is not true. `selectable` is `pinned AND approved`: an unpinned round (unprofiled program, or locked before REG) is never calculable, because its legacy `scoring_method` column is still editable by managers. SQL reader only; `resolveRoundMethod` in TS is for display/validation of drafts and must not be used to calculate; K0's "frozen at publish" (P3) is satisfied by the pin, never by live configuration.
- Programs that are **not** profile-locked (unprofiled/advanced) have no pins; calculation for them must fail closed until a pin or a profile lock exists. REG does not change that.

## 5. Existing programs: `@1` / `@3` and the legacy map (S4-7, no silent rewrite)

Existing programs follow `studio_simple@1` (10B), `@2`, `@3` (10C.5). Their **stored** values never change: no division/round selection is backfilled, no `scoring_method` is rewritten, no pin is created retroactively.

`competition_scoring_legacy_map` (append-only data) interprets the three engine keys the profiles already write:

| Stored legacy value | Interpreted as |
|---|---|
| `ordinal_majority` | `studio_ordinal_majority@1` |
| `callback_tally` | `studio_callback_tally@1` |
| `proficiency_rating` | `proficiency_rating@1` (**rejected → fail closed**) |

Everything else (`majority_rules`, `skating`, `wsdc_callback`, `relative_placement`, `custom`, `none`, `feedback_only`, `proficiency`, `cumulative_points`, `round_specific`) is **deliberately unmapped** and fails closed. In particular legacy `majority_rules` is **not** UCWDC Majority Rules, and `skating`/`wsdc_callback` are not NDCA/WSDC.

Locked programs from before REG have no pins and cannot gain a selection (the guard); they are read live through the map with `pinned = false`. That is the "stay fail-closed until compatibility and transitions are reviewed" behaviour of S4-7; any transition is the workflow in §7.

## 6. Sanctioning field and disclosure (S4-1, S4-2)

`events.competition_sanctioning in ('none','ucwdc','ndca','wsdc','other')`, default `none`, only for `event_type = 'competition'` (check).

- It is the **organizer's declaration**; DanceFlow does not verify it and never infers it. Selecting a method never changes it, and declaring it never enables a method (tested: a UCWDC-declared event still cannot select `ucwdc_majority_rules`, and may select a studio method).
- Writes: studio/organizer owners and admins only (`can_edit_competition_event_operations`; the events update policies alone would let any staff role write it), refused once any program of the event is locked or not draft (`COMP_SANCTIONING_LOCKED`), and refused at event INSERT for session users (create, then declare).
- The value in force at lock is copied into each pin.
- `sanctioningDisclosure(value)` in `registry.ts` returns `{declared, verifiedByDanceFlow: false, text}`. **The text is provisional**: S4-2 disclosure wording is still an open owner item; no UI consumes it yet.

## 7. S4-7 audited draft migration / duplication workflow — DESIGN ONLY, later implementation

Not implemented here. Goal: an unfinished draft (or a locked competition after review) can move to a registry method without recreating it by default and without rewriting history.

1. **Eligibility.** Program is `draft` and unlocked → change by the normal guarded update; no workflow needed. Locked/configured/active → must use the workflow.
2. **Two paths**, chosen by a manager with a required reason:
   - **Duplicate-forward (default for locked):** `duplicate_competition_program(program, reason)` creates a new draft program from the locked snapshot (same profile version, divisions, rounds, dances, rules), leaving the source untouched and linked (`duplicated_from`). The new draft can select methods; it is published and pinned like any new competition. Registration/entries are **not** copied automatically; moving them is a separate audited step.
   - **In-place migration (unlocked, non-draft only, e.g. configured but nothing scored):** `migrate_competition_scoring(program, mapping, reason)` allowed only while no ballot, mark, calculation or result exists for the program; writes one audit event with before/after selections, then re-pins. Anything with a ballot or result is refused (certified/locked results are immutable).
3. **Review gate.** A compatibility report (per round: current resolution, proposed method, ballot-format compatibility, panel X-3 check, purpose) must be produced and stored with the audit event; every row must be `ok`. Rows resolving to an unavailable/rejected method block the migration.
4. **Audit.** Append-only `event_competition_scoring_migrations` (actor, reason, source program, target program or before/after JSON, report hash, time). Never updated.
5. **Never:** rewrite a pin, change a certified result, auto-run on deploy, or backfill.

Open for the owner before implementation: who may approve (manager vs owner), whether registrations carry over on duplicate, and the audit retention.

## 8. What REG does not do

No engine code (F1 owns `results/engines/**`), no results lifecycle (F2), no ballot formats (E2), no UI, no UCWDC/NDCA/WSDC method, no change to the publish function or to any existing check. Hosted DEV/PROD untouched.

## 9. Open items for the coordinator / owner

- Engine id strings (§2) must match F1's registration.
- F2's `calculate` should read `competition_round_scoring_effective` rather than `event_competition_rounds.scoring_method`.
- S4-2 disclosure wording; S4-7 workflow decisions (§7).
- E2's `ballotFormatForScoring` (legacy-key → format) can later be replaced by the registry's `acceptedBallotFormats`; not changed here.

## 10. Independent review (Opus) and known limitations

Review found no P0. Fixed: reader `selectable` requires a pin (P1-1); a division cannot be inserted into a locked program whose divisions already have a selection (P1-2, guards the `add_competition_division` path without replacing it); internal pin/resolve/guard functions are revoked from `service_role` and the pin writer refuses unlocked programs (P1-3); the pin-protect trigger permits deletion when either the round or the program is gone (P1-4, order-independent cascade); `FOR SHARE` on the program row in the guard and the sanctioning trigger (lock races); `Object.hasOwn` on the legacy map; `notify pgrst`.

Known, deliberately not changed here (existing 10B behaviour or later scope):
- The legacy `event_competition_rounds.scoring_method` column stays editable under the existing manage policy; REG makes that harmless by requiring a pin for calculation, but does not guard the column.
- `add_competition_division` / `remove_competition_division` (10B) do not copy selections, and removal cascades pins of a locked program; fixing them replaces 10B functions and belongs with the S4-7 workflow.
- No check that a division's method purpose fits its round types (for example the advancement-only callback method on a final); to be validated at publish/selection in a later slice.
- Unprofiled programs never get pins and therefore never calculate through the reader.
