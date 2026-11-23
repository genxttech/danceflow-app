# NSI I1 restricted-role rehearsal evidence

Engineering evidence for gates G7, G8 and G10 of `../NSI_I1_Schema_Plan.md` (§17.1, §18). Synthetic objects only (`nsi_rh_*`, `intake_private`, `intake_destructive`); these scripts are **not** I1 migrations and must never be run against shared DEV or PROD.

| Folder | Environment | Postgres | Date |
|---|---|---|---|
| `local/` | Disposable local Supabase stack `nsi-g7-rehearsal` (destroyed after use) | 17.6 (image 17.6.1.106) | 2026-10-14 |
| `hosted/` | Temporary standalone Supabase project `fiurmeioieenkxiaynos` (deleted after use) | 17.11 | 2026-10-14 |

| Script | Purpose |
|---|---|
| `RH00_probe.sql`, `RH00b_probe.sql` (local) | Show that ownership transfer requires `SET` membership on PG16+ (rolled back) |
| `RH01_setup*.sql` | Idempotent synthetic setup: role, SET membership, private schema, protected tables, triggers, wrapper, implementation created as the role, explicit revokes/grants |
| `RH02_sql_tests*.sql` | 31 SQL checks (G7/G8 and SQL-simulated G10) |
| `RH03_api*.sh` | 14 API checks through Supabase (G10). Requires `NSI_RH_SYNTHETIC_PASSWORD` in the environment; creates two synthetic `@nsi-rh.test` users with confirmation pre-set (no email) |
| `RH04_followups*.sql` | Audit update with rows present; trapped-error leak check |
| `RH09_fingerprint.sql` | Catalog fingerprint (role, memberships, schema ACL, function owners/ACLs, tables, policies, triggers) |
| `ISO_sa.sql` (hosted) | Read-only isolation check run before any test SQL |

Results: local `RH02_results.txt` (31/31), `RH03_results.txt` (14/14), `RH04_results.txt` (2/2), fingerprints `fp_run3–5.txt` (identical) and `fp_final.txt`; hosted `RH02_hosted_results.csv` (31/31), `RH03_hosted_results.txt` (14 checks; the last is a boolean-format artifact, value `false` = pass), `RH04_hosted_results.csv` (2/2), fingerprints `hfp_run1–3.csv` (identical) and `hfp_final.csv`, isolation `ISO_standalone.csv`.

No credentials, API keys, database passwords or synthetic-user passwords are stored here. Synthetic user ids in result files refer to deleted environments.
