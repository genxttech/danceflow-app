# CF1-C browser acceptance, runs 10-35 (2026-10-31 / 2026-11-01)

**System under test (SUT):** local `cf1/integration` 17250a4e + F1 engine 4c9cefc6 (PR #337, over-capacity tie returns an unresolved result) + CF1 B commits 3b7aa59c (unresolved-tie panel), 0da55ea3 (co-sign panel, Final heat-size control), 2e4de6e1 (results/ballots pages 404 only on authz/not-found) and 14408619 (co-sign line is plain text), plus the local QA-only engine registration patch in `src/lib/competition/results/engineAdapter.ts` (registers the F1 studio engines; not part of any PR). Production build (`next start -p 3100`) against the local Supabase stack `cf1c-qa`.
Runs 10-26 used 17250a4e + the engine patch only (no B commits); runs 27-32 used the SUT above.
Nothing hosted was touched. No Stripe calls. **Payment records are fixture-seeded**, not real Stripe settlement evidence.
Run artifacts (outside the repository): `C:\Dev\cf1c-qa-run\runs\r10`..`r32`.

## Scenario results (final runs: r34 advancement, r35 regression)

| Scenario | Result | Notes |
|---|---|---|
| SCN-0c setup | PASS (setup, not a scenario) | |
| SCN-11.4a, SCN-11.5 | PASS | |
| SCN-11.5b | PASS, **through the UI** | judge-entry correction co-signed by a different manager on the results page (B panel); no RPC. Earlier runs 14/16/17 were RPC-assisted (superseded). |
| SCN-11.5c-cancelled | PASS | Final cancelled through the Day-of "Cancel round" control (reason required) |
| SCN-11.5c-locked | PASS | Final scheduled through Day-of, early-locked on the ballots desk, correction refused COMP_ADVANCEMENT_FINAL_LOCKED, heat reopened with a reason |
| SCN-11.5c-started, SCN-11.5c-ballot | PASS | |
| SCN-R80, SCN-R83 | PASS | |
| SCN-R81 | PASS for "Final only (ordinal majority)": clean round passes and an ineligible couple (registrations page, predicate P clause ii) is refused at lock. "Callbacks + Final" is covered by the callback scenarios, not by R81's driver. | cancelled/refunded variants (P clause iii) have no UI until R2 refunds (#292) |
| SCN-X1 | PASS | request exclusion, different manager co-signs, judges re-rank, lock/calculate/approve, review shows "Excluded from the ranking" |
| SCN-R82 | BLOCKED (not exercised) | no UI creates an entry without a registration; SQL gate U82 PASS |
| SCN-X2 | PASS (r37) | reversal refused while the couple is still ineligible (COMP_EXCLUSION_STILL_UNAVAILABLE, nothing written); after eligibility is restored on the registrations page the reversal is requested, the requester cannot co-sign it, a different manager co-signs, and the round locks, calculates and approves with all four couples ranked |
| SCN-11.4b, SCN-11.4b-cap, SCN-11.4b-resolve | PASS (r34) | owner policy 2026-11-01 (see cf1-tie-over-capacity-decisions-2026-11-01.md): the F1 engine now completes with every row advanced = null and per-row tie_status; the desk shows an "Advancement unresolved" panel (scores, couples above the cut, couples tied at the cut, why nothing advanced); no Approve or Advance control is offered; nothing is written; a capacity raise to fit the tie is refused; a co-signed judge-entry correction dissolves the tie, version 1 stays unresolved on record and version 2 advances four. Approve refusal itself is proven in SQL (the control is absent in the browser). No tie-breaker or director override was built (rules decisions RD-1..RD-6 open). |

## Intermittent second-manager 404: resolved as infrastructure + a product error-handling defect
Runs 15 and 17 showed a 404 on the results page for the second manager. Independent investigation: the local Kong gateway returned a 502 ("upstream prematurely closed connection", keepalive race) on the POST to `/rest/v1/rpc/competition_round_results_review`, and the page did `if (error || !data) notFound()`, so a transport error rendered as a 404. Session, role, workspace and round resolution were fine in the failing requests; Postgres logged no error. Not an authorization or data-consistency fault. Product fix: B 2e4de6e1 (only authz/not-found errors 404; others throw). Confidence about 90% (the join is by timing and endpoint). Harness fix still open: Kong upstream keepalive on the QA stack.

## Harness fixes in this PR
Ballot submits wait for the `?saved=`/`?error=` redirect; alerts target `main [role="alert"]`; lock refusal read from the page alert; action timeout 90 s; de-duplicated scoring setups; fixture cleanup deletes events by cascade; Stripe client removed (fixture-seeded payments).

## Release-gate reconciliation (RB1(b) needs U80-U83 and U85 on the composed chain with the OD-17 protections)
| Gate | SQL evidence | Browser evidence | Status / decision needed |
|---|---|---|---|
| U80 non-callback regression | A3 DB checks PASS | SCN-R80 PASS (r35) | met |
| U81 each discipline family and scoring method | A3 DB checks PASS (5 labelled) | R81 PASS for "Final only (ordinal majority)" (clean round passes, ineligible couple refused at lock); "Callbacks + Final": callback scenarios 11.4a/11.5 and X1/X2 cover the ordinal Final, the callback roster-unavailable arm at lock is SQL-only | **owner decision**: accept "scoring setups the UI offers" = the two setups the wizard lists, with the callback unavailable-couple lock refusal proven in SQL only, or require a browser scenario for it |
| U82 comped/manual entries | A1, A3 PASS (9 labelled) | none: no UI creates an entry without a registration (R82 not exercised) | **owner decision** (matrix row says "UI half only if a screen exists"): record U82 as SQL-only because no screen exists, or require the screen first |
| U83 byte-identical evidence | A3 PASS (2 labelled) | SCN-R83 PASS (r35) | met |
| U85 existing suites | 13 suites PASS on composed chain; A1 suite PASS 132 checks / 5 blocked on the A1-only chain and on the A1+A0..A7 chain (an earlier "no verdict" came from a stale suite copy lacking commit ff115943; the runner logs an empty verdict silently, fix recommended, not applied) | n/a (SQL gate by definition) | met on SQL |
OD-17 protections remain disabled for live events; RB1(b) is not closed by any of this.

## Local gateway 502 (kept separate from the harness)
Kong (local QA stack) returns 502 to occasional RPC POSTs ("upstream prematurely closed connection", keepalive race). Effects seen: a 404 on the results page (before B 2e4de6e1 stopped mapping 5xx to 404) and a panel status of "Unknown". The harness now reloads and retries the panel status; that masks, not fixes, the stack fault. Not fixed: Kong upstream keepalive on the QA stack (not production; production has no Kong in the path).
