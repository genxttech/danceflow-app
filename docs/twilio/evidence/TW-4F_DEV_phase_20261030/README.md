# TW-4F DEV phase evidence (2026-10-30)

Curated, sanitized evidence for `TW-4F_DEV_Migration_Phase_Closeout.md`. DEV project `epdrtzcydvnoidwrepqz`, application and manifest at `main` `e749427ce5eaea3316752729f565e11254ac45af`.

## Contents

| Path | What it is |
|---|---|
| `apply/apply_steps.json` | The 41 apply steps: file, duration, `rollup:ALL` after, and the five checks (fingerprint equals prediction, inventory equals prediction, `other_sms_functions` unchanged, all tables zero rows) |
| `apply/cp0_summary.json` | Pre-apply state (CP0): rollups, 296 fingerprint rows count, row counts of the 20 `studio_sms_*` tables, database session summary |
| `apply/final_rollups.json`, `apply/acceptance_summary.json` | Final state and the machine-checked results of AT-1 to AT-9 |
| `apply/apply_run_log.txt` | The driver's log, one line per step |
| `integration/` | Unauthenticated phase: 53-function read RPC results (`rpc_results.json`), GET smoke log, network guard log, before/after summary |
| `authwalk/` | Authenticated phase: proxy request log (method, path without query, status, redirect path only), guard log, before/after counts |
| `rollback/TW-4F_DEV_Rollback_Exceptions_Evidence.json` | Per-step results of the Docker 41-file round trip (the documented DEV-only rollback exceptions) |
| `reference/TW-4F_Docker_Chain_Top_Fingerprint_e749427c.txt.gz` | Harness fingerprint of the full chain, the reference for AT-7 |
| `tools/` | Reference copies of the scripts used (not maintained; local temp paths replaced by `<TEMP>`) |
| `working_record/` | The two long working documents (readiness review and execution package) as they stood at closeout |
| `raw_artifact_manifest.json` | sha256 and size of **all 209 raw artifacts** produced (probe dumps, per-step before/after fingerprints and inventories, logs). The raw set is kept outside Git. |

## Verifying

Hash any raw file and compare with `raw_artifact_manifest.json`. The step results can be re-derived from the raw `NN_result.json` files named there.

## Sensitive data

Scanned before commit for JWTs, bearer headers, Stripe, Supabase, Resend and Twilio keys or SIDs, e-mail addresses, non-loopback IPs, cookie and token names, password assignments, long secrets and UUIDs. No credential, token, cookie or personal value was found. The committed request logs contain no query strings, headers, cookies or bodies by construction. No session, code or password was ever captured.
