# NSI resume status (milestone N0), 2026-11-23

Base: `origin/main` ec0be82aa. Branch `nsi/n0-preserve`, draft PR 808. Dark, Git-only. Nothing here was applied to PROD; no flag, env, Gate A or intake email was touched.

## 1. What exists and how verified

| Area | State | Evidence |
|---|---|---|
| Migrations M1-M9 (`20261118090000`..`20261118098000`) + rollbacks | **Applied to shared DEV** (M1-M5 2026-10-14, M6-M9 later); in Git only as of PR 808 | Files byte-identical to DEV-applied SHA-256 prefixes: M1 2b1f924d, M2 3712c5ca, M3 43fcd0a7, M4 795e0fb3, M5 50bc7a4f, M6 62e2f4de, M7 41b3b5ef, M8 7d297f5a, M9 367be6bf (re-checked 2026-11-23 on the copy in this branch) |
| SQL suites + concurrency harnesses (`sql-tests/`) | Local-only validation (disposable Postgres 17 image); DEV-safe subset ran on DEV | Counts in `NSI_I2_M7_M9_Notes.md` (I1 foundation 97/303, I2 92, M7 34, M8 43, M9 17). **Not re-run on current main in N0.** |
| `src/lib/intake`, `settings/student-intake` UI, settings link | Code on branch; behind an explicit per-studio allowlist in `access.ts`; link hidden unless allowlisted | Unit tests exist; **typecheck/tests against current main not yet run in N0** (see section 6) |
| Rehearsal evidence (`rehearsal/`) | In Git, scanned for credentials (none: only env-variable names and local container defaults) | |

DEV drift check, read-only via `sb.sh dev-read`, 2026-11-23 11:37Z:
- NSI catalog fingerprint `534c5e93300ef25b5fa8496fb472d48f`, 670 parts: **matches**.
- `appointments` structural fingerprint `e0c4db1b4d1b027df0e6e1593d0f14ce`: **matches** (also identical on PROD).
- `intake_private.retention_gate_open()` = **false** (Gate A closed). Total rows across all `intake_*` tables = **0**. 19 intake tables (I1 18 + M7 grants).
- PROD (`prod-read`): 0 `intake_*` relations, no `intake_private` schema. Untouched, as expected.

## 2. Migration ordering finding (Task 2)

- **Neither hosted DB uses a migration registry for these files.** DEV's `supabase_migrations.schema_migrations` holds exactly one row (`20261014090519`) and no NSI rows; PROD has no `supabase_migrations` schema at all. Everything is applied by file through `sb.sh` with an explicit SHA-256. So there is no version-row mismatch to repair on either database, and nothing to "register".
- Main's migration folder has 477 SQL files; the latest is `20270222094000`. NSI files carry `20261118...` stamps, about 3 months behind the tip. They sort in the middle of the Nov-2026 files. A fresh replay in filename order therefore runs M1-M9 before the Dec 2026 to Feb 2027 files.
- That is only a problem if a later-stamped file alters an object NSI depends on. NSI touches `appointments` (read), clients, studios, studio roles and billing-free tables. Grep of post-2026-10-14 files shows only the GC-series group-class files (`20261016`..`20261026`) touch appointments, and they sort **before** NSI. The `appointments` structural fingerprint is the same on DEV and PROD (both include those), so NSI's assumptions hold.
- **Recommendation:** keep the `20261118...` names. Do not renumber (DEV-applied hashes and rollback exact-fingerprint checks are tied to these names and bytes). For PROD apply, use the same file-plus-SHA path, in order M1..M9 (and later NSI files above `20261118098000`), after a full-chain disposable replay of main's folder with NSI included, which has **not** been run yet. New NSI files continue the series (`20261118099000`+). Risk to log: if a future tool applies by version number (`supabase db push`), the sparse registry would try to apply everything below the max; that path is not used for these databases today.

## 3. Blocker refresh against current main (Task 4)

| Item | Status on main today | Release blocker? |
|---|---|---|
| `intake_ensure_request` alignment (first-appointment rule, `enabled_at` watermark, 10-minute settle delay) | **Still open.** M8 body (`nsi-body:m8`) does not call `evaluate_appointment_eligibility`. Slice 6 below fixes it locally (migration M10, not applied) | **Yes, before Gate A** |
| P1-2 simulation/preview performance on large studios | Open (needs single-pass history scan) | Yes for pilot, not for DEV |
| P2-3 lapsed grant renewal back-fills bookings made during the lapse | Open, product decision | Decision needed before pilot |
| P2-4 `intake_designate_guardian` not entitlement-gated before Gate A | Open | Before Gate A |
| I2-A UI uses `intake_set_service_assignment` | **Still open**: `settings/student-intake/actions.ts:68` calls the old RPC; the M8 `intake_set_service_type` (enable flag + template) is unused by the UI | Yes for config UI correctness |
| Pricing / billing entitlement | **Not applicable (owner correction 2026-11-23)**: Student Intake is not separately priced. Audited: no `student_intake` BillingFeature, plan entry, billing key, `requiredStudioPlanForFeature` use or Stripe product exists in code or SQL; nothing can block authorized access on billing grounds. M7 pilot grants (DB) are a rollout control only; the UI uses an env allowlist until it reads the grants | No |
| T1 timezone consistency | No dedicated T1 work found on main (timezone fixes exist for other surfaces; staff API exposes `timeZone`). Treat as open | Blocks reminders/invites (I4), not config UI |
| T2 dispatcher reliability | **Merged** (#220): `dispatch.ts` skips every `intake_*` key until an intake renderer exists | Closed |
| T3 branded intake templates/renderers/previews | **Not started** (no intake renderer on main) | Blocks any intake email |
| T4 shared outbox SQL (claim-by-ID etc.) | **Not started; must wait** for M-0 close-out + rollback-window expiry | Blocks queued intake email |
| M-0 close-out | **Open**: PROD S3 and frozen; closeout runbook (#758/#763) prepared 2026-11-21; unfreeze gated on webhook decision, sender-domain check and owner go; #762 stage-2 precondition defect needs a live-line release | **Yes: no intake email anywhere until closed** |
| I3 Part A (A1-A11) | All open (invitations, sessions, guardian verification, minor service path, decline, version pinning, role auth, N1, shared outbox A10, dependencies A11) | Part A blocks I3 code/SQL authorization |
| I3 Part B (B1-B8) | All open (B1 platform retention policy approval; B2 minor-default removal; B3 N4 repeated erasure; B4 test tightening; B5 DB entitlement for Gate B; B6 A3/A5 live; B7 PROD prerequisites; B8 owner/legal retention decisions) | Block opening Gate A |

## 4. Remaining work by capability

| Capability | Done | Remaining |
|---|---|---|
| Studio config UI | Template builder, service assignment, preview (I2) | Switch UI to `intake_set_service_type`; entitlement decision; typecheck/test on main; staff-visible readiness |
| First-appointment eligibility | Evaluator + preview + simulation (M6/M8) | `ensure_request` through evaluator (M10, in progress); perf P1-2; reconciler job (I4) |
| Student/guardian completion | Write RPCs for drafts/submit/answers (I1) | Account-free sessions, guardian verification, minor path, decline (I3 Part A) |
| Automated invitations | Nothing | Invitation tables, tokens, outbox integration (A1, A10); T3, T4; M-0 close-out |
| Reminders | Nothing | T1; SMS waits for TW-4; I4 |
| Staff review | Status/answers read RPCs | Review UI, delivery visibility, role rules (A8) |

## 5. Dependency table: genuine release blockers vs not

| Dependency | Blocks | Genuine blocker? |
|---|---|---|
| M-0 close-out + rollback-window expiry | Any queued/sent intake email, T4 | **Yes** (spec 22.6) |
| ensure_request alignment | Gate A | **Yes** |
| I3 Part B (B1-B8) | Gate A / collection | **Yes** |
| Owner/legal retention and minors decisions (B8, B1) | Gate A | **Yes** (owner) |
| T3 renderers, T4 SQL, `INTAKE_ROOT_SECRET` | Invitations (I4) | Yes for email, no for I3 DB work |
| T1 timezone | Reminders | Yes for reminders only |
| TW-4 | SMS reminders | Yes for SMS only |
| Pricing / BillingFeature | Nothing (no separate pricing exists) | **No** |
| P2-3 product decision | Pilot grant renewals | Decision, not code |
| UI switch to `intake_set_service_type` | Config UI correctness | Not for DB gates |
| Migration ordering/renumbering | Nothing | **No** (see section 2) |
| Typecheck/tests on main | PR merge | Required by CI, not a design blocker |

## 6. Not yet done in N0 (stated plainly)

- `src/lib/intake` and the settings UI have not been typechecked or unit-tested against current main (no `node_modules` in this worktree; CI on PR 808 will report).
- Full-chain disposable replay of main's migration folder including NSI not run.
- Slice 6 (M10): see `NSI_I2_M10_Notes.md` once written; **not applied to DEV**; independent review required first.

## 7. Update 2026-11-23 (later): M10 on DEV, M11 in progress, owner decision for Gate A

- **M10 applied to shared DEV** (file sha256 `9fdd4a63b629…`, fingerprint `c6b3d46b…|670`, DEV-safe suite 97/97, Gate A closed, 0 rows): `rehearsal/d6_dev_m10/D6_report_2026-11-23.md`. The P1 blocker "ensure_request does not call the evaluator" is **closed on DEV**; it remains a PROD item only because PROD has no NSI objects yet.
- **M11:** P2-2 detached link reported as `detached_from_request` (write attempt gone; preview omits linked appointments), P2-3 anchor recomputed to the earliest live attached appointment, P2-5 corrected READ COMMITTED comment, explicit M10/M9 precondition. Validation evidence is added under `rehearsal/` once the lifecycle run is recorded; it needs a review pass before any DEV apply.
- **No separate pricing** (owner correction): nothing in this document treats pricing or a billing entitlement as a blocker.

### Owner decision needed before Gate A (P2-1): who counts as an "existing student"?

Today the evaluator treats a client as an existing student, and so never asks for intake automatically, when they have **any earlier appointment** in the studio (as client or as partner) of type private, intro or coaching with status scheduled, rescheduled, confirmed, attended or no_show, **regardless** of: (a) whether that appointment was imported from another system, (b) whether its lesson type is ticked for intake, (c) whether the earlier appointments used a different intake form (template). The effect: a person who is genuinely new to this studio's intake can be silently skipped, for example someone whose only earlier lesson was an imported record, a lesson type the studio does not use for intake, or a lesson where they were only the partner. Staff can still request intake manually, but nobody is told the student was skipped.

| Option | Behaviour | Cost |
|---|---|---|
| A (recommended for V1) | Keep the conservative rule (any prior qualifying lesson means existing student). Add a staff-visible "existing student, not asked" list with a one-click manual request, so nobody is silently stranded. | Small: a read RPC and UI. No rule change, no migration to the evaluator. |
| B | Count only history that would itself have asked for intake (selected types and the same form); treat imported history as not counting. | Larger: evaluator change, simulation and preview change, more edge cases (a lesson type deselected later changes who counts). Risk of asking real existing students for forms. |
| C | Count only appointments created on or after the studio's `enabled_at`. | Simple, but then every studio's whole existing roster is treated as new the first time they book after enablement. Unacceptable. |

Recommendation: A for V1, revisit B after the pilot data (the simulation RPC already shows who would be skipped). This does not block Gate A work, but the decision (and the staff list if A) must exist before collection opens.

## 8. Consolidated owner decision package (concise; recommendations are engineering's)

None of these blocks the work in flight (DEV-safe SQL, local design). Each is needed before the stage shown. No pricing decision exists (owner correction): pilot grants, staff role and Gate A are the only access controls.

| # | Decision | Needed before | Recommendation |
|---|---|---|---|
| O1 (P2-1) | Who counts as an "existing student" (any earlier lesson, including imported, partner-only, unselected-type, other-form history, never gets an automatic request) | Gate A | Keep the conservative rule; add a staff "existing student, not asked" list with a one-click manual request (small read RPC and UI) |
| O2 (D1/A8) | Which staff roles may create guardian invitations and choose recipients | I3-2 | Owner, admin, front desk (same set that may attest guardian consent); instructors no |
| O3 (D2) | Account-free link for everyone, or portal-only for people who already have a portal account | I3-4 | Link for everyone; portal sign-in as an optional convenience |
| O4 (D3) | Guardian decline: terminal, or staff may re-invite the same request. **Decline now belongs to I3-2 (M16), not I3-3** | I3-2 | Terminal; staff opens a new request if the family changes its mind |
| O5 (D4) | Minor threshold and the "pending legal review" wording (spec 14.9) | I3-3 and Gate A | Keep 18 as a studio setting, with the pending-legal-review note visible until cleared |
| O6 (D5) | Invitation life and session limits | I3-1 | 14-day link, 30-minute sliding session, 4-hour absolute |
| O7 (D7) | What front desk and instructors may see about intake delivery rows | I4 | Owner/admin/front desk: status only, never content; instructors: none |
| O8 (P2-3 of M7-M9) | A lapsed pilot grant that is renewed: should bookings made during the lapse be back-filled | pilot renewals | No back-fill: bookings made while access was off stay out (matches the `enabled_at` rule) |
| O9 (B1/B8) | Platform retention periods and the legal basis for evidence, audit and minors | Gate A | Owner/legal decision with counsel; engineering supplies the options table (retention.md in the spec 14.9 list); no recommendation on the legal content |
| O10 | Release sequence: unfreeze marketing (M-0 close-out) before any intake email | I4 | Keep the rule: no intake email anywhere until M-0 closes and its rollback window expires; T4 follows |

Engineering tasks that are NOT owner decisions: provisioning `INTAKE_ROOT_SECRET`, confirming the trusted client-IP source on Vercel, Resend tracking-off check, mail-client fragment test (needs authorized test sends before any invitation email).

## 9. Open list carried forward (M11 delta review, 2026-11-23; fold into M12/M13 and the I4 design; the applied M11 file is not edited)

| # | Item | Plan |
|---|---|---|
| C1 | **Stale anchor cannot be refreshed** under the contract "the reconciler and preview skip linked appointments": the anchor is recomputed only on an attach | I4 gets an explicit per-open-request anchor-refresh step (small RPC, called for open requests whose anchor appointment is no longer live). `NSI_I2_M11_Notes.md` and `NSI_I3_PartA_Design.md` corrected |
| C2 | **Partner arm mismatch**: the M11 anchor query accepts `client_id` or `partner_client_id`, while `appointment_snapshot` (the attach validator) is client-only | Align in the next migration: drop the partner arm from the anchor query, or extend the snapshot. Recommendation: drop the partner arm (a partner is not the subject of the request) |
| C3 | **Preview link exclusion is not scoped**: any link on any request hides the appointment (closed-request detached links, other-template links, reassigned appointments) | Scope the exclusion to links of an OPEN request of the same client and template, or record it as an explicit I4 rule, before any detach writer exists (none exists today, so no live effect) |
| C4 | Lifecycle logs were git-ignored (`*.log`) | Renamed to `.txt` and committed; the full-chain replay on the **final** M11 bytes is recorded in `NSI_Full_Chain_Replay_Plan.md` when it completes |
| N1 | `20261118100000_…hardening.sql` line 15 still says "NOT APPLIED to any shared environment"; it is applied to DEV (D7 report) | Header comment only; not edited (hash pinned) |
| N2 | `rehearsal/d6_dev_m10/d6_postflight_state.sql` and `d7_dev_m11/state.sql` report the ensure_request marker as `m10`, `m8` or `other`; `other` means m11 | Reading aid only; the fingerprint is the authority |
| N3 | The rollback file's second and third header lines are garbled ("Refused while a detached link exists would not matter…") | Rollback not applied anywhere; editing it changes only its own hash (`NSI_I2_M11_Notes.md` records the current one). Fix when M12 touches the rollback set, not before |
| N4 | H01c lacked a positive control | Added to `test_T_nsi_i2_m11_ensure_request_local.sql` (an unlinked appointment of the same kind is listed) |
| N5 | Consider an index on `intake_request_appointments (studio_id, appointment_id)` for the preview's link exclusion and the anchor query | Add in M12/M13 with the C3 change; measure with the simulation on a large studio (P1-2) |

## 10. M12 review conditions: P1-A (staff can mint a link whose token they know) and P1-B (rate-limit keys)

Both are **hard blockers for I3-4 / any UI or outbox wiring**. M12 itself stays dark and unapplied until the delta review.

**P1-B (done in TypeScript, M12 unchanged in meaning):** `rateLimitBucket(ring, kind, windowSeconds, value)` is now `HMAC-SHA256(HKDF subkey "intake/ratelimit/v1", kind || window || value)`; the signing secret must decode to exactly 32 random bytes (hex or base64) and a degenerate value is refused. Tests: 22 cases in `invitationToken.test.ts`.

**P1-A.** The app derives the token and passes only its hash. Any caller who can run the app code (or any staff member with the service path in a future UI) knows the token it just minted, so a minted link can be used to submit "as the student". Two options:

| | Option 2: record the minting actor (implemented in M12) | Option 1: two-party issue |
|---|---|---|
| How | The invitation stores `issued_by_user`; every session copies it (`issued_by_user`, immutable); the `invitation_issued` audit event names the staff member; the `link_exchanged` event refers to the session, so every use is attributable | Staff calls an authenticated "request invitation" RPC (no hash); a separate service-role "finalize" RPC, run only by the app server, supplies the token hash. Staff never hold the service key, so they cannot choose or learn a token the student did not receive |
| Stops | Nothing (attributable, not prevented) | Staff self-minting, and a stolen service key alone |
| Cost | Done | Two RPCs, a pending-invitation state, expiry of unfinalized requests, a second catalog level and a new test matrix; the app server becomes a required hop |
| Residual | A staff member can still submit as the student, but cannot do so unnoticed or without being named in the evidence | A compromised app server plus any staff request can still mint |

**Recommendation:** keep option 2 now, and add one rule before I3-4: **a submission made through a staff-minted link is stored with a `staff_minted` marker and never counts as student-authored evidence** (it can be staff-assisted data entry, which is a legitimate use). Use option 1 only for the guardian-consent path in I3-2, where the stakes are higher (minor consent). This keeps the student path simple and puts the stronger control where a forged consent would matter.

M12 also carries these review fixes in place (still unapplied): lock order client lock then invitation row for exchange, issue, revoke, bulk revoke and erase; expected-generation parameter on issue plus a staff `intake_next_invitation_generation` read; issue refuses a request with no live appointment before revoking anything; an unknown token writes no rate-limit row; the live-session cap is serialized by the invitation row lock; sessions record the minting actor. Not done (listed, not hidden): `p_reason` on revoke, an enum widening of revoke reasons.

## 11. Open list after the M12 delta reviews (carry-forward; M12 is NOT amended again)

M12 passed two independent reviews (delta review of round 2: GO, no P0/P1). The items below are scheduled as **M13, a purge-hardening migration that must land before any purge cron or I4 wiring** (the purge is unreachable on DEV: no cron, no data).

| # | Item | Plan (M13) |
|---|---|---|
| H1 | Number of try-locks per purge call is unbounded (every candidate row evaluated takes an advisory transaction lock) | Pick a bounded set of candidate ids first, try-lock in a second step, cap distinct clients per call well below `max_locks_per_transaction` |
| H2 | The hold check and the locks are evaluated in one statement (one snapshot) | Take locks in one statement and check holds and delete in a later statement (fresh snapshot) |
| H3 | Missing tests | Purge skips a held client (two sessions: one holds the client lock, the purge must skip and report it); mutation probes for `try_lock_client` in the purge, for lock removal in bulk revoke, a separate probe for issue vs revoke lock removal; negative test for the session minting-actor guard |
| H4 | `session_revoked` actor type consistency | Use the same system actor type as `link_exchanged` |
| H5 | Operations | Run the purge one call at a time; the cron ships with I4 |

**Still gating I3-4 / any UI, outbox or email wiring:** P1-A (a link session is never student-authenticated evidence; assurance stays `declared_unverified`; I3-4 save and submit carry session and invitation provenance; the guardian path needs the L2 email code on top of the link) and the P1-B-adjacent items (TS rate-limit keys are HMAC, signing secret is 32 random bytes; `INTAKE_ROOT_SECRET` is not provisioned anywhere). Next design-only work: I3-2 (guardian email challenge, attestation, role matrix) and I3-3 (minor determination service path, guardian decline). The I1-local fixture port follows.

**Update (M13 written):** items H1-H5 are implemented in M13 (`NSI_I3_1_M13_Notes.md`), validated locally, pending an independent delta review, a full-chain replay on the M13 bytes and the DEV apply. Nothing about P1-A/P1-B or the M-0 gate changed.

## 12. M13 delta review (conditional GO, no P0/P1): blockers recorded, M13 is not amended again

**P2-A..D are BLOCKERS for any purge cron, I4 wiring and Gate A** (specification: `NSI_M14_Hold_Semantics_Spec.md`; migration M14 "hold-semantics + purge liveness"):

| # | Finding | Fix (M14) |
|---|---|---|
| P2-A | The hold check compares `effective_at` (hold transaction start) with `now()` (checking transaction start): a hold committed after an erase or purge transaction began can be missed. **Same root cause in `intake_erase_client` / `erase_client_impl` (pre-existing, more serious: a held client's whole record could be erased)** | Destructive paths ignore `effective_at`; a committed, unreleased hold protects immediately |
| P2-B | The destructive paths assume READ COMMITTED | Refuse (55000) unless READ COMMITTED in purge and erase |
| P2-C | Held clients can starve the purge's 50-client window | Pre-filter holds in the candidate statement, order by oldest expiry |
| P2-D | Tests are not discriminating enough | Two-session hold-commit test, erase-regression test, C7 asserts success and `clients_locked < clients_candidate`, P04 probe with a different non-null actor, three more probes |

Nits: `client_ref` on `session_revoked`; dead m13 precondition branch (comment only); harness summary label. **None of this is on PROD** (PROD has no NSI objects) and shared DEV has Gate A closed and no data, so there is no live exposure.

**Renumbering:** M14 = hold semantics and purge liveness (safety item, before any I3-3 implementation); the minor-determination migration is now **M15**; I3-2 becomes M16. Sequence: M13 DEV apply (after the clean replay on its bytes) -> M14 spec, implementation, review -> I3-3/M15 -> I3-2/M16 -> I1-local fixture port.

## 13. I3-3 specification revision 2 (review conditional GO; owner decisions added)

`NSI_I3_3_DB_Spec.md` revision 2 addresses P1-1..P1-6 and the P2s (studio-local date with the UTC-12 fallback, the birthday rule applied first inside the database, declaration provenance, monotone automatic determinations, an explicit reference date and open-request rule, lock order for the session functions, no daily row growth, threshold clamp, neutral declaration classes, explicit privilege statements). New or changed owner decisions, all **pending** with draft defaults: **O5** (threshold, 29 February rule, wording), **O5b** (may a studio set a threshold below 18; draft: clamp to 18), **O11** (a declared adult requires staff confirmation; draft: yes), **O12** (an extra `under_13` declaration class; draft: yes, routing only). The migration is **M15**; M14 (hold semantics and purge liveness) comes first. No SQL is written for M15 until the revision 2 spec is reviewed.

## 14. Non-heavy follow-up docs (2026-11-23, text only, for independent review)
- `NSI_I3_3_DB_Spec.md` **revision 3**: reconciled with the final M14 bytes (section 9: isolation guard, no hold check in determinations, erase interaction, audit `client_ref`, catalog 104 -> 110, rollback to the M14 catalog); queued for the quick re-review.
- `NSI_I3_2_DB_Spec.md` (M16, draft rev 1): guardian challenge, attestation, two-party guardian issue, decline, respondent guard, N1 vocabulary.
- `NSI_P1A_Staff_Minted_Links.md`: P1-A resolved as engineering rules (option B for the student path, option C for guardians); only **O11** and **O5b** remain open on the minor/evidence path; all labelled recommended, pending owner decision.
- `NSI_I1_Local_Fixture_Port_Plan.md`: the 14 call sites and the recipe; the port itself needs the heavy lock and is not done.
M14 is not applied to DEV; waiting for the delta-review GO relayed by the coordinator.

## 15. M14 APPLIED TO DEV (2026-11-23)
M14 (sha256 ae6bbf0b…ef2d2) applied to shared DEV via sb.sh; DEV catalog fingerprint now **be5a715adedad4197649593d23c6ce09|770** (was 97e13781e9f0498d8e452c64d6d43e18|768), assert_catalog ok, Gate A closed, 0 rows, DEV-safe suites PASS. Report: rehearsal/d10_dev_m14/D10_report_2026-11-23.md. Delta review GO (two low items accepted as documented, bytes unchanged). PROD untouched. Next: M15 (I3-3) after the rev 3 spec re-review; then M16.

## 16. M15 APPLIED TO DEV (2026-11-24)
M15 (sha256 0b700fb2ccb3…cdfe) applied to shared DEV via sb.sh; DEV catalog fingerprint now **3fc0eea416e8f820856935a2b94d078a|776** (was be5a715a…|770), assert_catalog ok, Gate A closed, 0 rows, DEV-safe suites PASS (I1 109, level-10 9, level-11 5). Independent review: CONDITIONAL GO, condition (DEV columns exist) met and added as L05. Report: rehearsal/d11_dev_m15/D11_report_2026-11-24.md. Follow-ups M15.1 (P2-2, P2-3, P2-4 tests) before Gate A. PROD untouched. Next: M16 (I3-2) spec review, then implementation; P1-A rule 4 still a draft.
