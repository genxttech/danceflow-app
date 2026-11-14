# 20270217090000 segment packing: SQL release evidence

Migration `20270217090000_twilio_ucs2_surrogate_segments.sql` (PR #489) redefines `public._tw4us_segments`. CI runs no SQL, so these checks were run by hand on a disposable database. They are the pre-apply evidence for a future hosted release. They do **not** authorize one, and nothing here was applied to any hosted database.

- **Code under test:** merged main `7d492298a6edfe983315bb448f95fa393277cd0d` (#489 squash `e58ef358`, then #450). The files were taken with `git show origin/main:<path>`, and their SHA-256 hashes are in `inputs.sha256`.
- **Database:** a disposable `postgres:17` container, PostgreSQL 17.9, UTF8. It was removed after the run.
- **Run window:** 2026-11-14, 08:51Z to 08:59Z.
  - Host at the start: 9.1 GB free RAM, CPU 61%.
  - Host at the end: 10.3 GB free RAM, CPU 42%.
  - No test was skipped or timed out.

## Results

| Check | Result |
|---|---|
| Precondition guard on an empty database | Refused with `requires 20261201090000 (public._tw4us_segments)`, and the function stayed absent |
| Rollback body vs main's `20261201090000` function body | Byte-identical (1,066 characters) |
| Pre-state | Main's function, with `execute` revoked from `public` and granted to a test role |
| Apply `20270217090000` | Applied. The ACL is unchanged, and the function stays immutable, not security definer, with `search_path=pg_catalog, public, pg_temp` |
| `sql-tests/test_T_tw4f_ucs2_segments.sql` (38 cases, same as the TS fixture) | All cases passed |
| 12,000-body corpus vs merged `src/lib/sms/segments.ts` | **0 mismatches** (0 under, 0 over) |
| Main's old function on the same corpus | 4,179 bodies below the new estimate, 0 above |
| Rollback, then corpus | Old counts return (4,179 differ) |
| Re-apply, then parity test and corpus | All cases passed, 0 mismatches |
| Second apply (idempotent) | 0 mismatches |
| Cost, 750-character emoji body | 2.38 ms per call (500 calls, varying input) |

The first log (`run1.log`) has an alias error in the corpus query, because `over` is a reserved word. `run2.log` reran every corpus step with the aliases fixed, and the table above comes from `run2.log`. The guard, ACL, parity-test and rollback results come from `run1.log`.

**Corpus:** 8,000 bodies from the #489 review corpora, plus 4,000 fresh bodies from `build-corpus.mts.txt` (rename to `.mts`, place beside `segments.ts`) (seed 20261114). The fresh bodies cover:
- Latin, GSM-7 extension characters, CJK, Hangul (syllables and loose jamo), Devanagari conjuncts, Arabic with Prepend, Hebrew points, Thai and unspaced Lao;
- ZWJ sequences, flags, odd runs of regional indicators, tag flags and skin tones;
- 80-mark clusters, which exercise the over-67-unit path.

The expected counts come from the merged `segments.ts`, which Node 24 runs directly.

## Before any hosted apply
- Re-run `test_T_tw4f_ucs2_segments.sql` against the target's own pre-state.
- Confirm `_tw4us_segments` there matches main's `20261201090000` body.
- Apply the SQL and the app together.
- Settlement still charges the provider's `num_segments`, never this estimate.
