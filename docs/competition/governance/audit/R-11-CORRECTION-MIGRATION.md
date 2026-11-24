# R-11 correction migration (RB-11.1, RB-11.2): draft, NOT APPLIED ANYWHERE

**Status: draft pull request. The migration has not been applied to DEV, PROD or any hosted environment, and applying it to any hosted environment needs separate owner approval.**
Authority: owner ratification R-11 and the R-14 security-correction authorization of 2026-11-24 (items 11-18 in the coordinator brief). Base `origin/release/website-embeds`.
Finding report: PR 859 (`R-11-VERIFICATION.md` sections 5-9). Scope here: ONE function, `public.approve_competition_round_result(uuid, uuid, text, uuid)`.

## 1. What changes

| | Before (base text, md5 `3cf63c3bb00a78142ea2c8e70a8b4a0c`, post F2 + A3 + PV-1) | After (md5 `5adf8f1680306964abb688068616b4ce`) |
|---|---|---|
| Override reason (RB-11.1) | non-blank after trim, at most 500 characters ("x" accepted) | `_cf1_reason_is_substantive`: 20-500 characters, at least 4 words, at least 3 distinct, no placeholder, not a repeated character. Refusal: `COMP_SECOND_APPROVER_REQUIRED` (unchanged code) |
| Self-approval after a correction (RB-11.2) | calculator may self-approve any version with a reason | corrected result: **no override**. Refused with the new code `COMP_CORRECTION_APPROVER_REQUIRED` when the approver is the calculator of the version **or anyone who opened a correction of the round**. An independent manager approves normally |
| Initial self-approval | allowed with a reason, audited as `result_approval_override` | unchanged, plus the substantive reason rule; `refs.initial = true` added to the audit event |
| Audit | `result_approved` / `result_approval_override` events | same kinds; `refs.initial` (true/false) added to both |

Nothing else is created, altered, dropped or granted. The migration redefines the function by pinned exact-text replacement (three fragments), exactly like F2/A3/PV-1: the pre-text md5 and the post-text md5 are both asserted, so any later divergence of the function makes the migration fail instead of overwriting it. Both md5 values were also reproduced **offline from the migration texts** (F2 body + A3 patch + PV-1 patch = `3cf63c3b...`; + R-11 fragments = `5adf8f16...`; reversing the fragments gives `3cf63c3b...` and the identical string), so the pins do not depend on a database run.

## 2. Initial versus corrected: the immutable-history source

`corrected` is true when ANY of three append-only sources shows it (all read under the round `FOR UPDATE` lock that `approve` already holds and that `open_competition_round_correction` also takes, so the answer cannot change between the check and the approval row):

1. `event_competition_result_approvals`: an approval of **another** version of the round (covers re-approval after withdrawal or any invalidated approved version).
2. `event_competition_correction_causes` (A7, `20270120095500`): one row per correction opening, written by the `AFTER UPDATE OF status` trigger `cf1_a7_record_correction_cause` (**ENABLE ALWAYS**), with `opened_by` (the correction opener's id). The same trigger raises `COMP_CORRECTION_CAUSE_REQUIRED` and rolls the correction back if it cannot write the row, so every correction on a chain with A7 has a row.
3. `event_competition_result_events`: the F2 correction audit event (`kind = 'round_state_changed'`, `to_state = 'ballots_locked'`, `refs.correction = true`, `actor_user_id` = the opener), written by `open_competition_round_correction` in the same transaction as the round edge (the F2 round guard `COMPF2_ROUND_WRITER` refuses the `calculated|approved|published -> ballots_locked` edge without it).

Proof from the schema that these are immutable and cannot be edited by a manager under RLS:

* Write path: `revoke all ... from public, anon, authenticated, service_role` on all three tables, then `grant select` only (F2 L731-736; A7 grants nothing at all). RLS is on. Rows are written only inside SECURITY DEFINER functions (`_compf2_event`, `approve_competition_round_result`, the A7 trigger) whose own execute rights are revoked from every API role.
* Edit path: `protect_competition_history_evidence()` raises on UPDATE, DELETE and TRUNCATE for all three tables (the only exception is the cascade of a deleted event, which also removes the round the rule is asked about). A7 additionally enables its triggers ALWAYS. Approval rows can only be inserted in the transaction of an approval audit event of the same version and approver (`COMPF2_APPROVAL_WRITER`), and `unique(result_version_id)` holds.
* Residual: a database superuser who disables triggers or sets `session_replication_role = replica` on the F2 tables (not ALWAYS) can alter history. The correction-cause source is ENABLE ALWAYS, and the three sources are alternatives (any one suffices), so suppressing the answer needs coordinated superuser DDL on all three. This is the same residual class the CF1 R2 gate decision accepted.

Sources deliberately **not** used, and why: `event_competition_rounds.correction_open` (derived, cleared by recalculation and by the U66 recovery), `rounds.status` (moves), the version number (a number above 1 also arises from a plain ballot change before any approval; using it would block legitimate initial approvals), `result_versions.status` (moves), any client parameter.

Conservative consequences (intended): a correction opened from `calculated` (the first result never approved) still makes later approvals corrected; a correction that was later cancelled by the U66 recovery still counts.

## 3. Reason standard decision (RB-11.1)

`_cf1_reason_is_substantive(text)` (`20270120090000` L350-369) was read in full and **is reused**:

* `LANGUAGE plpgsql IMMUTABLE`, no table access, no SECURITY DEFINER; `search_path` set. Execute is revoked from every API role; it is reachable only from definer functions, and `approve` is SECURITY DEFINER (the function owner holds execute). A6 already calls it from definer functions the same way (`20270120095000` L444, L655), and `20270120090000` L570.
* Rule: `btrim` then 20-500 characters; not one of `n/a, none, test, testing, fix, fixed, asdf, tbd, ok`; not one repeated character; at least 4 whitespace-separated words and at least 3 distinct words. A one-line explanation such as "only manager present on the floor today" (39 characters, 7 words) passes; the previous suite's "sole manager on site" (exactly 20 characters, 4 words) passes at the boundary.
* Known limits of the rule (not changed here): it checks shape, not meaning ("aaaa bbbb cccc dddd" passes); it is the same bar A6 withdrawal reasons already meet; the 500 limit matches the approvals table CHECK (1-500), which is unchanged and still satisfied.

## 4. Verified-email requirement and `service_role` revocation: LEFT OUT (separate findings)

Both were assessed against legitimate internal callers and are **not** in this migration.

**`service_role` EXECUTE on approve and calculate (RF-11.1).** Evidence: the only application caller of `approve_competition_round_result` is the server action `approveRoundResultAction` in `src/app/app/events/[id]/competition/results/actions.ts`, which uses the user-session client `createClient()` from `@/lib/supabase/server` (the signed-in user's JWT); `calculate_competition_round` has the same single caller (`calculate.ts` via the same session `rpc`). No cron, job, webhook, admin-client or e2e path calls either function with a service-role client (`grep` of `src`, `e2e`, `scripts`; the e2e PV-1 spec calls `calculate` through the manager's own session). The SQL suites run as superuser and switch to `authenticated`; none calls these functions as `service_role` except the new suite's characterization test, which expects `COMP_FORBIDDEN`. So revoking looks compatible. It is left out because (a) the hosted grants were not read (hosted reads were not needed for this PR and were not made), and a `CREATE OR REPLACE`-preserved ACL is not the same thing as a `REVOKE`; (b) the rollback of a grant change cannot restore "exactly the previous hosted ACL" without knowing it; (c) it is not exploitable: a service-role token carries no user, `auth.uid()` is null, and the first check raises `COMP_FORBIDDEN` (asserted in the new suite). Recommended as a **separate** small migration after a hosted ACL read, with its own authorization.

**Verified email for the approving manager (RF-11.2).** `_compe2_round_role` returns `manager` for anyone who passes `can_manage_event_competition` without a verified email; publish, withdraw, correction recovery and the co-sign functions do require one. Adding the requirement to approve changes who can approve today: a manager without a bound verified-email identity would lose approval but still be able to calculate, and the failure would surface only at approval (the UI does not warn). Compatibility with real accounts and with fixtures could not be demonstrated without hosted reads and a full run, so it is left out. Recommended as a separate decision (owner policy question: should approval need the same verified credential as publication?).

## 5. Compatibility assessment

* **App callers / signatures:** `approve_competition_round_result(p_round_id, p_result_version_id, p_override_reason, p_request_id)` keeps its signature, security definer, search_path, owner and ACL (`CREATE OR REPLACE` keeps them; the migration re-asserts them). Return shape is unchanged (no new key; `refs.initial` is only in the audit event). The replay branch (same request id) is untouched and runs before everything else.
* **Order of checks is preserved:** manager role (`COMP_FORBIDDEN`) -> request id -> replay -> round state (`COMP_RESULT_INVALID_TRANSITION`) -> version lookup -> `COMP_RESULT_STALE` (non-latest, hash mismatch) -> PV-1 verification -> **[new: initial/corrected + reason rules]** -> audit event + approvals row -> certification loop -> A3 roster check (`COMP_ROSTER_ENTRY_UNAVAILABLE` / `COMP_ROSTER_BELOW_MINIMUM`) -> approved write. The four no-override protections are therefore untouched: stale hash is refused before the new logic; the roster check and the min-two rule run unconditionally after it; the withdrawal window and exclusion co-sign separation live in other functions that have no override parameter.
* **Error codes:** `COMP_SECOND_APPROVER_REQUIRED` is kept for the initial path (missing / insufficient reason): it is mapped by the app (`messages.ts` L10-11, "A different manager should approve this result. If you are the only manager, say why in the override reason and approve again."), which is correct advice there. The corrected path raises the **new** code `COMP_CORRECTION_APPROVER_REQUIRED`. The app maps unknown codes to the generic "That could not be done. Reload the page and try again." (`resultErrorMessage`, `messages.ts` L167-174), which is safe; reusing the old code would have shown the override hint on a corrected result, which is wrong and invites repeated attempts. `COMP_RESULT_STALE` and `COMP_FORBIDDEN` are unchanged.
* **UI (`results/[roundId]/page.tsx` L245-261):** the override textbox is shown whenever the viewer is the calculator and has no `required`/minimum length. No app change is authorized in this PR. What the UI would need later (list for the relabelling/UX workstream): (1) map `COMP_CORRECTION_APPROVER_REQUIRED` in `messages.ts` ("A corrected result needs a different manager: not the person who calculated it and not the person who opened the correction."); (2) hide the override box for a corrected version (the page can read the approvals/correction history; a `competition_round_results_review` field `corrected: boolean` is the clean source); (3) `minLength`/`required` and a hint "20-500 characters, at least four words" on the box for an initial version; (4) change the `COMP_SECOND_APPROVER_REQUIRED` copy to mention the reason standard; (5) show "single-staff override (initial approval)" and never present it as independent verification. Behavior is correct without any of these.
* **Existing SQL suites that pin or reconstruct the approve text** (updated in this PR, test-only): `test_T_competition_cf1_a3_results.sql` U79 pin list (adds `5adf8f16...`) and the U53 pre-A3 reconstruction (reverses the R-11 fragments first, a no-op without R-11); `test_T_competition_pv1_recompute.sql` W3 (accepts the successor md5). `scripts/qa/pv1/fault-injection.sh` pins the PV-1 tip (`POST=... 3cf63c3b... fns=10`); run it only after the R-11 rollback (listed, not edited).
* **Existing suites that call approve after a correction** use A1 as calculator and opener and A2 as approver (`f2` L674-712, `a3` U59 L772-785, `f3` L593, L674, L980, `a4` fixtures use `null` reasons) so they keep passing by construction: reviewed by reading each call site, execution PENDING or recorded in section 7.
* **Coordination with other open PRs:** OD-07 (PR 838, post-completion corrections design) and OD-26/OD-31 compositions that pin the approve md5 need to pin the successor `5adf8f16...` when they land after this. PR 859's two `it.fails` markers (`r11.approval.static.test.ts`) read only the F2 migration file and will keep "failing as expected" after this lands; they should be re-pointed to this migration's text (assert the `_cf1_reason_is_substantive` and `v_initial` fragments here) by 859 or a follow-up. This PR does not edit 859's files.
* **Operational note (sole-manager and two-manager studios):** a corrected result needs a manager who is neither calculator nor opener. With two managers it works if the opener also recalculates (A opens, A recalculates, B approves). With one manager a corrected result can no longer be approved at all (owner policy R-11(4): corrections follow OD-07's independent correction-approval workflow, which is where a fallback, if any, belongs). A deadlock (opener A, calculator B, nobody else) is recoverable by a new correction opened by anyone and recalculated by the opener.

## 6. Slot table (migration timestamp)

Base head migration: `20270218090000`. Slots proposed in open PRs (migration files, from `ghapp pr list --json files`, 2026-11-24): 844 `20270219090000`; 800 `20270221090100`; 793 `20270222190000`; 820 and 797 `20270223090000`; 811 and 796 `20270223091000`; 817 `20270223100000`; 819 `20270223110000`; 823 `20270223120000`; 824 `20270223130000`; 831 `20270223140000`; the older stacked PRs 375/441/445 re-use existing (already merged) names. **Chosen: `20270224090000`** (later than the base and than every slot above; free). Rollback: `rollback/20270224090000_competition_r11_approval_override_scope_rollback.sql`.

## 7. Tests

New suite `sql-tests/test_T_competition_r11_approval_override_scope.sql` (superuser, one rolled-back transaction, synthetic fixtures `...-b11ff4XXXXXX`; verdict `COMPETITION R11 SQL SUITE PASS (n checks)`). Checks, by group:

* **S (structure):** security definer/search_path/ACL; unchanged signature; post md5 pin; order of stale checks < history read < reason check < audit event < roster check < approved write; the history read uses only the three append-only tables and no parameter / `correction_open` / round status; append-only triggers on the three tables; no API write privilege; `_cf1_reason_is_substantive` immutable and not API-executable; no override/force/bypass parameter in exclusion / withdrawal-related / co-sign / advancement RPCs.
* **r1** initial self-approval with a substantive reason succeeds with a distinct `result_approval_override` event (actor, reason, calculator, `refs.initial = true`) and an approvals row; idempotent replay.
* **r2** initial two-manager approval succeeds, normal kind, reason discarded, `refs.initial = true`.
* **r3 (RB-11.1)** refused: none, whitespace, `x`, `ok`, `n/a`, `testing`, repeated character, one long word, four short words, one repeated word, over 500 characters; nothing left behind; boundary 20 characters accepted.
* **r4 (RB-11.2)** corrected, calculator = opener: self-approval refused with and without a substantive reason (`COMP_CORRECTION_APPROVER_REQUIRED`); independent manager approves; replay; `refs.initial = false`, no reason.
* **r5** corrected, opener is not the calculator: opener refused (with and without reason), calculator refused, independent third manager approves.
* **r6** correction opened from `calculated` (never approved): self-approval refused, independent approves.
* **No-override protections:** r7 stale input hash and r8 non-latest version with a substantive reason -> `COMP_RESULT_STALE`, nothing written; r9 ineligible couple with a reason -> `COMP_ROSTER_ENTRY_UNAVAILABLE`, whole approval rolled back; r12 minimum-two (`_cf1_is_callback_final` / `_cf1_eligible_roster_count` stubbed inside the rolled-back suite transaction) -> `COMP_ROSTER_BELOW_MINIMUM` for the calculator with a reason and for an independent manager; r10 exclusion co-sign by the requester -> `COMP_EXCLUSION_COSIGN_SAME_PERSON`, a different manager may co-sign; withdrawal window: catalog proof that no withdrawal/exclusion/advancement RPC has an override parameter (the A6 SQL suite covers the window itself).
* **Unauthorized callers (r11):** chair, scorer, judge, studio-B owner, authenticated user without a role -> `COMP_FORBIDDEN`; anon -> permission denied; `service_role` token without a user -> `COMP_FORBIDDEN`.
* **Audit immutability:** update/delete of approvals, result events and correction causes refused; truncate refused; an API role cannot insert result events; override events always carry a reason, the calculator as actor and `refs.initial = true`; corrected approvals are never by the calculator or an opener.

Runner `scripts/qa/r11/run-r11.sh` (local isolated container only; requires the heavy lock under an `r11` owner): chain up to the base, **characterization run before the migration (the suite must fail on the blockers)**, apply, suite pass, replay no-op, rollback (md5 + ACL equal the base), rollback replay, re-apply, then the existing f2, a3, pv1, f3, a5 suites and the new suite again.

**Execution status:** see section 9.

## 8. Rollback

`rollback/20270224090000_competition_r11_approval_override_scope_rollback.sql`: refuses unless the installed text is the post-migration text (md5 pinned), reverses the three fragments, asserts the restored text is byte-identical to the pinned pre-migration text (`3cf63c3b...`, i.e. the F2 + A3 + PV-1 text; no CRs; reproduced offline), `CREATE OR REPLACE` with identical signature, owner and ACL, re-asserts security definer / search_path / grants, and is a no-op when already rolled back. No object other migrations depend on is dropped. Restoring it **re-opens RB-11.1 and RB-11.2**. Audit rows written under the new text keep their extra `refs.initial` key (schemas are unchanged).

## 9. Independent security review and execution log

**Review** (a subagent that had not seen this work's conclusions, given the migration, the function definitions and the threat model; read-only; it could not run Postgres). Result: **no blocker**; nothing it tried let a corrected result be approved by its calculator or a correction opener, and it found no way to forge or suppress the initial/corrected decision from an authenticated session. Findings and dispositions:

| # | Finding | Disposition |
|---|---|---|
| 1 | should-fix: the reason standard could be met by padding (NBSP, zero-width, punctuation tokens, leading tab counted as a word) | **Fixed in this migration** (function text only, the shared helper is unchanged because A5/A6/F1 use it): the initial override additionally requires at least 12 letters/digits and at least 4 whitespace-separated tokens that contain a letter or digit. Four new suite checks. |
| 2 | should-fix (policy): sole-manager / two-manager studios can deadlock a corrected result | Documented (section 5). By owner policy R-11(4) there is no override for corrections; a fallback belongs to OD-07. |
| 3 | note: correction co-signers and replacement-ballot filers are not excluded as approvers | Not changed: the owner wording is "calculator and the person who opened the correction". Wider separation is an owner decision (both tables are insert-only and could be added to the opener set). |
| 4 | low: rollback held a literal CR byte | **Fixed** (escape form `E''`, verified by the static test). Line-ending note: the dollar-quoted anchors fail closed (anchor count) if a file is applied with CRLF line endings, as PV-1 does. |
| 5 | note: no test for U66 recovery, request-id reuse across rounds | Added the padding cases; U66 / request-id-reuse cases are listed as not covered (the review found no defect there). |
| 6 | note: F2 history triggers are not ENABLE ALWAYS | Residual documented (section 2): superuser-class only; the cause table is ENABLE ALWAYS and the three sources are alternatives. |
| 7 | note: rollback ordering | R-11 must be rolled back before any rollback of PV-1 or A3 (stated in the rollback header). |

Not examined by the review and not claimed: hosted data. Approvals recorded under the OLD text on a corrected version (approver = calculator after a correction) are not rewritten; a read-only count on the target environment (approvals joined to correction causes where approver = calculator and version > 1) is recommended before release.

**Execution log (local isolated Postgres only; nothing hosted was touched; full output in [R-11-RUNNER-LOG.txt](R-11-RUNNER-LOG.txt)).** Heavy-lock rules followed: ticket `20261124T093621-r11-correction` created first, lock taken only when my ticket was oldest and the lock free (NSI M16a finished first), lock and ticket released afterwards, container `df-r11-*` removed by exact name. Image `ns1-base:snap` plus the chain of `run_cf1_f3.sh` and F3, PV-1, OJ-1 (the `df-isoqa/base:20261205090000` image lacks the 10A objects, so it was not usable). Result of `scripts/qa/r11/run-r11.sh`: **PASS**.

| Step | Result |
|---|---|
| P1 precondition: approve md5 before = `3cf63c3b...` | PASS |
| P2 characterization on the unpatched chain | the R-11 suite FAILS as expected: one-character, placeholder, padded reasons are accepted and a corrected version is self-approved (RB-11.1 and RB-11.2 reproduced) |
| P3 apply: approve md5 = `5adf8f16...`; owner, ACL, security definer, search_path identical | PASS |
| P4 R-11 suite after apply | PASS (85 checks) |
| P5 replay no-op; rollback restores `3cf63c3b...` and the same ACL; rollback replay no-op; re-apply | PASS |
| P6 existing suites after the migration | f2 PASS (198), a3 PASS (117, 7 blocked as before), pv1 PASS (30), f3 PASS (191), a5 PASS (186, 4 blocked as before) |
| R-11 suite once more at the end | PASS (85 checks) |
| vitest `r11.migration.static.test.ts` (offline reproduction of every md5 pin, fragment reversal, shape) | PASS (12) |

**PENDING (not run, not claimed):** `test_T_competition_cf1_a4_minimum_integration.sql` (needs the cf1-a4 composed image and its fixtures; the minimum-two path was exercised in the R-11 suite with stubbed helpers instead), `test_T_competition_cf1_a6_withdrawal.sql` (withdrawal window; no code in this migration touches it), the F2 race scripts (`run_f2_races.sh`, approve vs correction; the round `FOR UPDATE` lock argument is by reading only), U66 recovery then approve, request-id reuse across rounds, the full composed chain (including the Twilio/organizer migrations between PV-1 and the base head), and any hosted environment. One local observation: in this image `service_role` holds no EXECUTE on approve (the R-11 suite accepts either refusal); the hosted grant remains unread.


## 10. Register

`RELEASE-BLOCKERS.md` in this folder records RB-11.1 and RB-11.2 as **OPEN Studio/Custom release blockers** until this correction is independently reviewed, tested and APPLIED to the authorized release environment. PR 859's `it.fails` markers flip only after the migration is applied AND the markers are re-pointed (see section 5); this PR does not edit 859's files.
