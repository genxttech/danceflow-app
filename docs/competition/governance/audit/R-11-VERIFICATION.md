# R-11 verification: result approval and separation-of-duties controls

**Policy ratified (owner, DanceFlow policy, R-11):** result approval needs a **different manager** than the calculator, or an **audited override reason**; **no
override** exists for the minimum-two-couples rule (`COMP_ADVANCEMENT_BELOW_MINIMUM`), the withdrawal window, exclusion co-sign separation of duties, or approval of a stale
result (input hash must match current ballots); a chair cannot override a manager decision and vice versa; client-role direct calls are refused.
**Policy ratified vs implementation verified are kept separate.** Base `origin/release/website-embeds` @ `49dbaee1b`. Evidence labels as in
[R-07-VERIFICATION.md](R-07-VERIFICATION.md). **All SQL claims are INSPECTED; no SQL suite was run** (heavy-lock queue). Executed evidence is the static test
`src/lib/competition/results/__tests__/r11.approval.static.test.ts` (reads migration text; 5 tests pass). No SQL, engine or migration change.

## 1. `approve_competition_round_result` (INSPECTED)

Created in `20270114090000` (F2); patched in place by exact-text md5-pinned replacements: `20270120093000` (A3: `_cf1_require_roster_eligible(..., 'approve')`; per its header the check runs after the certification loop and just before the status write, so after the override audit event, approvals insert and heat certification; the call is atomic; `20270120105000` (OD-17) also carries md5-pinned approve patch lines and was not traced here) and `20270215090000` (PV-1: `_comppv1_verify` after the stale-hash check). Grants: revoked from public and anon, granted to `authenticated`.

| Clause | Enforcement | Override path? | Existing tests (SQL NOT RUN) | Gap |
|---|---|---|---|---|
| Different manager or audited reason | `v_override := calculated_by = auth.uid()`; the calculator needs a reason of 1-500 characters else `COMP_SECOND_APPROVER_REQUIRED`; audit event `result_approval_override`; a non-calculator's reason is discarded; DB check ties a reason to approver = calculator | yes, by design, only for the calculator | `f2_results` L518, L519, L567, L568, L571-575, L542-548; vitest `contract.k0.test.ts` (pure helper) | no test that a different approver's reason is discarded |
| Minimum two couples | `COMP_ROSTER_BELOW_MINIMUM` via `_cf1_require_roster_eligible` at approve; `COMP_ADVANCEMENT_BELOW_MINIMUM` in A6 precheck, `apply_competition_round_advancement` (zero and fewer than 2), and the Final-start trigger | **none** (no override parameter anywhere; every raise unconditional) | `a4_minimum_integration` L468-469, L480-484, L564-565 (loose: accepts STALE or ROSTER_BELOW_MINIMUM), `a6_withdrawal` L390-391, L521, L599, `a4_concurrency.sh` | no test that approve raises the explicit roster code on its own, nor that an override reason cannot bypass it |
| Withdrawal window | `_cf1_a6_precheck`: `COMP_ADVANCEMENT_FINAL_STARTED`, `COMP_WITHDRAWAL_BALLOTS`, `COMP_ADVANCEMENT_FINAL_LOCKED`, `COMP_WITHDRAWAL_NO_APPROVED_RESULT`; re-run under locks at co-sign. Exclusion: `COMP_EXCLUSION_WINDOW` unless the round is active or ballots_locked | **none** | `a6_withdrawal` L398-399, L539, L546, L556; `a5_exclusion` L413-418 (request side) | no test of the exclusion window at co-sign |
| Exclusion/withdrawal co-sign separation | `cosign_round_exclusion`: `COMP_EXCLUSION_COSIGN_SAME_PERSON`, `COMP_EXCLUSION_COSIGNER_FILED_BALLOT`; reversal equivalent; withdrawal `COMP_WITHDRAWAL_COSIGN_SAME_PERSON` and requester must still be a verified manager | **none** (no reason parameter on any co-sign) | `a5_exclusion` L449, L482, L598, L382; `a6_withdrawal` L351, L325 | no test of an unverified-email co-signer |
| Stale result | `COMP_RESULT_STALE` for a non-latest version and for an input-hash mismatch, both **before** the override branch; PV-1 then re-verifies the stored rows | **none** | `f2_results` L608, L711; `a0_tie_policy` L646 | no test supplying an override reason together with a stale hash. **Static ordering is now asserted (executed):** `r11.approval.static.test.ts` |
| Chair vs manager | approve requires exactly role `manager` (`_compe2_round_role` returns manager, then chair, then scorer); exclusion and withdrawal requests manager-only; co-sign and cancel allow manager or chair; nothing lets a chair reverse an approved result or a manager reverse a chair decision | none | chair co-sign positive tests (`a5_exclusion` L485, `a6_withdrawal` L383); chair cannot request (L382, L325) | **no test that a chair calling approve is refused** (no chair user in the f2 suite); none for a chair cancelling a manager's request |
| Client-role direct calls | `authenticated` only; every function returns `COMP_FORBIDDEN` when `auth.uid()` is null; A5/A6/apply also revoke `service_role` | n/a | `f2_results` L534 (anon), L350-358 (anon cannot execute any F2 function), L525-531 (judge, scorer, cross-tenant, no role) | no test that `service_role` is refused on approve |

## 2. Static tests added (executed, no database)

`r11.approval.static.test.ts`: approve is manager-only; the stale checks precede the override branch; the calculator-only override with a 1-500 character reason; no
`COMP_ADVANCEMENT_BELOW_MINIMUM` branch inside approve and no `p_override` parameter in the A5 exclusion RPCs; approve revoked from public and anon. These are
presence/ordering checks on migration text, not behavioral proof.

## 3. Release findings (no behavior changed)

| ID | Finding | File / function |
|---|---|---|
| RF-11.1 | `approve_competition_round_result` revokes only public and anon (`f2:1242`); A5/A6/apply also revoke `service_role`. Not exploitable (`auth.uid()` is null -> `COMP_FORBIDDEN`) but inconsistent; hosted grants not read. | F2 approve |
| RF-11.2 | Approve checks the manager role but not a verified email for the approver; request, co-sign, apply and withdrawal do. If R-11 expects a verified second manager, this is a gap. | F2 approve |
| RF-11.3 | The override reason is only non-blank and at most 500 characters; A5/A6 reasons use the stricter `_cf1_reason_is_substantive`. | F2 approve vs A5/A6 |
| RF-11.4 | Test looseness: the approve-after-exclusion test accepts either `COMP_RESULT_STALE` or `COMP_ROSTER_BELOW_MINIMUM`, so it can pass on STALE alone. | `a4_minimum_integration` L564-565 |
| RF-11.5 | The UI action `results/actions.ts` was only confirmed to call the RPC with `p_override_reason`; no extra UI checks were read. | `results/actions.ts` |

## 4. PENDING

All SQL suites above (f2_results, a4_minimum_integration, a5_exclusion, a6_withdrawal, a4_concurrency); missing negative tests: chair refused on approve, override reason vs stale hash, explicit
roster-minimum code at approve, exclusion window at co-sign, service_role refused on approve, different approver's reason discarded. They need a local isolated Postgres under the heavy-lock
queue (not available in reasonable time). Not determined: later migrations or rollbacks that redefine these functions beyond the 2027*.sql grep; hosted privileges.

---

# Extension: owner ratification R-11 of 2026-11-24 (D3 self-approval for INITIAL Studio/Custom approval ONLY)

**Policy ratified vs implementation verified:** the policy is ratified. Implementation is **inspected, not executed** (SQL not run); two static `it.fails`
characterizations are added in `r11.approval.static.test.ts` (10 tests: 8 pass, 2 expected fail). **A Studio/Custom RELEASE BLOCKER is recorded (RB-11.2).**

## 5. Release blockers and findings

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| **RB-11.2** | **Studio/Custom release blocker** | **The D3 self-approval override is not limited to INITIAL approval.** `approve_competition_round_result` has no notion of initial vs corrected: it checks only `v_ver.calculated_by = auth.uid()` and a non-blank reason. After `open_competition_round_correction` (manager-only, reason 1-500 chars; invalidates versions, round back to `ballots_locked`) a recalculation creates version N+1, which goes through the same approve function, so the calculator can self-approve the corrected version with the override. A7 `cosign_competition_correction` co-signs the correction *cause* by a different person, but it does not approve the result and the re-approval is still the D3 override. Republication (`publish_competition_round_result`, F3) takes no override but requires an approval row, so a self-approved corrected version can be published. Withdrawal (`withdraw_competition_round_result`) and `_cf1_record_ballot_correction` are not approval paths. Advancement guards (`cf1_guard_advancement_approval`) have no override, but a self-approved version feeds them. | `20270114090000` approve L1020-1106 (override branch L1074-1083; no `correction`/version reference in the body), `open_competition_round_correction` L1177; `20270122090000` publish L352; A7 `20270120...` cosign L489. INSPECTED. Static marker: `KNOWN BLOCKER RB-11.2` (`it.fails`) |
| **RB-11.1** | release blocker if an "explicit, substantive reason" is required | The reason rule is `nullif(btrim(p_override_reason),'')` plus at most 500 characters (also in the approvals CHECK). **A 1-character reason such as "x" is accepted**; a whitespace-only reason is refused. `_cf1_reason_is_substantive` (20-500 characters, at least 4 words and 3 distinct, no placeholders, not one repeated character) is used by A6 (A5 and F3 use other reason checks) but **not** by approve. The UI input is not required and has only `maxLength=500`; the pure helper `contract.ts` is looser still. | F2 L1034, L154-157; `20270120090000` L350; results `[roundId]/page.tsx` L256-261. Static: `KNOWN BLOCKER RB-11.1` (`it.fails`) |
| RF-11.1 | low (not exploitable) | approve and calculate revoke only public/anon; `service_role` keeps EXECUTE (A5/A6/A7/F3 revoke it). Reachable at the endpoint with a service-role key, but `auth.uid()` is null so the first check raises `COMP_FORBIDDEN`; a service-role call cannot carry a user identity. Hosted grants not read. | F2 L1241-1249, L1031-1033 |
| RF-11.2 | medium (policy-dependent) | approve checks only the `manager` role, **not a verified email**; publish and withdraw do. | F2 L1031; E2 L681 |
| RF-11.6 | info | Audit is sound: the override has its own event kind `result_approval_override` (actor, version, input hash, calculator, reason, time); the approvals table has `unique(result_version_id)`, a CHECK tying a reason to approver = calculator, insert-only triggers (no update/delete/truncate), and approval rows can be written only inside the approve transaction. **No initial/corrected marker** exists in the event, the approvals row or the UI (the UI shows "single-staff override: <reason>" on any approved version). | F2 L143-160, L200-215, L326-346; results `[roundId]/page.tsx` L245 |

### Bounded correction proposal (DESIGN ONLY; no SQL authorized)

1. In `approve_competition_round_result`, derive "initial" from the round's history (no prior invalidation/correction event for the round; an explicit correction-opened flag is cheaper and exact). For a non-initial version, set `v_override := false` and raise `COMP_SECOND_APPROVER_REQUIRED` when the approver is the calculator **or the person who opened the correction**, so no self-approval path exists after a correction.
2. For the initial override, require `_cf1_reason_is_substantive(v_reason)` (same rule as A6) and add the matching UI `required`/minimum-length hint (copy via the relabelling workstream).
3. Record `refs.initial = true|false` in the `result_approval_override` event so the audit trail distinguishes the two.
4. Revoke `service_role` on approve and calculate (as A5/A6/A7/F3 do) and add the verified-email check for the approving manager for consistency.

All four need a new owner-gated migration with the tests below; none was made.

## 6. The four absolute no-override protections and the other required negative cases

| Protection / case | Enforcement (INSPECTED) | Override path | Negative test status |
|---|---|---|---|
| Minimum two couples | `COMP_ROSTER_BELOW_MINIMUM` at approve (`_cf1_require_roster_eligible`), `COMP_ADVANCEMENT_BELOW_MINIMUM` at A6 precheck/apply/Final-start | none | SQL tests exist (a4_minimum_integration, a6), one loose; static: approve body has no minimum branch (EXECUTED static). Explicit code at approve with an override reason: PENDING |
| Withdrawal window | `_cf1_a6_precheck` codes; `COMP_EXCLUSION_WINDOW` | none | SQL tests exist (request side); co-sign side PENDING |
| Exclusion co-sign separation | `COMP_EXCLUSION_COSIGN_SAME_PERSON`, `COMP_EXCLUSION_COSIGNER_FILED_BALLOT` | none | SQL tests exist (a5_exclusion L449, L482, L598); static: no `p_override` in A5 (EXECUTED static) |
| Stale / mismatched input hash | `COMP_RESULT_STALE` before the override branch | none | static ordering test EXECUTED; SQL test with an override reason and a stale hash **PENDING** (none exists) |
| Unauthorized callers | `COMP_FORBIDDEN` for non-manager and null uid; anon revoked | n/a | SQL tests exist (f2_results L525-534); chair and service_role cases PENDING |
| Missing / invalid override reasons | blank -> `COMP_SECOND_APPROVER_REQUIRED`; over 500 -> same | n/a | SQL tests exist (L518, L519, L567, L568); 1-character acceptance recorded by a static test |
| Initial self-approval used during a correction workflow | **not blocked (RB-11.2)** | **reachable** | `it.fails` marker EXECUTED; SQL test PENDING (would show success today) |
| Chair vs manager decisions | approve is manager-only; chair can co-sign exclusions/withdrawals/correction causes, cannot request, approve, publish or open a correction; nothing lets either role reverse the other's approved result | none found | chair-refused-on-approve SQL test PENDING |

SQL negative tests needing the isolated database (all PENDING; the heavy-lock queue held tickets and a running multi-hour job, over the 45-minute rule): chair calls approve (expect `COMP_FORBIDDEN`); calculator self-approves with a stale hash and a valid reason (expect `COMP_RESULT_STALE`); calculator self-approves version N+1 after a correction (documents RB-11.2: succeeds today); calculator self-approves with reason "x" (succeeds today: RB-11.1); a `service_role` key calls approve (expect `COMP_FORBIDDEN`); minimum-two at approve with an override reason (expect `COMP_ROSTER_BELOW_MINIMUM`).

## 7. Chairman vs manager authority (INSPECTED)

Manager: calculate, approve (D3), request exclusion/withdrawal, open a correction, publish, withdraw a result. Chair: co-sign exclusions, withdrawals and correction causes only. Neither role can overturn the other's decision, and no role gains unrestricted authority over the other. Whether a chair may cancel a manager's pending request was not traced in this extension (the earlier R-11 trace says cancel allows either role).

## 8. Not represented as independent verification (UI/copy audit)

No text says "independent verification" or "two-person authorization" for result approval. Strings: results `page.tsx` L32 "have a second manager approve it"; `[roundId]/page.tsx` L245 "single-staff override: <reason>", L256 "A second manager should approve it. If you are the only manager, say why:", L261 "Approve with override"; `messages.ts` L10-11. "two-person" at `CallbackPanels.tsx` L286 and "second manager or the chair co-signs" at L123 concern withdrawals and correction co-signs, not result approval. The wording is accurate but does not state that the override is a single-person approval, and it is shown on corrected versions too. Copy changes belong to the relabelling workstream; none made.

## 9. Future profiles (NOT IMPLEMENTED; the Studio override must be unavailable)

`R11-WSDC-0001` (3.4.3, PDF p.19: Chief Judge and Scoring/Tabulation duties must be provided by separate individuals), `R11-NDCA-0001` (IV.C.7, PDF p.34: the Chairman's decision is final on marking and timetable matters), `R11-UCWDC-0001` (Couples II.N.1, PDF p.15: decisions of the judges, Contest Coordinator and Event Director are final). Where a body mandates separation, the D3 self-approval must be unavailable for that profile.

## 10. Independent review of this extension

A subagent re-checked RB-11.1/RB-11.2 against the code and found them correct and found no missed override path. Corrections applied: `_cf1_reason_is_substantive` is used by A6, not A5; the two `it.fails` markers were tightened to branch-level patterns. Remaining caveats: the markers read only the F2 file, so a later exact-text patch of approve (as A3 and PV-1 did) would not flip them; RB-11.2 applies when the same person recalculates the corrected version (a different recalculator makes the approval ordinary), and a different approver who opened the correction would still need the opener check in the proposal. Nothing was executed against a database.
