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
