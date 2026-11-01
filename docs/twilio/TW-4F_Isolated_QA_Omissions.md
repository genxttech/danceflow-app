# TW-4F isolated QA: replay omissions and what they mean (2026-10-21)

The isolated baseline is the production schema dump of 2026-07-15 plus the repo's migrations replayed in version order through 20261205. **It is not production-equivalent.** 24 of the 240 replayed migrations cannot run in a throwaway database and are skipped (`scripts/qa/known-unreplayable.txt`); the baseline build fails on any OTHER failing migration, in particular on any TW-4F one. This document classifies every omission and states, with evidence, whether it can affect a TW-4F conclusion (authorization, financial controls, tenant isolation, sender provisioning). Regenerate the evidence with `node scripts/qa/audit-omissions.mjs --baseline <container> --reference <container>`; it exits non-zero ("fail closed") if a skipped migration creates or replaces an object that TW-4F SQL references, or if any TW-4F function body has a dangling reference in the baseline.

Scope note (2026-10-23): the baseline replays only through 20261205090000 and is unchanged by the TW-4F chain 20261206..20261227, which the scenarios apply on top of it. The 22 omissions and their classification below are therefore unchanged; re-run `audit-omissions.mjs` (with `--scan <ref>:<version>` for each newer TW-4F migration) before relying on the "no dependency" conclusion for migrations added after 20261217.

## 1. Why they fail (three causes)

| Cause | Migrations | Dependency / assumption |
|---|---|---|
| **A. Supabase storage-api tables absent** | 20260721234500, 20261005090000, 20261006090000 | `storage.buckets` is created by the storage-api service, not by the Postgres image. |
| **B. Production-state preflights** | 20260918030000 (landmark 5A: named target rows), 20261007090000 and 20261007093000 (LAUNCH-SEC-1C-0 / 1C-0-R: reviewed definition of `user_has_client_portal_access`), 20261011090000 (LAUNCH-SEC-2B: reviewed appointments policies), 20261027090000 / 20261028090000 (REFUND-RECON: reviewed bodies), 20261102090000 / 20261103090000 / 20261104090000 (Phase 9A-C: reviewed payroll definitions), 20261110090000 (10C.4) | The migration asserts that the database holds the exact production definitions (md5 of function bodies, specific rows) and aborts otherwise. A schema replayed from July cannot satisfy them. |
| **C. Cascades from A or B** | 20261008090000 (needs `auth.users.deleted_at`, a GoTrue column), 20261009090000, 20261026090000, 20261109090000, 20261111090000, 20261112090000, 20261113090000, 20261114090000, 20261115090000 | They need objects the failed migrations in A/B would have created (`my_verified_email`, `verified_email_for_user`, the competition and payroll families) or a GoTrue column. |

Per migration, the exact error and the objects it creates:

| Migration | Why it cannot replay | Objects it creates / replaces | Referenced by TW-4F SQL |
|---|---|---|---|
| 20260721234500_create_commerce_cover_images.sql | relation "storage.buckets" does not exist |  | none |
| 20260918030000_landmark1a_slice5a_capability_activation_bridge.sql | Slice 5A guard failed: 5 of 5 named target rows no longer match expected state (studio_id/user_id/active=true/ |  | none |
| 20261005090000_launchsec1b_client_photos_private_storage.sql | relation "storage.buckets" does not exist |  | none |
| 20261006090000_launchsec1b2_public_asset_storage_authorization.sql | relation "storage.buckets" does not exist |  | none |
| 20261007090000_launchsec1c0_emergency_auth_closure.sql | LAUNCH-SEC-1C-0: user_has_client_portal_access is not the reviewed definition |  | none |
| 20261007093000_launchsec1c0r_prod_compatible_auth_closure.sql | LAUNCH-SEC-1C-0-R: user_has_client_portal_access is not the reviewed definition |  | none |
| 20261008090000_launchsec1ca_verified_email_proof.sql | column u.deleted_at does not exist | verified_email_identities, auth_email_change_markers, track_auth_email_change, _launchsec1ca_live_session_id, _launchsec1ca_mailbox_auth_at, _launchsec1ca_current_email, ... | none |
| 20261009090000_launchsec1cb_verified_email_enforcement.sql | LAUNCH-SEC-1C-B: LAUNCH-SEC-1C-A objects are missing | verified_email_for_user, claim_client_account_invitation, accept_pending_team_invitations | none |
| 20261011090000_launchsec2b_tenant_write_surface.sql | LAUNCH-SEC-2B: appointments policies/triggers/columns are not the reviewed definitions | _guard_appointments_floor_rental_financial_fields | none |
| 20261026090000_gc352_public_class_purchase_holds.sql | function "public.my_verified_email()" does not exist | group_class_enrollment_holds, _gc352_guard_hold_transition, _gc352_refuse_committed_converting, _group_class_roster_reserved_count, enforce_group_class_capacity_floor, start_public_class_purchase, ... | none |
| 20261027090000_refund_reconciliation_integrity.sql | REFUND-RECON-1: required column missing: group_class_enrollment_holds.payment_id, group_class_enrollment_holds | _sync_group_class_purchase_refund, _apply_payment_refund_and_reevaluate | none |
| 20261028090000_refund_reconciliation_timestamp_integrity.sql | REFUND-RECON-2: _apply_payment_refund_and_reevaluate is not the reviewed REFUND-RECON-1 body | _apply_payment_refund_and_reevaluate | none |
| 20261102090000_phase9a_payroll_integrity.sql | Phase 9A preflight: public.current_studio_payroll_role is not the reviewed definition (count 1, md5 1b41fa626f | payroll_actor_role, refresh_payroll_batch_totals, refresh_payroll_pay_period_totals, refresh_payroll_totals_after_earning_change, enforce_instructor_earning_integrity, enforce_payroll_pay_period_integrity, ... | none |
| 20261103090000_phase9b_payroll_approval_evidence.sql | Phase 9B preflight: public.payroll_actor_role is not the reviewed 9A definition (count 0, md5 <NULL>). | payroll_evidence_activation, payroll_batch_approval_snapshots, payroll_batch_approval_snapshot_lines, payroll_batch_payment_evidence, payroll_export_events, prevent_payroll_evidence_change, ... | none |
| 20261104090000_phase9c_compensation_history.sql | Phase 9C preflight: public.payroll_actor_role is not the reviewed definition (count 0, md5 <NULL>). | instructor_compensation_rule_history, prevent_compensation_rule_history_change, save_instructor_compensation_rule | none |
| 20261109090000_phase10c_competitor_registration.sql | function "public.verified_email_for_user(uuid)" does not exist | event_competition_competitors, _comp10c_competitor_guard, _comp10c_resolve_competitor, _comp10c_participant_competitor, validate_competition_entry_registration_links, competition_registration_program_open, ... | none |
| 20261110090000_phase10c4_participant_role_integrity.sql | 10C.4 preflight: Phase 10C registration is not installed. | _comp10c4_participant_shape_errors, _comp10c_allowed_roles, _comp10c_quote, start_competition_registration | none |
| 20261111090000_phase10d_heats_floor_schedule.sql | column p.competitor_id does not exist | event_competition_floor_heats, _comp10d_heat_music_key, _comp10d_floor_heat_problems, _comp10d_scoring_heat_duplicate, competition_floor_schedule_problems, _comp10d_check_floor_heat_integrity, ... | none |
| 20261112090000_phase10d1_heat_entry_eligibility.sql | function "public._comp10d_check_floor_heat_integrity()" does not exist | _comp10d_check_floor_heat_integrity | none |
| 20261113090000_phase10c5_competition_draft.sql | function "public.open_competition_registration(uuid)" does not exist | create_competition_draft, set_competition_category_pricing, open_competition_registration | none |
| 20261114090000_phase10c5_profile_v3.sql | function "public.open_competition_registration(uuid)" does not exist | can_edit_competition_event_operations, protect_competition_event_operations, create_competition_draft, open_competition_registration | none |
| 20261115090000_phase10c5_registration_isolation.sql | function "public.create_competition_draft(uuid,jsonb)" does not exist | competition_registration_account_required, protect_competition_program_registration_settings, competition_registration_program_open, open_competition_registration, start_competition_registration, create_competition_draft | none |

## 2. Impact on TW-4F conclusions

- **No skipped migration touches a TW-4F object.** None of the 22 mentions `studio_sms*`, `tw4`, `twilio` or `sms`. The "Referenced by TW-4F SQL" column above is computed, not asserted: it matches the objects each skipped migration creates against every TW-4F migration text (22 files scanned).
- **No dangling references.** Dangling references from TW-4F function bodies (in the baseline): 0 (every public function and table that a TW-4F function body in the baseline calls exists in the baseline).
- **Security surface of the core tables TW-4F relies on** (policies, triggers, grants, RLS flag of profiles, user_studio_roles, studios, clients, payments, events): 50 entries identical to the reference database; exactly one differs: the trigger `protect_competition_event_operations` on `events` exists only in the reference, created by the skipped Phase 10C.5 competition migration (20261114090000). It is a competition-events guard, unrelated to TW-4F, and is listed so it is not mistaken for a hidden difference. TW-4F authorization reads `profiles.platform_role` and `user_studio_roles` (and `studios` for names) only through SECURITY DEFINER functions, so a TW-4F authorization or tenant-isolation test cannot pass here because of a weaker core-table surface.
- **What is genuinely different** (and therefore NOT validated by this baseline): the payroll, accounting, commerce, competition, verified-email and storage families, and the functions listed as differing by the audit. They are outside TW-4F. A defect in how TW-4F interacts with them (for example a payroll function reading an SMS table) would not be caught; none exists today (see the dangling-reference check), and any future TW-4F dependency on those families must re-run this audit.
- **Equivalent objects restored through the baseline snapshot?** No object created by a skipped migration is restored: the July dump predates them. Where a TW-4F function needs an older object, it exists in the dump (the audit's zero dangling references proves it).
- Catalog comparison against the shared QA database (read-only): functions baseline 630 vs reference 767 (140 only in the reference, 57 of them TW-4F-named: unmerged or later work); 74 bodies differ, 5 of them TW-4F-named (unmerged work in the shared database).
- tables baseline 367 vs reference 386 (20 only in the reference, 9 TW-4F-named).

### Verdict

No skipped migration touches an object referenced by TW-4F SQL, and no TW-4F function body has a dangling reference in the baseline. The baseline is still NOT production-equivalent (see the table above).


## 3. Limits to keep in mind

- The baseline is **local and developer-only**: the July dump is git-ignored (`backups/`), so CI cannot build it. Until a base-schema artifact is available to CI, this harness is a developer/release-gate tool, not a CI job.
- Rows: the baseline is schema only; suites create their own synthetic fixtures. Production-data-dependent behaviour is out of scope.
- The reference database used for the comparison is the shared QA stack, which also contains other sessions' unmerged migrations; the "only in the reference" lists are explained by that and by the baseline stopping at 20261205 (R2a, PR #251, R2b and an unmerged `_tw4fi_location_path` variant).
