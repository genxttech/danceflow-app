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
