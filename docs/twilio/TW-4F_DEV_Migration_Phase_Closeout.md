# TW-4F DEV migration and authenticated integration: phase closeout

Status: **closed as PASS on 2026-10-30** (DEV project `epdrtzcydvnoidwrepqz` only). Application baseline: `main` at `e749427ce5eaea3316752729f565e11254ac45af` (merged manifest, PR #361). PROD untouched and on hold. This document is the summary; the detail is in `evidence/TW-4F_DEV_phase_20261030/` (index in its `README.md`). Follow-up test work is in `TW-4F_DEV_Docker_Acceptance_Work_Packages.md`.

## 1. What was done

| Stage | Outcome |
|---|---|
| Manifest correction (PR #361) | `20261206090000` placed in its numeric slot (between `1205` and `1207`); 41-file DEV list added as manifest section 4.1; all 48 forward and 48 rollback hashes verified unchanged |
| Rollback exception evidence | Docker round trip of all 41 files on a DEV-equivalent database: rollback returns to the starting catalog with **0 differences**, re-apply returns to the first apply with **0 differences**; intermediate per-step exceptions enumerated (`evidence/.../rollback/`) |
| Local DEV-bound build | `e749427c` built with five DEV variables only; type check and build exit 0; DEV URL embedded in the server output, service-role key embedded nowhere; network guard allowed only the DEV host |
| DEV key identity | Both keys carry the DEV project ref and role claims and were accepted by DEV's gateway while an invalid key was rejected on the same endpoint |
| **41-file DEV migration** | Applied 2026-10-30 21:41 to 21:49 UTC, one file at a time, forward only. Each step's full fingerprint and inventory matched a local lockstep prediction row for row; zero-row precondition checked before every step; no pilot, provider or fee activity |
| Acceptance AT-1 to AT-10 | All passed within the limits in section 3 |
| Unauthenticated integration | 53 read RPCs and all TW-4F routes/pages exercised by GET only: 0 incompatibilities |
| Authenticated walkthrough | Owner signed in (password + TOTP, entered personally); `/platform/sms` rendered fully at aal2; owner settings pages refused cleanly; 0 of 151 requests were 5xx |

## 2. Final DEV state (read-only probes)

- Whole-schema fingerprint `rollup:ALL` **`3a38f6b6`**, unchanged through the unauthenticated and authenticated phases (0 of 1,234 fingerprint rows differing, 0 inventory rows differing).
- 75 probed tables, 74 `studio_sms_*` tables: **all 0 rows**; no pilot exception, approval, spend, charge, credit, provisioning, sender, runner-window or switch-log row.
- All SMS activation, provisioning, recurring, usage, fee-lifecycle and billing switches **OFF**; no `TW4_*`/`SMS_*` variable exists in either Vercel project; only `/api/cron/sms-onboarding-purge` is scheduled among SMS routes.
- Platform administrators: exactly one, with one verified TOTP factor. Dual-control paths unexercised.
- The only side effect of the walkthrough outside the migrations: one new authentication session (`auth.sessions` 18 to 19).

## 3. Verified behavior versus untested paths

| Area | Verified (and how) | Not verified |
|---|---|---|
| Schema | 41 files applied; fingerprint equals the local prediction at every step; objects, grants (23 client-exposed functions = manifest), RLS, pinned search paths, function bodies (412 of 412 equal to the Docker chain) | Behavior of the 277 volatile (mutating) functions on DEV |
| `1231` AAL2 | Catalog: helper requires `aal2`, three registration policies reference it. Runtime: an aal2 admin session loaded `/platform/sms` through the admin-gated list function; an aal1 session was held at the TOTP prompt by the app | A real aal1 token being refused **at the database** (the app layout blocks first); policy denial path |
| Application | Build compiles, type-checks, starts, serves; 43 read RPCs answer with migrated signatures; 10 owner-facing RPCs correctly refuse a service-role caller; 8 of 8 admin functions refuse a random actor; anon refused 4 of 4 | Owner-facing pages with data (needs a studio-role user and pilot access); any mutating action or form submit |
| Authentication | Password + TOTP flow to aal2 on localhost; redirects for the platform admin on `/app/settings/sms*` | Magic-link flow for this account is not used; sign-out path |
| Flags | Configuration and database: all OFF | Runtime confirmation under load or with provider credentials present |
| Providers | Nothing contacted: no Twilio, Stripe or Resend call, no SMS, no charge | All provider behavior: registration, numbers, fees, webhooks with real signatures, payments, email delivery |
| Dual control | Existing Docker suites (see work packages) | Anything on DEV: one administrator only |

## 4. Migration-history discrepancy (explicit)

- The 41 migrations (and the 7 earlier TW-4/TW-4F files `20261119090000` to `20261122090000`, i.e. all 48 in the TW-4F manifest) are **in the DEV schema but not recorded individually in `supabase_migrations.schema_migrations`**. The table has **1 row**, and the probe's history check lists **none** of the TW-4/TW-4F versions.
- Cause: they were applied with `supabase db query --linked -f <file>`, which runs SQL and does not write history, matching the runbook (manifest section 8.1). The repository has 431 `.sql` files in `src/lib/supabase/migrations` (282 with a 14-digit version prefix) against one history row, so the history table has never described these projects (manifest: "not authoritative", 2026-10-19 sync record).
- **Risk:** any tool that trusts the history table will mis-plan. In particular `supabase db push` on DEV would treat nearly every local migration as pending and try to apply it. **Never run `db push`, `migration up` or an automated "apply pending" against DEV or PROD.** `supabase migration list` would show the mismatch (read-only, harmless).
- **Authority instead:** the manifest (hashes, order, section 4.1), the probe fingerprints and this evidence. DEV equals the Docker prediction at fingerprint `3a38f6b6`.
- **Options (not performed, not authorized):** (a) leave as is and keep the rule above (recommended while hosted projects are applied by hand); (b) later reconcile with `supabase migration repair --status applied <versions>` after the owner decides, which **modifies migration history** and needs separate authorization and a plan covering all non-TW-4F files too. PROD's history was not examined in this phase.

## 5. Evidence handling

- 209 raw artifacts were produced locally (probe dumps, per-step before/after fingerprints, request logs). A curated, sanitized subset (27 files) is committed with a sha256 manifest of all 209 so the raw set can be verified later; the raw set stays outside Git.
- Scan before commit: JWTs, bearer headers, Stripe/Supabase/Resend/Twilio keys and SIDs, e-mail addresses, non-loopback IPs, cookie and token names, password assignments, long secrets and UUIDs. Result: **no credential, token, cookie or personal value**. Findings were a catalog column name containing "bearer", the placeholder number `+15550000000` in a test script, public sha256 hashes, and one synthetic fixture UUID. Local temp paths and the OS user name were replaced in committed tool copies. The proxy log holds method, path (no query), status and redirect path only.
- The owner's password, TOTP code, session cookie and tokens were never requested, read or stored.

## 6. Remaining items and decisions

See `TW-4F_DEV_Docker_Acceptance_Work_Packages.md`. Open owner decisions that are not test work: B-6 (dual control versus a documented single admin for pricing changes), the pilot approval gates in `TW-4F_Pilot_Readiness_Checklist.md`, and whether to reconcile migration history (section 4).
