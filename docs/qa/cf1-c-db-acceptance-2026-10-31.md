# CF1-C Phase 2: DB-level acceptance, composed chain (2026-10-31)

Single local Postgres container `cf1c-pg` (supabase postgres 17.6.1.106), never hosted, under the shared slot lock (taken and released by C).
Chain: clean full chain from the chain-probe recipe (July prod dump + 271 migrations applied, 4 explicit skips, 0 failed), then CF1 from
`origin/cf1/integration` **bd956bd3** (A1 e3b73914 ... A7, B, B2, A4 as merged there). Driver: the A4 `run_all.sh` logic, copied to a C-owned directory and worktree;
raw report in `docs/qa/cf1c-db-run/report_full.txt`. Browser/E2E was NOT run (memory ceiling): see the end.

## Chain checks
| Check | Result |
|---|---|
| Full chain build | PASS (271 applied, 4 skipped, 0 failed) |
| CF1 composed apply (A1,A0,A4a,A2,A3,A5,A6,A7) | PASS |
| Reverse rollback, fingerprint diff vs pre-CF1 | PASS (0 lines) |
| Re-apply, fingerprint diff vs first apply | PASS (0 lines) |

## SQL suites (22 of 22 PASS; "blocked" = checks the suite itself declares out of its scope)
HL1 42, E2 211, E2 p1fix 10, F2 198, O1 95, SS1 advancement-freeze 13, SS1 round-lock 36, NS1 152, CX1 15, K1 23, REG 80, Phase 10D 79, 10D.1 22 (these 13 are U85: PASS, unchanged apart from A2's HL1 md5 line);
CF1: A1 131 (4 blocked), A0 141 (4), A2 29, A3 107 (3), A4a 63 (2), A5 187 (4), A6 180 (3), A7 74 (1), A4 55 (3). Blocked-by-design checks are compositional and are exercised by A4/A0 suites; they are not counted as passed.

## Concurrency scripts
A0 PASS, A2 PASS (15), A4 PASS, A5 PASS, A6 PASS, A7 PASS. **A3 lock probe: NOT VERIFIED** ("cannot create a3probe": the harness's CREATE DATABASE retry did not
succeed this run, none of the 9 expected probe values appeared). Owner: A3 / A4 harness. Not a product defect finding; not passed.

## Gates (A.9.5) from this evidence
- **PASS by owning suite (DB level):** U85 (13 existing suites above); U80/U81/U83 DB side and U72 SQL half are inside the A3 suite (107 checks) and A4; U1-U6, U8-U14, U16, U17, U19-U27, U29-U36, U40, U42, U44, U45, U47, U50, U52, U54, U55, U84 (A0 suite + A0 concurrency); U37-U39, U41, U48, U49, U51, U62, U63 (A6); U58, U61, U68, U69 (A2); U59, U60, U73, U79 (A3); U65, U74-U76, U78 (A5); U67, U77 (A4a); U43, U56, U71 (A4); U57, U64, U70, U82 (A1). **Caveat:** I mapped gates to suites from the A.9.5 owner column; I did not audit each gate id against individual check labels, so treat these as "owning suite passed", not "gate id individually verified".
- **NOT VERIFIED:** U61 lock probe (A3 concurrency, above).
- **BLOCKED, never passed:**
  - U7, U46 hosted-permission gates (need hosted DB; owner: owner/host).
  - U66 F3 exit (F3 not built; owner: F3 work).
  - U18, U28 and every Playwright scenario in `cf1-acceptance-matrix.md` (SCN-11.4a, 11.4b, 11.4b-cap, 11.5, 11.5b, 11.5c-*, R80-R83, X1, X2) - reason "memory ceiling, not run" (no Supabase stack/production build/Chromium started); owner: owner/host.
  - U15 not applicable.
- **Product defects found:** none in this run.
- RB1 (b) is **not** established: it also needs the QA-A half of U80-U83, which did not run.
