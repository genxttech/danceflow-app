# CF1-C browser acceptance, runs 10-32 (2026-10-31 / 2026-11-01)

**System under test (SUT):** local `cf1/integration` 17250a4e + CF1 B commits 0da55ea3 (co-sign panel, Final heat-size control), 2e4de6e1 (results/ballots pages 404 only on authz/not-found) and 14408619 (co-sign line is plain text), plus the local QA-only engine registration patch in `src/lib/competition/results/engineAdapter.ts` (registers the F1 studio engines; not part of any PR). Production build (`next start -p 3100`) against the local Supabase stack `cf1c-qa`.
Runs 10-26 used 17250a4e + the engine patch only (no B commits); runs 27-32 used the SUT above.
Nothing hosted was touched. No Stripe calls. **Payment records are fixture-seeded**, not real Stripe settlement evidence.
Run artifacts (outside the repository): `C:\Dev\cf1c-qa-run\runs\r10`..`r32`.

## Scenario results (final runs on the SUT above: r31 advancement, r32 regression)

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
| SCN-X2 | BLOCKED (not exercised) | stub; the reversal needs the cause cleared, which the eligibility control can now do; not yet written |
| SCN-11.4b, SCN-11.4b-cap | **FAIL as authored: discrepancy** | the Final capacity is now settable before the Final has a heat (B Final heat size section) and the callback event builds with capacity 4. With a tie over capacity the F1 callback-tally engine fails closed (COMP_ENGINE_UNSPECIFIED_CASE, reason tie_over_capacity, no rows) and the desk shows "no result was produced". The scenario (and the capacity RPC's "blocked-tie version" model, rows with advanced = null) expects a completed calculation with no advanced flags. Needs an owner decision (F1 engine vs A0/A3/B model); contract not changed here. |

## Intermittent second-manager 404: resolved as infrastructure + a product error-handling defect
Runs 15 and 17 showed a 404 on the results page for the second manager. Independent investigation: the local Kong gateway returned a 502 ("upstream prematurely closed connection", keepalive race) on the POST to `/rest/v1/rpc/competition_round_results_review`, and the page did `if (error || !data) notFound()`, so a transport error rendered as a 404. Session, role, workspace and round resolution were fine in the failing requests; Postgres logged no error. Not an authorization or data-consistency fault. Product fix: B 2e4de6e1 (only authz/not-found errors 404; others throw). Confidence about 90% (the join is by timing and endpoint). Harness fix still open: Kong upstream keepalive on the QA stack.

## Harness fixes in this PR
Ballot submits wait for the `?saved=`/`?error=` redirect; alerts target `main [role="alert"]`; lock refusal read from the page alert; action timeout 90 s; de-duplicated scoring setups; fixture cleanup deletes events by cascade; Stripe client removed (fixture-seeded payments).
