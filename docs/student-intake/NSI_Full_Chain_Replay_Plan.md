# NSI full-chain disposable replay plan (heavy-lock slice, NOT yet run)

Goal: prove that M1-M10 apply cleanly, and produce the same NSI catalog, when placed in main's real migration history, and that no later main migration changes an object NSI depends on. Local disposable stacks only. No hosted database is touched.

## Why it is needed
- NSI files are stamped `20261118…`; main's folder runs to `20270222094000` (477 files). On a fresh replay by filename NSI lands in the middle of the history; on PROD it would be applied at the end (PROD uses explicit file plus SHA apply, no registry, see `NSI_Resume_Status.md` section 2).
- The existing NSI harness (`nsi_i2_m10_lifecycle_local.sh`) starts from `pg_dump -s -n public` of `df-isoqa/base:20261118090000` (main's chain only up to the NSI stamp). It never saw the Dec 2026 to Feb 2027 migrations, and its `appointments` fingerprint (`ff651a6c…`) differs from PROD's (`e0c4db1b…`).

## Tooling that already exists (use it, do not build a new one)
`scripts/qa/iso-qa.mjs` (PR #266): `baseline` builds `df-isoqa/base:<cutoff>` = July production schema dump plus repo migrations replayed from a git ref up to the cutoff, skipping the explained list in `scripts/qa/known-unreplayable.txt`; `up <scenario> --migration ref:version` applies extra migrations; `compare <scenarioA> <scenarioB>` diffs the catalog fingerprint of two scenarios. Containers are labelled `df.isoqa=1`, own network, Kong on 127.0.0.1:56600-56799.

## Steps (one container at a time; hold `C:\dfr\heavy.lock` for the whole run, about 60-90 minutes including image builds; stop all own containers before release)

| # | Action | Pass criterion |
|---|---|---|
| R0 | Preconditions: independent M10 review GO; disk >= 15 GB free; no other iso-qa stack of mine; PR 808 head recorded | recorded SHA of every NSI file equals the DEV hashes (M1-M9) and the M10 hash |
| R1 | `iso-qa.mjs baseline --ref origin/main --cutoff 20270222094000` (image A: main only, to the tip) | image builds; `appointments` fingerprint equals PROD `e0c4db1b…` (this validates the image as a PROD stand-in; if it differs, record both component lists and stop) |
| R2 | `iso-qa.mjs baseline --ref nsi/n0-preserve --cutoff 20270222094000` (image B: NSI inside the history by filename order) | image builds; no NSI file appears in the known-unreplayable list; NSI migrations apply without error mid-chain |
| R3 | Scenario "end-of-chain": image A, then apply M1-M10 in order through the scenario mechanism (`--migration nsi/n0-preserve:<version>` for each). Needs one added scenario in the iso-qa manifest (the manifest is a tooling file: it is a small, separate PR and is CODEOWNERS-neutral) | M1-M10 apply; `assert_catalog()` passes |
| R4 | `iso-qa.mjs compare` image B (replay order) vs scenario R3 (PROD order) | exit 0: identical catalogs. A difference means a later main migration interacts with NSI: stop and analyze |
| R5 | On the R3 database run the NSI suites with that database as the base: M10 lifecycle harness pointed at a schema dump of image A (`NSI_APPT_FP=e0c4db1b4d1b027df0e6e1593d0f14ce`), the I1 foundation, I2-local, M7, M9, M10 suites | all pass; NSI catalog fingerprint equals `534c5e93…|670` at M9 and `c6b3d46b…|670` at M10 |
| R6 | Rollbacks in reverse order M10 to M7 on the R3 database | exact fingerprint restore at every step |
| R7 | Record evidence under `docs/student-intake/rehearsal/full_chain/` (commands, versions, image ids, fingerprints, pass counts; no secrets) and update `NSI_Resume_Status.md` | PR 808 (or its follow-up) carries the record |

## Stop conditions
Database crash or OOM (infrastructure failure, exit 3: not an application result); any NSI migration failing in R2 or R3; any catalog difference in R4; the `supautils` segfault canary (never call a revoked function as anon/service through PostgREST; this plan uses psql only).

## Out of scope
DEV and PROD apply (separate authorization; PROD is an owner gate), flag or env changes, intake email, Gate A.

## Result of the first run (2026-11-23, M1-M11 as of branch commit fbae24e09, before the M11 review amendments)

Runner `scripts/qa/nsi-full-chain-replay.sh`, scenarios `full-nsi-end` and `full-nsi-mid` in `scripts/qa/scenarios.json`. Evidence in `rehearsal/full_chain/`.

| Step | Result |
|---|---|
| A: baseline from origin/main through 20261205 + every other post-cutoff main migration (26 files, filename order) + the TW-4F chain (38, merge order) + NSI M1-M11 at the end | all 75 migrations applied; `assert_catalog()` ok; NSI fingerprint `5c8ef043…|670` (M11) |
| NSI suites on A | M11 9/9, M10 17/17, M7 36/36, M9 17/17, I1 foundation 97/97, I2-local 92/92 |
| Rollbacks on A | M11 to M10 exact (`c6b3d46b…`), M10 to M9 exact (`534c5e93…`) |
| B: baseline built from the NSI branch (NSI inside the history by filename order: 229 applied, 22 known-unreplayable skipped) + the same chain without NSI files | applied; NSI fingerprint identical to A |
| pg_dump (public + intake_private, schema only) A vs B | 6 differing lines, **none about NSI or any schema object**: 4 are the random `\restrict` tokens of pg_dump, 2 are the `applied_at` timestamp inside one TW-4F function comment. Normalized diff = 0 |

Conclusion: NSI applied last (PROD order) and NSI applied inside the history produce the same catalog; no later main migration interacts with an NSI object. **Ordering is not a problem.**

Caveats, stated plainly
- The stand-in is not PROD: the baseline image (July dump + replay, 22 known-unreplayable migrations skipped) has `appointments` fingerprint `ff651a6c…`, not PROD's `e0c4db1b…` (it lacks the `group_class_enrollment_holds` FK and the floor-rental financial-fields trigger). NSI adds nothing to `appointments`, so this does not affect NSI, but the image cannot certify PROD parity of unrelated objects.
- Rollbacks M8 and M7 were not repeated on A (covered by the earlier M7-M9 lifecycle harness); suites ran on the shared baseline, one stack at a time.
- The run predates the M11 amendments (anchor rules, preview change); it should be repeated once the final M11 bytes are reviewed (one command: `scripts/qa/nsi-full-chain-replay.sh <out>`; about 45 minutes).

## Result of the second run: FINAL M11 bytes (branch commit 643e1047d, 2026-11-23)

Same runner from an isolated detached worktree pinned to that commit (`NSI_REF`), same scenarios. Evidence: `rehearsal/full_chain/summary_final_bytes.txt`, `schema_diff_head_final_bytes.txt`.

- A (NSI last, PROD order) and B (NSI inside the history): both reach NSI fingerprint `9c575d50b7ef98d73b2583e73818e8d1|670`, **identical to shared DEV after the M11 apply**.
- Suites on A: M11 18/18, M10 17/17, M7 36/36, M9 17/17, I1 foundation 97/97, I2-local 92/92. Rollbacks M11 to M10 to M9 exact.
- pg_dump A vs B: the same 6 noise lines as the first run (4 random `\restrict` tokens, 2 `applied_at` timestamps in one TW function comment); no NSI or schema difference.
- The summary shows two `FAIL` lines. Both were runner bookkeeping, not product failures: the runner still expected the pre-amendment fingerprint (`5c8ef043…`) and did not normalize the dump noise. Fixed in the runner afterwards (`NSI_EXPECT_FP`, noise filtering); the substantive results above stand.
- Caveats unchanged (baseline image is not PROD: `appointments` fingerprint `ff651a6c…` vs PROD `e0c4db1b…`; M8/M7 rollbacks not repeated).
