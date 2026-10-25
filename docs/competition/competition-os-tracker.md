# Competition OS tracker

Status: **single authoritative Competition OS tracker.** The Master Roadmap (`docs/roadmap/DanceFlow_Master_Roadmap.md`) stays the product-level source; this file tracks slice, PR, migration-slot, QA and decision state below it.

- **Reconciled against:** `origin/main` = `d535720d` (PRICING-P1, #302), 2026-10-24. `fd5e31a6` (#311, Competition workspace mobile overflow fix) is its ancestor and is merged.
- **Rule:** every slice PR updates its own row (state, head, CI, QA evidence, blocker) in this file in the same PR. Do not edit another slice's row.
- **Roadmap link:** not yet linked. Link this file from the roadmap Phase 10 section after PR #301 (which owns the roadmap Phase 10 edit) merges.
- **Evidence rule:** every fact below was read from `gh pr view` or `git show` on 2026-10-24. QA results are copied from PR bodies and comments and are not upgraded. **PASS**, **BLOCKED** and **NOT RUN** stay distinct. Items marked "(brief)" come from the Competition coordinator's assignment and are not yet written in a merged Git file.
- Nothing in this file authorizes a merge, hosted SQL, a deploy, a flag change or a live refund. Each needs separate owner authorization.

## 1. Approved decisions ledger

### 1.1 D1–D4 (owner, 2026-10-23)

| ID | Decision | Recorded in |
|---|---|---|
| D1 | Contract, specs, R1, R2, O1-read, C1-exports and Q1 may start. **E1 and E2 wait for the owner's Schedule & Heats walkthrough.** | Coordinator assignment (brief). Gate also in roadmap v2.22 (l.140, l.165, l.913, l.1039) |
| D2 | Claude drafts engine specs; the owner approves them; no engine code before sign-off. | K0 §3 and K1 docs header ("engines are specified first, approved, then built"), #291/#293 |
| D3 | Result approval needs a second person (the account that ran the calculation cannot approve). A single-staff override exists, needs a reason, and is audited. | K0 P9, `docs/competition/scoring-results-contract.md` §1 (#291) |
| D4 | Published results always go to entrant portals. The public results page is opt-in per program. | K0 P10 (#291) |

Note: the D1 text and the D1–D4 date are stated in K0's header ("Owner decisions D1–D4 of 2026-10-23 applied") but K0 does not spell out D1 and D2. Their wording above is from the coordinator brief.

### 1.2 R2 refunds (owner, 2026-10-23) — `docs/competition/r2-entry-refunds.md` §4, §4.0 (#292)

| ID | Decision |
|---|---|
| D1 (b) | Per-entry cap = net paid (gross minus the entry's share of order discounts; largest remainder, ties by `sort_order` then id). |
| D2 (a) | Fee lines are refundable as separate lines, only when staff select them. |
| D3 | Platform application fee kept (`refund_application_fee` off). |
| D4 | Refund without withdrawing, and withdraw without refunding, are both allowed. |
| D5 | Refund authority: studio owner/admin, organizer owner/admin, platform admin. Withdraw/scratch: organizer staff too, no refund. |
| D6 (a) | Dashboard refund recorded at order level, unattributed; a partial one opens a staff attribution exception. |
| D7 (a) | Refund allowed; withdrawal refused while the entry is in a locked/certified heat. |
| D8 | Superseded by C1. |
| C1 = (a) | Each successful refund is a separate accounting entry dated when it succeeds. Locked accounting periods are never rewritten. |
| Q1 = locked | A danced entry is treated as locked even if the heat is not formally locked. No automatic withdrawal; audited official-resolution process. |
| Q2 = block, narrow | An unresolved exception affecting competitive participation, placements, advancement or result integrity blocks publication of the affected round only. Financial-only exceptions do not block. |

The R2 PR body (#292) records "D1–D7 approved; D8 superseded by C1; Q1; Q2". R2 doc §4 still labels D1–D8 "PROVISIONAL" in one place (line 383) while §4 header says approved; the PR body and §4.0 are the later statement.

### 1.3 SC1 / terminology / CC1 — `docs/competition/scratch-policy-and-competition-credit.md` (#301)

| ID | Decision | Recorded in |
|---|---|---|
| Scratch = withdraw | "Scratch" and "withdraw" mean the same thing; "Scratch" is the competition-facing term. A scratch is never financial and never automatically causes a refund. The organizer picks: No refund (default), future competition credit (CC1), or Refund (R2 workflow). | #301 doc §1 (owner direction 2026-10-23), §2 |
| S-D1 | Keep both stored values `scratched` and `withdrawn`; the UI shows "Scratched". | Applied in #306 PR body ("S-D1"); #301 doc §5 lists it as the question with this default |
| S-D2 | An official may scratch an entry in a locked-but-not-danced heat as an audited action, without reopening the heat; a reason is mandatory. | Applied in #306 PR body ("S-D2"); #301 doc §5 |
| CC1 | Competition credit is a separate bounded workstream. It starts after R2 merges and needs CC-D1…D8 first. Credit is never a Stripe refund. | #301 doc §4.3 |

### 1.5 Owner decisions of 2026-10-24

| # | Decision (owner's words) | Recorded in |
|---|---|---|
| 1 | **K0 O1–O5 APPROVED.** "Accept all five proposed fail-safe defaults, including complete assigned ballots before locking, manager/designated-chair locking, hidden public judge identities, generic under-review notices, and blocking earlier-round corrections once later-round ballots exist." | K0 §11, PR #291 head `0ea4e10b` |
| 2 | **R2 operational classification APPROVED.** "Classify all four `competition_refund_*` exception kinds as operational. Preserve Q2 affected-round-only publication blocking; purely financial exceptions must not block unrelated competitive results." | #292 PR body "Open items" (code already matched) |
| 3 | **CI-B CB-1 and CB-2 APPROVED.** "Remove general event check-in permissions from instructor and independent_instructor roles. Allow front_desk to perform competition admission, mark attendance, and collect authorized desk payments, but not issue refunds, scratch entries, edit eligibility, or modify heats. Implement CB-2 in its separately reserved SQL slice." CB-2 = slot `20270112090000`, new session, stacked on #320. | This tracker (recorded from the coordinator handoff; to be copied into #295/CB-2 docs by their owners) |
| 4 | **Schedule & Heats walkthrough waived for Git-only development** of E1 officials, E2 ballots and O1 day-of. "The walkthrough remains mandatory before those PRs can merge or deploy." | This tracker (coordinator handoff) |
| 5 | **K1 Stage 1 (X-1…X-7) APPROVED.** "Approve K1 Stage 1 (X-1..X-7) as recommended." X-1 (a): `@1`/`@3` programs score with engine `@1` defaults written into the spec. X-2: fail closed on every unspecified case. X-3: `ordinal_majority` and `callback_tally` need ≥3 judges and an odd panel; `proficiency_rating` allows 1 or more; Studio engines refuse `chief_judge_tiebreak` / `score_roles_separately`. X-4: no lock with an absent judge; a manager removes the judge (audited) and the reduced panel must satisfy X-3. X-5: scratched/no-show entries excluded, not placed last. X-6: one result per dance, no combined result in v1. X-7: every heat in a round has the same panel, else fail closed. All D-OM / D-PR / D-CT items stay open (Stage 2 next). | The three `docs/competition/engine-spec-*.md` on PR #293, head `4a260687` |
| 6 | **K1 Stage 2 (callbacks, D-CT-1…10) APPROVED.** D-CT-1 yes only. D-CT-2 owner: "Judges select exactly T couples across the entire callback round, not T per heat. They may save selections across heats but cannot submit their final ballot until exactly T eligible couples are selected." (eligible = not scratched/no-show, X-5). D-CT-3 tally = count of yes, higher ranks higher. D-CT-4 owner: "Advance all couples tied at the cutoff when the final can safely accommodate them. If that would exceed the approved floor capacity, do not permit an arbitrary manager-selected advancement decision. Require a separately approved, auditable tie-break process. Until that process is specified and successfully completed, advancement remains blocked. A callback runoff among tied couples is a candidate approach, but is not yet authorized as an automatic rule." Option (c) manager decision REJECTED; callback runoff is a candidate only; over capacity the engine fails closed with a reason code. D-CT-5 organizer sets T before ballots open; T ≥ eligible entries means everyone advances and the round is not danced. D-CT-6 no placement, label "Semi-final". D-CT-7 by entry only. D-CT-8 only when turned on in Advanced, no automatic threshold. D-CT-9 across the round (needs X-7). D-CT-10 nothing carries into the Final; tally is staff information. | `engine-spec-callback-tally.md` on PR #293, head `79d32f5a` |
| 7 | **K1 Stage 3 (ordinal majority) APPROVED.** "Approve Stage 3 with option B: OM-A, strict majority, tie chain (1) more judges at that cutoff, (2) lower sum of those ordinals, then shared placement numbered 2,2,4; D-OM-4 and D-OM-5 as recommended; floor capacity = 10D final heat capacity." D-OM-1 OM-A; D-OM-2 strict majority `m = floor(J/2)+1`; D-OM-3 chain (1) more judges marking ≤ c, (2) lower sum of ordinals ≤ c, (3) share the placement, adopted as DanceFlow Studio rules (resemble Skating System steps; no Skating System, NDCA or UCWDC compliance claim; random draw, entry number, registration time and names excluded); D-OM-3b numbering skips (2, 2, 4); D-OM-4 no equal ordinals on a ballot; D-OM-5 full 1…N ranking required. This also resolves the callback "approved floor capacity" sub-question (D-CT-4) = the final round's configured couples-per-heat capacity from 10D. | `engine-spec-ordinal-majority.md` on PR #293, head `79d32f5a` |
| 8 | **K1 Stage 4 scoring architecture APPROVED in principle** (S4-1, S4-2, S4-3, S4-6): five independent dimensions (sanctioning; format/division type; scoring method + version from a versioned registry, per division with optional round-level override; ballot format + permitted marks; result purpose), disclosed sanctioning with no implied sanction, official methods only exact, feedback and placement from one ballot only where the method defines both. Stages 1–3 apply to the Studio methods only. **S4-4 (revised):** no universal median/majority-mark calculation for medal feedback; the selected method and version define panel size, ties, missing marks and even panels, else refuse the calculation. **S4-5:** registry-based approach approved; UCWDC Majority Rules stays unavailable until K1-U is fully specified and independently verified. **S4-7:** keep version-locking and certified-result immutability; no silent rewrite; audited migration or duplication workflow for unfinished drafts; locked competitions fail closed until reviewed. **REJECTED:** the three-band median proposal as a universal studio method (`proficiency_rating` stays fail-closed, not deleted). | `docs/competition/scoring-architecture-decisions.md` on PR #293, head `c7e91cd8` |

Recorded 2026-10-24 from the Competition coordinator's handoff of the owner's words; items 1 and 2 are also written in Git as noted.

### 1.4 Other standing decisions this tracker relies on

- Functional QA is developer-owned; the owner gives business acceptance only (roadmap l.1039). Owner acceptance gates: Schedule & Heats walkthrough (gates 10E); organizer walkthrough and verified "this is me" walkthrough (gate public registration).
- Public Competition registration is HELD and the flag is OFF (roadmap v2.22 l.913). Public registration additionally needs CI-B, CI-D and the 10C.1 gates (l.140).

## 2. PR matrix

State as of 2026-10-24 (checks from `statusCheckRollup`; "CI" means the *Typecheck, build, lint, unit/integration tests* job). Playwright E2E is `SKIPPED` on every PR (gated on E2E secrets). Merge authorized: **none yet** for every row.

| PR | Slice | Head | Base | State | CI | QA evidence | Blocking item | Merge authorized |
|---|---|---|---|---|---|---|---|---|
| #291 | K0 scoring→results contract (docs + types, no SQL) | `d8a84fa7` | main | OPEN | SUCCESS (+ Vercel) | §4 K0 | Opus review; owner approval to freeze (O1–O5 APPROVED 2026-10-24) | none |
| #292 | R2 / CI-D entry refunds (SQL `20270103`, webhook, staff flow) | `f5775a0a` | main | OPEN, **draft** | SUCCESS | §4 R2, §4 W1 integration | Release gate: #320 desk balance must land first; K0 correction-event tie-in; real-DB clean-chain rerun before PROD SQL (operational classification APPROVED 2026-10-24) | none |
| #293 | K1 Studio v1 engine specs (docs only) | `5fa47468` | main | OPEN | no CI test job on this PR (docs only); Vercel SUCCESS | §4 K1 | Owner decisions D-OM / D-PR / D-CT (Stages 1–3 and Stage 4 architecture APPROVED 2026-10-24; Stage 4 methodology (K1-U etc.) open) | none |
| #295 | CI-B atomic check-in (no SQL) | `399d90ce` | main | OPEN | SUCCESS (+ Vercel) | §4 CI-B | CB-1 APPROVED 2026-10-24 (instructor roles lose event check-in); CB-2 front-desk SQL is a separate stacked workstream (slot 0112) | none |
| #297 | Q1 full simulated competition E2E (stages 1, 2, 4) | `6d46c837` | main | OPEN | SUCCESS (+ Vercel); spec skips in CI | §4 Q1 | Later stages are `test.fixme` until their slices exist; W3 extension in progress locally (brief) | none |
| #301 | SC1/CC1 scratch policy + credit design (docs only; also edits roadmap Phase 10) | `1d87deda` | main | OPEN | Vercel SUCCESS | Docs only | Owns the roadmap Phase 10 edit; owner S-D1/S-D2 recorded as applied in #306; CC-D1…D8 open | none |
| #306 | SC1 scratch workflow (SQL `20270108`) | `77a176ac` | main | OPEN, **draft** | SUCCESS | §4 SC1, §4 W1 integration | Owner review; apply-order with R2 (both orders PASS in W1 integration) | none |
| #311 | Competition workspace mobile overflow (nav `min-w-0`) | — | main | **MERGED** `fd5e31a6` (2026-10-24T13:36:57Z) | — | Not read here | — | n/a |
| #320 | CI-B desk balance: refunds never appear as balance due (W2; SQL `20270111`) | `328674d6` | `competition-r1-checkin-cas` (#295) | OPEN, **draft** | SUCCESS | §4 W2 | Stacked on #295: merge #295 first. R2 must not release before it | none |
| #321 | C1 closeout reads (W5): read-only P&L, CSV, checklist (no SQL) | `30f943e5` | `competition-r2-entry-refunds` (#292) | OPEN, **draft** | SUCCESS | §4 W5 | Stacked on #292; desk-balance and publication checks wait for #320 and F2/F3 | none |
| #322 | K1 callback setup corrections (W4; SQL `20270110`) | `d02e0df9` | main | OPEN, **draft** | SUCCESS | §4 W4 | Owner D-CT-5 (callback target T) and related decisions not made here | none |
| E1 officials | `20270101090000` | no PR yet | main | **in development** (Git-only; new session) | — | — | Walkthrough waived for Git-only development only; mandatory before merge or deploy (§1.5 #4) | none |
| O1 day-of | `20270106090000` | no PR yet | main | **in development** (Git-only; new session) | — | — | same | none |
| E2 ballots | `20270102090000` | no PR yet | E1 + O1 (stacked) | **in development** (Git-only; new session) | — | — | same; depends on E1 and O1 | none |
| CB-2 front-desk | `20270112090000` | no PR yet | #320 (stacked) | **in development** (Git-only; new session) | — | — | Depends on #320 | none |

Heads moved since the first version of this tracker: #292 `a27e943c`→`c32a693d`→`f5775a0a`, #306 `8f6e7874`→`e4b7a57e`→`77a176ac`, #291 `a8c7c611`→`0ea4e10b`. Re-read before relying on a SHA. The four "in development" rows come from the coordinator assignment of 2026-10-24; fill in PR numbers when they open.

## 3. Migration slot ownership

Main has no `2027*` migrations (latest on main: `20261230090000_twilio_rfl_pilot_spend_evidence.sql`). Slots are reservations; nothing below is applied anywhere.

| Slot | Owner | Source | Status |
|---|---|---|---|
| `20270101090000` | E1 officials | K0 §12 | in development (Git-only) |
| `20270102090000` | E2 ballots | K0 §12 | in development (Git-only), stacked on E1 + O1 |
| `20270103090000` | **R2** entry refunds | K0 §12; #292 | in #292, unmerged, local-DB only |
| `20270104090000` | F2 results lifecycle | K0 §12 | not built |
| `20270105090000` | F3 publication + read RPCs | K0 §12 | not built |
| `20270106090000` | O1 day-of (schedule/start/cancel round) | K0 §12 | in development (Git-only) |
| `20270107090000` | C1 closeout | K0 §12 | not built (writes) |
| `20270108090000` | **SC1** scratch | #301 doc §4.3; #306 | in #306, unmerged, local-DB only |
| `20270109090000` | CC1 credit | #301 doc §4.3 | design only |
| `20270110090000` | K1 setup fixes (W4) | #322 | in #322, unmerged, local-DB only |
| `20270111090000` | Desk balance (W2) | #320 | in #320, unmerged, local-DB only; apply after R2 `20270103090000`, SQL before app |
| `20270112090000` | CB-2 front-desk RLS | owner decision 3 (2026-10-24) | **approved**; in development (new session), stacked on #320 |


**Apply order and rollback**

- R2: apply the SQL before promoting the app. Every refund webhook calls the new RPCs. Roll back the app first, then the SQL. The R2 rollback refuses while any refund, exception or refund accounting evidence exists. The PROD preflight refuses if any competition payment already carries a refund (#292 PR body).
- SC1: the rollback restores the exact 10A guard body and the original grants; if scratch history exists it keeps the audit tables (#306 PR body). The soft-rollback path is NOT RUN.
- Release gate (found by R2 QA): the competition desk balance (`record_competition_checkin_payment`, `competition/checkin/actions.ts`) counts refunded money as balance due. Fix: balance = total − Σ amount. **R2 must not release before it** (W2).
- Order between R2 and SC1: both are Git-only. #306 and #292 touch `registrations/page.tsx` (trivial rebase); W1 owns the integration.

## 4. QA evidence ledger

Copied from PR bodies/comments. Nothing upgraded. Hosted databases: none touched by any slice.

### K0 (#291)
| Check | Result |
|---|---|
| `vitest run src/lib/competition` (25 files / 422 tests; K0 adds 20) | PASS |
| `tsc --noEmit` | PASS |
| `eslint src/lib/competition/results` | PASS |
| Runtime / UI / SQL behavior | N/A (no runtime code paths changed) |

A later PR comment (2026-10-23T19:04Z) reports the doc was updated for R2 C1/Q1/Q2: "Tests 25/25, tsc and eslint clean". PR body figures are from the earlier run.

### R2 (#292)
| Check | Result |
|---|---|
| R2 SQL suite (isolated local Postgres) | PASS (109 in the original body; 118 at `34295013`; 123 in W1 integration) |
| Forward/rollback round trip; second run refused; rollback refuses with evidence | PASS |
| Regression suites with vs without R2: PAY-WH-1 (114), PAY-WH-1A (66), 10C pricing parity (45) | PASS, identical with and without R2 |
| 10A/10C/10C.4/10C.5/10D/10D.1/REFUND-RECON suites on the cloned DB | Fail **at baseline** (privilege/ownership/ACL assertions, auth-schema drift); identical with and without R2. Rerun on a clean migration-built DB before PROD SQL |
| Regression on a migration-built database | **BLOCKED** (repo cannot reproduce PROD's line-ending-pinned chain; replay lacks `event_payments.event_id`; QA matrix §I) |
| Local app end-to-end, Stripe test mode, `stripe listen` (comment, head `34295013`): single-entry full refund; partial refund of one of three; fee-line refund; discounted order (net cap $20, $20.01 refused); double-submit; Stripe failure; dashboard partial + attribution; dashboard full refund of remainder; locked/danced heat (E-L); certified heat (E-C, "result stands"); wrong-event tampering (404 + RPC refusal); webhook replay; D3 application fee not refunded | PASSED |
| Network-error injection during create | **BLOCKED** (cannot be induced safely against Stripe test mode; unit-tested) |
| Mobile layout of refund page | **NOT RUN** |
| `tsc --noEmit` | PASS (clean for `src`) |
| vitest | PR body (earlier head): 7,891 passed, 3 failed (2 also fail on origin/main; 1 only under load, passes alone 39/39). Latest comment: 1,061 tests in affected areas pass |
| Independent payment-integrity review | No P0; four P1s fixed; P2 5–7 fixed; P2 8–10 documented (§8.1) |
| Not run (PR body) | End-to-end Stripe test-mode flows at the time of the first body; superseded by the comment above |

### K1 (#293)
| Check | Result |
|---|---|
| Docs only; diff touches exactly the three owned files | PASS (checklist item ticked) |
| Fixture arithmetic checked by hand against each stated option | PASS (checklist item ticked) |
| Owner sign-off of decisions | Stage 1 (X-1…X-7), Stage 2 (D-CT-1…10), Stage 3 (D-OM-1…5, D-OM-3b) and Stage 4 architecture APPROVED 2026-10-24. **Pending:** K1-U (UCWDC Majority Rules v16.9b), any studio medal method, NDCA and WSDC sources, D-CT-4 over-capacity process, S4-2 wording, S4-7 workflow, registry storage and slot. `proficiency_rating` rejected as a universal method and fail-closed |

No code or tests exist. **Scoring implementation (F1) stays blocked until the complete spec set and the pending Stage 4 methodology are recorded.** Head `79d32f5a` records Stages 1–3 (callback and ordinal fixtures reworked and hand-checked; F-OM-04 uses four judges and conflicts with X-3, flagged). Still unspecified: the auditable tie-break process for a callback tie over the final capacity (advancement blocked meanwhile), cross-heat combination of ordinal rankings, per-dance ballot keying, and where the final capacity enters the K0 envelope.

### CI-B (#295) — 20-row developer-owned matrix
| Rows | Result |
|---|---|
| 1–17 (concurrent same-ticket scans; repeat scan banner; two-ticket registration; group-class insert race and pre-existing row; unpaid ticket zero writes; manual whole-registration and single-attendee concurrency; legacy registration; role matrix with zero DB queries for refused roles; competition presence/batch/completion CAS; harness control proves the old pattern double-admits; mutation check) | PASS (unit, interleaving fake DB) |
| 18 front_desk reaches competition check-in | **BLOCKED** (needs SQL; now approved as CB-2, slot 0112, in development) |
| 19 Real PostgREST/DB concurrency against DEV | **BLOCKED** (no hosted DB access authorized) |
| 20 Browser walkthrough of check-in banners | **NOT RUN** |
| `tsc`, eslint on changed files | clean; vitest 7871 passed (one full run had unrelated flaky timeouts that pass alone) |

### Q1 (#297)
| Stage | Result |
|---|---|
| §9 stage 1 (create, wizard, publish, open registration) | PASSED (two consecutive local runs: 3 passed, 8 skipped) |
| Stage 2 (3 dancers + 1 guest register and pay; webhook settles; "Registration confirmed") | PASSED |
| Stage 3 (entry change + per-entry refund) | **BLOCKED** `test.fixme` (R2 / no entry-change UI) |
| Stage 4 (eligibility → check-in → bibs 101–108 → generate heats → publish running order) | PASSED |
| Stage 4 duplicate check-in scan rejected | **BLOCKED** `test.fixme` (R1/CI-B; no scan input) |
| Stages 5–10 (day-of, judging, recall/final, approval + draft-hidden, publication, closeout) | **BLOCKED** `test.fixme` |
| Teardown (0 `e2e-compfull-*` studios and 0 auth users left) | PASS |
| `tsc`, ESLint on new files | clean |
| Not run in CI | Playwright job gated on E2E secrets; spec also needs the flag and Stripe test values; whole file skips without them |

Gaps found (no app change): paid entries start `unverified` and the check-in session page has no eligibility control; a published running order is staff-only (no heat sheet for dancers/public); hosted Stripe Checkout card entry is not automated; duplicate competitor numbers not exercised.

### SC1 (#306)
| Check | Result |
|---|---|
| SC1 SQL suite (78 checks, isolated local Postgres) | PASS |
| Apply → full rollback → re-apply; guard md5 and lifecycle ACL restored; re-apply refused by preflight | PASS |
| Soft rollback with existing scratch history | NOT RUN in the original body; **PASS** in W1 integration (above) |
| Regression 10A/10B/10C/10C.5/10D/10D.1 with vs without SC1 | Identical; pre-existing clone failures unchanged |
| Unit tests `src/lib/competition` | PASS (418) |
| `tsc`, ESLint on changed files | PASS |
| Independent review | 0 P0; both P1s, in-scope P2s, P3-1…P3-5 fixed; P2-4 handed to R2; P3-6 left to server enforcement |
| Browser walkthrough F1–F13 (isolated Supabase CLI stack, 2026-10-24) | PASS (13 flows, DB-verified) |
| Concurrency (two sessions) | NOT RUN in the original body; **PASS** in W1 integration (above) |
| Mobile (375px) | Existing issue on every competition page; #311 (merged, "nav min-w-0") appears to be that separate fix; its QA was not read here |

### R2 + SC1 integration (W1, from the #306 PR body, 2026-10-24)
Database "CLI-crlf" = Supabase CLI stack with real Auth/Storage, July prod schema dump + 266 repo migrations in order (0103 then 0108), `20260831` replayed in CRLF; seven unrelated migrations not applying (details in #306 body). This clears the earlier "migration-built database BLOCKED" row for R2 on that stack; it is not a hosted database.

| Check | Result |
|---|---|
| R2 SQL suite (0103→0108) | PASS (123) |
| SC1 SQL suite | PASS (78) |
| 10A/10B/10C/10C.4/10C.5/10D/10D.1 | PASS (109/130/177/55/220/79/22) |
| PAY-WH-1 / PAY-WH-1A / 10C pricing parity | PASS (114/66/45) |
| REFUND-RECON-1/2 (rewards trigger disabled) | PASS (54/35) |
| Reverse apply order (0108 then 0103); combined rollback (SC1 then R2); R2 rollback refuses while SC1 live; combined rollback with evidence | PASS |
| SC1 two-session concurrency (25 with soft rollback); SC1 soft rollback with history; scratch vs R2 refund both orders | PASS, no deadlock |
| No scratch path writes refunds/allocations/scopes/accounting or touches order/payment/registration | PASS (20) |
| Combined `tsc --noEmit` | PASS |
| vitest `src/lib/competition` + `src/app/api/stripe` | 436 pass, 1 fail (`workspace.phase10b`, also fails on origin/main) |
| Same suites on a public-schema clone | NOT RUN |
| Stripe test-mode E2E on the combined app | NOT RUN |
| Network-error injection | BLOCKED |
| Independent review | 0 P0, 0 P1; three P2 fixed; P3 documented |

Defects found and fixed in R2 (SC1 unchanged); R2 pin `sync_competition_entries_from_registration` is now `3a19d4b4`. The R2×SC1 scripts live on the reference branch `competition-int-r2-sc1` (no PR) only. This supersedes the SC1 "Soft rollback" and "Concurrency" NOT RUN rows below.

### W2 desk balance (#320)
| Check | Result |
|---|---|
| Helper tests (6) + action tests (5; 3 fail on old code) + #295 race tests | PASS (10 in checkin dir) |
| `tsc` | PASS |
| SQL suite `test_T_competition_checkin_balance.sql` (13) on local `cib-bal-db` (DEV-schema clone with R2) | PASS |
| PAY-WH-1A suite before/after migration (66) | PASS / PASS |
| Rollback restores prior body (md5 `387aacac…`); re-apply idempotent | PASS |
| Independent money review | P1 fixed; P2s noted (order-total edits/over-collection unchanged) |
| Clean migration-built DB (iso-qa) | BLOCKED |
| Hosted DEV/PROD, deploy, live Stripe | NOT RUN |

Rule: `balance = max(0, order total − Σ amount)` over payments `paid`/`refunded`. Apply after R2 `20270103090000` and PAY-WH-1A, SQL before app; rollback app first. Merge order: #295, then #320.

### W4 K1 setup fixes (#322)
| Check | Result |
|---|---|
| New SQL suite on old body | FAIL as intended |
| New SQL suite on new body (23) | PASS |
| Apply → rollback to exact 10B md5 → re-apply | PASS |
| vitest `src/lib/competition` (25 files / 417 tests) | PASS |
| 10B/10C.5/10D/10D.1 suites before vs after | Verdicts identical (on a schema clone) |
| Clean baseline for those suites | BLOCKED (clone; environmental failures identical before/after) |
| `tsc --noEmit` | PASS |
| Independent review | No blocking findings |
| Browser/UI walkthrough | NOT RUN |
| Hosted DEV/PROD | NOT RUN |

Open (not decided here): D-CT-5 (callback target T owner/default/T ≥ entries); Final-only vs callback round in an empty category; post-publish edit policy for T.

### W5 closeout reads (#321)
| Check | Result |
|---|---|
| 26 vitest tests | PASS |
| SQL suite (17, incl. RLS for two studios) on local Postgres | PASS |
| TS model on rows captured under RLS; whole-project `tsc`, eslint | clean |
| Independent review | No P0; P1/P2 fixed |
| Rendering the page against a database | NOT RUN |
| Hosted DEV/PROD | NOT RUN |

Read-only; no SQL (slot 20270107 unused). Checklist shows PASS / BLOCKED / NOT AVAILABLE YET (desk balance waits for #320; publication/certification wait for F2/F3).

### SC1/CC1 docs (#301)
Docs only; no runtime paths changed. No tests run.

## 5. Open owner decisions (decided items moved to §1.5)

| Group | IDs | Question / default | Where |
|---|---|---|---|
| Gate | Walkthrough | Waived for Git-only E1/E2/O1 development (decision 4 above). **Mandatory before those PRs merge or deploy**, and still gates public registration (organizer and "this is me" walkthroughs) | Roadmap v2.22 l.140, l.165; §1.5 |
| K1 | D-PR-1…5 | `proficiency_rating` D-PR items: not decided; the three-band median proposal was REJECTED as a universal studio method (2026-10-24) and the key stays fail-closed. No studio medal method is approved | `scoring-architecture-decisions.md` §1.6 |
| CC1 | CC-D1…D8 | Credit owner, redeemable scope, default expiry, accounting categories, partial refund + credit on one item, transferability, fee lines, platform fees on future orders | #301 doc §5 |
| K1 Stage 4 | K1-U | UCWDC Majority Rules v16.9b full spec: **DRAFT written** (`engine-spec-ucwdc-majority-rules.md`, #293), independently verified WITH CORRECTIONS (`k1u-verification-report.md`; fixtures recompute identically); corrections C-1..C-5 applied after owner decisions of 2026-10-25: OQ-1 approved (16-value scale governs; 11 March 2026 newsletter is supporting evidence, file not yet pinned, sha256 pending), OQ-2 approved (AllStars/Spotlight use 6-medal Group-and-Rank), OQ-3 revised (no J>=3 guard; separate panel-eligibility check UNVERIFIED, J=1/2 fail closed, official panel-size source requested). Independent golden-fixture review DONE (`k1u-independent-fixture-review.md`, 32 fixtures, arithmetic agrees; D-3..D-11 applied). Owner dispositions 2026-10-25: D-1 approved (unselected = 0 on a valid completed ballot), D-2 BLOCKED (UCWDC Q1), D-4 approved for simple Prelims→Finals only (multi-Prelims/Semi-Finals UNAVAILABLE, Q2), G-13 BLOCKED (Q3, IR-22), panel eligibility BLOCKED (Q4). K1-U status: **spec verified for supported cases; method UNAVAILABLE pending UCWDC Q1–Q4**; draft questions in `ucwdc-clarification-questions.md` (not sent; owner sends). F1 for UCWDC stays blocked. D-6 remains open (fails closed). DRAFT. Source `2026-Scoring-Format-v16.9b-1.pdf` sha `44290a06` (lists the 16-mark ProAm/ProPro scale, HM = 26 down to GG★ = 11). A "March 2026" edition is unconfirmed | `scoring-architecture-decisions.md` §2 |
| K1 Stage 4 | Studio medal method | No studio medal feedback or placement method is approved | same |
| K1 Stage 4 | NDCA / WSDC | NDCA Skating System and WSDC Relative Placement: no authoritative algorithm source | same |
| K1 Stage 4 | S4-2 / S4-7 / registry | S4-2 disclosure wording; S4-7 draft-migration/duplication workflow design; registry storage and its migration slot | same |
| K1 | D-CT-4 over-capacity | Auditable tie-break process for a callback tie over the final capacity (a runoff is a candidate only); advancement blocked meanwhile | `engine-spec-callback-tally.md` |

K1 X-1…X-7, D-CT and D-OM moved to §1.5. S-D1 and S-D2 are recorded as applied in #306 (see §1.3). K0 O1–O5, R2 operational classification, CB-1 and CB-2 moved to §1.5. Remaining open: the Stage 4 pending methodology and the callback over-capacity tie-break process (both listed in this section), CC-D1…D8, the walkthrough gate for merge/deploy, and D-CT-5 (#322).

## 6. 16-stage lifecycle matrix

Legend: **MERGED** implemented and on main · **UNMERGED** built, in an open PR · **IN DEV** work in progress with no PR · **DESIGNED** spec/contract only · **BLOCKED** waiting on the owner · **MISSING** no design or code found.

| # | Stage | Status | Evidence |
|---|---|---|---|
| 1 | Setup | **MERGED** (10A–10C.5 per roadmap l.972–975, l.913); **UNMERGED** K1 setup fixes (#322, slot 0110) | Q1 stage 1 PASSED on local stack |
| 2 | Programs / rules | **MERGED** (10B workspace, `studio_simple@3` profile, 10C.5 wizard) | roadmap v2.22 |
| 3 | Discovery / registration | **MERGED**, public registration **HELD**, flag OFF | roadmap l.913; Q1 stage 2 PASSED locally |
| 4 | Payment / settlement | **MERGED** (CI-A, PAY-WH-1/1A/1B); refunds **UNMERGED** (#292, draft) | §4 R2 |
| 5 | Check-in | Baseline **MERGED**; atomic check-in **UNMERGED** (#295); desk balance **UNMERGED** (#320); front-desk RLS CB-2 **IN DEV** (slot 0112, approved) | §4 CI-B |
| 6 | Schedule & heats | **MERGED** (10D, 10D.1); owner walkthrough **BLOCKED** (open) | roadmap l.165; Q1 stage 4 PASSED |
| 7 | Day-of / scratches | 10D scratch/no-show **MERGED**; SC1 scratch workflow **UNMERGED** (#306); O1 day-of round control **IN DEV** (slot 0106; same walkthrough condition) | §4 SC1; K0 §4 |
| 8 | Officials / judges | **IN DEV** (E1, slot 0101; Git-only; walkthrough mandatory before merge/deploy) | K0 §12 |
| 9 | Ballots | **IN DEV** (E2, slot 0102; stacked on E1 + O1; same walkthrough condition) | K0 §3–4 |
| 10 | Engines | Specs **UNMERGED** (#293); Studio methods approved (callback tally, ordinal majority); architecture approved (scoring-architecture-decisions.md); `proficiency_rating` fail-closed; UCWDC, NDCA, WSDC unavailable; **F1 scoring code BLOCKED** until the spec set and pending methodology are recorded | §5 |
| 11 | Callbacks / recalls / placements | **DESIGNED** (K0 §6); engines not built; Q1 stage 7 `fixme` | K0 §6 |
| 12 | Approval | **DESIGNED** (D3 second-person rule, F2 slot 0104); K0 contract **UNMERGED** (#291) | K0 §4 |
| 13 | Publication + portals | **DESIGNED** (F3 slot 0105, D4); no heat sheet or results for dancers/public today | Q1 gap 2 |
| 14 | Corrections / disputes | Corrections **DESIGNED** (K0); disputes and chargebacks **MISSING** (listed as R2 follow-up) | K0 §4; #292 PR body "Follow-ups" |
| 15 | Reconciliation / closeout | **DESIGNED** (C1 writes slot 0107, K0 §10); closeout read models **UNMERGED** (#321, draft) | K0 §10 |
| 16 | E2E simulation | **UNMERGED** (#297): stages 1, 2, 4 PASSED locally; remainder `test.fixme` | §4 Q1 |

Roadmap line numbers cited above are from `origin/main` at `d535720d`.

## 7. Q1 definition-of-done stage table

Source: `e2e/tests/competition-full-event.spec.ts` on `competition-q1-sim-event-harness` head `6d46c837`. The spec is serial; stage numbers below are the spec's "stage N" names.

| Spec stage | What it must prove | Result | Depends on |
|---|---|---|---|
| 1 | Owner creates event, configures categories and pricing, publishes, opens registration | PASSED | merged |
| 2 | 3 dancer accounts + 1 guest register and pay; webhook settles | PASSED | merged |
| 3 | One entry changed, one cancelled with per-entry refund; totals reconcile | BLOCKED (`fixme`) | R2 (#292), entry-change UI |
| 4 | Check-in issues bibs; running order built; schedule published | PASSED | merged |
| 4 (dup) | Duplicate check-in scan rejected | BLOCKED (`fixme`) | CI-B (#295) plus a scan input |
| 5 | Day-of: heats run, one scratch recorded | BLOCKED (`fixme`) | SC1 (#306), O1 |
| 6 | 3 judges submit ballots; a paper ballot entered by the scorer; one ballot correction versioned with a reason | BLOCKED (`fixme`) | E1, E2 |
| 7 | Prelim with recall advances correct entries into a generated final; placements and a tie resolve per approved spec | BLOCKED (`fixme`) | K1 sign-off, F1, F2 |
| 8 | A second staff member approves; before approval no public/dancer/other-tenant user can see results | BLOCKED (`fixme`) | F2 (D3) |
| 9 | Publish; dancer sees only own entries; public page shows the published version; other studio sees nothing; correction republishes as v2 with audit trail | BLOCKED (`fixme`) | F3 (D4) |
| 10 | Closeout: exports, settlement reconciled (entry revenue minus refunds), program complete, event deletion blocked | BLOCKED (`fixme`) | C1, R2 |

Stage 3 and stage 4 duplicate-scan rows are the spec's own "fixme" markers; W3 is extending this harness locally (brief), so re-read before relying on this table.

## 8. Update log

| Date | Change |
|---|---|
| 2026-10-24 | Initial tracker (W6). Reconciled against main `d535720d`. |
| 2026-10-24 | Recorded four owner decisions (K0 O1–O5, R2 operational classification, CB-1/CB-2, walkthrough waiver for Git-only E1/E2/O1) in §1.5; K0 §11 updated on #291; reconciled #320, #321, #322; added E1/O1/E2/CB-2 as in development; refreshed heads of #291, #292, #306. |
| 2026-10-24 | Recorded K1 Stage 1 (X-1…X-7) approval. |
| 2026-10-24 | Recorded K1 Stage 2 (callbacks) and Stage 3 (ordinal majority) approvals; #293 head `79d32f5a`; F1 blocked until Stage 4. |
| 2026-10-24 | Recorded K1 Stage 4 scoring architecture (approved in principle) and its pending methodology; #293 head `c7e91cd8`. |
| 2026-10-24 | K0 amendment (E2/O1/E1 tables, split audit with F2 unified read, method-specific X-3) on #291, head `d8a84fa7`. |
| 2026-10-24 | K1-U draft UCWDC Majority Rules spec added on #293 (head `c9386777`); verification and owner approval pending. |
| 2026-10-24 | K1-U verification (verified with corrections) recorded; #293 head `f72f04a4`; OQ-1..OQ-3 open. |
| 2026-10-25 | Recorded K1-U owner decisions OQ-1, OQ-2, OQ-3 (revised); #293 head `a750e74f`. Newsletter file and panel-size source requested; independent fixture review pending. |
| 2026-10-25 | K1-U independent fixture review recorded; D-3..D-11 applied; #293 head `c69da750`; open owner/UCWDC questions listed. |
| 2026-10-25 | K1-U owner dispositions (D-1, D-2, D-4, G-13, panel) recorded; UCWDC clarification questions draft added; #293 head `648f202a`. |
| 2026-10-25 | K1-U spec restructured into source-confirmed / owner-approved / unanswered parts; Semi-Finals scope and D-4 statement fixed; all five hashes pinned; #293 head `aaffc9f5`; independent reviewer to re-verify. |
| 2026-10-25 | K1-U re-verification of aaffc9f5 (NOT PASS) applied: R-2, R-3, R-4, R-6 and nits; R-1 (G-1/G-3/G-8) and R-5 pending owner; #293 head `42d0c5d5`; reviewer re-checks. |
| 2026-10-25 | K1-U owner ruling on re-verification applied: owner-approved interpretations I-1..I-3 (G-1/G-3/G-8), R-5 refused as incomplete (Q5 added to draft questions), four categories in section 12; #293 head `a4f26f1f`; NOT PASS stands, K1-U not complete; reviewer re-checking. |
| 2026-10-25 | K1-U re-verification of a4f26f1f (NOT PASS) applied: N-1..N-4 and nits; #293 head `7b48abdc`; reviewer re-checking; K1-U still not complete. |
| 2026-10-25 | K1-U re-verification of 7b48abdc PASS recorded; section 3.3 carve-out nit fixed; #293 head `5fa47468`; reviewer asked to confirm. |
