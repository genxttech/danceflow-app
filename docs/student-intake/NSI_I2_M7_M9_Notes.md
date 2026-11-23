# NSI I2 — M7–M9: pilot grants, explicit lesson types, simulation, archiving

Status: **authored and validated locally only.** Not applied to shared DEV or PROD. Untracked, uncommitted. Gate A is closed and untouched.
Baseline: M1–M5 (I1) and revised M6 (`62e2f4de98ed…`, applied to DEV 2026-10-15) are the deployed foundation and are not edited.

## 0. Verified shared-DEV state (milestone ACCEPTED 2026-10-15; M7–M9 applied ~18:00–18:01Z)

| Item | Verified value |
|---|---|
| Environment | shared DEV `epdrtzcydvnoidwrepqz` only. **PROD has none of M1–M9.** |
| Applied migrations | M1–M5 (I1), M6 `62e2f4de98ed…` (revised, applied earlier 2026-10-15), M7 `41b3b5ef…`, M8 `7d297f5a…`, M9 `367be6bf…` (full hashes in section 1) |
| Catalog counts | 19 tables, 85 intake functions, 70 triggers, 23 RLS policies |
| `assert_catalog()` | passes; deployed body md5 `2881cdc21dcb58c8ff82fd5d31aca5e0` = M9 copy (M7 copy `46704cb2…`, M8 copy `83f2c1ce…` matched at each step) |
| Catalog fingerprint | `534c5e93300ef25b5fa8496fb472d48f`, 670 parts — identical to the local M9 database built from the same files (`sql-tests/nsi_i2_catalog_fingerprint_local.sql`) |
| `appointments` fingerprint | `e0c4db1b4d1b027df0e6e1593d0f14ce` — unchanged at every step; no trigger, FK or index added |
| DEV-safe suite | 97/97 after each of M7, M8, M9 |
| Gate A (collection gate) | **CLOSED** (`retention_gate_open() = false`); neither grant overrides it |
| Data on DEV | 0 audit events, requests, responses, completions, templates, settings, lesson-type selections and feature grants; 0 intake rows in `outbound_deliveries`; no synthetic auth users created |
| Access | every studio is OFF: no grant has been issued; only a platform admin (`profiles.platform_role`) can issue or revoke grants (RPC only) |
| Rollback | app first, then M9 → M8 → M7 (exact-fingerprint rollbacks; refused once a grant, an archive/restore audit event, or a default-template selection exists) |
| Local work state | everything in worktree `C:Devstudioapp-nsi-i2` (branch `nsi-i2-eligibility`, off main `81e023bc`) is **uncommitted and unpushed**; I1 spec/plan/migrations are copied-in untracked files (originals untracked in `studioapp-intake-audit`) |

### Open blockers (nothing below is fixed; all deferred while launch-critical work has priority)
1. **P1 release blocker — `intake_ensure_request` alignment:** the write path still lacks the first-appointment rule, the `enabled_at` watermark and the settle delay (asserted open as `P1-BLOCKER-1..3` in the M8 suite). Required before Gate A may open.
2. **P1-2 — simulation / preview performance:** the partner-or-client history query scans the studio's appointments per row (≈18.6 s per 200 rows at 20k appointments; `authenticated` timeout is 8 s). Blocks pilot/UI use of the simulation; not a DB-safety issue.
3. **P2-3** renewing a lapsed live grant back-fills bookings made during the lapse (product decision). **P2-4** `intake_designate_guardian` is not entitlement-gated before Gate A. **P2-6** remaining coverage gaps. **P3** items listed in section 1b.
4. **UI/application compatibility (section 3 items a–h) is NOT done:** the Student Intake settings UI still treats `intake_set_service_assignment(type, NULL)` as "use the default form" (now: deselect), gates on an env allowlist instead of `intake_feature_status`, cannot represent "selected, use default", and has no archive or simulation action. **Do not enable the UI for any studio** until updated.
5. Delivery dependencies are unchanged: no intake email may be queued or sent while Marketing M-0 release dependencies are open (spec section 22.6); T1–T4 gates and Gate A retention approvals remain (implementation plan section 11).

## 1. Files and hashes (SHA-256)

| File | SHA-256 |
|---|---|
| `20261118096000_nsi_i2_m7_pilot_grants.sql` | `41b3b5efe9c7f15fbec383f26b2dd0f0fa9a06a314f60c1edf3d4889e0d9df83` |
| `20261118097000_nsi_i2_m8_lesson_types_simulation.sql` | `7d297f5a02aab897adf1a5c2f1601464e9defaebd7e08d0b575283496ef64a97` |
| `20261118098000_nsi_i2_m9_template_archiving.sql` | `367be6bf305f6c487ece302023aa49497865dbd1d8f48e958044f8bc7a1fcfb4` |
| `rollback/…096000_…_rollback.sql` (M7) | `8930b37e96a43827ea0e98e1628fbe38e317b37b87f3773af8b5064c4f2315f1` |
| `rollback/…097000_…_rollback.sql` (M8) | `9628ea2af30f9c5c01943936aa7eb7801d3f0031298f5057adb9f742383b5108` |
| `rollback/…098000_…_rollback.sql` (M9) | `7d5a5e4870a830764e9306fdaa549faae7465e2fa846e79e78044290c7bc26bc` |

(M7 rollback `8930b37e…` and M9 rollback `7d5a5e48…` are unchanged by the review round; the M8 rollback gained a guard.)

## 1b. Independent review round (Opus, 2026-10-15) — status

Verdict was CONDITIONAL GO (no P0). Fixed in this revision: **P1-1** the 90-day window is now absolute (`interval '2160 hours'`, expiry `now() + 24*days hours`), with test G17 (grants under New York / Auckland / Los Angeles sessions, revoked and superseded from other sessions; a mutation that restores the calendar-day rule fails G17); **P2-5** the eight vacuous checks (G08a, G15b, G16, T04, T05b, S02, P04, R12) now capture the call first or assert something real; **P2-1** the template row is read `FOR SHARE` when checked active in `intake_update_settings`, `write_service_type` and `intake_ensure_request` (harness `concurrency/nsi_i2_archive_race_local.sh`: K4a–d archive vs default/selection races, K4e concurrent grants; a mutation removing FOR SHARE makes K4 fail, the shipped code passes); **P2-2** the M8 rollback is also refused while any studio with a default template has fewer than three selected lesson types; publish uses `is distinct from`.

**Still open (tracked, not fixed here):** P1-2 simulation/preview performance on large studios (needs a single-pass history scan; release/pilot blocker, not a DEV-apply blocker); P2-3 renewing a lapsed live grant back-fills bookings made during the lapse (product decision, align with the `ensure_request` work); P2-4 `intake_designate_guardian` is not entitlement-gated before Gate A; P2-6 remaining coverage gaps (simulation performance, retention-choice/floor without a grant, pending-request issuance after a lapse); P3 items (reintake-floor RPC can still edit archived templates; retention-choice RPC has no grant check while unreachable; `now()` is transaction time; tripwire is a plain substring).

## 2. What each migration does

**M7 — pilot grants (decision 1, D1, D2, D5).** New table `intake_feature_grants` (capabilities `config_preview`, `live_collection`; mandatory reason; expiry within 90 days; revoke-only, never edited or deleted; no API privilege; RLS on). Platform-admin-only RPCs `intake_grant_feature` / `intake_revoke_feature`; owner/admin RPC `intake_feature_status` (booleans and expiry only). `assert_staff`: capability `configure` now needs an active `config_preview` grant; new capability `disable` (turn OFF, no grant); new platform-admin-only `feature_grant`. `new_obligation_allowed` (Gate B) now also needs an active `live_collection` grant (closes spec 16.5 / N2: a service-role caller that skips app checks is refused by the database). `intake_update_settings`: ON needs `live_collection`; OFF needs `disable` only; a default template must be an active template of the studio. Audit CHECK widened by `feature_granted`, `feature_revoked`.

**M8 — lesson types, evaluator, simulation (decision 2, D3, D4).** `intake_service_assignments.template_id` becomes nullable: **a row means "this type requires intake"; a NULL template means "use the default"; no row means not selected.** One reader (`service_type_template`) and one writer (`write_service_type`); `intake_set_service_type` is the full-semantics RPC; the legacy `intake_set_service_assignment` keeps its signature (template = select with it, NULL = deselect). The evaluator (now 5 arguments, M6's 4-argument form dropped) adds `type_not_selected`, `studio_not_entitled`, history over all three supported lesson types regardless of selection (primary and partner participation; cancelled never counts) and a simulation mode. `intake_simulate_eligibility` (owner/admin + `config_preview`) is `STABLE`, looks back 1–30 days (default 14), never reads or writes `enabled_at`, and labels every row `simulated = true`. `intake_ensure_request`: **qualification block only** replaced.

**M9 — archiving (decision 3, D6).** `intake_archive_template` / `intake_restore_template`; trigger `intake_templates_30_archive_guard` refuses archiving the default, a template used by a selected type, or a template with an unissued (unpinned) open request. Archived templates cannot be edited, published, made default or selected. Versions, responses, completions and pinned references are never touched; issued requests finish on their pinned version.

## 3. Ordering, compatibility and rollback

* Apply strictly **M7 → M8 → M9**; roll back **M9 → M8 → M7** (the catalog self-check refuses any other order). Each migration replaces `intake_private.assert_catalog()` with a verbatim copy of the previous one plus its own exact inventory, and ends by calling it.
* Rollbacks restore the previous level's bodies byte-for-byte (fingerprint-verified) and are **refused** when they would destroy history: M7 once any grant or grant audit event exists; M8 while any selection has a NULL template; M9 once an archive/restore audit event exists. Audit rows are append-only, so these rollbacks become forward-fix-only after first use.
* **Replay hazard, closed:** replaying M1, M5, M6, M7 or M8 on a newer database fails closed and changes nothing (older catalog, or a *version tripwire*: functions replaced by M7–M9 carry an `-- nsi-body:mN` marker that `assert_catalog` requires, so replaying M5 can no longer silently restore the pre-grant `intake_update_settings`, the pre-selection `intake_ensure_request`, etc.). M2–M4 and M9 replay idempotently.
* **Application compatibility (must ship with or before M8; review P2-7 additions marked +):** (a) `RECONCILE_OUTCOMES` knows `type_not_selected` and `studio_not_entitled` (done); (b) **the Student Intake settings UI must stop using `intake_set_service_assignment(type, NULL)` as "use the default form"** — under M8 that deselects the type; it must call `intake_set_service_type`. (c) The UI's environment allowlist is not a database control: writes now also need a `config_preview` grant, so UI and grants must be rolled out together. + (d) the read model (`AssignmentRow.template_id`, `studioConfig.ts`) cannot represent "selected, use default" and must distinguish a NULL-template row from no row; + (e) UI copy ("all three use intake once it is on", the "Use the default form" option) and `canTurnOn`/`nextAction` must account for lesson-type selection; + (f) turning intake ON needs BOTH `config_preview` (it goes through `configure`) and `live_collection`; + (g) the app guard must not require the allowlist to turn intake OFF or to read configuration after a lapse (the database allows both); + (h) before a live grant the service-role preview returns `studio_not_entitled` for every row, so pre-activation views must use `intake_simulate_eligibility`. The simulation RPC can replace the service-role preview in the UI for pre-activation use.
* DEV precondition (as for M6): the deployed `assert_catalog` body md5 must equal the previous level's copy (M6 copy for M7), and `assert_catalog()` must pass before each apply.
* Local-only version compatibility: PostgreSQL 17.6 (same as DEV/PROD).

## 4. Deviations from the approved plan and interpretations to confirm

1. D3 "cancelled or unconfirmed bookings do not establish participation": the `appointment_status` enum has `scheduled, rescheduled, confirmed, attended, no_show, cancelled`; there is no pending/preview/failed value, so such bookings cannot be read. **Interpretation:** only `cancelled` is excluded; `scheduled` is a committed booking (spec 1.2: `confirmed` is a late acknowledgement). `no_show` still counts as prior participation (unchanged from M6). Confirm or tighten.
2. The legacy RPC's NULL meaning changed (see compatibility) — required by "no alternate qualification path".
3. `intake_update_settings` also enforces "default template must be active/same studio" (the reverse check of D6).
4. A TypeScript outcome-list addition was made so the preview adapter accepts the new outcomes; no other application behaviour changed.

## 5. P1 release blocker — unchanged and explicit

`intake_ensure_request` is **not** aligned with the evaluator. M8 only fixed *type selection*. The following are still **not** enforced by the write path and are asserted as open in the M8 suite (`P1-BLOCKER-1..3`; each flips to a failure when fixed so the alignment cannot be forgotten):
1. first-appointment rule (an existing student still gets a request),
2. `enabled_at` watermark (a pre-enablement booking is still back-filled),
3. 10-minute settle delay.
The erasure barrier **is** enforced for every writer by the table-level collection gate (test `P1-NOTE`), but is not an evaluator outcome in the write path. Aligning `ensure_request` to call the evaluator under the client lock remains required before Gate A may open.

## 6. Tests

`test_T_nsi_i2_m7_grants_local.sql` (34), `…_m8_types_simulation_local.sql` (43), `…_m9_archiving_local.sql` (17), updated `test_T_nsi_i2_local.sql` (92), `test_T_nsi_i1_foundation.sql` (97, DEV-safe), `test_T_nsi_i1_local.sql` (303); `nsi_i2_m7_m9_lifecycle_local.sh` (forward one by one with boundary suites, exact-fingerprint rollbacks, replays, refused-rollback guards); `concurrency/nsi_i2_concurrency_local.sh` (K1–K3). Live "permission denied" probes under a switched role crash the local 17.6 image, so privilege negatives use the catalog (`has_function_privilege`) and function-body 42501 refusals.
