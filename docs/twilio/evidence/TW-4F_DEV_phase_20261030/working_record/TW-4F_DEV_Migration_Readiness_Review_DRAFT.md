# TW-4F DEV migration-readiness review, revision 8 (DRAFT, NOT EXECUTED)

Status 2026-10-30, against main `b0257594954446e85e7a92befbe33f5f82101962`. Sections 0 to 7 are revision 2, sections 8 to 11 revision 3, sections 12 to 16 revision 4, section 17 revision 5 (re-based on main `e749427c`), section 18 revision 6 (local build preflight), section 19 revision 7 (DEV-bound local build and key verification), section 20 revision 8 (runtime smoke test; execution package). **Revision 4 supersedes the P3 exception wording in sections 4 and 8.4 (see section 14) and the GO/NO-GO in section 11 (see section 16).** **No migration, deployment, promotion, cancel, rollback or other hosted write was performed.** The only hosted access was read-only: Vercel API GET calls and `inspect`, and `begin read only` queries on DEV (`epdrtzcydvnoidwrepqz`). PROD was not queried and stays on hold. Applying anything needs the owner's separate written authorization.

## 0. Recommendation

**NO-GO for a DEV apply today (updated assessment: section 11). The SQL side is ready; the application side is not: no existing deployment is a verified DEV-bound build.** Nothing found in this revision is a technical blocker: DEV is a clean, unmodified 1122-level schema, the 41-file inventory is exact and hash-verified, and the order is dependency-valid.

Owner items still open (none of them is mine to decide):

1. Written authorization for the DEV apply (project, ref, the 41-file list in section 2, who deploys which build).
2. Option for the three constraints that stay wider after rollback (section 4).
3. Whether to proceed on DEV with a single platform admin (section 5).
4. Which application build will talk to DEV, and its release with or before `1123`, `1127`, `1128`, `1213`, `1214`, `1229`, `1230`, `1231` (section 3).

The manifest section 4 correction (`1206` in its numeric slot, plus the 41-file list) is prepared as draft PR [#361](https://github.com/genxttech/danceflow-app/pull/361), head `19f74e82`, not merged.

## 1. Part A: Vercel production state (read-only)

| Question | Finding |
|---|---|
| What serves `www.idanceflow.com` and `idanceflow.com`? | `danceflow-app-qfem` deployment **`dpl_HEvyvNbHzAiMBGT3yPVzeiGJk6Sj`**, target production, `readySubstate PROMOTED`. `vercel inspect` on both domains resolves to this id. |
| Its Git SHA | Built by the CLI (source `cli`, not Git) from branch `release/pricing-p1`, `gitCommitSha 4bc938c6e3788bf9e34f8cd83b92f1036ec33562` (PRICING-P1, #319). Created 2026-10-25T03:16:12Z (2026-10-24 23:16 EDT). |
| Baseline comparison | Identical to the approved PRICING-P1 baseline recorded at close. No newer qfem deployment is `PROMOTED`. |
| qfem settings drift | `autoAssignCustomDomains=false`, last updated 2026-10-25T03:40Z, which is before every merge in question. Domains unchanged: `idanceflow.com` (redirects to www), `www.idanceflow.com`, `danceflow-app-qfem.vercel.app`. No drift. |
| Did `f3a89874` or `b0257594` get promoted in qfem? | **No.** qfem `dpl_DNanFZXdRW7fDY2LofjBsiuWhDCU` (`f3a89874`) is `CANCELED`, `STAGED`, alias not assigned. qfem `dpl_5ymWezcou2GmgKZDkSkXA2qzzQzp` (`b0257594`) is `READY` but `STAGED`, not live. Every main-merge production build in qfem since 2026-10-25 (18 listed) is `STAGED`. |
| The separate `danceflow-app` project | **Yes, auto-promoted, by design.** `dpl_4YozH4U8uzfkSAX1fC65qUP4Dzxw` (`f3a89874`) and `dpl_8uoCuL8dSmkZZ8gp6Z5ddYD2Y3Yo` (`b0257594`) are `PROMOTED`. Its `autoAssignCustomDomains` is `true`, and its only domain is `danceflow-app.vercel.app` (aliases `danceflow-app-dance-flow`, `danceflow-app-git-main-dance-flow`). Every main merge since 2026-10-25 (17 listed) was auto-promoted the same way. This matches the recorded qfem-release-process note ("danceflow-app auto-serves its own vercel.app domain"), so it is not drift. It has no custom domain and is not customer-facing. |

Observations to report, not drift:

- `https://danceflow-app.vercel.app/` returned **HTTP 500** at check time. I have no earlier health baseline for that domain, I did not read its environment, and I did not touch it. Worth an owner look, because that project auto-serves every main merge.
- **Cancelled qfem build.** `dpl_DNanF…` (`f3a89874`): created 17:13:37.250Z, never started building, `CANCELED` at 17:19:14.285Z, which is 76 ms after the next commit's build (`b0257594`) turned `READY` at 17:19:14.209Z. The same pattern appears at `cacadd57`, canceled 02:23:16.983Z, 67 ms after `512fd7d2` turned ready at 02:23:16.916Z, and for two builds on 2026-10-25. This is consistent with Vercel dropping a queued build once a newer commit on the same branch supersedes it. That is an inference. The deployment metadata does not name an actor, and the GitHub status text ("Canceled from the Vercel Dashboard") is generic. Nothing was lost: the superseding build exists, and cancelled builds are never promoted.
- Active state matches the approved baseline. **No unexpected promotion and no configuration drift.**

## 2. Part B: exact DEV migration inventory

### 2.1 Count reconciliation

- Revision 1 said "21 files". **That was wrong.** The merged manifest has 48 rows, plus the reserved `1220` slot with no file. The 7 already on DEV are `1119_090`, `1119_091`, `1119_092`, `1119_092100`, `1120`, `1121`, `1122`. **Pending = 48 − 7 = 41 files**, exactly the length of the sequence I listed.
- Dated shorthand used in manifest section 4: `1130` means `20261130090000`, `1201` means `20261201090000`. The three `1202` files (`_090`, `_140`, `_150`) are three separate files.

### 2.2 DEV state: what the evidence is

1. **The CLI migration history is not usable.** `supabase_migrations.schema_migrations` on DEV holds exactly one row (`20261014090519`, `remote_schema`). It says nothing about this chain, so applied state comes from the catalog, not from history.
2. **Not an object probe alone.** I extracted every object each pending file creates or alters (tables, functions, indexes, triggers, constraints, policies, types, columns): 635 distinct names across the 41 files. A read-only catalog query on DEV found **no new object from any pending file**. The names that already existed were all created by baseline migrations, so I compared their definitions, not their names:
   - `studio_sms_{price_list,credit_reservations,provider_charges}_kind_check` and `studio_sms_spend_events_kind_check` exist. Their definitions on DEV lack `brand_low_volume` / `monthly_low_volume`, so **`20261202090000` is not applied** (and `20261203090000`, which re-reads `price_list_kind_check`, is not applied).
   - The three `studio_sms_registrations` policies exist but contain no `aal2`, and `_sms_onb_is_platform_admin()` has no `aal2`, so **`20261231090000` is not applied**.
   - `studio_sms_onboarding_audit_action_check` has 32 actions and none of the `sender_reverify_*`, `number_*`, `rfl_*`, `prov_*` additions.
3. **Whole-schema corroboration.** Re-running `probe_fingerprint.sql` today gives rollups identical to the manifest's recorded values: ALL `bf10276e` (286 objects), `tw4` function bodies `62585cfa` (84), function metadata `05025717` (84), plus the column / constraint / index / trigger rollups over the 20 `studio_sms_*` tables. Bodies, columns, constraints, indexes and triggers are therefore unchanged since the 1122-level state recorded on 2026-10-24. Policies are not in that probe, which is why I read them directly.
4. Conclusion: **DEV is at `20261122090000`; all 41 files are pending; no partial layer exists.** DEV holds 20 `studio_sms_*` tables (all counted by the fingerprint).

### 2.3 Why `20261206090000` appeared after `20261217090000`, and the correction

- Manifest section 4 lists `… 1217 → 1206 → 1218 …`. The reason given there is "by merge order": `1206` was merged to main on 2026-10-23 (`cdf342e2`), after `1207` and `1217` (2026-10-21/22), and the earlier isolated-QA scenario (`iso-qa.mjs`) applied it last. It is a merge-history artifact, **not a dependency**.
- Dependency facts (read from the files, not assumed):
  - `1206` requires only `1205` (reconcile-run table and RPC, the `sender_reverify` job in the lease check) and the unchanged `1204` bodies of three sender functions.
  - No file between `1207` and `1217` (or anywhere later) redefines `tw4_sender_due_reverify`, `_tw4sr_judge`, `tw4_sender_reverify`, `tw4_sender_reverify_run` or `tw4_sender_health`.
  - The audit-action constraint is widened by `1206, 1207, 1208, 1209, 1212, 1213, 1221, 1225`. Each one reads the live definition and extends it (`format(… %L …)` over the live list, no literal list), so the order does not matter.
  - `1223` needs the `sender_reverify` job to exist, which holds in either order.
- The 27-file Docker chain applied `1206` **first** (numeric order), and ran the full round trip in that order. The manifest order was exercised only by the older isolated-QA scenario.
- **Correction used in this report: `1206` takes its numeric slot (after `1205`, before `1207`).** Both orders are dependency-valid; numeric is the one the chain QA covered end to end including rollback, and it makes the strict-reverse recovery order simply the reverse of the timestamps. If the owner prefers the manifest order, nothing breaks, but then section 4's rollback order changes to match.

### 2.4 Inventory (apply in this order, one file at a time)

Hashes are the LF-normalized sha256 from the merged manifest. They were re-verified against `origin/main` by `verify_manifest_hashes.sh` (48 migrations, exit 0) at `b0257594`. "Requires" is the manifest section 5 column; all are satisfied by earlier rows in this numeric order.

| # | Timestamp | File | sha256 forward (LF) | Requires | Order note | App pairing |
|---|---|---|---|---|---|---|
| 1 | 20261123090000 | 20261123090000_twilio_tw4f3b_pay_stripe_credit_purchases.sql | e7afd0a3657e335c8d761bc04156167cc55e7bfd6ed3fff5073189d72ebf28bc | 1122 | numeric | YES: drops/re-creates tw4_credit_topup_pending, tw4_credit_settle_topup, tw4_credit_reverse_topup (main callers: smsCreditPurchases.ts, creditStore.ts) |
| 2 | 20261124090000 | 20261124090000_twilio_tw4f3b_ui_credit_reads.sql | 3476092b32f8f4e7b0324161c059860d3c2542f309b74eecbd7be526d3f15186 | 1123 | numeric | read function dropped/re-created; confirm the build's reader matches |
| 3 | 20261125090000 | 20261125090000_twilio_pay_integrity_hardening.sql | 10ef2b00c4831702cbb6e5b6939495557db69165d62aede43ef4a72d857f13a1 | 1123 | numeric | none identified |
| 4 | 20261126090000 | 20261126090000_twilio_recurring_authorization.sql | 9fa3000f06d5ad7b8547d7a80d17b33a18818e488ac6bd396aa82ad7af3625ab | 1122, 1125 | numeric | none identified |
| 5 | 20261127090000 | 20261127090000_twilio_recurring_execution.sql | 8decf51801b640f10d8a7adfb2180d1179446c8a757de33a441a3499f7d3a480 | 1126 | numeric | YES: drops/re-creates tw4_recurring_charge (main caller: smsRecurring.ts) |
| 6 | 20261128090000 | 20261128090000_twilio_monthly_spending_limits.sql | 2b211559cb0a25facfe8c1e2dcd0dc1cb3854814d58f16856e55b56cb6a50f4c | 1127 | numeric | YES: drops/re-creates tw4_recurring_due and _tw4rc_promised |
| 7 | 20261129090000 | 20261129090000_twilio_tw4f_provider_integration.sql | 5e9395e47c655eaa18c7b5445b515d052548c706b22a464c987c825f37361278 | 1121 (independent of 1128) | numeric | none identified |
| 8 | 20261130090000 | 20261130090000_twilio_tw4f_admin_panel.sql | 2b7796173739138e1fb57aade02c3df04f946b85423a2cb79c9cbdf63298fae2 | 1129, 1122 (independent of 1128) | numeric | none identified |
| 9 | 20261201090000 | 20261201090000_twilio_sms_usage_financials.sql | 849fda85d353d74cfd66509d86cfd22bd87726f754886ada846081d52d74c561 | 1128 | numeric | none identified |
| 10 | 20261202090000 | 20261202090000_twilio_tw4f_financial_integrity.sql | f1fc7e81e60c4001654708e4726c446148566699f5946787451dc85155dd59fe | 1130, 1128 | numeric | none identified |
| 11 | 20261202140000 | 20261202140000_twilio_tw4ml_default_tz_perf.sql | eb75f67320f9dc0532e4854fea546d1adf5774094abfb3f3c6359ed596d79cf5 | 1128 | numeric | none identified |
| 12 | 20261202150000 | 20261202150000_twilio_tw4f_panel_monthly_limits.sql | dd9d4f210867c1dcae307e99d6969e918cbf23a4f5ab529cd08add2d440a064d | 1128, 1130 | numeric | read function dropped/re-created; confirm the build's reader matches |
| 13 | 20261203090000 | 20261203090000_twilio_inbound_usage_recording.sql | a21074c58bb07ecd2e76d730de8a658ab359feb3be5ae47c538b8e2a26728212 | 1201 | numeric | none identified |
| 14 | 20261204090000 | 20261204090000_twilio_sender_readiness.sql | 6671ed7ab4a896c5c25ce36fd1ec047a35758704298399b4ce8f1a3964e3f122 | 1203 | numeric | none identified |
| 15 | 20261205090000 | 20261205090000_twilio_usage_reconciliation.sql | 2e8f122800477af9d241b9989042445095a28a5d7dcc31a525653995c18c515e | 1204 | numeric | none identified |
| 16 | 20261206090000 | 20261206090000_twilio_sender_reverification.sql | 7e766d021d478d8615c88134e41f62dd5bae7eb4379583fff1b10aa3f89b0b0e | 1205 | numeric slot (manifest 4 had it after 1217; see 4) | none identified |
| 17 | 20261207090000 | 20261207090000_twilio_r2a_messaging_service_campaign.sql | 8321fabb802623e766636087681a5b758af0aefa0dc5f76650eabf5aacda8d6b | 1204 | numeric | none identified |
| 18 | 20261208090000 | 20261208090000_twilio_r2b_number_activation.sql | 7551885c236bbe5d41a76fca6c3926ee9ba176ded8bdaf99baf9111e99c93b42 | 1207 | numeric | none identified |
| 19 | 20261209090000 | 20261209090000_twilio_recurring_fee_lifecycle.sql | d5f3af102b4ccc23e951c7735213846231748d97f369ffc27edcd25bd4a84c9e | 1205 | numeric | none identified |
| 20 | 20261210090000 | 20261210090000_twilio_r2c_owner_provisioning_read.sql | a77e7f9762864ea12ba356a2386daf35c854600d224356fa349d24b629e6a918 | 1207 | numeric | read function dropped/re-created; confirm the build's reader matches |
| 21 | 20261211090000 | 20261211090000_twilio_rfl_ops.sql | 75e470601359e6bf18eec1141f94fb0af085ebda6bcdfa54b9b97e6241621d7f | 1209 | numeric | none identified |
| 22 | 20261212090000 | 20261212090000_twilio_prov_fee_resolution_evidence.sql | 280adc409572d185bc2a67c0802b30131e16164cdb740116c9d187bd36e99df3 | 1207, 1208, 1209 | numeric | none identified |
| 23 | 20261213090000 | 20261213090000_twilio_r2b_p1_identity_evidence.sql | 3cb2f083bd59e6b6d7f48096c8d85119245e944ca2dca754fc29dc370659087b | 1208 | numeric | YES: drops/re-creates tw4_num_inventory_ack |
| 24 | 20261214090000 | 20261214090000_twilio_r2b_p2_orphans_reconciliation.sql | 9978f3a7fa9f99fa5460be98dd59301ed02278fbf14168f0fb8e39c1ab8ecc87 | 1208, 1213 | numeric | YES: drops/re-creates tw4_num_inventory_observe (main caller: numberStore.ts) |
| 25 | 20261215090000 | 20261215090000_twilio_prov_evidence_targets.sql | 2a3308aa1b1d4425d1d49263c4b94806b68051be42c6fef963d20f03c58f5277 | 1212 | numeric | read function dropped/re-created; confirm the build's reader matches |
| 26 | 20261216090000 | 20261216090000_twilio_prov_orphan_exposure.sql | e7f240e2279eaec0b5202b81d48ae76963c6b4417f79ff07ea819224102bf3d8 | 1212, 1211 | numeric | read function dropped/re-created; confirm the build's reader matches |
| 27 | 20261217090000 | 20261217090000_twilio_r2b_rfl_lifecycle_integration.sql | 0c832ffe4848c6642288fc994d20c54046bbb4e52165c5221dddbfbd64ac086f | 1208 … 1214 (1215/1216 not required) | numeric | none identified |
| 28 | 20261218090000 | 20261218090000_twilio_usage_reconciler_readiness.sql | c85bfafc7d8b15840fb9da18daff74f02d663681e49f7d51cb92952acf311af5 | 1205 (and 1204) | numeric | none identified |
| 29 | 20261219090000 | 20261219090000_twilio_act_pilot_funding_lock_order.sql | f1a7268bad4f6df513c5f3dcfab2d73836d6b60868692cdbc8301143546a8887 | 1208..1217; 1218 for any activation to pass | numeric | none identified |
| 30 | 20261221090000 | 20261221090000_twilio_admin_recovery_tooling.sql | 7dfcfcfa718ba297dc956bb56770c0b844cd30f335c72da7eebeb639f0b803c3 | 1207..1217 | numeric | none identified |
| 31 | 20261222090000 | 20261222090000_twilio_owner_texting_status.sql | d4bbc183aae7fc8489abff4ed45a28753039a873dac6bd03f853a909e2a60748 | 1208, 1209, 1212, 1214; _tw4act_items by signature (1219) | numeric | read function dropped/re-created; confirm the build's reader matches |
| 32 | 20261223090000 | 20261223090000_twilio_inventory_reconcile_run.sql | f3db1425ba82bfa79363889abaab3bc6b92efc7f71a5eacd277a5f147dc480de | 1205 | numeric | none identified |
| 33 | 20261224090000 | 20261224090000_twilio_rfl_cancel_target.sql | 59b03309d0e72441b9f17b83f993ee5a9b630709082a1be25705b10ce3671bee | 1209, 1211 | numeric | read function dropped/re-created; confirm the build's reader matches |
| 34 | 20261225090000 | 20261225090000_twilio_rfl_d5_cover.sql | f3c7700ef11879ea51c7c1215e775d41b4a1cbc64bddddf4d7a10af5093f5dfc | 1209..1217 | numeric | none identified |
| 35 | 20261226090000 | 20261226090000_twilio_act_console_gates.sql | 09588758d7739eebce82405c70d03a93a1e3c0080c93d95e0d749a0e51cc0723 | 1219, 1225 | numeric | none identified |
| 36 | 20261227090000 | 20261227090000_twilio_owner_number_offers.sql | 0c8e77b2a6693f6fce87fa9d432aed954eb0f466696c388f5705efeb01612c03 | 1208, 1222 | numeric | none identified |
| 37 | 20261228090000 | 20261228090000_twilio_ki1_cross_month_release.sql | 643b6c9e712c7813e68afdb88490a420fc4529f99306e878a94d18cb7d516514 | 1207..1221 (tw4_prov_observe as 1221 left it) | numeric | none identified |
| 38 | 20261229090000 | 20261229090000_twilio_rfl_pilot_evidence.sql | c9295ed40d54a6931fde47e75aede01b85fc382672bfbce9172f0fc1f3edd283 | 1209..1226 (1225 body fingerprint-checked) | numeric | YES: tw4_rfl_pilot_cover 4 to 11 arguments (main caller: providerFeeLifecycle.ts) |
| 39 | 20261230090000 | 20261230090000_twilio_rfl_pilot_spend_evidence.sql | e3275cd720bd044029e3caed553e60211a7c20949e84be06dce3049f2a5667e8 | 1209..1229 (predecessor bodies md5-checked) | numeric | YES: tw4_spend_authorize 7 to 14, tw4_pilot_exception_create 4 to 10 (main callers send the evidence arguments) |
| 40 | 20261231090000 | 20261231090000_twilio_platform_admin_aal2.sql | 5bb6faceecad0fef65bf842d93b4eba677e4df3e6b65bf01634ebb14c69e5333 | 20261119090000, 20261012090000 (a precondition checks _sms_onb_is_platform_admin and studio_sms_registrations exist) | numeric | YES: behaviour change; an aal1 platform-admin token is refused (AAL2 step-up build) |
| 41 | 20261231100000 | 20261231100000_twilio_pilot_spend_hardening.sql | 7862e9b97c83be4e1972de03104ac8b7d0738c54ce30c03cb731aeabd1d0a837 | 1230 (md5 of the three 1230 bodies checked) | numeric | none identified |

Notes on the table:

- "App pairing: YES" means the SQL drops a function signature or changes behaviour in a way an older caller would not survive. Main already contains callers for the new shapes (for example `pilotApprovalEvidence.ts` sends the `1230` evidence arguments, and `providerFeeLifecycle.ts` calls the 11-argument `tw4_rfl_pilot_cover`). The production build `dpl_HEvyvNbH…` (`4bc938c6`) references none of these functions in application code (only tests mention `tw4_`), so it is unaffected, but it is also not a build that could exercise this chain.
- "Read function dropped/re-created" rows replace a read RPC with a changed shape. The matching reader ships in main; confirm it with the same build.
- Hosted apply gates: `1230` and `1231b` must run before any pilot exception or approval exists (their forward preconditions refuse otherwise); with no pilot rows on DEV they pass. The apply method is the manifest 8.1 D1 to D5 procedure.

### 2.5 Reconciliation with the 27-migration Docker chain

- The chain = baseline image `df-isoqa/base:20261205090000` (July production schema plus repo migrations through `20261205090000`, already baked in) **plus 27 files**: `20261206090000` … `20261231100000` (26 TW-4F files) and `20270201090000_billing_protected_subscriptions.sql` (the 27th; unrelated billing, **not part of the DEV plan**).
- DEV plan (41) = 15 files already inside the image (`1123, 1124, 1125, 1126, 1127, 1128, 1129, 1130, 1201, 1202_090, 1202_140, 1202_150, 1203, 1204, 1205`) + 26 files the chain applied, rolled back and re-applied.
- So the 41 are covered as: 26 by the Docker chain (forward, reverse rollback, re-apply, second cycle) and 15 by the image build (forward only). The reverse-rollback evidence for those 15 is from earlier per-slice QA at `960a9d02` and was **not re-run here**. If the owner wants a rollback rehearsal for them, it needs a separate local run.
- The chain's final verdict is FAIL (exit 1), as reported earlier: the three-constraint rollback gap, four suite failures (stale tests and harness gating, none caused by `1231`/`1231b`), and a skipped canary suite. None blocks a forward DEV apply.

## 3. App-release pairing summary

Must be released with or before the SQL (the build that talks to DEV, from main at or after `b0257594`):

| SQL | Why |
|---|---|
| `1123`, `1127`, `1128` | Drops and re-creates the credit-topup, recurring-charge and recurring-due functions (new signatures). |
| `1213`, `1214` | Drops and re-creates `tw4_num_inventory_ack` and `tw4_num_inventory_observe`. |
| `1229`, `1230` | `tw4_rfl_pilot_cover` 4 to 11 arguments; `tw4_spend_authorize` 7 to 14; `tw4_pilot_exception_create` 4 to 10. Old callers fail once applied. |
| `1231` | AAL2: any path using the platform admin's own token needs an aal2 session; aal1 is refused. |
| `1231b` | SQL only; no signature changes, but it requires `1230`. |

Open: **which deployment, if any, talks to DEV is unknown to me.** I did not read environment values. The live qfem build is wired to PROD per the release notes, and the `danceflow-app` project auto-serves every main merge. The owner must say which build the DEV apply is paired with before authorization.

## 4. Gate 1: the three constraints that stay wider after a full rollback (preserved)

| Constraint | Cause | Semantic? |
|---|---|---|
| `studio_sms_approval_refs_shape` | `20261208090000` adds the `number_selection` branch; its rollback does not restore the narrow form | yes (wider allowlist) |
| `studio_sms_approval_refs_source_check` | same migration; the rollback rebuilds an equal list, printed `ANY('{..}'::text[])` instead of `ANY(ARRAY[..])` | no (representation only) |
| `studio_sms_onboarding_audit_action_check` | `1209`, `1212`, `1225` widen it; their rollbacks do not narrow it (`1221` does) | yes (wider allowlist) |

P3, pre-existing, identical at `960a9d02` and at `75c4b28b`. `1231`, `1231b`, `20270201090000` do not contribute. Effect on DEV: a reverse rollback will not return DEV to its pre-apply catalog, and the fingerprint comparison for the affected steps will differ on exactly these three constraints. Options: (1) accept and record, with D3 expecting exactly those differences (my recommendation for the first DEV apply); (2) fix the rollbacks first in a separate PR with its own QA; (3) skip the D3 round trip. Owner decision required.

## 5. Gate 2: dual control with one platform admin (preserved, unresolved)

DEV and PROD each have exactly one platform admin, with one verified TOTP factor. Dual-control paths fail closed with one admin. No account was created and no factor was enrolled. The DEV apply itself needs no admin session, but any DEV verification of a dual-control approval cannot pass, and after `1231` the admin's own token must be aal2. The owner either supplies a second admin, or accepts that dual-control paths stay untested on DEV.

## 6. Recovery procedure

1. Before D0 record: the deployment serving DEV; fresh `probe_objects.sql` and `probe_fingerprint.sql` output (today's values: ALL `bf10276e`, bodies `62585cfa`); row counts of every `studio_sms_*` table (all 0).
2. On a refusal or a fingerprint difference: stop. Do not edit the SQL or the rollback. Capture the output.
3. Roll the app back first (promote the recorded previous deployment, a separate authorization), then the SQL.
4. SQL rollback runs in strict reverse of the order actually applied: `1231b, 1231, 1230, 1229, 1228, … 1207, 1206, 1205, … 1123` (numeric order reversed). `1231b` must precede `1230` (the `1230` rollback md5-checks bodies that `1231b` replaced). `1231` is independent but keeps its place.
5. `55000` refusals mean rows or a later layer exist. Never weaken one. After the first pilot evidence row, `1230` and `1231b` cannot be rolled back; roll the app back, leave the SQL, forward-fix.
6. After each rollback step take the fingerprint: it must equal that file's recorded before-fingerprint, except the three constraints in section 4.
7. Run `probe_objects.sql` before any rollback step: some rollbacks do not detect later layers (`1211` and `1217` do not refuse while `1225` is applied).

## 7. Other items (tracked, not blockers for a forward DEV apply)

- Stale tests: `f3recon` F3-09(d) and `j2owner`; `r2b` and `tw4fj1` need harness support. `isolatedQa.canary` skipped.
- The hosted probes cannot see the `1231` body or its policy re-creation. After applying `1231`, check `position('aal2' in prosrc) > 0` for `_sms_onb_is_platform_admin()` and read the three policies directly (as done in 2.2).
- `https://danceflow-app.vercel.app/` returning 500 (section 1) and the build-to-DEV question (section 3).
- ConfiDance pilot gates (KI-1, U-2 pricing, U-4 evidence, reconciler scheduler and alert recipients, compliance mailbox) are separate from the DEV schema apply. PROD stays on hold.

## 8. Workstream A: DEV application compatibility (read-only)

Owner direction applied (planning only, nothing authorized): the documented P3 rollback-constraint exception is the proposed DEV-only recovery model; every other object keeps strict fingerprint checks; technical DEV validation may proceed with one platform admin while dual-control workflows stay blocked and unverified.

### 8.1 Which deployment and configuration is associated with DEV

| Fact | Finding |
|---|---|
| Project that can be DEV-bound | `danceflow-app` (`prj_NjLGbAWH2rrkAGF3ABSxLfZDgUI6`). It is the only project whose Supabase variables (`NEXT_PUBLIC_SUPABASE_URL`, `_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) are scoped to **preview and development only** (all set 2026-09-25). Its **production target has no Supabase variables.** |
| qfem | One `NEXT_PUBLIC_SUPABASE_URL` entry (id `xtw15Y1atMAnomcH`) is scoped `production,preview`, so qfem previews use the same value as production (PROD per the release notes). qfem has **no** preview-scoped service-role key (production and development only). qfem preview builds are therefore not DEV builds. |
| Which database the legacy preview scope points at | **Not verified.** Values are encrypted; I did not decrypt or print them, and the API does not return them. The `epdrtzcydvnoidwrepqz` ref cannot be confirmed from Vercel. Needs an owner or ops confirmation (Vercel dashboard, no value copied). |
| Deployment currently serving that scope | None for main. Legacy production `dpl_8uoCuL8dSmkZZ8gp6Z5ddYD2Y3Yo` is `b0257594` but runs the production scope (no Supabase, section 10). The newest legacy preview `dpl_F3AiB9Y4fLJWFjNjdY9hNCUTwEEe` is branch `competition-cf1-callback-final-design` at `238baea2` (not in main, `STAGED`). |
| Names present on the DEV-capable (preview) scope, no values read | TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, CRON_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_SITE_URL, PUBLIC_LEAD_STUDIO_ID, OUTBOUND_FROM_EMAIL, NOTIFICATION_FROM_EMAIL. **Absent:** every TW4_* switch, `SMS_EIN_ENCRYPTION_KEY` (qfem production only), `AI_FEATURES_ENABLED`, `NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED`. Whether the Twilio and Stripe secrets are live or test is unknown. |

Conclusion: **no existing deployment is a verified DEV-bound build of main.** One has to be created (a deployment, which needs its own authorization) or the app run locally against DEV with the owner's own environment file.

### 8.2 Does main support the required RPC signatures and AAL2

Checked statically on `origin/main` `b0257594` (the build SHA I would pair; nothing newer is needed). Method: for each changed function, take the final SQL definition's parameter list and look for each parameter name in the application callers (test files excluded).

| Function (final SQL definition) | SQL params | App caller on main | Every SQL parameter used by a caller |
|---|---|---|---|
| tw4_credit_settle_topup (1123) | 7 | smsCreditPurchases.ts, creditStore.ts | yes |
| tw4_credit_topup_pending (1125) | 5 | same | yes |
| tw4_recurring_charge (1217) | 3 | smsRecurring.ts | yes |
| tw4_num_inventory_observe (1214) | 5 | numberStore.ts | yes |
| tw4_rfl_pilot_cover (1231b) | 11 | providerFeeLifecycle.ts | yes |
| tw4_spend_authorize (1231b) | 14 | pilotApprovalEvidence.ts, entityStore.ts, panel.ts | yes |
| tw4_pilot_exception_create (1230) | 10 | pilotApprovalEvidence.ts, creditStore.ts, panel.ts | yes |
| tw4_credit_reverse_topup, tw4_recurring_due, tw4_num_inventory_ack, _sms_onb_is_platform_admin | n/a | database-internal (no app caller) | n/a |

AAL2: `requirePlatformStepUp("aal2")` guards the platform SMS server actions (`src/app/platform/sms/*Actions.ts`), and `/platform-mfa/challenge` implements the step-up with the 15-minute window. That is PR #312 (`2ff4beb7`, 2026-10-29), in `b0257594`.

Limits of this evidence: it is a text match of parameter names, not a type check or a run. The caller window can also capture neighbouring calls, so the reverse direction (extra caller keys) is not asserted. Runtime proof is the isolated Docker QA chain, which exercised these RPCs against the 26 files at `b0257594` (passed apart from the known stale suites, section 7). The promoted qfem production build `4bc938c6` calls none of these functions and cannot validate them.

### 8.3 Application-before-SQL dependencies (complete list)

| SQL | Main build live first? | Why |
|---|---|---|
| 1123 | yes | re-creates tw4_credit_topup_pending, _settle_topup, _reverse_topup with new signatures |
| 1127 | yes | tw4_recurring_charge replaced |
| 1128 | yes | tw4_recurring_due, _tw4rc_promised replaced |
| 1213, 1214 | yes | tw4_num_inventory_ack and _observe replaced |
| 1229, 1230 | yes | tw4_rfl_pilot_cover 4 to 11 args; tw4_spend_authorize 7 to 14; tw4_pilot_exception_create 4 to 10 |
| 1231 | yes | an aal1 platform-admin token is refused afterwards |
| 1231b | no signature change | needs 1230 applied first |
| 1124, 1212, 1215, 1216, 1222, 1224 | confirm reader | read RPCs replaced; the main reader matches them |

On DEV the "with or before" window is harmless while the TW-4F paths stay dark (no TW4_* switch exists on the legacy project) and nobody exercises them between the app step and the SQL step.

### 8.4 Proposed deployment and migration sequence, with recovery checkpoints (not authorized)

| Step | Action | Checkpoint / recovery |
|---|---|---|
| S0 | Owner authorizes in writing: project and ref, the 41-file list (PR #361 once merged, or section 2.4), the build and who deploys it | none |
| S1 | Confirm, without printing values, that the legacy preview scope's Supabase URL is the DEV ref | stop if it is not |
| S2 | Read-only preflight on DEV: both probes (expect ALL `bf10276e`, bodies `62585cfa`), 0 rows in every studio_sms_* table; record the DEV-bound deployment id and the previous one | CP0 = these records; they are the recovery target |
| S3 | Create the DEV-bound build of `b0257594` (or run locally against DEV) with no TW4_* switch and no enabling flag (manifest 8.5) | CP1: smoke the build against the unchanged schema (login only), then freeze |
| S4 | Apply the 41 files one at a time, `supabase db query --linked -f` from a scratch workdir. Fingerprint before and after each; objects probe on every file | CP2 after #6 (1128), CP3 after #15 (1205), CP4 after #28 (1218), CP5 after #38 (1229), CP6 after #39 (1230, **before any pilot row exists**), CP7 after #40 (1231: check `position('aal2' in prosrc) > 0` and read the three policies), CP8 after #41 (1231b) |
| S5 | D4 grants and RLS probe, D5 flags-off check | any deviation stops the run |
| S6 | Optional D3 round trip (rows still 0), reverse order with 1231b before 1230, **under the P3 exception below** | after each rollback the fingerprint must equal that file's recorded before-fingerprint; then re-apply and compare with CP8 (identical) |
| Recovery | Any refusal or fingerprint difference: stop, capture output, do not edit SQL. Roll the app back to CP0 first (separate authorization), then SQL in strict reverse (section 6). After the first pilot evidence row, 1230 and 1231b cannot be rolled back: forward-fix only | |

**P3 exception, defined for the checks.** In S6 the only permitted difference is, by name, `studio_sms_approval_refs_shape` (wider allowlist), `studio_sms_approval_refs_source_check` (representation only) and `studio_sms_onboarding_audit_action_check` (wider allowlist), and only on the steps that undo 1208, 1209, 1212 and 1225. Everything else stays an exact fingerprint match. Preparation item: capture the exact post-rollback text of those three constraints from the Docker chain so the comparison is against a recorded string, not a judgement. The chain already re-applied forward after rollback in its second cycle, so a forward re-apply over the wider constraints is evidenced. This exception covers DEV only; it is not a PROD recovery model.

**One platform administrator.** Technical validation proceeds: schema, grants, fingerprints, function bodies, single-admin AAL2 behaviour. Dual-control approvals are **blocked and unverified**; no DEV evidence may be cited for them.

### 8.5 Compatibility blockers

1. No verified DEV-bound deployment exists (8.1). Creating one is a deployment; running locally avoids that.
2. The DEV ref behind the legacy preview scope is unconfirmed (encrypted, not decrypted).
3. The DEV-capable scope carries Twilio, Stripe and Resend secrets (live or test unknown). D5 forbids enabling flags and none exist, but the owner should know a DEV build holds them. No SMS or Stripe call is made by any step here.
4. `SMS_EIN_ENCRYPTION_KEY` is absent on the legacy project, so EIN-encrypting onboarding flows cannot be exercised on that build. Schema validation is unaffected.
5. The legacy project's fate (section 10) interacts with this plan: do not retire or lock it before the DEV build question is settled.

## 9. Workstream B: manifest correction (done as a draft PR)

- Draft PR [#361](https://github.com/genxttech/danceflow-app/pull/361), branch `docs/tw4f-manifest-dev-order`, head `19f74e82`, base `b0257594`. Documentation only (+52/-2, one file).
- Order line: `1206` moved from after `1217` to its numeric slot; the note is rewritten (no dependency; Docker QA covered the numeric order). New section 4.1 lists the 41 files in order with app-pairing flags; filenames checked to exist; hashes stay in section 3, untouched.
- `verify_manifest_hashes.sh`: 48 migrations, **MANIFEST HASHES OK**. The commit message has no AI attribution and no Co-Authored-By.
- Not merged, not marked ready. The tracker line "may be applied after 1217" (line 226) is left alone: still true, just no longer the plan.

## 10. Workstream C: legacy Vercel project (read-only)

**The 500 is a missing-configuration failure, not a code defect.** Runtime logs for `dpl_8uoCuL8dSmkZZ8gp6Z5ddYD2Y3Yo` show "Your project's URL and Key are required to create a Supabase client" on every request that reaches the Supabase client (the home page and the first request of every page). The production target of `danceflow-app` has no Supabase variables; they were scoped to preview and development on 2026-09-25. Every main merge builds there, auto-promotes, and serves 500. `/api/health` answers 404.

| Question | Finding |
|---|---|
| Intended to be externally accessible? | **Not documented as intended.** No custom domain; the recorded release notes call it an auto-served vercel.app domain, not customer-facing. It is publicly reachable anyway: the production alias answers without sign-in (project protection is `all_except_custom_domains`; deployment and branch URLs answer 302 to Vercel sign-in). Owner intent is unconfirmed. |
| Security risk of auto-promoting main | **Low today, latent.** The production target has STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and RESEND_API_KEY (set 2026-04-16) but no database, so data paths fail before a write. Worth confirming those are still wanted there, and whether any Stripe webhook endpoint still targets this domain (I made no Stripe call). Latent risk: anyone adding Supabase variables to this project's production scope turns every main merge into an instantly live release with no promotion gate, the opposite of the qfem model. |
| Reliability risk | Each main merge builds twice (qfem staged plus legacy promoted). The 8 or more crons in `vercel.json` run on the legacy production deployment and fail closed (503/401: CRON_SECRET is preview/development only), producing error noise and no writes. |
| Unintended feature exposure | None found. Feature switches are absent in this project (no TW4_*, no competition-registration flag, no AI flag), so code ships dark; with no database nothing can run. |

Recommendations (separate; none executed):

- **R1** Confirm intent with the owner.
- **R2** If it is only a legacy or staging remnant: stop it auto-promoting (set `autoAssignCustomDomains=false` to mirror qfem, or disconnect the Git production branch) and remove the stale production-scoped secrets.
- **R3** If it is retired: archive it after confirming no Stripe webhook, Resend or cron dependency.
- **R4** If it is meant to be the DEV host: make that explicit (DEV-only variables, deployment protection on for all deployments including production, no real-call secrets).

Do not change it before the DEV build decision in 8.5.

## 11. Updated DEV GO/NO-GO

**NO-GO today.** Reasons, in order: (1) no authorization (hosted migrations remain withheld); (2) no verified DEV-bound application build, and the DEV ref behind the legacy preview scope is unconfirmed; (3) the P3 exception needs its recorded expected constraint text before S6.

**Not blockers:** the SQL side (41 hash-verified files, dependency-valid order, DEV a clean 1122-level schema); the single platform admin (technical validation proceeds, dual control stays blocked and unverified); the three-constraint limitation (accepted for DEV only, under the exception).

**Becomes technical GO when:** the owner authorizes in writing (project, ref, the 41 files, the build and its deployer); the DEV ref is confirmed; a main build bound to DEV exists with no enabling flag (or is run locally); the exception text is captured. PROD stays on hold. Preserved unchanged: the three-constraint rollback limitation (section 4) and the single-admin dual-control issue (section 5).

## 12. Workstream A (revision 4): DEV application configuration, read-only

### 12.1 Does the `danceflow-app` Preview/Development Supabase URL point at DEV `epdrtzcydvnoidwrepqz`?

**Still unverified from Vercel; owner-side confirmation is required.** The values are stored as `encrypted`; the API returns ciphertext (length 1100), and I did not use `vercel env pull` or any decrypting route, so nothing secret was read or written to disk. Public client bundles (legacy and qfem) carry no Supabase host or Stripe publishable key I could read, so there is no public-metadata route either.

What supports, but does not prove, DEV: the preview/development scope holds exactly the three Supabase variables, set together on 2026-09-25 and absent from the production target; the owner's local `.env.local` has a `NEXT_PUBLIC_SUPABASE_URL` whose project ref equals `epdrtzcydvnoidwrepqz` (compared by program, ref not printed beyond the match). That file is not Vercel's configuration.

**Owner checklist (Vercel Dashboard, no value pasted into chat or files):**

1. Vercel, team `dance-flow`, project `danceflow-app`, Settings, Environment Variables. Filter to **Preview** and open `NEXT_PUBLIC_SUPABASE_URL`. Reveal it and read only the first six characters of the subdomain: expect `epdrtz`. Do not copy it.
2. Open `NEXT_PUBLIC_SUPABASE_ANON_KEY` the same way and note only its last four characters. In the Supabase dashboard for **DEV** (Project Settings, API) compare the anon key's last four. A URL that says DEV with a key from another project is the dangerous mismatch, so check both.
3. Repeat step 1 for `SUPABASE_SERVICE_ROLE_KEY` (last four against the DEV service-role key; reveal only on the Supabase side if you prefer, never in a screenshot).
4. Repeat step 1 for **Development**. Then check the `danceflow-app-qfem` Preview scope: expect the PROD ref `hvsujy`, which would confirm qfem previews are PROD-bound.
5. Reply with four yes/no lines (URL DEV, anon DEV, service-role DEV, qfem preview PROD). That is the only evidence I need.

### 12.2 Safest way to prepare a DEV-bound build of the approved SHA

Pin the application SHA to `b0257594954446e85e7a92befbe33f5f82101962`. PR #361 changes only a document, so a later docs-only main has an identical application; keep the pin anyway.

| Rank | Method | Deployment? | Exposure |
|---|---|---|---|
| 1 (recommended) | Detached worktree at `b0257594`, `next build` then `next start` on localhost, with a **minimal environment file** holding only the DEV Supabase URL, anon key and service-role key (plus `NEXT_PUBLIC_APP_URL=http://localhost:3000`). No Stripe, Twilio, Resend, OpenAI, Mux, Gusto, Google or Wave variables, no `CRON_SECRET`. | none | lowest: provider calls cannot happen because the keys are absent |
| 2 | A Vercel preview of a branch at `b0257594` in `danceflow-app` | **yes, needs its own authorization** | inherits the full preview scope (service-role key, Twilio, Stripe, Resend, `CRON_SECRET`); every branch build does |
| Never | Promote or redeploy the legacy production deployment; use a qfem preview | n/a | legacy production has no Supabase configuration; qfem previews are PROD-bound |

Do **not** reuse the owner's `.env.local` wholesale: it holds about 60 variables including provider secrets (Stripe test-prefix keys, Twilio, Resend, OpenAI, Mux, Gusto). Method 1 needs three. The TW-4F switches (`TW4_*`) are unset in every scope and must stay unset (manifest 8.5).

Note on automatic previews: pushing the PR #361 branch made Vercel build preview deployments for both projects (checks "Vercel – danceflow-app" and "-qfem", docs only, SSO-protected). That is the standard side effect of any PR and not a promotion; it means the legacy preview scope's secrets are exposed to every branch build already.

### 12.3 Application and SQL compatibility of the eight app-pairing layers

Static parameter match (section 8.2) found every SQL parameter used by a caller on main for all layers with an app caller. New evidence in this revision: all 41 files apply forward, roll back in strict reverse and re-apply on a DEV-equivalent database with no error (section 14), which proves the SQL half. Application half is a text match plus the Docker `localStack` suites from the earlier chain run; no application type check or end-to-end run was repeated.

| Layer | Final signature owner | App caller on main | Status |
|---|---|---|---|
| 1123 | tw4_credit_topup_pending / _settle_topup / _reverse_topup | smsCreditPurchases.ts, creditStore.ts | params match; _reverse_topup is DB-internal |
| 1127 | tw4_recurring_charge | smsRecurring.ts | params match |
| 1128 | tw4_recurring_due, _tw4rc_promised | DB-internal | no caller; see the rollback note in section 14 |
| 1213 | tw4_num_inventory_ack | DB-internal | no caller |
| 1214 | tw4_num_inventory_observe | numberStore.ts | params match |
| 1229 | tw4_rfl_pilot_cover (11 args, final from 1231b) | providerFeeLifecycle.ts | params match |
| 1230 | tw4_spend_authorize (14), tw4_pilot_exception_create (10) | pilotApprovalEvidence.ts, entityStore.ts, panel.ts, creditStore.ts | params match |
| 1231 | _sms_onb_is_platform_admin (aal2) | `requirePlatformStepUp("aal2")` in platform SMS actions | present in `b0257594` |

### 12.4 Stripe, Twilio and Resend in the DEV-capable scope: test, live or unconfigured

Non-secret metadata can establish **configured**, not **mode**. Table (names, scope, type and update date only):

| Provider | Variables on the `danceflow-app` preview/development scope | Type | Set | Mode |
|---|---|---|---|---|
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (each **one entry shared by production, preview and development**) | encrypted | 2026-04-16 | **undetermined** |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (preview and development only) | encrypted | 2026-09-25 | **undetermined** (an `AC` SID looks the same in test and live) |
| Resend | `RESEND_API_KEY`, `OUTBOUND_FROM_EMAIL`, `NOTIFICATION_FROM_EMAIL` (shared by all three scopes) | encrypted | 2026-04-16 | **undetermined** (`re_` prefix is the same either way) |

Because the Stripe and Resend entries are shared across scopes, whatever mode the legacy **production** target runs in, the DEV-capable preview runs in too. The owner's local file shows `pk_test`/`sk_test` prefixes; that says nothing about Vercel's value. Until the owner reads the mode in each provider's dashboard (read-only view, no API call from me), treat all three as **live-capable**. Runtime logs show no Stripe webhook, Twilio callback or lead-form requests on the legacy production deployment in the retained window (50 entries, 2026-10-30 17:50 to 19:29 UTC): only cron paths (all 503) and 500s on `/` and `/login`.

### 12.5 Gates preserved

No deployment, promotion, environment change, provider call, SMS, Stripe operation or migration was made. Method 1 above needs no deployment. Method 2 and the migrations each need separate written authorization.

## 13. Workstream B (revision 4): PR #361 review

| Check | Result |
|---|---|
| Head | `19f74e8247d33b823ab1db701868626df72382ff`; unchanged since creation |
| Draft | yes; merge state `CLEAN` |
| Scope | one file, `docs/twilio/TW-4F_Hosted_Apply_Manifest.md`, +52/−2; no code, SQL or config file |
| Attribution | commit message and PR body contain no `Co-Authored-By`, "Claude", "Anthropic" or "Generated with" (searched); author Michael Curtis |
| Hashes | sections 3, 5 and 6 onward are **byte-identical** to `origin/main`; an independent script re-hashed all 48 forward and 48 rollback files (LF-normalized) from `origin/main` and found **0 mismatches**; `verify_manifest_hashes.sh` also passed (48, `MANIFEST HASHES OK`) |
| 41-file list | 41 rows, numbered 1 to 41, strictly ascending, every file named in the manifest with the identical filename, and equal to the manifest's rows after `20261122090000` |
| `1206` placement | list positions 15 (`1205`), 16 (`1206`), 17 (`1207`); the order line reads `1205 → 1206 → 1207` and contains no `1217 → 1206` |
| Dependencies | every manifest section 5 requirement precedes its dependent in the list; a text scan of all 41 forward files found none that names a **later** file; the Docker round trip (section 14) applied exactly this order, rolled it back in reverse and re-applied it on a DEV-equivalent database with no error |
| CI | only the three Vercel checks ran and passed. The repo's `Typecheck, build, lint, unit/integration tests` job did not run: its `pull_request` trigger has a `paths:` filter that a documents-only change does not match. `main` has no branch protection (API 404), so there are no required status checks to satisfy |

Independence caveat: I authored the PR. The review above is a separate script run against `origin/main` files and the PR head, plus the Docker run; it is not a second human reviewer.

**GO for merge** of #361 as a documentation correction (low risk, fully reversible by revert). It stays draft and unmerged until you authorize. Suggested follow-up, separate: record the section 14 rollback exceptions in the manifest's 8.1 D3 text.

## 14. Workstream C (revision 4): rollback exception evidence

Two runs, both on a disposable local Docker Postgres from `df-isoqa/base`, from `origin/main` `b0257594`, no hosted access:

- **Run 1** (`run-chain.mjs chain`, baseline image through `1205`): the existing chain, 27 files, to extract the three constraint definitions.
- **Run 2** (new, DEV-equivalent): image at `20261119092100`, plus `1120`, `1121`, `1122` (the DEV level), then the 41 pending files forward, one fingerprint after each; then all 41 rolled back in strict reverse, one fingerprint after each, compared with the state before that file was applied; then re-applied and compared with the first full apply. The fingerprint is the QA harness catalog fingerprint (functions with body md5, tables and columns, constraints, indexes, policies, triggers, views, sequences, types, default ACLs, schema ACL). Evidence file: `docs/twilio/TW-4F_DEV_Rollback_Exceptions_Evidence.json` (untracked).

### 14.1 The exact post-rollback definitions (run 1, baseline `1205`, after rolling back `1206` to `1231b`)

1. `studio_sms_approval_refs_shape`: **semantic widening.** The baseline form allows two branches (`spend_authorization`, `pilot_exception`). After rollback a **third branch stays**: `((source = 'number_selection'::text) AND (spend_event_id IS NULL) AND (kind IS NULL) AND (amount_cents IS NULL) AND (funding IS NULL) AND (studio_id IS NOT NULL))`, added by `20261208090000`.
2. `studio_sms_approval_refs_source_check`: **representation only.** Baseline prints `ANY (ARRAY['spend_authorization'::text, 'pilot_exception'::text])`; after rollback it prints `ANY ('{pilot_exception,spend_authorization}'::text[])`. Same two members, so no widening and no behavior change.
3. `studio_sms_onboarding_audit_action_check`: **semantic widening.** Baseline allows 50 action values; after rollback it allows 77. The 27 extra values that stay are: `prov_disposition, prov_listing, prov_orphan, rfl_alert_delivery, rfl_cancel_authorized, rfl_cancel_confirmed, rfl_cancel_refused, rfl_cancel_resolved, rfl_cancel_started, rfl_cancel_unknown, rfl_cancel_withdrawn, rfl_cover_recorded, rfl_cover_superseded, rfl_df_suspended, rfl_dual_approved, rfl_dual_consumed, rfl_dual_invalidated, rfl_dual_rejected, rfl_dual_requested, rfl_exposure_closed, rfl_exposure_disposed, rfl_exposure_opened, rfl_initial_cover_skipped, rfl_provider_billed, rfl_registered, rfl_switch_set, rfl_variance_acked`. No baseline value is missing from the post-rollback list.

Run 1 also re-applied equal (0 differences) and its second cycle equal.

### 14.2 What a full DEV round trip actually shows (run 2, new finding)

The gap is **transient on a full DEV round trip, not permanent.** Rolling back all 41 files returned the DEV-equivalent database to a catalog **identical to the starting state: 0 differences**; re-applying all 41 matched the first full apply **exactly: 0 differences**. Each wider constraint is cleared by a later (earlier-numbered) rollback or the objects are removed with their tables before the run ends; the per-step table shows where.

The per-step differences are larger than the three-constraint description (the earlier statement covered only rollback of `1206` to `1231b` over a `1205` image). Expected exceptions per rollback step, strict reverse order, compared with that file's own before-state:

| Rollback of (reverse order) | Objects that differ from that file's recorded before-state |
|---|---|
| 20261231100000 .. 20261226090000 (`1231b`, `1231`, `1230`, `1229`, `1228` .. `1226`) | none (exact match) |
| 20261225090000 .. 20261212090000 | studio_sms_onboarding_audit_action_check |
| 20261211090000 .. 20261210090000 | studio_sms_onboarding_audit_action_check, studio_sms_provider_alerts_kind_check |
| 20261209090000 | studio_sms_onboarding_audit_action_check |
| 20261208090000 .. 20261204090000 | studio_sms_approval_refs_shape, studio_sms_approval_refs_source_check, studio_sms_onboarding_audit_action_check |
| 20261203090000 .. 20261202140000 | the three above plus studio_sms_price_list_kind_check |
| 20261202090000 | studio_sms_onboarding_audit_action_check |
| 20261201090000 .. 20261129090000 | none (exact match) |
| 20261128090000 .. 20261127090000 | function tw4_recurring_due(text): body md5 differs (before `d38ad5ac…`, after `ae36ce19…`) |
| 20261126090000 .. 20261123090000 | none (exact match) |

New items beyond the previously known three: `studio_sms_provider_alerts_kind_check` and `studio_sms_price_list_kind_check` (wider allowlists that the rollbacks of `1211`/`1210` and of `1203` to `1202_140` leave in place), and `tw4_recurring_due(text)`, whose body after rolling back `1128` is not the pre-`1128` body (the `1127` rollback leaves it as it is; the difference is gone after the `1126` rollback). All are pre-existing rollback imprecisions; none involves `1229` to `1231b`. They were hidden before because those layers sit inside the Docker baseline image.

### 14.3 The precise expected fingerprint exceptions (DEV only)

1. **During D3 only,** at the rollback steps in the table above, the listed objects (and only those) may differ from that step's before-fingerprint, and only in the way recorded in the evidence file (compare against the stored strings, not by judgement). Every other catalog line must match exactly: functions (body md5, arguments, security, config, owner, ACL), tables and columns, other constraints, indexes, policies, triggers, views, sequences, types, default ACLs, schema ACL.
2. **At the end of D3** (all 41 rolled back) the catalog must equal the pre-apply state with **zero exceptions.** This is the key tightening: a non-zero final difference is a refusal.
3. **After re-apply** the catalog must equal the first full apply with zero exceptions.
4. The three-constraint wording in sections 4 and 8.4 is **superseded** by this table for a full DEV round trip. It still describes a partial rollback (for example a roll-back of only `1206` to `1231b`), where the three constraints do stay wider.
5. No exception is allowed for anything the table does not list, for any `1226`..`1231b` step, or for any hosted object outside `studio_sms_*` and the two functions named.

Caveat: run 2 used the Docker baseline image as a stand-in for DEV. Real DEV was confirmed at the `1122` level by earlier read-only probes, but non-TW4 schema drift (see the recorded DEV/PROD drift items) is outside this evidence. The hosted before-fingerprint must be taken at S2 and used in place of the Docker one for the final equality check.

### 14.4 DEV-only recovery procedure and refusal conditions

Procedure (all steps need the separate authorization; none is executed):

1. S2 preflight: both hosted probes, row counts (0 in every `studio_sms_*` table), and the catalog fingerprint; save as CP0.
2. Forward apply, one file at a time; fingerprint before and after each; objects probe on every file; stop at the first difference not explained by section 6 of the manifest.
3. To roll back: app first (previous recorded deployment, separate authorization), then SQL in strict reverse of the order applied, `1231b` before `1230`. After each rollback take the fingerprint and compare with that file's before-fingerprint **using the table in 14.2**.
4. After the last rollback compare with CP0: must be identical.
5. Optional re-apply and compare with the first full apply: must be identical.

**Refusal conditions (stop, capture output, do not edit SQL, do not retry with changes):**

- Any rollback raising `55000` (rows or a later layer exists); never weaken a guard.
- A difference not in the 14.2 table for that step, or a table-listed object whose text differs from the stored evidence.
- A non-zero final difference against CP0, or a non-zero re-apply difference.
- Any `studio_sms_*` row, pilot exception or pilot approval present before `1230`/`1231b` forward (their preconditions refuse), or after the first pilot evidence row: `1230` and `1231b` are then not rollbackable, so roll back the application and forward-fix only.
- A fingerprint taken between steps that differs from the previous step's after-fingerprint (drift while idle).
- Any error, crash or restart in the database log; any Twilio, Stripe or SMS side effect (none are possible with the switches off).
- Single platform administrator: dual-control approval paths stay blocked and unverified; a request to test them is a refusal, not a workaround.

## 15. Legacy Vercel project: credentials, exposure and a controlled retirement or isolation plan (metadata only)

### 15.1 Are the legacy Stripe and Resend credentials live?

**Not determinable from non-secret metadata.** Facts: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `RESEND_API_KEY` are each a single `encrypted` entry targeting production, preview and development, last updated 2026-04-16 (the project's creation week); they are not the `sensitive` type, so any team member with dashboard access can reveal them. No public bundle exposes the publishable key. The retained runtime logs show no webhook traffic. The mode (`pk_test`/`pk_live`, `sk_test`/`sk_live`) and whether the Resend key is a sending key can only be read by the owner in the Stripe and Resend dashboards (view only). I made no provider API call.

### 15.2 Does automatic main promotion create unnecessary exposure?

**Yes, modest and avoidable.**

- Every main merge becomes the live production deployment of a project that cannot serve (no database), reachable on a public URL. Information exposure is small (a generic 500 page with an error digest), but the URL, framework and error behavior are public for no business reason.
- Live-capable Stripe and Resend secrets sit in a production scope that serves nothing, and in a preview scope that runs **every branch's code**, including unreviewed branches, alongside the DEV service-role key, Twilio credentials and `CRON_SECRET`. That is the larger exposure, and it is independent of auto-promotion.
- Operational: each merge builds twice; the 8 or more crons fail closed every 15 to 60 minutes (20 `event-cart-orders` hits and others in about 1.7 hours, all 503), which is noise that can hide a real failure.
- Latent: adding Supabase variables to the production target would put every main merge live ungated.

### 15.3 Proposed controlled isolation, then retirement (not executed; each step needs separate authorization)

| Phase | Action | Reversible? | Gate |
|---|---|---|---|
| 0 (owner, read-only) | In Stripe: is any webhook endpoint pointing at `danceflow-app.vercel.app`; are the keys test or live. In Resend: key last-used and domain. In Vercel: who else uses the project. Decide whether `danceflow-app` is to become the DEV host. | n/a | none |
| 1 isolate | Set `autoAssignCustomDomains=false` on `danceflow-app` (mirrors qfem), so main merges stop going live. Keep the preview scope. | yes, flip back | owner authorizes the setting change |
| 2 secrets | Remove the Stripe, Resend and Twilio values from the **production** target (unused). If the DEV build method is local, also remove them from preview; otherwise replace with test-mode values and mark them `sensitive`. If any key was live and has been broadly revealable, rotate it at the provider. | restore from the secret manager | owner authorizes; provider-side rotation is a provider operation and needs its own approval |
| 3 crons | Crons run only on the production deployment; they stop when the project is paused or removed. Pause after Phase 1 once nothing depends on it. | yes, unpause | owner authorizes |
| 4 retire | After a soak (suggest 30 days of Phase 3 with no complaint), export the variable names, then archive or delete the project. If instead it is to be the DEV host, make that explicit: DEV-only variables, deployment protection on for all deployments including production, no provider secrets. | delete is not reversible | owner authorizes |

Do not start Phase 1 to 4 before the DEV build method (12.2) is chosen: method 2 would need the preview scope.

## 16. Updated DEV GO/NO-GO (revision 4)

**NO-GO today.** Reasons:

1. No authorization for hosted migrations or for creating any deployment (unchanged).
2. The DEV ref behind the `danceflow-app` preview scope is unconfirmed (12.1, owner checklist outstanding).
3. A DEV-bound build has not been created; the recommended method (local, minimal environment) needs no deployment but also needs the owner's go-ahead for S3.

**Improved since revision 3:** the rollback-exception gap is now fully characterized and **tighter than assumed**: a full DEV round trip ends with zero differences, and every intermediate exception is enumerated (14.2), including three items not previously known. PR #361 is reviewed and recommended GO for merge (documentation only). The 41-file order is proven end to end in Docker on a DEV-equivalent image.

**Technical GO is reached when** the owner: (a) completes the 12.1 checklist with four yes answers; (b) authorizes the 41-file DEV apply in writing, naming the build method; (c) merges or accepts #361 (optional for execution; the order is the same either way). The single platform administrator and the PROD hold are unchanged.

## 17. Post-merge update (revision 5): plan re-based on main `e749427c`

### 17.1 What changed in main

| Item | Value |
|---|---|
| PR #361 | squash-merged 2026-10-30 as `e749427c` (full SHA `e749427ce5eaea3316752729f565e11254ac45af`), pinned to head `19f74e82`; message explicit, no AI attribution (searched: 0 hits) |
| New `origin/main` | `e749427ce5eaea3316752729f565e11254ac45af` |
| Intervening change | PR #304 (`2c486c16`, merged 19:37Z, before #361): pricing recommendation, pilot readiness checklist, Stage B draft cleanup runbook. **Docs only.** |
| Changed files `b0257594..e749427c` | exactly four, all under `docs/twilio/`: the manifest (#361) and the three #304 documents. **No file outside `docs/`.** |
| Application identity | `src/` tree object, `package.json`, `package-lock.json` and `vercel.json` are byte-identical to `b0257594`. The application build, the 48 migrations, rollbacks and hashes are unchanged. |

Consequences for this plan:

1. The 41-file list, its hashes, order and app pairing stand unchanged; the manifest now carries the numeric `1206` slot and section 4.1 on main.
2. The application pin `b0257594` stays valid. `e749427c` builds the same application, so either SHA is acceptable for a DEV-bound build; **pin to `e749427c`** so the build matches the manifest the owner authorizes.
3. Revision 4's sections 12 to 16 need no technical correction. Wherever they say "PR #361 once merged", read "manifest section 4.1 on main".

### 17.2 PR #304 and the DEV plan

#304 adds no SQL and no application code, so it does not alter the 41 files or the SQL/app compatibility. It does bear on gates that sit next to the DEV apply:

- It names the pilot gates that stay open and are **not** part of a DEV schema apply: B-1 Stage B draft handling (nothing deleted, nothing authorized), B-2 the $150 cumulative pilot cap split ($20 absorbed inbound, $130 setup fees; planning only, enforces nothing in code), B-3 final retail price, B-4 Stripe answer, B-5 counsel/CPA, **B-6 dual control versus documented single admin for `tw4_price_set`**, B-7 hosted migrations, live SMS, provisioning and fee-bearing steps (none authorized).
- **B-6 interacts with the single-administrator gate (section 5).** The DEV schema apply needs no admin session, but a DEV check of `tw4_price_set` dual control cannot pass with one administrator. Keep it in the blocked-and-unverified list; do not substitute a workaround.
- The checklist relies on migration `20261203090000` (`tw4_inbound_record`, STOP/START/HELP classified as compliance, never charged) and the pilot spend hardening (`20261231100000`, PR 330). Both are inside the 41 files at their documented positions (#13 and #41), so a DEV apply delivers the objects #304 discusses. #304 asserts no hosted state, and none was changed.
- Open verification items V-1 to V-5 (Twilio invoice lines, failed-text fees, A2P fees, brand tier, UCS-2 segments) cannot be answered by a schema apply; they belong to the pilot, not to DEV readiness.
- Nothing in #304 changes the owner's DEV-planning directions: the rollback exception model (now section 14.2/14.3) and one platform administrator for technical validation.

### 17.3 Deployments triggered by the merge itself (automatic, not by me)

Merging produced the usual automatic builds, and I took no deployment action:

- `danceflow-app-qfem`: `dpl_hJE9tXXDbLkjKg1k6yQwnujjYjxJ` (`e749427c`, production target) queued as `STAGED`; **live production is unchanged**: `dpl_HEvyvNbHzAiMBGT3yPVzeiGJk6Sj` (PRICING-P1, `4bc938c6`), `autoAssignCustomDomains=false`.
- `danceflow-app` (legacy): `dpl_GdMQ5AfENFVeP8wyYdCoxGLUp4GS` (`e749427c`) building; that project auto-promotes by design and its production target still has no Supabase configuration (section 10). This is one more instance of the exposure in section 15.2.

### 17.4 Updated sequence and status of the gates

| Gate | Status after the merge |
|---|---|
| Manifest correction | **Done** (on main) |
| Authorization of the DEV apply | open (withheld) |
| Supabase ref behind the `danceflow-app` preview scope | open (owner checklist, 12.1) |
| DEV-bound build method and build SHA | open; recommended local minimal-env build of `e749427c`; a Vercel preview needs separate authorization |
| Rollback exceptions | characterized (section 14); table stored in `TW-4F_DEV_Rollback_Exceptions_Evidence.json` |
| Single platform administrator | accepted for technical validation; dual control (including `tw4_price_set`, B-6) blocked and unverified |
| Post-merge manifest verifier | see 17.5 |
| PROD | on hold |

Sequence S0 to S6 in section 8.4 is unchanged except that the authorized file list is now manifest section 4.1 on main at `e749427c`.

### 17.5 Post-merge hash verification

`verify_manifest_hashes.sh origin/main` at `e749427c`: 48 migrations, **MANIFEST HASHES OK** (exit 0). The independent re-hash and the order checks from section 13 were re-run against the merged manifest before the merge with the same results (0 hash mismatches; `1205 → 1206 → 1207`).

### 17.6 DEV GO/NO-GO (revision 5)

**NO-GO today, unchanged in substance.** Open items are the owner's: written authorization for the 41-file DEV apply and for the build method, and the four-line Supabase ref confirmation. No technical blocker was found in the merge or in #304. The plan is ready to execute the moment those are given; nothing hosted has been touched.

## 18. Isolated local DEV application-build preflight (revision 6, main `e749427c`)

Scope: local preparation and offline checks only. Nothing hosted was contacted, no environment secret was read or pulled, nothing was committed, pushed, deployed or merged, and no application code or migration was modified.

### 18.1 Setup and safety review (before anything was run)

- Worktree: `C:\Dev\studioapp-devpf`, detached at `e749427ce5eaea3316752729f565e11254ac45af` (`origin/main` checked equal immediately before creation; status clean).
- Root `package.json` has **no lifecycle hooks** (`preinstall`, `install`, `postinstall`, `prepare`, `prebuild`, `postbuild` all absent). Scripts are `dev`, `build` (`next build`), `start`, `lint` (`eslint`), `test`, `test:e2e`, plus four `qa:`/`synthetic:` tools that were not run.
- Dependencies in the lockfile that declare install scripts: `esbuild`, `fsevents`, `sharp`, `unrs-resolver`. None was executed: install used `--ignore-scripts`.
- `next.config.ts` has headers only: no remote fetch, no `next/font/google` anywhere in `src/`. Static generation: `sitemap.ts` and the knowledgebase page only.
- No `.env*` file exists in the worktree (only `*.example`), so Next loaded nothing implicitly. The owner's `.env.local` was not copied or read for values, and no Vercel variable was pulled.
- Network guard: every Node process (tsc, eslint, `next build` and its 13 workers) ran with a preload that blocks and logs any non-loopback TCP connection or DNS lookup. Limit: native (Rust) Turbopack code does not pass through Node's `net`; its design performs no fetch and the build log shows none.

### 18.2 Commands run and exit codes (all in `C:\Dev\studioapp-devpf`)

| # | Command (summary) | Exit | Result |
|---|---|---|---|
| 1 | `git worktree add --detach ../studioapp-devpf e749427c…` | 0 | clean, HEAD verified |
| 2 | `npm ci --ignore-scripts --offline --no-audit --no-fund` | 0 | 479 packages from the local npm cache in 6m26s; **no registry contact** (`--offline`); lockfile and `package.json` unchanged |
| 3 | `tsc --noEmit -p tsconfig.json` (default heap) | 134 | `JavaScript heap out of memory` (known; CI sets 6 GB) |
| 4 | `tsc --noEmit -p tsconfig.json` with `--max-old-space-size=6144` | **0** | no diagnostics |
| 5 | `eslint` (whole repo) | 1 | 496 problems: 98 errors, 398 warnings (see 18.4) |
| 6 | `next build` with the five placeholder variables (18.3) and the 6 GB heap | **0** | compiled in 93 s, TypeScript 117 s, 324 static pages, all routes listed, proxy (middleware) present |
| 7 | `git checkout -- next-env.d.ts` | 0 | restored the one tracked file the build regenerates; worktree clean again |

Network guard result: 0 blocked attempts (log: processes loaded, no `BLOCK` line).

### 18.3 Environment variable names

The build was run with exactly five variables, all placeholders: `NEXT_PUBLIC_SUPABASE_URL` (a closed loopback port, `127.0.0.1:9`), `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (non-key strings), `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SITE_URL` (`http://localhost:3000`). Build-time sufficiency is proven; strict necessity of each was not tested. **No real DEV value was needed or used**, so the artifact is a compile check, not a DEV-bound build (public variables are inlined at build, so a DEV-bound build must be built with the real DEV URL and anon key).

Runtime minimum for a DEV-bound run (names only): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`.

Deliberately excluded, and the build did not need them: `STRIPE_*`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `TWILIO_*`, `RESEND_API_KEY` and the e-mail sender variables, `CRON_SECRET`, `OPENAI_*`, `MUX_*`, `GUSTO_*`, `GOOGLE_CALENDAR_*`, `WAVE_*`, `INTEGRATION_TOKEN_ENCRYPTION_KEY`, `SMS_EIN_ENCRYPTION_KEY`, every `TW4_*`/`SMS_*` switch. Their absence means pages and routes that use them will fail at request time in a run, which is the intended safe default.

### 18.4 Static-check outcomes

- Type check: **pass** (exit 0) with the CI heap setting; default heap runs out of memory, same as the CI note.
- Build: **pass** (exit 0), no warnings or errors in the log.
- Lint: **fails repo-wide, pre-existing.** 98 errors in 40 files (`no-explicit-any` 48, `react/no-unescaped-entities`, `no-require-imports`, `prefer-const`, `no-html-link-for-pages`, and a React rule group) and 398 warnings. None is in TW-4F SMS or onboarding code (the two files under SMS-like paths are a client message-history card and a mobile-push page). CI lints **changed files only** for this reason, so this is known debt, not a regression from #361/#304 (both docs-only). I did not fix it (no code modification).
- Not run (outside the brief or unsafe): `vitest` (its `localStack` suites need a database), Playwright, the `qa:`/`synthetic:` scripts, `next start`/`next dev` (would be a live server holding DEV keys).

### 18.5 Compatibility of the eight app-pairing layers (current source, precise check)

Method: for all 342 functions created in the 41 files, take the final definition's parameter list (required versus defaulted) and parse every `"fn_name"` call site in non-test `src/` for the argument object's keys, including keys supplied by spreads and shared argument objects. 152 functions have literal app callers; the rest are database-internal. The first pass flagged 6 mismatches; all were checked by hand and are **false positives of the parser** (a `...exceptionEvidenceParams()` spread supplying exactly the 6 evidence keys; a shared `args = { p_actor }` object used for 5 read calls). After that: **0 real mismatches in 152 functions.**

| Layer | Final signature | App caller | Finding |
|---|---|---|---|
| 1123 | `tw4_credit_topup_pending` (5 params, final from 1125), `tw4_credit_settle_topup` (7), `tw4_credit_apply_refund`, `_apply_dispute`, `_topup_lookup`, `sms_credit_overview` | `smsCreditPurchases.ts`, `creditStore.ts`, `smsCreditView.ts` | keys match; `tw4_credit_reverse_topup` is database-internal |
| 1127 | `tw4_recurring_charge` (3 params, 2 required, final from 1217) | `smsRecurring.ts` | match |
| 1128 | `tw4_recurring_due` (internal), `tw4_recurring_due_list` (0), `tw4_monthly_limit_set` (6/3), `tw4_entity_timezone_set` | `smsRecurring.ts`, `smsMonthlyLimits.ts` | match; `_due` has no app caller |
| 1213 | `tw4_num_claim` (5/3), `tw4_num_identity_observe`, `tw4_num_history_observe`; `tw4_num_inventory_ack` | `numberStore.ts` | match; `_ack` is database-internal |
| 1214 | `tw4_num_inventory_observe` (5), `tw4_num_recon_*` (4 functions) | `numberStore.ts` | match |
| 1229 | `tw4_rfl_pilot_cover` (11 params, final from 1231b) | `providerFeeLifecycle.ts` | match (11 of 11 required keys sent) |
| 1230 | `tw4_spend_authorize` (14 params, 5 required), `tw4_pilot_exception_create` (10, all required) | `entityStore.ts`, `panel.ts`, `creditStore.ts`, `pilotApprovalEvidence.ts` | match; the evidence helpers supply exactly the 7 and 6 `p_evidence_*` keys, all of which are SQL parameters |
| 1231 | `_sms_onb_is_platform_admin()` requires `aal2` | `requirePlatformStepUp("aal2")` across the platform SMS actions; `/platform-mfa/challenge` step-up | present; behavioral check of the aal1 refusal remains a DEV step |

Limits: this is a static, name-and-arity check. It does not check argument types or return-shape parsing, and the runtime proof is the isolated Docker suites (sections 7 and 14), not repeated here.

### 18.6 Remaining blockers to a safely authorized 41-file DEV migration

1. **No authorization** for the DEV apply (hosted migrations remain withheld by the owner).
2. **No DEV-bound build exists.** The preflight proves the source compiles and type-checks at `e749427c`; a DEV-bound artifact still has to be produced with the real DEV URL and anon key. That needs either a local build with owner-supplied, DEV-scoped values (not yet authorized) or a Vercel preview (needs deployment authorization).
3. **Key-to-project identity** (anon and service-role keys belong to `epdrtzcydvnoidwrepqz`) is unverified. The owner has confirmed the URL assignment; a mismatched key pair is the dangerous case. Proposed check: after authorization, one read-only call per key to the DEV project that returns its project ref or a harmless row count, and a refusal if the ref differs. Not done now.
4. **Provider sandbox or live status** (Stripe, Twilio, Resend) unverified. A DEV-bound build must not receive those variables; the local method excludes them.
5. Rollback exceptions (section 14), the single platform administrator (dual control, `tw4_price_set` and the rest, blocked and unverified), and the pilot approval gates (#304 B-1 to B-7) are unchanged and not affected by this preflight.
6. Repo lint debt (98 errors) and the default-heap type check are known, CI-handled, and not blockers for a migration.

### 18.7 Recommendation for the next DEV-readiness gate

**CONDITIONAL GO** to the next gate (an authorized DEV-bound local build plus a read-only key-identity check), conditional on the owner:

1. authorizing the local DEV-bound build with a minimal env file containing only the five names in 18.3 (DEV-scoped values supplied by the owner on this machine; I would never print, log or commit them), and
2. authorizing the single read-only identity check per key (no write, no provider call).

**NO-GO remains** for executing any DEV or PROD migration until those pass and the owner separately authorizes the 41-file apply in writing. No technical blocker was found in the application source.

## 19. Local DEV-bound build and read-only DEV key verification (revision 7, main `e749427c`)

Authorized scope only: a local build with five variables, and read-only GET/HEAD requests to the DEV project host `epdrtzcydvnoidwrepqz.supabase.co`. No server was started, no RPC was called, no write was attempted, and nothing hosted other than that host was contacted.

### 19.1 Credential source and handling

- Source: the owner's existing local env file, read in-process for exactly three names (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`); each present once (no duplicates). The other two variables were set to `http://localhost:3000` by the launcher, not read from the file. No other value from the file was used.
- Values were never printed, logged or committed. The build log was scanned for all three values before being saved: 0 hits (and a redaction step was in place).

### 19.2 Credential verification results (no secret values)

Local checks, no network:

| Check | Result |
|---|---|
| URL shape | `https://<ref>.supabase.co`, no path or query; ref equals DEV `epdrtzcydvnoidwrepqz`; not PROD `hvsujyfbftfffxpfmlpb` |
| Anon key | JWT; claims `ref=epdrtzcydvnoidwrepqz`, `role=anon`, issuer `supabase`, issued 2026-04-05, expires 2036-04-05 |
| Service-role key | JWT; claims `ref=epdrtzcydvnoidwrepqz`, `role=service_role`, same issuer and dates |
| Keys differ | yes |

Read-only requests to the DEV host, each key used separately (only HTTP status and error class recorded):

| Request | Result | What it establishes |
|---|---|---|
| `GET /auth/v1/settings` with a deliberately invalid key (negative control, same endpoint) | 401 `Invalid API key` | the endpoint really validates keys |
| same endpoint, anon key | 200 | the DEV gateway accepts the anon key |
| same endpoint, service-role key | 200 | the DEV gateway accepts the service-role key |
| `GET /rest/v1/studio_sms_legal_entities?select=id&limit=0`, invalid key | 401 `Invalid API key` | control |
| same, anon key | 401 Postgres `42501 permission denied for table` | key accepted, request executed as the database role, table closed to the API role (matches the TW-4F design) |
| same, service-role key | 401 Postgres `42501 permission denied for table` | key accepted and executed in the database; the table has no API privileges even for this role (matches the design) |
| `GET /rest/v1/` (schema document, read only, body not stored or printed), service-role key | 200 | accepted as the privileged key (this document is restricted to the secret key) |
| `GET /rest/v1/`, anon key | 401 `Invalid API key` | the root document refuses the anon key; consistent with that restriction, since the same key was accepted on two other endpoints |

**What this establishes, and what it does not.** Establishes: both keys were accepted by the DEV project's own gateway while an invalid key was rejected on the same endpoint (so acceptance is meaningful), both carry `ref` = DEV in their claims, the roles behave differently as their `role` claims say, and the service-role key reaches the schema document the anon key cannot. Together this is good evidence that both credentials belong to DEV. It does not by itself prove: that the claims are untampered (they are self-asserted until the signature is accepted, which the gateway acceptance covers), that neither key also works on another project (I did not send a DEV key to PROD, which is on hold; only the claim and the DEV acceptance speak to this), or anything about key rotation state. A `200` alone would not prove identity; the invalid-key control and the `ref` claims are what do.

Two requests used `HEAD`/`GET` on a TW-4F table with `limit=0` and `Prefer: count=exact`: they returned no row data. An earlier request pair (HEAD with a bearer header) returned 401 for anon and 403 for the service key, consistent with the same `42501` denial.

### 19.3 Local build

| Item | Result |
|---|---|
| Worktree | `C:\Dev\studioapp-devpf`, detached at `e749427ce5eaea3316752729f565e11254ac45af`; `.next` removed before the build |
| Environment passed | the five names plus only OS plumbing (`PATH`, `SystemRoot`, `windir`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `HOME`), heap/preload `NODE_OPTIONS`, `NEXT_TELEMETRY_DISABLED`, and the guard's log path. The parent environment was not inherited. No Stripe, Twilio, Resend, `CRON_SECRET`, OpenAI, Mux, Gusto, Google or Wave variable and no `TW4_*`/`SMS_*` switch. |
| Command | `next build` via a launcher, under the network guard that blocks every non-loopback connection or lookup |
| Exit code | **0**. Compiled in 102 s; TypeScript pass took 5.7 min this run; 324 of 324 static pages |
| Network guard | 0 blocked attempts: no outbound connection or DNS lookup was tried by the build or its 13 workers |
| Build-log secret scan | URL, anon, service: 0 occurrences |

### 19.4 Embedded configuration

- Server output (`.next/server`, 6,061 files scanned): the DEV host `epdrtzcydvnoidwrepqz.supabase.co` appears in **146 files**, the full DEV URL in the same 146, the anon key in 39. This confirms the embedded project URL is DEV.
- Client output (`.next/static`, 107 files): neither the URL nor the anon key is embedded; nothing Supabase-related is shipped to browser bundles in this build.
- **The service-role key is embedded in no file** (0 of 6,168). It is read from the environment at run time only.
- No trace of the earlier placeholder (`127.0.0.1:9`) remains.

### 19.5 Unexpected activity, writes, state

- Network: only the read-only DEV requests listed in 19.2 (from a separate checker, not from the build). The build made none. No request went to PROD, Vercel, Stripe, Twilio, Resend or any other host.
- Writes: none. Only `GET` and `HEAD` were used; no RPC was called; no server was started and no route was invoked.
- Worktree: HEAD unchanged at `e749427c`; `package.json` and the lockfile unchanged; no source or migration touched. The build regenerates one tracked file (`next-env.d.ts`); it was restored, and `git status` is clean (the `.next` folder and `node_modules` are untracked and ignored).
- The built artifact exists locally in `.next`. It embeds DEV connection settings and must not be uploaded or deployed (that would be a separate authorization).

### 19.6 Remaining blockers to the hosted DEV migration

1. **Written authorization of the 41-file DEV apply** (withheld). Everything else below is preparatory.
2. Provider sandbox/live status in the pre-production Vercel scope (Stripe, Twilio, Resend) remains unverified; not touched, and the local build excluded them.
3. A Vercel preview or any deployment for DEV remains unauthorized and is not needed for the schema apply if the local build serves as the paired application.
4. Rollback exceptions (section 14), single platform administrator (dual control, `tw4_price_set`), and the pilot approval gates (#304 B-1 to B-7) stand unchanged.
5. Housekeeping before S2: take the hosted preflight fingerprint and row counts (read-only probes) immediately before the first apply, as in section 8.4.

### 19.7 Recommendation

**GO for the next gate** (the owner's decision on the 41-file DEV apply, with the paired application being this local build of `e749427c`). **NO-GO remains for executing any migration** until that written authorization exists. No technical blocker was found.

## 20. Local runtime smoke test and execution package (revision 8)

One localhost-only smoke test of the DEV-bound build passed: server bound to 127.0.0.1 only; GET / returned 200 using five read-only selects against DEV; /login, /privacy, /terms, /robots.txt 200; redirects and 404s as expected; network guard allowed only the DEV host (5 connections) and blocked nothing; no write, RPC or secret in any response or log; app stopped and port closed; worktree clean. The consolidated procedure is in `TW-4F_DEV_Migration_Execution_Package_DRAFT.md` (untracked). DEV migration execution remains **NO-GO until the owner explicitly approves it**; there is no remaining technical blocker.

## 21. Execution (revision 9)

The 41-file DEV forward application was executed and verified on 2026-10-30 (21:41 to 21:49 UTC). All 41 steps matched the local lockstep expectation row for row; AT-1 to AT-9 passed, AT-10 pending. See section 14 of `TW-4F_DEV_Migration_Execution_Package_DRAFT.md` and `docs/twilio/evidence/TW-4F_DEV_apply_20261030/`. Sections 1 to 20 above describe the pre-execution state.

## 22. AT-10 and bounded read-only DEV application integration (revision 10)

Scope: the locally validated DEV-bound build of `e749427c` on `127.0.0.1:3017`, five variables, no provider credential, no TW-4F switch; GET requests only; read-only RPC calls. No migration, rollback, history change, deployment, provider call or merge. Results are in `docs/twilio/evidence/TW-4F_DEV_integration_20261030/`.

### 22.1 Verdict

**AT-10: PASS** for what it can show without an authenticated session: the paired build starts, serves and reads the migrated schema; every TW-4F route and page answered with the expected status; every read RPC the application relies on resolved with its migrated signature; authorization failures were clean refusals; the database was unchanged. Limit: no signed-in session exists for this build, so authenticated page content and owner-facing RPCs were not exercised (section 22.5).

### 22.2 Safety proof before each call

- Application routes: each cron route is gated by an environment switch that is unset (answers 404 before any work) or by `CRON_SECRET`, which is unset (the cron guard answers 503 before any work, including the purge route); every POST-only route exports no `GET`, so Next answers 405 without running handler code; admin and owner pages call the auth guard first and redirect.
- RPCs: only functions with volatility `STABLE` or `IMMUTABLE` (145 of 422 TW-4F-related functions; 53 callable by the service role without composite or array arguments), called only by HTTP `GET`. PostgREST runs a GET in a read-only transaction and PostgreSQL forbids data changes in non-volatile functions, so a mutation cannot succeed. The 277 volatile functions (every mutating RPC) were not called. Response bodies were never printed or stored.

### 22.3 Application GET results (all as expected)

| Request | Result | Reading |
|---|---|---|
| `/`, `/login`, `/sms-consent` | 200 | home page still reads DEV (6 allowed connections to the DEV host in total) |
| `/studios/<DEV slug>/sms-privacy`, `.../sms-terms`, unknown slug | 404 | by design: `get_sms_legal_context` returns null for a studio without pilot access, submitted onboarding or registration, and the page calls `notFound()`; the RPC itself returned normally (null) |
| `/platform/sms`, `/app/settings/sms`, `/app/settings/sms/location` | 307 to `/login` | authentication guard ran; no 500 |
| `/api/cron/sms-inventory-reconcile`, `-usage-reconcile`, `-provider-fee-lifecycle`, `sms-recurring`, `-sender-reverify` | 404 | env switches off, as required |
| `/api/cron/sms-onboarding-purge` | 503 | `CRON_SECRET` not configured: fails closed; nothing purged |
| `/api/sms/send`, `/api/sms/twilio/inbound`, `/api/sms/twilio/status`, `/api/billing/sms-credits/checkout`, `/api/billing/sms-limits/set`, `/api/billing/sms-recurring/authorize` | 405 | POST-only routes; handler not run |

Network guard: 6 allowed connections, all to `epdrtzcydvnoidwrepqz.supabase.co`, 0 blocked. Server log 5 lines, 0 errors, no secret. Bound only to `127.0.0.1`; stopped afterwards; port closed.

### 22.4 Read-RPC integration (53 functions, service role, GET)

| Class | Count | Meaning |
|---|---|---|
| OK (HTTP 200) | 43 | resolved with the migrated signature and returned (mostly empty-state, since the TW-4F tables hold no rows); includes the admin overviews called with the real DEV platform-admin id (panel, monthly limits, recurring-fee ops, health, exposure, variance, sender overview and health, usage reconciliation, inbound, registration gaps, deferred retirements, number reconciliation), the studio-scoped state reads and the scan, due and target lists |
| REFUSED with `42501 not authorized` (HTTP 403) | 10 | owner-facing functions that authorize with `auth.uid()` (credit overview, history, purchases, admin overview, monthly limits, price list, recurring overview and admin overview, `sms_rfl_owner_overview`, `tw4_credit_checkout_context`): correct refusal for a service-role call; they need a user session |
| SIGNATURE (`PGRST202/203`) or ERROR (undefined function, table or column, 5xx) | **0** | **no runtime incompatibility found** |
| Skipped | 1 | `tw4_inbound_unrecorded` (array argument) |

Authorization controls: with a random actor, 8 of 8 admin functions refused (`42501`, HTTP 403). With the anon key, 4 of 4 functions refused at the database (`42501`, HTTP 401), including two granted only to `authenticated` and two granted only to the service role.

### 22.5 Runtime incompatibilities

None found. Not exercised and therefore still unproven at runtime: authenticated and aal2 sessions (page content behind login, the 10 owner-facing refusals' success paths, the aal1-refusal behaviour of `1231` through a real token); any volatile (mutating) RPC; every dual-control path; provider behaviour. The TW-4F tables are empty, so read functions were tested for signature, authorization and error handling, not for data shaping. The positive path of the public SMS legal pages needs a studio with pilot access.

### 22.6 Database state after testing

| Item | Before | After |
|---|---|---|
| `rollup:ALL` | `3a38f6b6` | `3a38f6b6` |
| Fingerprint rows differing | n/a | **0 of 1,234** |
| Inventory rows differing | n/a | **0** (read-only transaction confirmed) |
| Probed tables with rows | 0 of 75 | 0 of 75 |
| `studio_sms_*` row counts | 74 tables, all 0 | 74 tables, all 0, identical |
| Audit, credit-ledger, spend-event, reply-counter rows | n/a | 0, 0, 0, 0 |
| Migration history rows | 1 | 1 (`remote_schema`), unchanged |

### 22.7 Remaining DEV acceptance blockers

None blocking the schema acceptance. Open (each needs authorization): authenticated and aal2 session verification (owner-assisted TOTP), mutating-path validation on DEV, dual control (needs a second administrator), provider-facing behaviour (all switches off), and positive-path public legal pages.

### 22.8 Recommendation for the next bounded step

**Owner-assisted, read-only authenticated walk-through:** start the same local build on localhost, you sign in as the existing DEV platform administrator and complete the TOTP step (I never handle the password or code), then load `/platform/sms` and the studio SMS settings pages (GET renders only, no form submissions). That exercises the page loaders and the `1231` aal2 behaviour against the migrated schema. I would watch the server log and compare the database fingerprint and row counts before and after, with the same guard allowing only the DEV host. Mutating-path validation stays with the isolated Docker suites until separately authorized. PROD stays on hold.

## 23. Authenticated DEV walkthrough (revision 11)

Scope: the DEV-bound build of `e749427c` on localhost behind a logging proxy that recorded only method, path (query removed), status and redirect path; five variables; no provider credential; no TW-4F switch. The owner entered the password and the TOTP code personally in the Browser pane; no credential, code, cookie or token was requested, read, logged or stored. GET page renders only; no form was submitted by the walkthrough. Results: `docs/twilio/evidence/TW-4F_DEV_authwalk_20261030/`.

### 23.1 Authentication sequence (from the request log)

| Step | Request | Result |
|---|---|---|
| Password sign-in | `POST /login` (server action) | 303, then `GET /platform-mfa/challenge` 200: the password-only session (aal1) is held at the TOTP prompt, **no platform page served** |
| TOTP | `POST /platform-mfa/challenge` (server action) | 303 to `/platform/sms`, which rendered 200: aal2 reached |

An earlier `POST /login` at 22:20 (before the password sign-in, while the flow was still believed to be magic-link) produced no new user: `auth.users` is 903 before and after. The log does not record which mode it was, so an authentication email may have been sent for the owner's existing address.

### 23.2 Page results

| Page | Result |
|---|---|
| `/platform` (landing after MFA) | 200, dashboard rendered |
| `/platform/sms` | **200, fully rendered with the migrated schema.** Sections loaded with empty states and no error: sending status (pending approval), message and consent counters (0), provider setup (Twilio credentials and callback secret shown as failed, as expected with no provider credential), prepaid credit, recurring charges, published prices, usage reconciliation (reconciler not ready, billed texting OFF), recurring provider fees (scan OFF, delivery OFF, STALE), switches, alerts, exposure, variances, **dual-control requests (0 waiting)**, cancellation and safety suspension, provider exposure and recovery, SMS activation (no location at any stage), subaccount onboarding (none), pilot access (no studio has access), studio registrations (none), message log (none). |
| `/app/settings/sms` | **307 to `/platform/studios`**: authorization refusal handled cleanly. The platform administrator has no studio workspace context for the owner-facing settings, so the app redirects to the studio picker. |
| `/app/settings/sms/location` | **307 to `/platform/studios`** (same). |
| Server errors | 0 responses of 5xx across 151 requests (146 GET 200, 3 POST 303, 2 GET 307) |

Notes: Next's link prefetch also rendered other `/platform/*` pages (billing, organizers, studios, webhooks, alerts, analytics and similar) with GET; these are ordinary read renders. The owner-facing settings pages' authenticated content could not be shown because the account is a platform administrator, not a studio user (see 23.5).

### 23.3 AAL2 behaviour

- aal1 session: the app served the TOTP challenge and no platform page; aal2 session: pages served. The layout enforces `requirePlatformAdmin` and `requirePlatformMfa`.
- Positive path of migration `1231`: `/platform/sms` loaded its onboarding list through `list_sms_onboardings`, whose admin check is `_sms_onb_is_platform_admin()` (now requiring `aal2`). The page showed "No studio has pilot access yet" instead of its "unavailable" fallback, so the function admitted the aal2 session.
- Not exercised: the **refusal of an aal1 token at the database** through a real aal1 request (the app layout blocks aal1 before any such call), and the three `studio_sms_registrations` policies' denial path. Both stay catalog-verified (AT-5, AT-6) only.

### 23.4 State comparison (read-only probes before and after)

| Item | Before | After |
|---|---|---|
| `rollup:ALL` | `3a38f6b6` | `3a38f6b6` (0 of 1,234 fingerprint rows differ) |
| Inventory rows | | 0 differ |
| Tables with rows | 0 of 75 | 0 of 75; `studio_sms_*` 74 tables identical, all 0 |
| `sms_message_logs`, `sms_contact_permissions`, `workspace_access_logs`, `platform_admin_actions`, `outbound_deliveries`, `studio_sms_registrations`, studios last access | 12, 3, 2031, 3, 206, 0, 2026-10-11 | identical |
| `profiles`, `dancer_profiles`, `client_account_links`, `user_studio_roles`, `user_account_status`, recap recipients, `auth.users`, identities, MFA factors | 900, 17, 4, 166, 0, 1, 903, 18, 1 (1 verified) | identical |
| `auth.sessions` | 18 | **19** (the owner's session; ordinary authentication activity) |

SMS business data is unchanged; the only difference is the one new authentication session.

### 23.5 Runtime and coverage limits

- Network guard: 35 allowed connections, all to the DEV host; 0 blocked. Bound to localhost only. The Twilio card shows credentials failed because none were supplied, by design.
- Not covered: owner-facing settings pages' authenticated content (needs a studio-role user with SMS pilot access, which would require enabling access: a write); any mutating action; dual control (needs a second administrator); aal1-token database refusal; provider behaviour.
- The server and proxy were stopped (ports 3017 and 3018 closed). The Browser pane still holds the owner's localhost session cookie; it is only usable against a server started on that port. Sign out in the pane next time, or clear site data.

### 23.6 Next DEV acceptance work packages

1. **WP-1 Owner-facing pages with real data (needs a write, separate authorization):** enable pilot access for one designated test studio and a studio-role test user, then GET-render `/app/settings/sms` and `/location`. Alternative with no DEV writes: run the Docker suites that already cover the owner views.
2. **WP-2 aal1 refusal at the database:** capture a real aal1 platform-admin JWT in a controlled test (owner-assisted, never logged) and call one stable admin read to confirm `42501`, or cover it in the Docker suite with a synthetic aal1 claim.
3. **WP-3 Mutating-path validation:** exercise the mutating RPCs and server actions with flags still off, preferably in Docker (already done for the SQL) and then as DEV-recorded dry runs under separate authorization.
4. **WP-4 Dual control:** requires a second administrator supplied by the owner; remains blocked.
5. **WP-5 Provider paths:** only after the above and per the pilot gates (#304); nothing authorized.
6. **WP-6 Housekeeping:** commit or archive the evidence and report documents (currently untracked), decide whether to keep the DEV-bound local build, and record the walkthrough in the roadmap.
