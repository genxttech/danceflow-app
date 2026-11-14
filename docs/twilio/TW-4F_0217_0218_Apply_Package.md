# TW-4F apply package: 20270217090000 + 20270218090000

Prepared 2026-11-14 from main `8ce3e8ca`. **Nothing here has been applied.** Each hosted apply needs explicit owner authorization naming the target (DEV or PROD) and the file hashes below.

| Migration | What it does |
|---|---|
| `20270217090000_twilio_ucs2_surrogate_segments.sql` | Exact SMS part counts for reservations (`_tw4us_segments`). Pure function; no table, grant or data change. |
| `20270218090000_twilio_inbound_start_order.sql` | A recovered STOP is ordered against a START by Twilio's message times. Adds `studio_sms_inbound_start_signals`, `sms_inbound_start_signal_record`, `tw4_inbound_start_sids`, and redefines `tw4_inbound_recover`. |

## 1. Files and checksums (main 8ce3e8ca, LF only, CR = 0)

| File | SHA-256 |
|---|---|
| `src/lib/supabase/migrations/20270217090000_twilio_ucs2_surrogate_segments.sql` | `1129f2516c9d106fdbeaac8f62f49fe42d18c8f6bb98267884e2abec7767d936` |
| `src/lib/supabase/migrations/20270218090000_twilio_inbound_start_order.sql` | `3d1823b03be7381f3797c37fa2db33bfc6db543155ca08ac2d612119c174cb4f` |
| `src/lib/supabase/migrations/rollback/20270217090000_twilio_ucs2_surrogate_segments_rollback.sql` | `67c5f374d7e7df8aa454453d0c8862a576df19f81bbed14beb826f0fc255b831` |
| `src/lib/supabase/migrations/rollback/20270218090000_twilio_inbound_start_order_rollback.sql` | `c3dc3db0b7c65b732406fa512d61d1a2af8de3ce9630ec718e6f253f91fdc26f` |

Function bodies, as `md5(prosrc)` computed from the files:

| Function | Before (prerequisite) | After forward | After rollback |
|---|---|---|---|
| `_tw4us_segments(text)` | `6e718787e22779b89126baf0d90ef023` (20261201) | `f973d4ab41d206e78436bf1ba40e430a` | `6e718787…` (byte-identical restore) |
| `tw4_inbound_recover(uuid, text, jsonb)` | `3d90583591f5e168883c9c2270c1bb9c` (20261205) | `87d6df180eb3eaef7980b1d2b5858e05` | `3d905835…` (byte-identical restore) |

## 2. Prerequisites: read-only probe 2026-11-14 ~21:25Z (`sb.sh dev-read` / `prod-read`, `scripts/hosted/tw4f/0217_0218/preflight.sql`)

DEV (`epdrtzcydvnoidwrepqz`) and PROD (`hvsujyfbftfffxpfmlpb`) returned identical results: PostgreSQL 17.6, both prerequisites present with the exact Git bodies, neither migration applied.

| Check | DEV | PROD | Required |
|---|---|---|---|
| `_tw4us_segments` body | `6e718787…` | `6e718787…` | = 20261201 |
| `_tw4us_segments` ACL | `{postgres=X/postgres}` | same | unchanged by 0217 |
| `tw4_inbound_recover` body | `3d905835…` | `3d905835…` | = 20261205 |
| `tw4_inbound_recover` ACL | `{postgres=X/postgres,service_role=X/postgres}` | same | unchanged by 0218 |
| `studio_sms_entity_studios` | present | present | 0218 guard |
| start-signal table / functions | absent | absent | absent (0218 not applied) |
| `tw4_local_qa_marker` | absent | absent | must stay absent |
| billed senders / usage attempts | 0 / 0 | 0 / 0 | (no caller of `_tw4us_segments` exists) |
| smoke `ucs2_emoji` / `gsm_extension` (`smoke.sql`) | 2 / 3 | 2 / 3 | old body |

Hosted state is read from the catalog. There is no migration-history table on PROD, and DEV records no TW-4 versions: these chains are applied as plain SQL.

**Live callers on PROD today.** None reach either function.
- **Live app `c0172455`:** registers `/api/cron/sms-usage-reconcile` (every 15 min) and has `SMS_USAGE_RECONCILER` set. `SMS_USAGE_EVIDENCE_READS` is **not set**, so the reconciler has no provider and never runs inbound recovery (the call that reaches `tw4_inbound_recover`).
- **`_tw4us_segments`:** reached only through billed-texting reservations and usage recording. PROD has 0 billed senders and 0 usage attempts.

Applying the SQL to PROD therefore changes no live behaviour until evidence reads or billed texting are switched on (each a separate owner gate). The live app does not write START signals (that code is on main, not deployed), so the signal table stays empty. The new `tw4_inbound_recover` then treats DanceFlow-only START records the stricter way (applied, listed): the intended fix.

## 3. Sequence

The order is the same for each target. Stop at the first deviation.

1. **Preflight** `sb.sh <env>-read scripts/hosted/tw4f/0217_0218/preflight.sql`. It must match §2.
2. **Apply 0217** `sb.sh <env>-apply src/lib/supabase/migrations/20270217090000_twilio_ucs2_surrogate_segments.sql 1129f2516c9d106fdbeaac8f62f49fe42d18c8f6bb98267884e2abec7767d936`
3. **Apply 0218** `sb.sh <env>-apply src/lib/supabase/migrations/20270218090000_twilio_inbound_start_order.sql 3d1823b03be7381f3797c37fa2db33bfc6db543155ca08ac2d612119c174cb4f`
4. **Postflight** `preflight.sql` again. It must show:
   - `segments_md5 = f973d4ab41d206e78436bf1ba40e430a`, ACL unchanged;
   - `recover_md5 = 87d6df180eb3eaef7980b1d2b5858e05`, ACL unchanged;
   - `start_signals_table` true with 0 rows;
   - `start_signal_record_fn` and `start_sids_fn` true, each ACL `{postgres=X/postgres,service_role=X/postgres}`;
   - `local_qa_marker` false.
5. **Smoke** `sb.sh <env>-read scripts/hosted/tw4f/0217_0218/smoke.sql`. It must return `ucs2_emoji = 3`, `gsm_extension = 2`, `plain_160 = 1`, `ucs2_70 = 1`.

**Order between targets:** DEV first, then PROD. PROD can follow at any time: there is no live caller (§2), and SQL before the app is the required order.

**The app:** the code that uses 0218's START signals (#517) and #521 is on main, which is not deployable to production while #445 is held (main lacks 70 live commits). Any later production app release containing them must come **after** the PROD SQL.

## 4. Rollback

Roll the **app** back first (if a release containing #517 is live), then the SQL in reverse order:

1. `rollback/20270218090000_twilio_inbound_start_order_rollback.sql` (`c3dc3db0…`). It restores `tw4_inbound_recover` to the 20261205 body (`3d905835…`), then drops the two functions and the signal table. Signals hold no consent state.
2. `rollback/20270217090000_twilio_ucs2_surrogate_segments_rollback.sql` (`67c5f374…`). It restores `_tw4us_segments` to the 20261201 body (`6e718787…`).

Afterwards, `preflight.sql` must equal §2 exactly, and `smoke.sql` must return 2 / 3 again.

Rollback evidence in Git:
- the 20270217 round trip on PostgreSQL 17.9: `docs/twilio/evidence/20270217-segments/` (#495) and the CI workflow `sms-segments-sql.yml` (#496);
- the 20270218 round trip by `md5(prosrc)`: `localStack.tw4recon` R9 (#517, 38/38).

## 5. What stays off

No hosted SQL is applied until authorized. Applying either file sends nothing, calls no provider and spends nothing. Evidence reads, billed texting, SMS activation, prices and the #445 / #326 holds are unchanged.
