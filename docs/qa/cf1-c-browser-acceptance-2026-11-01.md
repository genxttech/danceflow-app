# CF1-C browser acceptance, runs 10-18 (2026-10-31 / 2026-11-01)

System under test: local `cf1/integration` 17250a4e, production build (`next start -p 3100`) against the local Supabase stack `cf1c-qa`.
Nothing hosted was touched. No Stripe calls. **Payment records are fixture-seeded**, not real Stripe settlement evidence.
Run artifacts (outside the repository): `C:\Dev\cf1c-qa-run\runs\r10`..`r18` (results.json, traces, screenshots).

## Scenario results (best run on the same tree)

| Scenario | Result | Evidence run | Notes |
|---|---|---|---|
| SCN-0c setup | PASS (setup, not a scenario) | r17, r18 | |
| SCN-11.4a | PASS | r14, r16, r17 | r15: FAILED with a 404 for the second manager (see open defect) |
| SCN-11.5 | PASS | r14, r16, r17 | |
| SCN-11.5b | PASS, **RPC-assisted** | r14, r16, r17 | the judge-entry correction co-sign is called through `cosign_competition_correction` (owner session, not service role); the app has no screen for it |
| SCN-11.5c-started | PASS | r17 | |
| SCN-11.5c-ballot | PASS | r17 | |
| SCN-R80 | PASS | r18 | r17: FAILED with the same second-manager 404 |
| SCN-R83 | PASS | r18 | |
| SCN-11.4b, 11.4b-cap | BLOCKED | r17 | no UI sets the Final capacity before the Final has a heat |
| SCN-11.5c-locked | BLOCKED | r17 | Final is Draft after advancement; Lock heat is offered only for scheduled/active rounds |
| SCN-11.5c-cancelled | BLOCKED (not exercised) | r17 | no UI cancels a Final |
| SCN-R81 | BLOCKED (not exercised) | r18 | no UI to cancel/refund one registration |
| SCN-R82 | BLOCKED (not exercised) | r18 | no UI creates an entry without a registration |
| SCN-X1 | BLOCKED, reclassified after r18 | r18 | failed run 18 on the same missing-UI precondition; the reclassification to BLOCKED has **not been re-run** |
| SCN-X2 | BLOCKED (not exercised) | r18 | |

## Open defect: intermittent second-manager 404
Run 15 (SCN-11.4a) and run 17 (R80): the second manager got 404 on `/competition/results/<round>` right after sign-in. Runs 14, 16, 18 passed with the same flow. No database error was logged at those times. Unexplained; traces for r15 and r17 are kept. Not dismissed.

## Harness fixes in this commit
- Ballot submits wait for the `?saved=`/`?error=` redirect (a standing correction-window status banner made the old wait return early and the reload cancelled the submit).
- Alert assertions target `main [role="alert"]` (Next's route announcer also has role=alert).
- 90 s action timeout, 60 s expect timeout (a missing control hung 40 minutes in run 14).
- `cosignCorrectionViaRpc` helper (labelled RPC-driven in evidence).
- Stripe client removed from the regression spec; fixture-seeded payments only.
- Fixture cleanup deletes the event by cascade first (CF1 history guards refuse row deletes).
