# TW-4F DEV migration execution package (EXECUTED ON DEV 2026-10-30; see section 14)

Prepared 2026-10-30 against `origin/main` `e749427ce5eaea3316752729f565e11254ac45af` (merged manifest, PR #361 included). It consolidates the earlier readiness work (`TW-4F_DEV_Migration_Readiness_Review_DRAFT.md`, sections 2 to 19) into one operable procedure. **Nothing in this document authorizes anything.** Executing any step needs the owner's explicit written approval of the DEV migration operation. PROD stays on hold. No Vercel deployment, Stripe, Twilio, Resend, SMS spending, merge or provider provisioning is part of this package.

Target: Supabase DEV project `epdrtzcydvnoidwrepqz` only. Application: the local build of `e749427c` (no deployment). Files: the 41 listed below, from Git at `e749427c`, nothing else.

## 1. Local runtime smoke test (completed before this package; evidence)

One bounded run of the DEV-bound build of `e749427c` on `127.0.0.1:3017`, five environment variables only (the three Supabase values plus `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SITE_URL`), no provider credential and no TW-4F switch, under a network guard that allowed only the DEV host and blocked everything else.

| Item | Result |
|---|---|
| Binding | only `127.0.0.1:3017` was listening (no wildcard or LAN socket) |
| `GET /` | 200, 972 ms, title "DanceFlow \| Where the dance community connects"; this page performs 5 read-only anon selects/counts on public tables |
| `GET /login`, `/privacy`, `/terms`, `/robots.txt` | 200 |
| `GET /signup`, `/studios`, `/app` | 307 redirects (to `/login`, `/discover/studios`, `/login`): no database dependency |
| `GET /api/health`, unknown path | 404 |
| Responses containing a Supabase URL, anon key or service key | 0 |
| Network guard | 5 allowed connections, **all to `epdrtzcydvnoidwrepqz.supabase.co`**; **0 blocked**; no other host contacted |
| Server log | 5 lines, 0 error or warning lines; no secret value in it |
| Writes, RPCs, mutating routes | none: GET only; the home page's queries are `select`/`count` on `studios`, `events`, `dancer_partner_profiles`, `studio_job_postings`, `commerce_catalog_items` |
| Stop | process tree killed; port no longer answering; 0 listening sockets |
| Worktree | still at `e749427c`, clean after restoring the regenerated `next-env.d.ts`; `.next` build kept |

Not exercised on purpose: any RPC, any `/api/*` route other than the harmless 404, any cron, webhook or callback route, and anything touching a table or function among the 41 pending layers. Result: the build starts, serves and reads from DEV on the **pre-apply** schema.

## 2. Preconditions (all must hold; any failure stops the operation)

### 2.1 Authorization (D0)

The owner's written authorization must name: project DEV `epdrtzcydvnoidwrepqz`; Git ref `e749427ce5eaea3316752729f565e11254ac45af`; the 41 files in section 3 and nothing else; that no flag, deployment, cron or provider operation changes; whether stage S6 (rollback rehearsal) is included; who operates the CLI session. An authorization template is in section 11.

### 2.2 Fresh pre-apply DEV state (D1), taken immediately before S4, read-only

**A fresh probe was not taken for this package**: hosted queries are outside this preparation's authorization. The last known values (2026-10-30, read-only, DEV) are context only and must be re-taken: whole-schema probe fingerprint `rollup:ALL` `bf10276e`, function bodies `62585cfa`, migration history table 1 row, none of the 635 object names of the 41 files present, the 20 `studio_sms_*` tables at 0 rows. Procedure (manifest section 7): fresh scratch workdir outside the repo, copy in `probe_objects.sql` and `probe_fingerprint.sql` from `e749427c` and hash them, `supabase link --project-ref epdrtzcydvnoidwrepqz`, verify the ref aloud before each session, run each inside `begin read only; … rollback;`, save output with the ref beside it, never print environment values.

Required pre-apply facts (record as CP0):

1. `probe_fingerprint.sql`: `rollup:ALL`, every per-scope rollup, and `rollup:other_sms_functions` saved in full.
2. `probe_objects.sql`: every object of the 41 files `MISSING`; base dependencies `PRESENT`; `00_env.read_only_txn = on`; no partly applied layer (any mixed file stops the plan).
3. **Zero-row precondition**, read-only (counts only, no row data):

```sql
begin read only;
select c.relname,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text::int as row_count
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'studio\_sms\_%'
order by 1;
rollback;
```

   Expected: every row `0` (or the table absent before its layer). **Any non-zero count stops the plan and goes to the owner.** Also expect: no pilot exception, no pilot-funded approval, no evidence row (these tables do not exist yet on DEV, so this holds trivially, and `1229`/`1230` preconditions refuse otherwise).
4. Flags and switches OFF per manifest 8.5 (section 7 here); no TW-4F cron (`vercel.json` registers only `/api/cron/sms-onboarding-purge` among the SMS routes, and no deployment is created by this package).
5. Row of the CLI history table is informational only (not authoritative on these projects).
6. Git integrity: `verify_manifest_hashes.sh origin/main` at `e749427c` prints `MANIFEST HASHES OK` (48 migrations); each of the 41 files is exported with `git show e749427c:<path>` into the scratch workdir, LF-normalized, hashed, and equals the manifest section 3 value (full hashes are in the manifest; the table below shows the first 12 characters).
7. The local application is stopped, and no other client is driving DEV during the operation. Note: Vercel preview deployments scoped to DEV exist (SSO-protected, branch builds such as `238baea2`, older code not paired with these migrations). Nobody should open them during S4 to S6.

### 2.3 Tooling preconditions

Supabase CLI logged in on the operator's machine, `supabase db query --linked -f` working from the scratch workdir; the database password or access token held by the operator only; nothing recorded in files. A second terminal ready for the read-only probes.

## 3. Exact migration sequence (strict numeric order, one file at a time)

Stage names used in this package: S2 = fresh read-only preflight (section 2.2); S3 = the paired local build (section 4, A0); S4 = apply the 41 files (this section and section 5); S5 = acceptance tests (section 9); S6 = optional rollback rehearsal (section 6).

Source: manifest section 4 and 4.1 at `e749427c`. Stop at the first deviation. Full 64-character hashes are in manifest section 3; "App" restates the pairing (`app first` = the paired build must already exist, which it does as the local `e749427c` build; `confirm reader` = a read RPC changed shape).

| # | Timestamp | File (after the timestamp) | Forward sha256 (first 12 of 64; full in manifest 3) | Rollback sha256 (first 12) | Requires | App | Rollback refuses when | Rows block rollback | Checkpoint |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 20261123090000 | twilio_tw4f3b_pay_stripe_credit_purchases.sql | e7afd0a3657e | 308cbee6516d | `1122` | app first | purchase bindings, refunds, disputes or live pending checkouts exist | **yes** |  |
| 2 | 20261124090000 | twilio_tw4f3b_ui_credit_reads.sql | 3476092b32f8 | 7438d468eb5a | `1123` | confirm reader | no data gate (drops two read functions) | no |  |
| 3 | 20261125090000 | twilio_pay_integrity_hardening.sql | 10ef2b00c483 | 746f3bfdf411 | `1123` | - | dispute records exist (aborts `55000` if old disputes cannot be rebuilt) | **yes** |  |
| 4 | 20261126090000 | twilio_recurring_authorization.sql | 9fa3000f06d5 | c23f8e87c8e1 | `1122`, `1125` | - | authorizations, charges or audit evidence exist | **yes** |  |
| 5 | 20261127090000 | twilio_recurring_execution.sql | 8decf51801b6 | d0900f28995f | `1126` | app first | scheduler runs, switch changes or run-stamped charges exist | **yes** |  |
| 6 | 20261128090000 | twilio_monthly_spending_limits.sql | 2b211559cb0a | 30dd965d3804 | `1127` | app first | limits, ceilings, timezone changes or set-aside commitments exist | **yes** | CP2 |
| 7 | 20261129090000 | twilio_tw4f_provider_integration.sql | 5e9395e47c65 | c0f9954e71a3 | `1121` (independent of `1128`) | - | webhook receipts or tier decisions exist; an onboarding has a chosen tier | **yes** |  |
| 8 | 20261130090000 | twilio_tw4f_admin_panel.sql | 2b7796173739 | 1ca56f470097 | `1129`, `1122` (independent of `1128`) | - | panel requests or eligibility records exist | **yes** |  |
| 9 | 20261201090000 | twilio_sms_usage_financials.sql | 849fda85d353 | 6d1e536fdf97 | `1128` | - | usage attempts, billed senders, switch rows or usage reservations exist | **yes** |  |
| 10 | 20261202090000 | twilio_tw4f_financial_integrity.sql | f1fc7e81e60c | cfde042e52b2 | `1130`, `1128` | - | `1203` applied (roll it back first); a Low-Volume Standard fee kind has been used | **yes** (evidence) |  |
| 11 | 20261202140000 | twilio_tw4ml_default_tz_perf.sql | eb75f67320f9 | 691dba3d934b | `1128` | - | no gate (replaces `_tw4ml_default_tz`) | no |  |
| 12 | 20261202150000 | twilio_tw4f_panel_monthly_limits.sql | dd9d4f210867 | 786cfacaa3ab | `1128`, `1130` | confirm reader | no gate (drops one read function) | no |  |
| 13 | 20261203090000 | twilio_inbound_usage_recording.sql | a21074c58bb0 | b621ee50dc09 | `1201` | - | inbound records, ceilings or inbound prices exist | **yes** |  |
| 14 | 20261204090000 | twilio_sender_readiness.sql | 6671ed7ab4a8 | 1c36772025ed | `1203` | - | sender records or verifications exist | **yes** |  |
| 15 | 20261205090000 | twilio_usage_reconciliation.sql | 2e8f12280047 | 0e496d748a08 | `1204` | - | reconciliation evidence exists | **yes** | CP3 |
| 16 | 20261206090000 | twilio_sender_reverification.sql | 7e766d021d47 | 2932f6b70b4b | `1205` | - | re-verification run or inconclusive audit evidence exists | **yes** |  |
| 17 | 20261207090000 | twilio_r2a_messaging_service_campaign.sql | 8321fabb8026 | 5fa293415ce5 | `1204` | - | provisioning evidence exists | **yes** |  |
| 18 | 20261208090000 | twilio_r2b_number_activation.sql | 7551885c236b | a765c4e4d930 | `1207` | - | number provisioning evidence or number approval references exist | **yes** |  |
| 19 | 20261209090000 | twilio_recurring_fee_lifecycle.sql | d5f3af102b4c | 4716984c1773 | `1205` | - | lifecycle evidence exists | **yes** |  |
| 20 | 20261210090000 | twilio_r2c_owner_provisioning_read.sql | a77e7f976286 | 98dc89ee2666 | `1207` | confirm reader | no gate (drops one read function) | no |  |
| 21 | 20261211090000 | twilio_rfl_ops.sql | 75e470601359 | e612b9bb0cf7 | `1209` | - | operational evidence exists | **yes** |  |
| 22 | 20261212090000 | twilio_prov_fee_resolution_evidence.sql | 280adc409572 | 142048860b0c | `1207`, `1208`, `1209` | - | evidence exists | **yes** |  |
| 23 | 20261213090000 | twilio_r2b_p1_identity_evidence.sql | 3cb2f083bd59 | 393df0bca1be | `1208` | app first | provider identity evidence exists; a function it installed has been changed since (fingerprint) | **yes** + fingerprint |  |
| 24 | 20261214090000 | twilio_r2b_p2_orphans_reconciliation.sql | 9978f3a7fa9f | de8d74383285 | `1208`, `1213` | app first | orphan findings exist; a function it installed has been changed since (fingerprint) | **yes** + fingerprint |  |
| 25 | 20261215090000 | twilio_prov_evidence_targets.sql | 2a3308aa1b1d | a0d2430de1ae | `1212` | confirm reader | no gate (plain drop of one read function) | no |  |
| 26 | 20261216090000 | twilio_prov_orphan_exposure.sql | e7f240e2279e | e56a6d6530e0 | `1212`, `1211` | confirm reader | no gate (drops two read functions) | no |  |
| 27 | 20261217090000 | twilio_r2b_rfl_lifecycle_integration.sql | 0c832ffe4848 | 0d1bd3d27e87 | `1208` … `1214` (`1215`/`1216` not required) | - | not applied; a replaced function changed after this migration; or a restored body is not byte-exact | no row gate, **fingerprint-gated**; registrations and retirements written while live stay valid |  |
| 28 | 20261218090000 | twilio_usage_reconciler_readiness.sql | c85bfafc7d8b | ef10b282a193 | `1205` (and `1204`) | - | billed texting is on, or another function calls the helper; a replaced function changed since (fingerprint) | no row gate; fingerprint-gated | CP4 |
| 29 | 20261219090000 | twilio_act_pilot_funding_lock_order.sql | f1a7268bad4f | bb3301f53e34 | `1208`..`1217`; `1218` for any activation to pass | - | a replaced function changed since (fingerprint); `1226` applied (intended) | no row gate; fingerprint-gated; undo before `1218` |  |
| 30 | 20261221090000 | twilio_admin_recovery_tooling.sql | 7dfcfcfa718b | 9d7368ed0e41 | `1207`..`1217` | - | fingerprint only (restored bodies/privileges must match; a later change blocks it) | no row gate; fingerprint-gated |  |
| 31 | 20261222090000 | twilio_owner_texting_status.sql | d4bbc183aae7 | 21f4c0e66cb2 | `1208`, `1209`, `1212`, `1214`; `_tw4act_items` by signature (`1219`) | confirm reader | no gate (plain drop) | no |  |
| 32 | 20261223090000 | twilio_inventory_reconcile_run.sql | f3db1425ba82 | 4a5a7dabbfe2 | `1205` | - | inventory reconciliation runs exist; another job kind added later; `tw4_reconcile_run_begin` changed since | **yes** + fingerprint |  |
| 33 | 20261224090000 | twilio_rfl_cancel_target.sql | 59b03309d0e7 | 8321de6ad70d | `1209`, `1211` | confirm reader | no gate (plain drop of one read function) | no |  |
| 34 | 20261225090000 | twilio_rfl_d5_cover.sql | f3c7700ef118 | f6a5288276b4 | `1209`..`1217` | - | superseded cover evidence exists; a replaced function changed since (fingerprint) | **yes** + fingerprint; undo before `1217`/`1211` |  |
| 35 | 20261226090000 | twilio_act_console_gates.sql | 09588758d773 | 8c275fc7ffff | `1219`, `1225` | - | a later migration changed a replaced body; restored bodies must match `1219` | no row gate; fingerprint-gated; **undo first** (before `1225`, `1219`) |  |
| 36 | 20261227090000 | twilio_owner_number_offers.sql | 0c8e77b2a669 | 20d6210d2038 | `1208`, `1222` | - | the status function is neither the `1227` nor the `1222` body; postcondition: `1222` body not restored | no row gate; **undo before `1222`** |  |
| 37 | 20261228090000 | twilio_ki1_cross_month_release.sql | 643b6c9e712c | ad26215a88a8 | `1207`..`1221` (`tw4_prov_observe` as `1221` left it) | - | a `ki1_released` audit row exists; `tw4_prov_observe` is not the `1228` body | **yes**; **undo before `1221`** |  |
| 38 | 20261229090000 | twilio_rfl_pilot_evidence.sql | c9295ed40d54 | 3d0fc8bc0364 | `1209`..`1226` (`1225` body fingerprint-checked) | app first | any evidence row; an approval reference > 120 characters; widened check missing; the eleven-argument body redefined | **yes**; **undo first (before `1228`)** | CP5 |
| 39 | 20261230090000 | twilio_rfl_pilot_spend_evidence.sql | e3275cd720bd | 92e691e2bff8 | `1209`..`1229` (predecessor bodies md5-checked) | app first | any evidence row; an old signature already exists; any of `tw4_spend_authorize` (14 args), `tw4_pilot_exception_create`  | **yes**; **undo first, before `1229`** | CP6 |
| 40 | 20261231090000 | twilio_platform_admin_aal2.sql | 5bb6faceecad | 7fd5f9d4739e | `20261119090000`, `20261012090000` (a precondition checks `_sms_onb_is_platform_admin` and `studio_sms_registr | app first | none declared (no `raise exception` mentions rollback) | **no** (restores the role-only check; independent of `1230` and `1231b`) | CP7 |
| 41 | 20261231100000 | twilio_pilot_spend_hardening.sql | 7862e9b97c83 | 5d15406a53c1 | `1230` (md5 of the three `1230` bodies checked) | - | the migration is not applied; the internal function or `tw4_spend_authorize` or `tw4_rfl_pilot_cover` differs from its ` | **yes**; **undo first, before `1230`** | CP8 |

Checkpoint labels: CP2 after #6 (1128), CP3 after #15 (1205), CP4 after #28 (1218), CP5 after #38 (1229), CP6 after #39 (1230), CP7 after #40 (1231), CP8 after #41 (1231b). File `1206` sits at position 16, immediately after `1205` and before `1207`.

Client-exposed functions (authenticated grants) introduced by these files, from manifest section 5; everything else is `service_role` only:

- 20261124090000: `sms_credit_purchases`, `sms_credit_admin_overview`
- 20261126090000: `sms_recurring_overview`, `sms_recurring_admin_overview`
- 20261128090000: `sms_monthly_limit_overview`
- 20261202090000: `sms_location_fee_kinds`
- 20261208090000: `tw4_num_select_as_owner`, `tw4_num_withdraw_as_owner`
- 20261209090000: `sms_rfl_owner_overview`
- 20261210090000: `get_studio_sms_provisioning`
- 20261222090000: `get_studio_sms_texting_status`
- 20261227090000: `get_studio_sms_number_offers` (and redefines `get_studio_sms_texting_status`)

## 4. Application compatibility and activation sequence

The paired application is the local build of `e749427c` (evidence: section 18 and 19 of the readiness report; precise parameter check 0 real mismatches in 152 functions; type check and build exit 0; smoke test above). **Activation means nothing is activated**: no feature, no sender, no provider flag, no deployment.

| Step | Action | Gate |
|---|---|---|
| A0 | Build exists and is unchanged (`.next/BUILD_ID` recorded); the five-variable environment file for it stays on the operator's machine | before S4 |
| A1 | Local app **stopped** for the whole of S4 to S6 (no client talks to DEV while the schema changes) | before S4 |
| A2 | After CP8 and the section 9 database checks pass, start the same build on `127.0.0.1` only, same five variables, same network guard allowing only the DEV host | after S5 |
| A3 | Repeat the section 1 smoke requests (GET only). Expected: identical statuses; the home page still reads the same five public tables. No RPC and no `/api` route | after A2 |
| A4 | Stop the application; confirm the port is closed | after A3 |
| A5 | Any deployment, preview, promotion, environment change or feature switch is out of scope and needs its own authorization | always |

The `1231` behaviour change (an aal1 platform-admin token is refused) is exercised only by the database checks in section 9, not through the application, because no admin session or dual-control path is used.

## 5. Per-file verification (D2) and special gates

For every file F in section 3, in order, **no batching** unless the authorization says so:

1. **Before**: run `probe_fingerprint.sql` and compare with the previous step's after-fingerprint (for file #1, with CP0). Any drift (a difference while idle) stops the run.
2. **Apply**: `supabase db query --linked -f F.sql` from the scratch workdir (the file carries its own transaction). Expect a final `COMMIT`; any `precondition failed`, `ERROR`, `55000` or `42501` stops the run. Never retry a failed apply; diagnose.
3. **After**: run `probe_fingerprint.sql` again. Only the objects listed for F in manifest section 6 may have changed (new objects appear, replaced functions change body md5, dropped functions disappear), and `rollup:other_sms_functions` must be **unchanged**. Any other change stops the run.
4. **Probe**: run `probe_objects.sql` after each file; the file's objects must read `PRESENT`; `UNEXPECTED` rows are to be explained, not ignored.
5. **Save** before, after and output under the step name with the verified ref.

Special gates:

- **`1229` and `1230`**: apply them as the last SQL before `1231`, with no pilot exception or pilot approval created in the meantime (their forward preconditions refuse otherwise). No platform-admin pilot action may run during the apply. After the first approval exists, `1230` and `1231b` cannot be rolled back.
- **CP7 (after `1231`)**: run the aal2 checks of section 9 before applying `1231b`.
- **`1231b`** requires `1230`; its function bodies are md5-checked by the `1230` rollback, so `1231b` must be rolled back first if a rollback is ever needed.
- **CP8**: save the full probes as the first full-chain after-fingerprint; it is the reference for any re-apply comparison.

## 6. Documented DEV-only rollback exceptions (S6, only if the authorization includes it)

Evidence: Docker runs from `e749427c` (chain run on the `1205` baseline image, and the DEV-equivalent 41-file round trip), stored in `docs/twilio/TW-4F_DEV_Rollback_Exceptions_Evidence.json` (untracked). A full reverse round trip of the 41 files returned the DEV-equivalent database to **0 differences** from the start, and re-apply to **0 differences** from the first apply. Intermediate exceptions, strict reverse order, compared with each file's own before-state:

| Rollback of (reverse order) | Objects allowed to differ from that file's before-state |
|---|---|
| 20261231100000 .. 20261226090000 | none (exact match) |
| 20261225090000 .. 20261212090000 | `studio_sms_onboarding_audit_action_check` |
| 20261211090000 .. 20261210090000 | `studio_sms_onboarding_audit_action_check`, `studio_sms_provider_alerts_kind_check` |
| 20261209090000 | `studio_sms_onboarding_audit_action_check` |
| 20261208090000 .. 20261204090000 | `studio_sms_approval_refs_shape`, `studio_sms_approval_refs_source_check`, `studio_sms_onboarding_audit_action_check` |
| 20261203090000 .. 20261202140000 | the three above plus `studio_sms_price_list_kind_check` |
| 20261202090000 | `studio_sms_onboarding_audit_action_check` |
| 20261201090000 .. 20261129090000 | none |
| 20261128090000 .. 20261127090000 | function `tw4_recurring_due(text)` body md5 (before `d38ad5ac…`, after `ae36ce19…`) |
| 20261126090000 .. 20261123090000 | none |

Semantics: `approval_refs_shape` keeps an extra `number_selection` branch (semantic widening); `approval_refs_source_check` prints `ANY ('{…}'::text[])` instead of `ANY (ARRAY[…])` with the same two members (representation only); `onboarding_audit_action_check` keeps up to 27 extra action values (semantic widening); `provider_alerts_kind_check` and `price_list_kind_check` keep wider allowlists; `tw4_recurring_due` keeps a non-identical body until the `1126` rollback. **Every other catalog line must match exactly, the end of the round trip must equal CP0 with zero exceptions, and the re-apply must equal CP8 with zero exceptions.**

**Measuring caveat.** The Docker evidence used the QA harness's whole-catalog fingerprint; the hosted `probe_fingerprint.sql` is coarser (function bodies and meta, and per-table column/constraint/index/trigger md5 for the 20 `studio_sms_*` tables, no policies). On hosted, therefore: (a) an exception shows as a change in the table-level fingerprint of exactly `studio_sms_approval_refs`, `studio_sms_onboarding_audit`, `studio_sms_provider_alerts`, `studio_sms_price_list`, and in the body md5 of exactly `tw4_recurring_due`; (b) the allowed constraint text is checked **directly** against the stored strings in the evidence file, with

```sql
begin read only;
select conrelid::regclass::text as tbl, conname, regexp_replace(pg_get_constraintdef(oid), '[[:space:]]+', ' ', 'g') as def
from pg_constraint
where connamespace = 'public'::regnamespace
  and conname in ('studio_sms_approval_refs_shape','studio_sms_approval_refs_source_check','studio_sms_onboarding_audit_action_check','studio_sms_provider_alerts_kind_check','studio_sms_price_list_kind_check')
order by 1, 2;
rollback;
```

and any text outside the stored strings is a refusal. Policies are not in the hosted probe: read `pg_policies` for `studio_sms_registrations` directly where a step touches them.

## 7. Flags and switches that must stay OFF (D5; verify, never change)

From manifest 8.5. Env flags unset or not `on`: `SMS_CREDIT_PURCHASES`, `SMS_MONTHLY_LIMITS`, `SMS_RECURRING_AUTHORIZATION`, `SMS_RECURRING_SCHEDULER`, `SMS_USAGE_BILLING`, `SMS_USAGE_RECONCILER`, `SMS_INBOUND_RECORDING`, `SMS_FEE_LIFECYCLE_SCAN`, `SMS_FEE_LIFECYCLE_DELIVERY`, `SMS_USAGE_EVIDENCE_READS`, `SMS_SENDER_VERIFY_READS`, `SMS_BILLED_REAL_SEND`, `SMS_SENDER_REVERIFY`, `SMS_INVENTORY_RECONCILE`, `TW4_ISV_REAL_CALLS`, `TW4_PROVISIONING_REAL_CALLS`, `TW4_NUMBER_REAL_CALLS`, `TW4_NUMBER_READS`, `TW4_CANCEL_RELEASE`, `TW4_SUBACCOUNT_WEBHOOKS`; `TW4_ISV_FAKE` and `TW4_ISV_MOCK_BRAND` never on a hosted project; `FEE_RELEASE_ENABLED=false`. DB switches: no row in the switch logs (`studio_sms_recurring_switch_log`, `studio_sms_usage_switch_log`, `studio_sms_rfl_switch_log`), no runner window open, no studio pilot access enabled, no sender activated, credit hold untouched, monthly limits at the $0 default, pilot ceiling unspent. In this package the local application's environment contains none of them, by construction. If any item is found on, stop and report; do not turn it off as a side effect.

## 8. Strict failure and refusal rules

Stop immediately, capture the output, and do not edit SQL, do not retry with changes, do not "fix forward" without the owner, on any of:

1. Any authorization element missing or different from the run (project, ref, file list, hashes).
2. A non-zero row count in any `studio_sms_*` table, or any pilot exception, pilot approval or evidence row, at any time before the end of the operation.
3. A hash mismatch between an exported file and the manifest, or a different Git ref.
4. A fingerprint difference while idle, between a step's after-fingerprint and the next step's before-fingerprint.
5. Any `ERROR`, `precondition failed`, `55000`, `42501`, crash or restart message during an apply, or no final `COMMIT`.
6. A change outside the objects listed for that file in manifest section 6, or any change to `rollup:other_sms_functions`.
7. A partly applied layer found at D1.
8. During rollback (S6): any `55000` refusal (rows or a later layer exists; never weaken a guard), any difference not in the section 6 table, any stored-text mismatch, a non-zero final difference against CP0, or a non-zero re-apply difference.
9. Any flag or switch found enabled (section 7), any TW-4F cron, any real-call adapter configured.
10. Any outbound provider activity (Twilio, Stripe, Resend) or any SMS: none can occur with the switches off, so one is a stop-and-escalate event.
11. A request to use a second administrator account, enrol a factor, or test a dual-control path (section 10).
12. The first pilot evidence row appearing before the operation ends: `1230` and `1231b` become non-rollbackable (forward-fix only).

## 9. Final DEV acceptance tests (read-only)

After CP8 and before A2:

| # | Test | Pass condition |
|---|---|---|
| AT-1 | `probe_objects.sql` | all objects of the 41 files `PRESENT`; no `MISSING`; `UNEXPECTED` rows explained |
| AT-2 | `probe_fingerprint.sql` | `rollup:ALL` equals CP8; `rollup:other_sms_functions` equals CP0 |
| AT-3 | Row counts (section 2.2 query) | all `studio_sms_*` tables `0` |
| AT-4 | Grants and RLS (D4) | RLS on and API privileges empty for `anon`/`authenticated`/`service_role` on every `studio_sms_*` table; pinned `search_path` on every `20_function` row; `anon:false`, `public:false`; `authenticated:true` for exactly the client-exposed set in section 3 |
| AT-5 | aal2 body | `select position('aal2' in p.prosrc) > 0 from pg_proc p where p.oid = to_regprocedure('public._sms_onb_is_platform_admin()')` returns `true` |
| AT-6 | aal2 policies | `select policyname, (coalesce(qual,'') ilike '%aal2%' or coalesce(with_check,'') ilike '%aal2%') as has_aal2 from pg_policies where schemaname='public' and tablename='studio_sms_registrations' order by 1` returns the three policies "Platform admins read / create / update studio sms registrations", each `has_aal2 = true` |
| AT-7 | `1230`/`1231b` bodies | the probe's function-body md5 for `tw4_spend_authorize`, `tw4_pilot_exception_create`, `tw4_rfl_pilot_cover` equals the value recorded for the same functions in `docs/twilio/TW-4F_Docker_Chain_Top_Fingerprint_e749427c.txt` (harness fingerprint of the full chain at `e749427c`, same CR-stripped md5; compare the first 8 hex characters) |
| AT-8 | Flags OFF (section 7) | all items off, nothing changed |
| AT-9 | Role privilege reads (no calls) | `has_function_privilege` for `anon`/`authenticated`/`service_role` on the revoked functions matches the manifest; no function is *called* through the API |
| AT-10 | Smoke A3 | statuses as in section 1; zero blocked guard events; the DEV host is the only host contacted |
| AT-11 | S6 (optional, separately authorized) | final equals CP0 with zero exceptions; re-apply equals CP8 with zero exceptions |

Pass = all of AT-1 to AT-10 (AT-11 if included). Anything else is a stop and report. Passing proves the schema and the application agree at the catalog and request level; it does not prove any dual-control, pilot, billing or provider behavior.

## 10. Single administrator and dual-control restrictions

DEV has exactly one platform administrator with one verified TOTP factor. The migration itself needs no administrator session (it runs as the database owner through the CLI). Therefore: no account is created or enrolled; no admin session is used during S4 to S6; every dual-control path (including `tw4_rfl_dual_*` approvals and `tw4_price_set` dual control, pilot decision B-6) is **blocked and unverified**, and no result from this operation may be cited as evidence for them; after `1231` the administrator's own token must be aal2, which is why no admin action is attempted. A request to test dual control needs a second administrator supplied by the owner and a new authorization.

## 11. Recovery procedure (DEV only)

1. **On any stop**: freeze (no further file), stop the local application if running, save the output, record the last completed file and its after-fingerprint, and report. Do not retry.
2. **Decision tree**:
   - Failure *before* a file committed (its transaction rolled back): DB state equals the last after-fingerprint. Diagnose; no recovery needed.
   - Failure after commits: owner chooses (a) stay (forward-fix in a new reviewed migration), or (b) roll back.
3. **Roll back** (separate authorization): application first (nothing is deployed, so confirm it is stopped); then SQL in strict reverse of what was applied: `1231b, 1231, 1230, 1229, … 1207, 1206, 1205, … 1123`; `1231b` must precede `1230`. Take the fingerprint after each, compare per section 6, stop on anything unlisted. Run `probe_objects.sql` before each step because some rollbacks do not detect later layers (`1211`, `1217` do not refuse while `1225` is applied).
4. After the first pilot evidence row: no rollback of `1230`/`1231b`; roll the application back (stop), leave the SQL, forward-fix.
5. After full rollback the target is CP0 with **zero** differences; DEV then holds the original state.
6. PROD is untouched by any of this, and the round trip is never repeated on PROD.

## 12. Authorization template (for the owner; not yet given)

> Authorize the TW-4F DEV migration operation on Supabase project `epdrtzcydvnoidwrepqz` only, at Git ref `e749427ce5eaea3316752729f565e11254ac45af`: stages S2 (read-only preflight), S4 (apply the 41 files in manifest 4.1 order, one at a time), S5 (read-only acceptance tests AT-1 to AT-10)[, and S6 (rollback rehearsal)]. The operator is ___. No flag, deployment, cron, provider operation, SMS, spend, PROD change or merge is authorized. Stop on any item in section 8 and report.

## 13. Final recommendation

**Preparation: complete.** The runtime smoke test passed, the package is consolidated, and every earlier technical gate is closed.

**GO/NO-GO for the DEV migration operation: NO-GO until you approve it.** There is no remaining technical blocker. The operation is **CONDITIONAL GO** on exactly three owner actions: (1) the written authorization above; (2) a decision on S6 (rollback rehearsal, optional but recommended once, with the measuring caveat in section 6); (3) confirmation that nobody will drive DEV (including the older DEV-scoped Vercel previews) during S4 to S6. The 41-file hosted DEV migration remains unauthorized and unexecuted.

## 14. Execution record (2026-10-30): the 41-file DEV forward application was performed

Authorized by the owner for DEV project `epdrtzcydvnoidwrepqz` only, files from manifest 4.1 at `e749427ce5eaea3316752729f565e11254ac45af`, forward application only. The optional hosted rollback rehearsal was **not** performed and **no rollback or cleanup SQL was run**. Window: preflight 21:39 UTC, first apply 21:41:38 UTC, last apply 21:48:57 UTC. Operator: the TW-4F DEV migration coordinator session, using `supabase db query --linked -f` from a fresh scratch workdir (linked ref read back as `epdrtzcydvnoidwrepqz`; unlinked and deleted afterwards).

### 14.1 Execution conditions

| Condition | Result |
|---|---|
| Controlled window; no other writer | `pg_stat_activity` at preflight: 7 sessions, **0 non-idle** (PostgREST x3 idle, Supavisor, exporter, one idle client, platform workers). No `cron.job` table, no non-system scheduler. DEV-scoped Vercel previews: **0 requests** in the retained preview logs. Peer sessions were doing unrelated pricing/competition work; no TW-4F writer. No drift between CP0 and step 1 (re-read immediately before the first apply) and none between any two steps (each step began with a full fingerprint equal to the previous after-fingerprint). |
| Fresh read-only fingerprint, inventory, row counts (CP0) | `rollup:ALL` `bf10276e` (identical to the earlier 2026-10-30 probe), 296 fingerprint rows, 531 inventory rows, 20 `studio_sms_*` tables all 0 rows, `read_only_txn=on` |
| Zero-row and no-pilot-evidence preconditions | held before every one of the 41 steps (a row-count query ran before each apply; the pilot and evidence tables did not exist until their layers and then stayed at 0) |
| Exact 41-file order and hashes | all 41 files exported from `e749427c`, LF-normalized, sha256 equal to manifest section 3 (0 mismatches), strictly ascending, `1206` at position 16 between `1205` and `1207` |
| Flags and switches | no `TW4_*`/`SMS_*`/`FEE_RELEASE` variable exists in the `danceflow-app` or `danceflow-app-qfem` Vercel projects; the paired local build had none; all switch-log, runner-window, access, sender, credit-account, pilot, spend, charge, provisioning and Twilio-account tables are at 0 rows; `vercel.json` schedules only `/api/cron/sms-onboarding-purge` among SMS routes |
| Single administrator | no admin session, account creation, factor enrolment or dual-control action occurred |

### 14.2 Method (stricter than the runbook's list-based check)

Before the window a local DEV-equivalent Docker database (image at `1119_092100` plus `1120` to `1122`) was built and the **same 41 exported files** were applied there, with `probe_fingerprint.sql` and `probe_objects.sql` captured after every file. The hosted CP0 was compared with the local starting state: **all 296 fingerprint rows and all inventory rows were identical**, so the local run was an exact predictor. After every hosted apply the full hosted fingerprint and inventory were compared **row for row** with the local expectation for that step, plus: `other_sms_functions` unchanged, every `studio_sms_*` table at 0 rows, probes in read-only transactions. The driver had no rollback logic and halts on the first deviation.

### 14.3 Per-file checkpoints (all 41 passed)

| # | Timestamp | rollup:ALL after | fingerprint = expected | objects = expected | other_sms unchanged | zero rows (tables) | apply time |
|---|---|---|---|---|---|---|---|
| 1 | 20261123090000 | b67b8904 | true | true | true | true (20) | 8.7s |
| 2 | 20261124090000 | 112b1d65 | true | true | true | true (20) | 7.5s |
| 3 | 20261125090000 | 3d945d60 | true | true | true | true (21) | 7.1s |
| 4 | 20261126090000 | 70f82528 | true | true | true | true (23) | 7.5s |
| 5 | 20261127090000 | 2e881bae | true | true | true | true (25) | 8.1s |
| 6 | 20261128090000 | 6653943f | true | true | true | true (28) | 9.2s |
| 7 | 20261129090000 | 4625d367 | true | true | true | true (29) | 7.8s |
| 8 | 20261130090000 | 2682f786 | true | true | true | true (30) | 8.6s |
| 9 | 20261201090000 | a7bb2d70 | true | true | true | true (33) | 6.7s |
| 10 | 20261202090000 | 0655bf39 | true | true | true | true (34) | 7.1s |
| 11 | 20261202140000 | a6b95f9e | true | true | true | true (34) | 7.1s |
| 12 | 20261202150000 | eb956a4a | true | true | true | true (34) | 7.8s |
| 13 | 20261203090000 | 4b831780 | true | true | true | true (36) | 7.5s |
| 14 | 20261204090000 | 5c9c55c2 | true | true | true | true (37) | 7s |
| 15 | 20261205090000 | d0d74a77 | true | true | true | true (42) | 7.9s |
| 16 | 20261206090000 | ec4cf0dc | true | true | true | true (42) | 6.7s |
| 17 | 20261207090000 | 4da45740 | true | true | true | true (44) | 8s |
| 18 | 20261208090000 | a290a77b | true | true | true | true (53) | 6.7s |
| 19 | 20261209090000 | 4032f78d | true | true | true | true (58) | 6.5s |
| 20 | 20261210090000 | 5c0b9939 | true | true | true | true (58) | 6.5s |
| 21 | 20261211090000 | cb2f82e0 | true | true | true | true (64) | 7.7s |
| 22 | 20261212090000 | 1b3656fe | true | true | true | true (67) | 7.9s |
| 23 | 20261213090000 | 997e6ae4 | true | true | true | true (69) | 8.5s |
| 24 | 20261214090000 | 0953f865 | true | true | true | true (72) | 7.2s |
| 25 | 20261215090000 | 7e01ed4b | true | true | true | true (72) | 7.4s |
| 26 | 20261216090000 | f46e1763 | true | true | true | true (72) | 7.6s |
| 27 | 20261217090000 | bd4efcd3 | true | true | true | true (72) | 7s |
| 28 | 20261218090000 | bb239a9e | true | true | true | true (72) | 7.4s |
| 29 | 20261219090000 | a99340b4 | true | true | true | true (72) | 6.8s |
| 30 | 20261221090000 | c21895a0 | true | true | true | true (72) | 6.4s |
| 31 | 20261222090000 | 2a2550e2 | true | true | true | true (72) | 6.9s |
| 32 | 20261223090000 | d0bd2833 | true | true | true | true (72) | 6.7s |
| 33 | 20261224090000 | 9d3ac369 | true | true | true | true (72) | 6.3s |
| 34 | 20261225090000 | 0171e63d | true | true | true | true (72) | 6.4s |
| 35 | 20261226090000 | 2b501f98 | true | true | true | true (72) | 6.9s |
| 36 | 20261227090000 | 9a0b0ef4 | true | true | true | true (72) | 7.1s |
| 37 | 20261228090000 | cbcfa52b | true | true | true | true (72) | 7.1s |
| 38 | 20261229090000 | 61316393 | true | true | true | true (73) | 7.1s |
| 39 | 20261230090000 | cf29d2e9 | true | true | true | true (74) | 6.7s |
| 40 | 20261231090000 | 5ed060cc | true | true | true | true (74) | 7.2s |
| 41 | 20261231100000 | 3a38f6b6 | true | true | true | true (74) | 6.7s |

Special gates: `1229` (#38) and `1230` (#39) applied with all pilot, exception, approval and evidence tables at 0 rows before and after. **CP7 after `1231` (#40):** `_sms_onb_is_platform_admin()` contains the `aal2` requirement and all three `studio_sms_registrations` platform-admin policies (read, create, update) contain it, verified **before** `1231b` was applied; `1231b` (#41) followed with `1230` present. Final `rollup:ALL` `3a38f6b6`, identical to the local expected final state.

### 14.4 Acceptance tests AT-1 to AT-10

| # | Test | Result |
|---|---|---|
| AT-1 | `probe_objects.sql` | **PASS.** 75 tables, 413 functions, 158 triggers, 3 policies, 6 dependencies `PRESENT`; **0 `MISSING`**. One `UNEXPECTED`: `studio_sms_registrations` (TW-3 table, not created by these migrations; documented in the manifest). |
| AT-2 | `probe_fingerprint.sql` | **PASS.** Fresh `rollup:ALL` `3a38f6b6` equals the step-41 after-fingerprint (0 differing rows) and the local expected final state (all rows); `other_sms_functions` equals CP0. |
| AT-3 | Row counts | **PASS.** All 75 probed tables exact `rows=0`; the 74-table `studio_sms_*` count query all 0. |
| AT-4 | Grants and RLS (D4) | **PASS.** RLS on and API privileges empty (`anon`, `authenticated`, `service_role`) for every probed table; 413 functions, no unpinned `search_path` on a `SECURITY DEFINER` function, `anon:true` none, `public:true` none; `authenticated:true` set = **23 functions, exactly the manifest section 5 client-exposed set** (none extra, none missing). |
| AT-5 | aal2 body | **PASS.** `_sms_onb_is_platform_admin()` requires `aal2`. |
| AT-6 | aal2 policies | **PASS.** The 3 `studio_sms_registrations` policies each reference `aal2`. |
| AT-7 | Function bodies vs reference | **PASS.** `tw4_spend_authorize`, `tw4_pilot_exception_create`, `tw4_rfl_pilot_cover` body md5 equal the Docker chain; across all functions compared by name, 412 equal and 0 differing. |
| AT-8 | Flags and switches off | **PASS (configuration and database).** No switch variable in either Vercel project, none in the local build, all switch, activation, pilot and provisioning tables at 0 rows, one scheduled SMS route (the purge). Runtime confirmation that no running deployment reads a switch is pending the integration test. |
| AT-9 | Role privileges, no calls | **PASS (catalog).** Verified from the probe's privilege data (same evidence as AT-4); no function was called through the API at any point. |
| AT-10 | Smoke after the migration (A3) | **PASS** (completed in the later bounded integration run; see readiness report section 22: GET-only application smoke, 53 read RPCs, 0 incompatibilities, database unchanged). Limit: no authenticated session. |

### 14.5 Confirmations and side effects

- **No pilot activation, provider provisioning or fee-bearing activity.** Every pilot, exception, approval, spend, charge, credit, provisioning, Twilio-account, sender, runner-window and switch table is at 0 rows. No Twilio, Stripe or Resend call was made by this operation and no SMS was sent. No application was running against DEV (the local build stayed stopped for the whole window). No deployment or Vercel setting changed.
- The CLI's `db query` does not record versions: `supabase_migrations.schema_migrations` still has its single `remote_schema` row (informational; not authoritative on these projects).
- `origin/main` advanced to `23ffbc43` during the window (billing migrations `20270202090000` and `20270202100000`, unrelated, **not applied**); nothing used it. The 41 files came from the pinned ref.
- Evidence is kept in `docs/twilio/evidence/TW-4F_DEV_apply_20261030/` (untracked): CP0 probes, per-step results, after-fingerprints and inventories, the driver log, the local lockstep expectations, the probe SQL used and the acceptance summary. No credential appears in it (scanned). The scratch workdir was unlinked and deleted.

### 14.6 Not yet verified (pending runtime and later gates)

AT-10 (migrated-schema smoke of the paired build); aal1 platform-admin token refusal through a real session (needs the DEV administrator's aal2 flow); every dual-control path (`tw4_rfl_dual_*`, `tw4_price_set`), which stays blocked and unverified with one platform administrator; all provider, activation and pilot behavior; the hosted rollback rehearsal (not authorized and not needed: the Docker round trip covers it).

### 14.7 Next gate

**GO for the next DEV application-integration test** (start the paired local build, GET-only smoke, then non-mutating read paths, flags off), with the restrictions above unchanged. Anything that writes, calls a provider, activates a feature or uses a second administrator needs its own authorization. PROD stays on hold.
