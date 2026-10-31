## CF1 A7 — OD-13 correction-ballot integrity (Option R), judge-entry co-sign, ballot-correction storage

Closes the scope gap named in `cf1-a0-contract.md` ("Status / not delivered"): approved OD-13 Option R, OD-13b C, OD-13c A, OD-19 D. Local only: no hosted DB, deploy, merge, Stripe/Twilio/Resend or activation. Draft.

**Stack:** `cf1/a0-core` + `cf1/a3-results-integrity` + `cf1/a5-exclusion-action` (the three were siblings; merged cleanly into this branch). Migration slot `20270120096000` (free on every remote branch when checked).

### What it adds
Tables `event_competition_correction_causes`, `…_correction_cosigns`, `event_competition_ballot_corrections` (insert-only, RLS on, no grants, ENABLE ALWAYS history triggers); status-edge trigger deriving the cause (no caller input); `cosign_competition_correction`; read RPC `competition_round_correction` (extra); pinned text-replace of `_compe2_insert_ballot` (3 single-line anchors, md5 pre `4e167401…` / post `e5cecd7b…` from an applied chain); deferred commit-time backstops; P-1 reader inventory; contract doc `cf1-a7-contract.md`.

### Departure from the design text — needs coordinator/owner eyes
Design §4.1 says a new exclusion during an open correction is refused. §4.6 route (4) and A5's contract do the opposite (open the F2 correction first, then record the exclusion). A7 does **not** add the refusal; Option R reads the newly-excluded set live, so ballots are never less restricted than the design, and the cause row stays immutable. Details in `cf1-a7-contract.md`.

### QA matrix (QA Postgres container from `ns1-base:snap`, chain NS1…HL1, A1, A0, A3, A5, A7; supabase_admin)
| Item | Result |
|---|---|
| Migration applies on the composed chain | PASS |
| Pins: pre `4e16740112345ac0c306e841b82ac473`, post `e5cecd7b4cff91bbdb7222cc5061b4d9`, each anchor exactly once | PASS |
| A7 SQL suite (cause derivation incl. baseline/calculated/mixed, Option R accept/refuse cases, Option F co-sign rules, mid-correction exclusion, backstops, immutability, grants, pins, read RPC, event-delete cascade) | PASS (63 checks, 1 blocked = the .sh) |
| A7 concurrency script (concurrent filers; filing vs co-sign lock; ballot vs round lock) | PASS (3 probes) |
| Rollback then fingerprint vs pre-A7; re-apply fingerprint vs post-A7 | PASS (only difference: ACL noise from a QA-only `grant … to postgres` I added to the SNAP image) |
| Regression: E2 (211), E2-P1FIX (10), F2 (198), CX1 (15), HL1 (42), SS1 advancement freeze (13), A0 (128, 4 blocked), A5 (173, 4 blocked) | PASS |
| NS1 suite | FAIL, pre-existing: trigger-count assertion (A0 adds a 5th heat-entries trigger; noted in `cf1-a0-contract.md`) — not caused by A7 |
| A3 suite, A1 suite, SS1 round-lock suite | FAIL on this composition, pre-existing and unrelated to A7 (A0's heat-entry writer guard vs. those suites' fixtures; capacity direct write) — see A0 contract addenda; not re-triaged here |
| Hosted DB / grants | NOT RUN (out of scope) |
| App/UI (B) consumption of the new RPCs | NOT RUN |
| Independent security review | see PR comment |
| Owner-role bug found by regression and fixed in the migration | On the SNAP image `_compe2_insert_ballot` is owned by `postgres` while the migration runs as `supabase_admin`; the helpers need an explicit grant to the owner (same pattern as A0 §9b). Added as §6b. |

### Not in this PR
UI, server actions, F3 publication, `COMP_CORRECTION_EXCLUSION_DURING_CORRECTION` (see above), backfill of corrections already open (none can exist hosted).

### Independent security review (separate read-only reviewer, given the code not my conclusions)
No Critical/High. Addressed in the migration: (M1) postflight now checks the applying role can execute the functions the A7 helpers call (owner mismatch would otherwise break every correction open); (M2) `callback_yes@N`, N<>1, now raises `COMP_CORRECTION_FORMAT_UNSUPPORTED` instead of skipping the rule, and the backstop no longer filters on version; header comment corrected (L5). Re-run after these edits: A7 suite 63 PASS, concurrency 3 PASS, E2/F2/CX1/A0 PASS.
Accepted/flagged for the owner (not changed):
* L3: open correction -> recalculate without replacing the excluded picks -> open again makes the baseline the newest version, so X is empty and the cause is `judge_entry_error`; any pick may change but only after a co-sign by a different person. Confirm this matches §4.1 intent.
* L4: the opener is not barred from filing a replacement ballot (only the co-signer is). A manager who is also an official could open, obtain a colluding co-sign, and file. Confirm against §4.7.
* L6: the co-signer prior-filer check uses `submitted_at >= cause.at` (transaction start time); no exploitable path found because the round lock queues the filer ahead of the co-sign.
