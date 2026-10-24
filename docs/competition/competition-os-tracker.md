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

### 1.4 Other standing decisions this tracker relies on

- Functional QA is developer-owned; the owner gives business acceptance only (roadmap l.1039). Owner acceptance gates: Schedule & Heats walkthrough (gates 10E); organizer walkthrough and verified "this is me" walkthrough (gate public registration).
- Public Competition registration is HELD and the flag is OFF (roadmap v2.22 l.913). Public registration additionally needs CI-B, CI-D and the 10C.1 gates (l.140).

## 2. PR matrix

State as of 2026-10-24 (checks from `statusCheckRollup`; "CI" means the *Typecheck, build, lint, unit/integration tests* job). Playwright E2E is `SKIPPED` on every PR (gated on E2E secrets). Merge authorized: **none yet** for every row.

| PR | Slice | Head | Base | State | CI | QA evidence | Blocking item | Merge authorized |
|---|---|---|---|---|---|---|---|---|
| #291 | K0 scoring→results contract (docs + types, no SQL) | `a8c7c611` | main | OPEN | SUCCESS (+ Vercel) | §4 K0 | Owner O1–O5; Opus review | none |
| #292 | R2 / CI-D entry refunds (SQL `20270103`, webhook, staff flow) | `c32a693d` | main | OPEN, **draft** | Test job SUCCESS; Vercel qfem PENDING at read time | §4 R2 | Owner sign-off on exception classification; desk-balance release gate (W2); K0 correction-event tie-in; W1 R2+SC1 integration | none |
| #293 | K1 Studio v1 engine specs (docs only) | `7c197e42` | main | OPEN | no CI test job on this PR (docs only); Vercel SUCCESS | §4 K1 | Owner decisions D-OM / D-PR / D-CT / X-1…X-7 | none |
| #295 | CI-B atomic check-in (no SQL) | `399d90ce` | main | OPEN | SUCCESS (+ Vercel) | §4 CI-B | Owner acceptance: instructors lose event check-in (CB-1); front-desk competition check-in needs SQL (slot 0112, CB-2) | none |
| #297 | Q1 full simulated competition E2E (stages 1, 2, 4) | `6d46c837` | main | OPEN | SUCCESS (+ Vercel); spec skips in CI | §4 Q1 | Later stages are `test.fixme` until their slices exist; W3 extension in progress locally (brief) | none |
| #301 | SC1/CC1 scratch policy + credit design (docs only; also edits roadmap Phase 10) | `1d87deda` | main | OPEN | Vercel SUCCESS | Docs only | Owns the roadmap Phase 10 edit; owner S-D1/S-D2 recorded as applied in #306; CC-D1…D8 open | none |
| #306 | SC1 scratch workflow (SQL `20270108`) | `e4b7a57e` | main | OPEN, **draft** | Test job SUCCESS; Vercel PENDING at read time | §4 SC1 | Owner review; 2-line trivial rebase with R2 on `registrations/page.tsx`; R2 must leave `scratched` entries alone (review P2-4, since addressed in #292 head per its PR comments) | none |
| #311 | Competition workspace mobile overflow (nav `min-w-0`) | — | main | **MERGED** `fd5e31a6` (2026-10-24T13:36:57Z) | — | Not read here | — | n/a |
| W2 | Desk balance fix (stacked on #295, slot `20270111`) | no remote branch/PR found at read time | #295 | pending | — | — | Depends on #295 | none |
| W4 | K1 setup fixes (slot `20270110`) | no remote branch/PR found at read time | main | pending | — | — | — | none |
| W5 | Closeout read models (C1 reads) | no remote branch/PR found at read time | main | pending | — | — | — | none |

Heads moved during this reconciliation: #292 was `a27e943c` (a merge of origin/main produced `c32a693d`), #306 was `8f6e7874` (now `e4b7a57e` after a merge of origin/main). Re-read before relying on a SHA. Local branches exist for W2 (`competition-cib-desk-balance`), W4 (`competition-k1-setup-fixes`) and W5 (`competition-c1-closeout-reads`) but none is pushed. Fill in PR numbers when they open.

## 3. Migration slot ownership

Main has no `2027*` migrations (latest on main: `20261230090000_twilio_rfl_pilot_spend_evidence.sql`). Slots are reservations; nothing below is applied anywhere.

| Slot | Owner | Source | Status |
|---|---|---|---|
| `20270101090000` | E1 officials | K0 §12 | not built |
| `20270102090000` | E2 ballots | K0 §12 | not built |
| `20270103090000` | **R2** entry refunds | K0 §12; #292 | in #292, unmerged, local-DB only |
| `20270104090000` | F2 results lifecycle | K0 §12 | not built |
| `20270105090000` | F3 publication + read RPCs | K0 §12 | not built |
| `20270106090000` | O1 day-of (schedule/start/cancel round) | K0 §12 | not built |
| `20270107090000` | C1 closeout | K0 §12 | not built (writes) |
| `20270108090000` | **SC1** scratch | #301 doc §4.3; #306 | in #306, unmerged, local-DB only |
| `20270109090000` | CC1 credit | #301 doc §4.3 | design only |
| `20270110` | K1 setup fixes (W4) | brief | reserved |
| `20270111` | Desk balance (W2) | brief | reserved |
| `20270112` | Front-desk RLS | brief | reserved, **pending owner** (CB-2) |

The brief gives the O1 / C1 / E1 / E2 / F2 / F3 names; the "0104 F2, 0105 F3" labels in the brief match K0 §12. Slots 0110–0112 are not written in any Git file yet.

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
| R2 SQL suite (isolated local Postgres) | PASS (109 checks in PR body; **118** in the latest PR comment, head `34295013`) |
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
| Owner review and sign-off of decisions | **NOT DONE** (unticked) |

No code or tests exist. Engines stay unavailable (`COMP_ENGINE_NOT_AVAILABLE`) until sign-off.

### CI-B (#295) — 20-row developer-owned matrix
| Rows | Result |
|---|---|
| 1–17 (concurrent same-ticket scans; repeat scan banner; two-ticket registration; group-class insert race and pre-existing row; unpaid ticket zero writes; manual whole-registration and single-attendee concurrency; legacy registration; role matrix with zero DB queries for refused roles; competition presence/batch/completion CAS; harness control proves the old pattern double-admits; mutation check) | PASS (unit, interleaving fake DB) |
| 18 front_desk reaches competition check-in | **BLOCKED** (needs SQL helper + RLS change; no migration slot) |
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
| Soft rollback with existing scratch history | **NOT RUN** (code path reviewed only) |
| Regression 10A/10B/10C/10C.5/10D/10D.1 with vs without SC1 | Identical; pre-existing clone failures unchanged |
| Unit tests `src/lib/competition` | PASS (418) |
| `tsc`, ESLint on changed files | PASS |
| Independent review | 0 P0; both P1s, in-scope P2s, P3-1…P3-5 fixed; P2-4 handed to R2; P3-6 left to server enforcement |
| Browser walkthrough F1–F13 (isolated Supabase CLI stack, 2026-10-24) | PASS (13 flows, DB-verified) |
| Concurrency (two sessions) | **NOT RUN** (lock order reviewed, no two-session test) |
| Mobile (375px) | Existing issue on every competition page; #311 (merged, "nav min-w-0") appears to be that separate fix; its QA was not read here |

### SC1/CC1 docs (#301)
Docs only; no runtime paths changed. No tests run.

## 5. Open owner decisions

| Group | IDs | Question / default | Where |
|---|---|---|---|
| K0 | O1 | Absent judge: may a round lock with fewer ballots than assigned judges? Default: fail closed | K0 §11 |
| K0 | O2 | Who may lock ballots: manager only or also a chair? Default: manager or chair | K0 §11 |
| K0 | O3 | Judge names/letters on public results? Default hidden | K0 §11 |
| K0 | O4 | Is a withdrawn publication explained publicly? Default generic notice | K0 §11 |
| K0 | O5 | Relax §6 (correcting an earlier round after the next round has ballots)? Default blocked | K0 §11 |
| R2 | Operational classification | Sign-off that all four `competition_refund_*` exception kinds are `operational` (alert, reopen on recurrence) | #292 PR body "Open items" |
| CI-B | CB-1 | Owner acceptance that `instructor` and `independent_instructor` can no longer run event check-in | #295 PR body ("Behavior change") |
| CI-B | CB-2 | Front-desk access to competition check-in: SQL helper + RLS + page-level gates; slot 0112 reserved | #295 PR body; slot per brief |
| Gate | Walkthrough | Owner Schedule & Heats walkthrough gates E1/E2 (10E) | Roadmap v2.22 l.140, l.165 |
| K1 | D-OM-1…5 | `ordinal_majority`: how ordinals combine, what "majority" means, tie-break chain, judge ties, complete rankings | #293 PR body |
| K1 | D-PR-1…5 | `proficiency_rating`: how bands combine, majority fallback, outcomes beyond Gold/Silver/Bronze, what is shown, complete marks | #293 PR body |
| K1 | D-CT-1…10 | `callback_tally`: mark shape, quota, tally, ties at the cut, target count, placements for non-called-back, roles, callback rounds under `@3`, multi-heat quotas, carry-forward | #293 PR body |
| K1 | X-1…X-7 | Cross-cutting: where decided values live (`studio_simple@4` vs `@1`/`@3`), fail-closed confirmation, panel size, absent judges, scratches, multi-dance rounds, multi-heat rounds | #293 doc §10 |
| CC1 | CC-D1…D8 | Credit owner, redeemable scope, default expiry, accounting categories, partial refund + credit on one item, transferability, fee lines, platform fees on future orders | #301 doc §5 |

The brief's "K1 D-OM/D-PR/D-CT/X" matches the ID families above. S-D1 and S-D2 are recorded as applied in #306 (see §1.3).

## 6. 16-stage lifecycle matrix

Legend: **MERGED** implemented and on main · **UNMERGED** built, in an open PR · **IN DEV** work in progress with no PR · **DESIGNED** spec/contract only · **BLOCKED** waiting on the owner · **MISSING** no design or code found.

| # | Stage | Status | Evidence |
|---|---|---|---|
| 1 | Setup | **MERGED** (10A–10C.5 per roadmap l.972–975, l.913); **IN DEV** K1 setup fixes (W4, slot 0110) | Q1 stage 1 PASSED on local stack |
| 2 | Programs / rules | **MERGED** (10B workspace, `studio_simple@3` profile, 10C.5 wizard) | roadmap v2.22 |
| 3 | Discovery / registration | **MERGED**, public registration **HELD**, flag OFF | roadmap l.913; Q1 stage 2 PASSED locally |
| 4 | Payment / settlement | **MERGED** (CI-A, PAY-WH-1/1A/1B); refunds **UNMERGED** (#292, draft) | §4 R2 |
| 5 | Check-in | Baseline **MERGED**; atomic check-in **UNMERGED** (#295); desk balance **IN DEV** (W2); front-desk RLS **BLOCKED** by owner (slot 0112) | §4 CI-B |
| 6 | Schedule & heats | **MERGED** (10D, 10D.1); owner walkthrough **BLOCKED** (open) | roadmap l.165; Q1 stage 4 PASSED |
| 7 | Day-of / scratches | 10D scratch/no-show **MERGED**; SC1 scratch workflow **UNMERGED** (#306); O1 day-of round control **DESIGNED** (slot 0106) | §4 SC1; K0 §4 |
| 8 | Officials / judges | **DESIGNED** (E1, slot 0101); **BLOCKED** by walkthrough | K0 §12 |
| 9 | Ballots | **DESIGNED** (E2, slot 0102); **BLOCKED** by walkthrough | K0 §3–4 |
| 10 | Engines | Specs **UNMERGED** (#293) awaiting owner decisions; engine code **MISSING** (fails closed) | §5 |
| 11 | Callbacks / recalls / placements | **DESIGNED** (K0 §6); engines not built; Q1 stage 7 `fixme` | K0 §6 |
| 12 | Approval | **DESIGNED** (D3 second-person rule, F2 slot 0104); K0 contract **UNMERGED** (#291) | K0 §4 |
| 13 | Publication + portals | **DESIGNED** (F3 slot 0105, D4); no heat sheet or results for dancers/public today | Q1 gap 2 |
| 14 | Corrections / disputes | Corrections **DESIGNED** (K0); disputes and chargebacks **MISSING** (listed as R2 follow-up) | K0 §4; #292 PR body "Follow-ups" |
| 15 | Reconciliation / closeout | **DESIGNED** (C1 writes slot 0107, K0 §10); closeout read models **IN DEV** (W5) | K0 §10 |
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
