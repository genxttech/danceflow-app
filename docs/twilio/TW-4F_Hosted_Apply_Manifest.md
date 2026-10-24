# TW-4F Hosted Apply Manifest and Release Package (H1)

Status 2026-10-23. First written for main `960a9d02` (PR #271); refreshed through main `67bb64f2` (hash table verified at that commit; adds `1228`, `1229`, `1230`), where every TW-4F migration except the not-started `1220` (F2) is merged. **Documentation and read-only scripts only.** Nothing described here has been executed against DEV (`epdrtzcydvnoidwrepqz`) or PROD (`hvsujyfbftfffxpfmlpb`); no hosted project was linked, queried or opened while writing it. Every step of the runbooks in section 8 needs the owner's separate written authorization.

Owner rules that bind this package (from the TW-4F completion tracker, `docs/twilio/TW-4F_Completion_Tracker.md` on main since #273):

- No real Twilio, Stripe or other fee-bearing call. No hosted DEV/PROD SQL, deploy, scheduler registration, delivery switch or SMS without a named authorization.
- Everything TW-4F is dark: every env flag and DB switch is off, `vercel.json` registers only `/api/cron/sms-onboarding-purge` among the SMS routes.
- PRs are merged only by the owner. Commits and PRs carry no AI attribution.

## 1. What is in this package

| Item | Purpose |
|---|---|
| This file | The manifest (sections 3-6), the recorded hosted state (section 2), the runbooks (section 8) and the QA record for this package (section 9). |
| `scripts/hosted/tw4f/gen_manifest_data.mjs` | Derives hashes, created/replaced/dropped objects, client-exposed grants, data statements and rollback refusals from Git blobs. `--table` prints the section 3 rows, no flag prints the section 6 appendix, `--sync-probes` rewrites the expected-object lists inside the two probes, `--json` prints everything. Git only: no database, no network. |
| `scripts/hosted/tw4f/verify_manifest_hashes.sh [ref]` | Recomputes every sha256 in section 3 from `git show <ref>:<path>` and fails on a mismatch, a duplicate, or a migration on the ref that the manifest does not list. |
| `scripts/hosted/tw4f/probe_objects.sql` | One SELECT: tables, RLS/FORCE RLS, exact row counts, ACLs and API-role privileges, functions (SECURITY DEFINER, pinned `search_path`, execute privileges, normalized body md5), triggers, policies, base dependencies, migration history. |
| `scripts/hosted/tw4f/probe_fingerprint.sql` | One SELECT: per-object md5 prefixes of function bodies/metadata and table columns/constraints/indexes/triggers/ACLs, with rollups for before/after comparison. |
| `scripts/hosted/tw4f/validate_local.sh` + `validate_local.fixture.sql` | Proves the probes run, never write, and normalize CRLF, on a throwaway local container. |

Both probes are single statements on purpose: the hosted method recorded in `TW-4_Production_Release_Readiness.md` section 4 is one read-only statement per call from a fresh scratch workdir.

## 2. Hosted state: PROBED 2026-10-24 (read-only)

**Observed 2026-10-24 ~02:00Z, owner-authorized.** I ran `probe_objects.sql` and `probe_fingerprint.sql` from `main` `18e5e03d`, each wrapped in `begin transaction read only … rollback`. They ran from fresh scratch workdirs whose linked project ref was checked before each run; the workdirs were deleted afterwards. Both probes report `read_only_txn = on`, connected as `postgres`, server 17.6. Nothing was written. The outputs contain object names, counts and md5 prefixes only.

| Environment | Observed state | Fingerprint rollups (`probe_fingerprint.sql` method) |
|---|---|---|
| PROD `hvsujyfbftfffxpfmlpb` | **TW-4 through `20261119092100` only.** 5 TW-4 tables are present: `studio_sms_onboarding`, `_onboarding_access`, `_onboarding_audit`, `_provisioning_steps` and `_runner_windows`, all 0 rows, RLS on, no API privileges. There are 36 TW-4 functions. Every object from `20261120090000` onward is MISSING. `supabase_migrations.schema_migrations` is ABSENT. | ALL `d17059a0` (120 objects); tw4 fn_body `f8130cf5` (36); tw4 fn_meta `7aeba3a8` |
| DEV `epdrtzcydvnoidwrepqz` | **PROD's objects plus `20261120090000`, `20261121090000` and `20261122090000`.** 19 TW-4/TW-4F tables, all 0 rows, RLS on, no API privileges. There are 84 TW-4 functions. Every object from `20261123090000` onward is MISSING. The migration-history table is present but not authoritative. | ALL `bf10276e` (286 objects); tw4 fn_body `62585cfa` (84); tw4 fn_meta `05025717` |
| Both | `studio_sms_registrations` (TW-3, created before this chain) is present with 0 rows. The 9 other SMS functions are identical on both (fn_body `57ffc959`, fn_meta `296327df`). DEV also has `tw4_credit_reverse_topup`, a 3b-0-era function not defined by the final chain on main, as an unlisted extra. Review it before the DEV apply. | — |

**Conclusions.**

- **DEV.** The first file to apply on DEV is `20261123090000`.
- **PROD.** The first file to apply on PROD is `20261120090000`.
- **No `1206`..`1227` object exists on either project.** (`1228`, `1229` and `1230` merged after this probe; they were not probed, and no record shows them applied anywhere.)
- **The §9a conflict is settled.** `TW-4F_Production_Onboarding_Plan.md` §9a ("1120/1121 NOT applied") is stale for DEV; it is correct for PROD.
- **Fingerprint baselines.** These rollups are the baselines for before/after comparison at each apply step. The older Phase A fingerprint `7d4442fa` used a different method, so it is not comparable. The probe expected lists were later re-synced for `1228`/`1229`; that only adds names (`_tw4rfl_evid_guard`, the evidence table) that do not exist on DEV or PROD, so these baselines stay comparable.

The history below is kept for reference.

## 2a. Previously recorded hosted state (history)

**Nothing in this subsection was observed by this package.** It was copied from earlier records. The probe above supersedes it.

| Environment | Recorded state | Source |
|---|---|---|
| PROD `hvsujyfbftfffxpfmlpb` | Twilio objects through `20261119092100` (TW-4A, 4A.1, R1, R1.1), all studio_sms onboarding tables with 0 rows. The app was `dpl_9JYuwjxf…` (main `2cc05d9e`) at that time; the live production app since 2026-10-23 is `dpl_87xgSBVM…` (a website-only build from `release/web-2a-website`), with `dpl_9JYuwjxf…` as its rollback target. | 2026-10-19 prod sync review; tracker section 2 |
| DEV `epdrtzcydvnoidwrepqz` | PROD's state plus `20261120090000`, `20261121090000`, `20261122090000` (Phase A fingerprint `7d4442fa`). | tracker section 2 |
| Both | Nothing newer than the rows above is recorded as applied: `20261123090000` through `20261230090000` (including the later-merged `1206`, `1215`, `1218`, `1219`, `1221`..`1230`) have been applied only to local or isolated QA databases, and are merged to main (`67bb64f2`) but not applied to any hosted project. `20261220090000` does not exist. | tracker sections 1-2; merge records through 2026-10-23 |

**The `7d4442fa` fingerprint cannot be reproduced.** The query that produced it is not recorded in the repository. The rollups of `probe_fingerprint.sql` use a different, documented method and will not equal it. Take a fresh baseline with this package's probe and compare to that baseline only.

**Document conflict (unresolved here).** `docs/twilio/TW-4F_Production_Onboarding_Plan.md` section 9a (written 2026-10-18) says migrations `20261120090000` and `20261121090000` are "NOT applied to DEV or PROD". The later Phase A record says DEV has `1120`, `1121` and `1122`. The likeliest reading is that section 9a predates the DEV apply, but that is an inference. Do not edit either document from this slice: only the authorized probe (step D1) settles it. The runbook therefore does not assume a DEV starting point: D1 decides, from the probe, the first file to apply. If the probe shows `1120`-`1122` objects on DEV, record the section 9a text as stale in the follow-up docs commit that adds the probe output.

The 2026-10-19 sync review also found PROD = main `2cc05d9e` (`dpl_9JYuwjxf…`) with main since moved on and not promoted (the live app has since become the website-only `dpl_87xgSBVM…`, 2026-10-23, which also does not carry the TW-4F build); PROD's app must stay fail-closed on a database that lacks the objects a promoted build expects. Nothing in this package changes that.

## 3. Migration hash table (main `67bb64f2`)

`sha256` is of the **LF-normalized blob**: `git show main:<path> | tr -d '\r' | sha256sum` (equivalent to the task's `git show main:<path> | sha256sum` when the blob has no CR, which is true for every file in this range: no blob below contains a CR byte, and the last column would say so otherwise). Paths are under `src/lib/supabase/migrations/`; rollback files are under `rollback/` with the suffix `_rollback.sql`.

CRLF handling, because it corrupted function-body fingerprints before:

- A Windows working tree with `core.autocrlf=true` can hand you CRLF files that hash differently. Always hash and apply from `git show <ref>:<path>` (LF blobs), not from a working-tree file you did not just export.
- Export the exact bytes you will apply: `git show main:<path> > scratch/<file>.sql`, then `sha256sum` it and compare with this table before applying. Apply that file, not the working tree copy.
- Function bodies stored in the database with a CR change their md5 unless normalized. The migrations' own precondition and rollback guards, and both probes, use `md5(replace(prosrc, chr(13), ''))` for this reason; the probe flags a stored CR as `(CR in stored body)`.
- `verify_manifest_hashes.sh` reads these rows; keep the row format.

| Timestamp | Forward file | sha256 forward (LF) | sha256 rollback (LF) | Line endings |
|---|---|---|---|---|
| 20261119090000 | 20261119090000_twilio_tw4a_sms_onboarding.sql | f792c351933e1dc15085048a088e6d11291c631d38baa9e1c1f8ecacd7a059af | b0f9d5c522342dd4f84069851d56ad1800ba77aba81b8d20367b7811844b019b | LF |
| 20261119091000 | 20261119091000_twilio_tw4a1_paused_status_and_legal_continuity.sql | 9ca53d4d32215e6a527a0278782d38576180b8fdcb06e32e255bd453d9df503a | a6144565c3fd0875946f6bfb98cee0d28cff33533783686e5ef5180f3208067c | LF |
| 20261119092000 | 20261119092000_twilio_tw4_r1_brand_runner.sql | 63ba6947ab87e506d2e643f20154e3210dd3dfa4da65ecb7dd4341fbec40f099 | e4cb9698afa10b12d17d14bbf52ac3d194008e9f574c2d6361546165a6bb63a6 | LF |
| 20261119092100 | 20261119092100_twilio_tw4_r1_1_window_and_sid_guards.sql | 1a57dd9a963dfd3daefe064842c9c41007d7ed439dccf3b8394ba7e8200d4826 | 299dfc10c3b1e14a501fe6bc71b62b855c808c13f923588b6e45bdcabb205e32 | LF |
| 20261120090000 | 20261120090000_twilio_tw4f1b_gate_evidence.sql | eb9d51375779e2ffc3038314e1196f142e5f52ef4bafeab68bc301f36c239696 | 548edba284361b56620ee17a2b7bf615ca67707cb3583b8301022373c0cade73 | LF |
| 20261121090000 | 20261121090000_twilio_tw4f3a_subaccounts.sql | 214dc97d4a5877fa7d32a3c11fe77aa7f88ba70b57d5776bb52a26e3a04c0a8f | dbb937119d9280b728d0f5dd6efe620bb93262fddc571661dedf0f07624a8dfe | LF |
| 20261122090000 | 20261122090000_twilio_tw4f3b0_prepaid_credits.sql | b1bbc7c0725fdbfaa444bda08a1bb4c0bdaa87b45777b6d1ef0de4abb21a544f | 523db03abd647c0ac0ad8c9c3d70df801c2178318f02fe9cdd0120ccdbcc44c2 | LF |
| 20261123090000 | 20261123090000_twilio_tw4f3b_pay_stripe_credit_purchases.sql | e7afd0a3657e335c8d761bc04156167cc55e7bfd6ed3fff5073189d72ebf28bc | 308cbee6516da7c38b81b369676b86ce87a016cc0d3f1c15947cd1328ff13add | LF |
| 20261124090000 | 20261124090000_twilio_tw4f3b_ui_credit_reads.sql | 3476092b32f8f4e7b0324161c059860d3c2542f309b74eecbd7be526d3f15186 | 7438d468eb5a2f7cddc35118cdc038405ec288937fd34688e1cc4334fc143809 | LF |
| 20261125090000 | 20261125090000_twilio_pay_integrity_hardening.sql | 10ef2b00c4831702cbb6e5b6939495557db69165d62aede43ef4a72d857f13a1 | 746f3bfdf411ab6f3fda0e0db59018e04dde70d82921180ec3db07dd08637a5f | LF |
| 20261126090000 | 20261126090000_twilio_recurring_authorization.sql | 9fa3000f06d5ad7b8547d7a80d17b33a18818e488ac6bd396aa82ad7af3625ab | c23f8e87c8e1b7464f75f5b44e7cf0bff9b453d2b13548061aec31d9d4b90c2c | LF |
| 20261127090000 | 20261127090000_twilio_recurring_execution.sql | 8decf51801b640f10d8a7adfb2180d1179446c8a757de33a441a3499f7d3a480 | d0900f28995fd04e3804f531ec63df493ae88bcdb178c3de6f8043ec3e540dd3 | LF |
| 20261128090000 | 20261128090000_twilio_monthly_spending_limits.sql | 2b211559cb0a25facfe8c1e2dcd0dc1cb3854814d58f16856e55b56cb6a50f4c | 30dd965d38046bcc70680b791cf32442974347d12c6f635b4eeb04994205c2e5 | LF |
| 20261129090000 | 20261129090000_twilio_tw4f_provider_integration.sql | 5e9395e47c655eaa18c7b5445b515d052548c706b22a464c987c825f37361278 | c0f9954e71a3ac595844ae714039449d2cda854d51fb46ea0be5324595a68881 | LF |
| 20261130090000 | 20261130090000_twilio_tw4f_admin_panel.sql | 2b7796173739138e1fb57aade02c3df04f946b85423a2cb79c9cbdf63298fae2 | 1ca56f470097d65af9bdc0142945abea2d54e676e6d2edc9b883b78bdc7fd55a | LF |
| 20261201090000 | 20261201090000_twilio_sms_usage_financials.sql | 849fda85d353d74cfd66509d86cfd22bd87726f754886ada846081d52d74c561 | 6d1e536fdf97788debc4a2f33b9590bde8a6f8edb57ad027d08e92a2fd197a40 | LF |
| 20261202090000 | 20261202090000_twilio_tw4f_financial_integrity.sql | f1fc7e81e60c4001654708e4726c446148566699f5946787451dc85155dd59fe | cfde042e52b2a3071656661015b274cf8b8a8556f81204d6ef879d1b319e8628 | LF |
| 20261202140000 | 20261202140000_twilio_tw4ml_default_tz_perf.sql | eb75f67320f9dc0532e4854fea546d1adf5774094abfb3f3c6359ed596d79cf5 | 691dba3d934bdc1a8673d3ec4f803d3f7bff4a33c9cd7cf4cca583037db8afda | LF |
| 20261202150000 | 20261202150000_twilio_tw4f_panel_monthly_limits.sql | dd9d4f210867c1dcae307e99d6969e918cbf23a4f5ab529cd08add2d440a064d | 786cfacaa3ab573cb865c9bd9ce4bcf639d835236967f360cc1fa8ea984bde0d | LF |
| 20261203090000 | 20261203090000_twilio_inbound_usage_recording.sql | a21074c58bb07ecd2e76d730de8a658ab359feb3be5ae47c538b8e2a26728212 | b621ee50dc090a314ce68275288d6950eac0d079efa6919fe8d8f3fc513575a9 | LF |
| 20261204090000 | 20261204090000_twilio_sender_readiness.sql | 6671ed7ab4a896c5c25ce36fd1ec047a35758704298399b4ce8f1a3964e3f122 | 1c36772025edf1bdc65b1bcd864b20c67d116a543895934cd3d36e48fb888e55 | LF |
| 20261205090000 | 20261205090000_twilio_usage_reconciliation.sql | 2e8f122800477af9d241b9989042445095a28a5d7dcc31a525653995c18c515e | 0e496d748a080296c1733e99f2b487ca1ff4b7d0c2a571f747232945b1bb39d5 | LF |
| 20261206090000 | 20261206090000_twilio_sender_reverification.sql | 7e766d021d478d8615c88134e41f62dd5bae7eb4379583fff1b10aa3f89b0b0e | 2932f6b70b4b49a95d77f9a4dca753727349ac5eeff5870ea83b5a5cccc4145d | LF |
| 20261207090000 | 20261207090000_twilio_r2a_messaging_service_campaign.sql | 8321fabb802623e766636087681a5b758af0aefa0dc5f76650eabf5aacda8d6b | 5fa293415ce5e3aba4bc9cffa048a3838fc4196f5c4bea10b270bf4f9f0cad25 | LF |
| 20261208090000 | 20261208090000_twilio_r2b_number_activation.sql | 7551885c236bbe5d41a76fca6c3926ee9ba176ded8bdaf99baf9111e99c93b42 | a765c4e4d930d7dbb3fa93927c48e587d42332aa3156c2884ec264cf0f46168b | LF |
| 20261209090000 | 20261209090000_twilio_recurring_fee_lifecycle.sql | d5f3af102b4ccc23e951c7735213846231748d97f369ffc27edcd25bd4a84c9e | 4716984c1773c5edf6f11bd7e7e61fe7bcaed1a0df4297271518bc24b9ddead1 | LF |
| 20261210090000 | 20261210090000_twilio_r2c_owner_provisioning_read.sql | a77e7f9762864ea12ba356a2386daf35c854600d224356fa349d24b629e6a918 | 98dc89ee2666d4cd2869ea1cc0174c369a6b5052357a6efa9ca4f69f20795690 | LF |
| 20261211090000 | 20261211090000_twilio_rfl_ops.sql | 75e470601359e6bf18eec1141f94fb0af085ebda6bcdfa54b9b97e6241621d7f | e612b9bb0cf78f8e87c376265648118ec6727e2dd7ebeead8c29142ca1168b48 | LF |
| 20261212090000 | 20261212090000_twilio_prov_fee_resolution_evidence.sql | 280adc409572d185bc2a67c0802b30131e16164cdb740116c9d187bd36e99df3 | 142048860b0c78516538f4b749d0860239a64b3853130b97040fd6649d69666d | LF |
| 20261213090000 | 20261213090000_twilio_r2b_p1_identity_evidence.sql | 3cb2f083bd59e6b6d7f48096c8d85119245e944ca2dca754fc29dc370659087b | 393df0bca1befd50aecf226d0c2b55e3d2dfe8135435d196fd9fb93d58ce118a | LF |
| 20261214090000 | 20261214090000_twilio_r2b_p2_orphans_reconciliation.sql | 9978f3a7fa9f99fa5460be98dd59301ed02278fbf14168f0fb8e39c1ab8ecc87 | de8d74383285941edeca005487aa05a7f81f913d6830fc61baba73b63b5df8d3 | LF |
| 20261215090000 | 20261215090000_twilio_prov_evidence_targets.sql | 2a3308aa1b1d4425d1d49263c4b94806b68051be42c6fef963d20f03c58f5277 | a0d2430de1ae7cb6ab5090094f387559ce02180cb5a7237a2d362f17298fd42d | LF |
| 20261216090000 | 20261216090000_twilio_prov_orphan_exposure.sql | e7f240e2279eaec0b5202b81d48ae76963c6b4417f79ff07ea819224102bf3d8 | e56a6d6530e040a14cea7a456600f96364ab5c606c95a044e701ce7651bca98a | LF |
| 20261217090000 | 20261217090000_twilio_r2b_rfl_lifecycle_integration.sql | 0c832ffe4848c6642288fc994d20c54046bbb4e52165c5221dddbfbd64ac086f | 0d1bd3d27e87aaaf2fb16400e9f43e5fd006b54b09ad1587d632b0827ff84471 | LF |
| 20261218090000 | 20261218090000_twilio_usage_reconciler_readiness.sql | c85bfafc7d8b15840fb9da18daff74f02d663681e49f7d51cb92952acf311af5 | ef10b282a193662eb21ca8b04d5ad146eff4386e3b4933329be758429f59ce43 | LF |
| 20261219090000 | 20261219090000_twilio_act_pilot_funding_lock_order.sql | f1a7268bad4f6df513c5f3dcfab2d73836d6b60868692cdbc8301143546a8887 | bb3301f53e3453e02644f8a4569b2848b0045f3bc70fc9655fe577129185f25f | LF |
| 20261221090000 | 20261221090000_twilio_admin_recovery_tooling.sql | 7dfcfcfa718ba297dc956bb56770c0b844cd30f335c72da7eebeb639f0b803c3 | 9d7368ed0e418b098ac41c4b1d394ec81f1a68f85dee5058ab7d4851f479d765 | LF |
| 20261222090000 | 20261222090000_twilio_owner_texting_status.sql | d4bbc183aae7fc8489abff4ed45a28753039a873dac6bd03f853a909e2a60748 | 21f4c0e66cb228bef2d3ac055cf57f8684d3febbec5f3a0aec4c6130672c89b7 | LF |
| 20261223090000 | 20261223090000_twilio_inventory_reconcile_run.sql | f3db1425ba82bfa79363889abaab3bc6b92efc7f71a5eacd277a5f147dc480de | 4a5a7dabbfe2a701c59aebfaec467a703efa30df6d206cd7980485a11d3d86e0 | LF |
| 20261224090000 | 20261224090000_twilio_rfl_cancel_target.sql | 59b03309d0e72441b9f17b83f993ee5a9b630709082a1be25705b10ce3671bee | 8321de6ad70dfd91f30c8c7750604afda08058380c5195caf63c3b55aca0d296 | LF |
| 20261225090000 | 20261225090000_twilio_rfl_d5_cover.sql | f3c7700ef11879ea51c7c1215e775d41b4a1cbc64bddddf4d7a10af5093f5dfc | f6a5288276b413ac5d36d72ffaca6a01a81d446b94d81c55c50457e791bcdd40 | LF |
| 20261226090000 | 20261226090000_twilio_act_console_gates.sql | 09588758d7739eebce82405c70d03a93a1e3c0080c93d95e0d749a0e51cc0723 | 8c275fc7ffffa2e2da617c9c6fdebc06ec9734d35757ef176eecc2f0b091f35d | LF |
| 20261227090000 | 20261227090000_twilio_owner_number_offers.sql | 0c8e77b2a6693f6fce87fa9d432aed954eb0f466696c388f5705efeb01612c03 | 20d6210d2038bf48429880a72047e4519f3bbaed446d2884429c60a71695626c | LF |
| 20261228090000 | 20261228090000_twilio_ki1_cross_month_release.sql | 643b6c9e712c7813e68afdb88490a420fc4529f99306e878a94d18cb7d516514 | ad26215a88a8f8b71fd78a2acf5276033d2f59d725ea404d27d0864d35f5a10c | LF |
| 20261229090000 | 20261229090000_twilio_rfl_pilot_evidence.sql | c9295ed40d54a6931fde47e75aede01b85fc382672bfbce9172f0fc1f3edd283 | 3d0fc8bc0364710d8be244033e2d14966f247681079bfa41c8813914dabb6922 | LF |
| 20261230090000 | 20261230090000_twilio_rfl_pilot_spend_evidence.sql | e3275cd720bd044029e3caed553e60211a7c20949e84be06dce3049f2a5667e8 | 92e691e2bff80de1d1daae01259880ee30f65ea8594f251f45de90af77055d84 | LF |

### 3.0 Notes on migrations merged after `960a9d02`

The `verify_manifest_hashes.sh <ref>` refs quoted in these notes are the main commits at which each row was added; verify the whole chain against `67bb64f2` or any later main.

`20261206090000` (#251, sender re-verification) merged to main `cdf342e2` (squash, approved head `9de9eb4c`); its row is in the table above with hashes from main. The forward file **changed during review**: the main blob is `7e766d02…`, not the earlier PR-head `d38de62c…` (the rollback hash is unchanged). It adds service_role functions `tw4_sender_reverify_run` and `tw4_sender_health`, redefines `tw4_sender_due_reverify`, `_tw4sr_judge` and `tw4_sender_reverify`, requires `20261205090000`, and its rollback refuses once a re-verify run or inconclusive audit row exists (55000). It is not applied to any hosted database. By merge order it sits after `1217` in the repository, but its only dependency is `1205`; a hosted apply runs it after `1207`..`1217` unless the owner orders otherwise, and #251's own runbook covers manual ordering. Record the position used, because it changes expected fingerprints.

`20261215090000` (#269) merged to main `6422e050` (squash); its row is in the table above with hashes taken from main (identical to the earlier PR head `5a2432d3`). It adds only the read-only service_role function `tw4_prov_evidence_targets(uuid,text)`, requires `20261212090000`, and its rollback has no row gate. It is still not applied to any hosted database.

`20261225090000` (#290, RFL decision D5 cover) merged to main `c982d7fa` (final PR head `84e1c801`); its row is in the table above with hashes from main, identical to the `0bde8897` re-hash. It redefines `_tw4rfl_guard`, `_tw4rfl_cover`, `_tw4rfl_register_core` and `tw4_rfl_pilot_cover`, adds four nullable supersede columns, requires `1209`..`1217`, has no client-exposed grant, and its rollback refuses while superseded cover evidence exists and is fingerprint-gated. It is not applied to any hosted database. **Hosted rollback must undo `1225` before `1217`/`1211`** (section 5.1); the `1211` and `1217` rollbacks do not detect it. Verify with `verify_manifest_hashes.sh c982d7fa`.

`20261221090000` (F4, #288, `twilio_admin_recovery_tooling`) merged to main `973f36da`; its row is in the table above with hashes from main. The forward file **changed between the earlier PR head and the merge**: main is `7dfcfcfa…`, the earlier PR head `9977fe03` hashed `194e5ef1…` (the rollback hash is unchanged). It adds six platform-admin functions (`tw4_admin_registration_retry`, `tw4_admin_registration_gaps`, `tw4_admin_deferred_retirements`, `tw4_admin_deferred_retire`, `tw4_admin_exposure`, `tw4_admin_prov_proof`; service_role only) and helpers, redefines `tw4_prov_observe` and `tw4_num_registration_retry`, requires `1207`..`1217`, has no client-exposed grant, and its rollback is fingerprint-gated. Not applied to any hosted database. Apply it after `1217`; it precedes `1225` in numeric order, so roll `1225` back first.

Three more merged to main `09ffea39` (rows in the table above, hashes from main, all identical to the PR-head hashes recorded earlier):

- `20261218090000` (F3 #277, merge `2877bab7`): adds `_tw4usage_reconciler_ready()` (service_role only); redefines `tw4_usage_begin` and `tw4_usage_set_switch`; no table/data/client grant. Billed texting cannot be switched on, and a new billed text is refused, unless the usage reconciler is ready. Rollback is fingerprint-gated and refuses while billed texting is on or another function (`1219`) calls the helper.
- `20261219090000` (F1 #280, merge `86dc9b1e`): redefines `_tw4act_funding`, `_tw4act_items`, `tw4_act_activate`, `tw4_act_mark_ready`, `tw4_act_suspend`; adds `_tw4act_pilot_funding`; no client grant. **Apply `1218` then `1219`; roll `1219` back first.** Without `1218` every activation fails closed.
- `20261222090000` (J2 #276, merge `09ffea39`): defines only `get_studio_sms_texting_status(uuid)`, client-exposed to `authenticated` (active `studio_owner` of that studio only); reads `_tw4act_items` by signature, so apply after `1219`. Rollback drops that function only. **`1227` (J3, provisional) redefines this function: roll `1227` back before `1222`.**

None is applied to any hosted database. Verify with `verify_manifest_hashes.sh 09ffea39`.

`20261224090000` (F5 #279, `twilio_rfl_cancel_target`) merged to main `d2489cc9`; its row is in the table above with hashes from main, identical to the PR-head hashes. It adds only the read-only `tw4_rfl_cancel_target(uuid, uuid)` (STABLE, security definer, `EXECUTE` for `service_role` only; refuses a non-administrator actor with 42501; writes nothing), requires `1209` and `1211`, has no client-exposed grant, and its rollback is a plain DROP with no row gate. Not applied to any hosted database. J1 (#278, `de9b9f99`) merged with no SQL.

`20261223090000` (#296, `twilio_inventory_reconcile_run`, merge `893941b0`) and `20261227090000` (J3 #294, `twilio_owner_number_offers`, merge `210f2b8e`) merged to main `893941b0`; their rows are in the table above with hashes from main, identical to the PR-head hashes.

- `1223` requires `1205`; it extends the `studio_sms_reconcile_runs` job check constraint with `inventory_reconcile`, replaces only the job list of `tw4_reconcile_run_begin`, and adds read-only `tw4_reconcile_run_alive(uuid, text)` (service_role only). No new table, no data, no client grant, no scheduler. **Its rollback refuses (55000) while inventory reconciliation runs exist**, refuses if a later migration added another job kind or changed `tw4_reconcile_run_begin`, and verifies the restored body and privileges.
- `1227` requires `1208` and `1222`; it defines client-exposed `get_studio_sms_number_offers(uuid)` (active `studio_owner` of that studio only) and **redefines `get_studio_sms_texting_status(uuid)`**, prechecking the `1222` body (md5 `ced24416`). **Apply `1222` before `1227`; roll `1227` back before `1222`**. The `1227` precheck compares the **raw** `md5(prosrc)` of `get_studio_sms_texting_status` against two bodies (`ced24416…` the `1222` body, `972869a5…` its own, for a re-apply); unlike the other migrations' guards it does **not** strip CR, so a body stored with CR fails the precheck closed. Probe with `probe_objects.sql` (`CR in stored body`) before applying. Its rollback restores the `1222` body exactly and refuses unless the function is the `1227` or `1222` body. The authenticated set is now 23 functions with `1222` and `1227` merged and applied.

Neither is applied to any hosted database. Verify with `verify_manifest_hashes.sh 893941b0`.

`20261226090000` (J4 #298, `twilio_act_console_gates`, merge `897120e1`) merged to main `897120e1`; its row is in the table above with hashes from main, identical to the PR-head hashes (`e2e30a79`, `ead3d86e`). It requires `1219` (bodies fingerprint-checked) and `1225`, replaces only F1's `_tw4act_pilot_funding` and `_tw4act_items`, adds checklist item `pilot_ki1_redecided`, and has no table, data or client-exposed grant. **Apply order `1218`, `1219`, `1221`, `1225`, `1226`; roll back `1226` first.** `1219`'s rollback refuses while `1226` is applied (intended). Its rollback restores the `1219` bodies byte-exactly and refuses if a later migration changed a body. **KI-1 activation block:** with `1226` applied, `tw4_act_mark_ready` and `tw4_act_activate` refuse for the pilot business (`ki1_owner_redecision_pending:lifted_only_by_migration`, TW042) until the owner re-decides KI-1 and a later migration lifts the item; see section 8.3. Not applied to any hosted database. Verify with `verify_manifest_hashes.sh 897120e1`. With this row every TW-4F pilot migration is merged; `1220` (F2) is not started.

`20261228090000` (KI-1 #307, `twilio_ki1_cross_month_release`) and `20261229090000` (U-4 evidence #305, `twilio_rfl_pilot_evidence`) merged to main `c2ac7a5f`; rows above with hashes from main.

- `1228` requires `1207`..`1221` (`tw4_prov_observe` exactly as `1221` left it) and replaces **only** `tw4_prov_observe`: a pilot-funded monthly reservation made in an earlier business month and approved in a later one is **released** on approval instead of captured (KI-1 double-capture fix); the audit note carries `ki1_released=<kind>` and an admin alert is raised. No table, data or client grant. **Its rollback refuses (55000) once a `ki1_released` audit row exists**, and refuses unless `tw4_prov_observe` is the `1228` body. The `pilot_ki1_redecided` activation item from `1226` is **not** lifted by it.
- `1229` requires `1209`..`1226` (the `1225` D5 body is fingerprint-checked). It adds the append-only `studio_sms_provider_cover_evidence` table (RLS on, all API privileges revoked, guard and truncate triggers), **drops the four-argument `tw4_rfl_pilot_cover(uuid,text,text,uuid)` and creates an eleven-argument version** (`service_role` only) that records dated written-authorization evidence with each pilot cover (decision U-4; refusal code TW052; see `docs/twilio/TW-4F_RFL_Pilot_Approval_Evidence.md`), and widens the `studio_sms_spend_events.approval_ref` check from 3..120 to 3..200. **The forward migration refuses to apply while a live evidence-free `pilot_approval` cover exists**, and locks the cover table (`share row exclusive`) while it runs. No client-exposed grant. **Rollback refuses** with any evidence row, with any approval reference longer than 120 characters, if the widened check is missing, or if the eleven-argument body was redefined; it restores the four-argument body byte-exactly. **App compatibility:** any caller of the four-argument signature fails once `1229` is applied; deploy the matching build with or before the SQL, and do not roll the app back past the evidence-aware build while `1229` stays applied.

`20261230090000` (U-4 spend evidence #316, `twilio_rfl_pilot_spend_evidence`) merged to main `67bb64f2`. It applies the `1229` rule to every other pilot spend approval. It requires `1209`..`1229`. It adds the append-only `studio_sms_pilot_spend_evidence` table (RLS on, all API privileges revoked, guard `_tw4pse_guard` plus truncate guard). It **drops and re-creates** `tw4_spend_authorize` (7 to 14 arguments; the seven evidence arguments default to null: a pilot authorization refuses TW052 without them, a credit authorization refuses TW052 with them, so credit behaves as before) and `tw4_pilot_exception_create` (4 to 10 arguments, evidence required), and redefines `tw4_rfl_pilot_cover` (same eleven-argument signature, now passing its evidence through to the spend authorization). Predecessor bodies are md5-checked (`6a166997` / `9a26f8aa` / `deffc1b8`; new `daee5a70` / `171b2d12` / `f5dffdaa`). Scopes: `pilot_exception`, `pilot_onboarding_fee`, `pilot_campaign_fee`, `pilot_number_purchase`, `pilot_period_cover`; the date may not be in the future or older than 400 days. No client-exposed grant. Automated paths (runners, F1/F4/F5 adapters, J4 activation) never authorize a pilot spend and are unchanged. **Rollback refuses once any evidence row exists**, if an old signature already exists, or if any of the three bodies was redefined since.

**HOSTED APPLY-ORDER GATE for `1230`.** Apply `1230` before any pilot exception or pilot approval is created: its forward precondition refuses while any pilot exception exists, or any live evidence-free pilot-funded spend approval (authorized or reserved, and not a `1229` cover that carries cover evidence) exists. No platform-admin pilot action (`tw4_pilot_exception_create`, `tw4_spend_authorize` with pilot funding, `tw4_rfl_pilot_cover`, `tw4_panel_*` approvals) may run during the apply. Hosted DEV and PROD held none at the 2026-10-24 probe, so apply `1229` and `1230` together as the last two files, then create pilot approvals only through the evidence-carrying functions. After the first approval, `1230` can no longer be rolled back (evidence is permanent).

**App compatibility:** `tw4_spend_authorize` and `tw4_pilot_exception_create` change signature (the old ones are dropped): an app build that calls the old signatures fails once `1230` is applied. Release the evidence-aware build with or before the SQL.

None of these is applied to any hosted database. Verify with `verify_manifest_hashes.sh 67bb64f2`.

### 3.1 Reserved slot not on main

The only remaining reserved timestamp. It has no file, so it has no hash and is not covered by `verify_manifest_hashes.sh`.

| Timestamp | Owner / PR | Status | Forward file | sha256 forward (LF) | sha256 rollback (LF) | Notes |
|---|---|---|---|---|---|---|
| 20261220090000 | F2 (not started) | reserved, waits for decision U-3 | none | n/a | n/a | Would own `_tw4sr_ready`, `_tw4sr_ready_core`. Do not plan an apply. |

If `1220` (F2) ever gets a PR, a follow-up commit adds its row (hash, objects, grants, data, rollback gate), places it in the section 4 order (numeric position between `1219` and `1221`) and re-runs the section 9 checks. Until then no apply plan includes it.

## 4. Apply order and method

Numeric order, one file at a time:

`1119_090 → 1119_091 → 1119_092 → 1119_092100 → 1120 → 1121 → 1122 → 1123 → 1124 → 1125 → 1126 → 1127 → 1128 → 1129 → 1130 → 1201 → 1202_090 → 1202_140 → 1202_150 → 1203 → 1204 → 1205 → 1207 → 1208 → 1209 → 1210 → 1211 → 1212 → 1213 → 1214 → [1215, merged] → 1216 → 1217 → 1206 → 1218 → 1219 → 1221 → 1222 → 1223 → 1224 → 1225 → 1226 → 1227 → 1228 → 1229 → 1230`

- Each file wraps itself in a transaction and refuses to run out of order or twice (precondition `to_regprocedure` / fingerprint checks), so a wrong order aborts with `precondition failed` and changes nothing.
- The Supabase CLI history table is **not authoritative** on these projects (2026-10-19 sync record), so the CLI's out-of-order refusal does not apply. If `supabase db push` were ever used, `1206` and `1215` would need `--include-all`; this runbook uses `supabase db query --linked -f <file>` from a scratch workdir instead.
- `1206` is order-independent of the main files after it (tracker section 1) but sits after `1217` by merge order; this runbook applies it after `1217` and before `1218` (the order line above shows it there; it is not in its numeric slot).
- All application of these files is **forward-only schema**; no file seeds price rows and none registers `pg_cron`.

## 5. Dependencies, client-exposed grants, data changes, rollback gates

Requires are taken from each file's header or its precondition checks; the numeric-order apply guarantees them; every file also self-checks (aborts) when a predecessor is missing. "Authenticated grants" are every grant to `anon`/`authenticated`/`PUBLIC`; the tracker's list of client-exposed functions is reproduced by this column exactly. Everything not listed is `service_role` only (or an unexposed helper).

"Rows block rollback?" is **yes** when the rollback script raises `55000` once the evidence rows named exist. "Fingerprint" means the rollback restores earlier bodies and aborts if a later change made them differ.

| Timestamp | Slice | Header requires | Authenticated grants | One-off data change | Rollback refuses when | Rows block rollback? |
|---|---|---|---|---|---|---|
| 20261119090000 | TW-4A onboarding foundation | base: `studios`, `profiles.platform_role`, `user_studio_roles`, `studio_sms_registrations` (TW-3 columns) | 7 RPCs: `set_sms_onboarding_access`, `list_sms_onboardings`, `get_studio_sms_status`, `get_sms_onboarding_draft`, `save_sms_onboarding_draft`, `submit_sms_onboarding`, `cancel_sms_onboarding` | none (inserts only inside functions) | onboarding, pilot-access, ledger or audit rows exist | **yes** |
| 20261119091000 | 4A.1 forward fix | `1119090000` | none (grants unchanged) | none | self-check only | no (bodies) |
| 20261119092000 | R1 brand runner | `1119090000`, `1119091000` | none | none | `1120` applied; runner ledger, window or audit rows exist | **yes** |
| 20261119092100 | R1.1 window and sid guards | `1119092000` | none | none | `1120` applied | no (bodies) |
| 20261120090000 | 4F-1b gate evidence | R1/R1.1 (`1119092100`) | none | none | submission confirmations or evaluation evidence exist | **yes** |
| 20261121090000 | 4F-3a subaccounts | `1120` | `sms_location_attest` | none | entities, subaccounts, spend or account evidence exist | **yes** |
| 20261122090000 | 4F-3b-0 prepaid credits | `1120`, `1121` | `sms_credit_overview`, `sms_credit_history`, `sms_price_list` | none (published prices: none seeded) | prices, credit accounts, ledger, reservations, payments or provider charges exist | **yes** |
| 20261123090000 | 4F-3b-pay Stripe purchases | `1122` | none | `UPDATE studio_sms_credit_topups SET refunded_cents = reversed_cents WHERE reversed_cents > 0` (0 rows on an empty DB) | purchase bindings, refunds, disputes or live pending checkouts exist | **yes** |
| 20261124090000 | 4F-3b-UI credit reads | `1123` | `sms_credit_purchases`, `sms_credit_admin_overview` | none | no data gate (drops two read functions) | no |
| 20261125090000 | pay integrity hardening | `1123` | none | backfills `studio_sms_credit_disputes` from existing dispute state (0 rows on an empty DB) | dispute records exist (aborts `55000` if old disputes cannot be rebuilt) | **yes** |
| 20261126090000 | recurring authorization | `1122`, `1125` | `sms_recurring_overview`, `sms_recurring_admin_overview` | none | authorizations, charges or audit evidence exist | **yes** |
| 20261127090000 | recurring execution | `1126` | none | none at top level; audit insert inside a replaced function | scheduler runs, switch changes or run-stamped charges exist | **yes** |
| 20261128090000 | monthly spending limits | `1127` | `sms_monthly_limit_overview` | none | limits, ceilings, timezone changes or set-aside commitments exist | **yes** |
| 20261129090000 | provider integration | `1121` (independent of `1128`) | none | none | webhook receipts or tier decisions exist; an onboarding has a chosen tier | **yes** |
| 20261130090000 | admin panel | `1129`, `1122` (independent of `1128`) | none | none | panel requests or eligibility records exist | **yes** |
| 20261201090000 | usage financials | `1128` | none | none | usage attempts, billed senders, switch rows or usage reservations exist | **yes** |
| 20261202090000 | financial integrity | `1130`, `1128` | `sms_location_fee_kinds` | **backfills `studio_sms_approval_refs`** from existing spend events and pilot/ceiling approvals (2 INSERT…SELECT statements; 0 rows on an empty DB) | `1203` applied (roll it back first); a Low-Volume Standard fee kind has been used | **yes** (evidence) |
| 20261202140000 | default-tz performance | `1128` | none | none | no gate (replaces `_tw4ml_default_tz`) | no |
| 20261202150000 | panel monthly limits | `1128`, `1130` | none | none | no gate (drops one read function) | no |
| 20261203090000 | inbound usage recording | `1201` | none | none | inbound records, ceilings or inbound prices exist | **yes** |
| 20261204090000 | sender readiness | `1203` | none | none | sender records or verifications exist | **yes** |
| 20261205090000 | usage reconciliation | `1204` | none | none | reconciliation evidence exists | **yes** |
| 20261206090000 | sender re-verification (#251, merged after `960a9d02`) | `1205` | none | none | re-verification run or inconclusive audit evidence exists | **yes** |
| 20261207090000 | R2a messaging service and campaign | `1204` | none | none | provisioning evidence exists | **yes** |
| 20261208090000 | R2b number activation | `1207` | `tw4_num_select_as_owner`, `tw4_num_withdraw_as_owner` | none | number provisioning evidence or number approval references exist | **yes** |
| 20261209090000 | recurring-fee lifecycle | `1205` | `sms_rfl_owner_overview` | none | lifecycle evidence exists | **yes** |
| 20261210090000 | R2c-I2 owner provisioning read | `1207` | `get_studio_sms_provisioning` | none | no gate (drops one read function) | no |
| 20261211090000 | RFL ops | `1209` | none | none | operational evidence exists | **yes** |
| 20261212090000 | fee-resolution evidence | `1207`, `1208`, `1209` | none | none | evidence exists | **yes** |
| 20261213090000 | R2b-P1 identity evidence | `1208` | none | none | provider identity evidence exists; a function it installed has been changed since (fingerprint) | **yes** + fingerprint |
| 20261214090000 | R2b-P2 orphans and reconciliation | `1208`, `1213` | none | none | orphan findings exist; a function it installed has been changed since (fingerprint) | **yes** + fingerprint |
| 20261215090000 | evidence targets (#269, merged after `960a9d02`) | `1212` | none (adds service_role read `tw4_prov_evidence_targets`) | none | no gate (plain drop of one read function) | no |
| 20261218090000 | usage-reconciler readiness (F3 #277, merged after `960a9d02`) | `1205` (and `1204`) | none | none | billed texting is on, or another function calls the helper; a replaced function changed since (fingerprint) | no row gate; fingerprint-gated |
| 20261219090000 | pilot funding / activation lock order (F1 #280, merged after `960a9d02`) | `1208`..`1217`; `1218` for any activation to pass | none | none | a replaced function changed since (fingerprint); `1226` applied (intended) | no row gate; fingerprint-gated; undo before `1218` |
| 20261221090000 | admin recovery tooling (F4 #288, merged after `960a9d02`) | `1207`..`1217` | none | none | fingerprint only (restored bodies/privileges must match; a later change blocks it) | no row gate; fingerprint-gated |
| 20261222090000 | owner texting status (J2 #276, merged after `960a9d02`) | `1208`, `1209`, `1212`, `1214`; `_tw4act_items` by signature (`1219`) | `get_studio_sms_texting_status` | none | no gate (plain drop) | no |
| 20261223090000 | inventory reconcile run (#296, merged after `960a9d02`) | `1205` | none | none | inventory reconciliation runs exist; another job kind added later; `tw4_reconcile_run_begin` changed since | **yes** + fingerprint |
| 20261224090000 | RFL cancel target (F5 #279, merged after `960a9d02`) | `1209`, `1211` | none | none | no gate (plain drop of one read function) | no |
| 20261226090000 | activation console gates (J4 #298, merged after `960a9d02`) | `1219`, `1225` | none | none | a later migration changed a replaced body; restored bodies must match `1219` | no row gate; fingerprint-gated; **undo first** (before `1225`, `1219`) |
| 20261227090000 | owner number offers (J3 #294, merged after `960a9d02`) | `1208`, `1222` | `get_studio_sms_number_offers` (and redefines `get_studio_sms_texting_status`) | none | the status function is neither the `1227` nor the `1222` body; postcondition: `1222` body not restored | no row gate; **undo before `1222`** |
| 20261228090000 | KI-1 cross-month release (#307, merged after `960a9d02`) | `1207`..`1221` (`tw4_prov_observe` as `1221` left it) | none | none | a `ki1_released` audit row exists; `tw4_prov_observe` is not the `1228` body | **yes**; **undo before `1221`** |
| 20261229090000 | pilot approval evidence (U-4, #305, merged after `960a9d02`) | `1209`..`1226` (`1225` body fingerprint-checked) | none (new table fully revoked; `tw4_rfl_pilot_cover` stays `service_role` only) | none at apply; **refuses to apply while an evidence-free live `pilot_approval` cover exists** | any evidence row; an approval reference > 120 characters; widened check missing; the eleven-argument body redefined | **yes**; **undo first (before `1228`)** |
| 20261230090000 | pilot spend evidence (U-4, #316, merged after `960a9d02`) | `1209`..`1229` (predecessor bodies md5-checked) | none (new table fully revoked; all three functions `service_role` only) | none at apply; **refuses to apply while any pilot exception exists or any live evidence-free pilot-funded approval exists** | any evidence row; an old signature already exists; any of `tw4_spend_authorize` (14 args), `tw4_pilot_exception_create` (10 args), `tw4_rfl_pilot_cover` redefined since | **yes**; **undo first, before `1229`** |
| 20261225090000 | RFL D5 cover (#290, merged after `960a9d02`) | `1209`..`1217` | none | none | superseded cover evidence exists; a replaced function changed since (fingerprint) | **yes** + fingerprint; undo before `1217`/`1211` |
| 20261216090000 | prov orphan exposure | `1212`, `1211` | none | none | no gate (drops two read functions) | no |
| 20261217090000 | R2b / RFL lifecycle integration | `1208` … `1214` (`1215`/`1216` not required) | none | none | not applied; a replaced function changed after this migration; or a restored body is not byte-exact | no row gate, **fingerprint-gated**; registrations and retirements written while live stay valid |

The client-exposed list matches tracker section 4: `sms_location_attest` (1121), credit reads (1122, 1124), recurring overviews (1126, 1128), fee kinds (1202_090), `tw4_num_select_as_owner` / `_withdraw_as_owner` (1208), `sms_rfl_owner_overview` (1209), `get_studio_sms_provisioning` (1210), plus the seven TW-4A RPCs (1119). The probe must show exactly these 23 functions (the seven TW-4A RPCs plus the sixteen listed, including `get_studio_sms_texting_status` from `1222` and `get_studio_sms_number_offers` from `1227`) as executable by `authenticated`, and nothing executable by `anon` or `PUBLIC` (runbook step D4).

### 5.1 Rollback rules (app-first)

1. **Roll the application back first**, then the SQL. A promoted build that calls objects the rollback drops would fail. Rollback of the app = promote the previous deployment (record the previous deployment id before each promotion).
2. SQL rollbacks run in **strict reverse of the order actually applied**, never a convenient subset. This is a hard rule, not a nicety: not every rollback script detects a later layer. The merged `1211` and `1217` rollbacks do **not** refuse while `1225` (#290, RFL D5 cover) is applied, so rolling them back before `1225` would silently drop the D5 check with no error. Record the exact apply order on every hosted run, derive the rollback order by reversing that record, and before any rollback step run `probe_objects.sql` and confirm which later layers are present. Treat a rollback that completes without refusing as proof of nothing about later layers. Several refuse while a later layer is present (`R1` refuses while `1120` is applied; `1202_090` refuses while `1203` is applied; the fingerprint-gated ones refuse when a later migration redefined their functions).
3. A rollback is **safe only while the database holds no evidence rows** in that layer's tables. Once a hosted database holds real rows, "rollback" means: roll the **app** back, leave the SQL in place (it is additive and dark), and forward-fix. Do not weaken a refusal to get past it.
4. The "no" rows above (body-only or read-function-only) can be rolled back with rows present, but only if every later layer that depends on them is already rolled back.
5. DEV is the only place this package asks for a reverse-rollback round trip (step D3), and only for layers applied during that session, while their tables hold 0 rows.

6. **Newest layers first.** With `1228`, `1229` and `1230` merged, the reverse order for the tail of the chain is `1230`, `1229`, `1228`, `1227`, `1226`, `1225`, and so on. Roll `1230` back **first**: it also redefines `tw4_rfl_pilot_cover`, so `1229`'s rollback refuses (eleven-argument body redefined) until `1230` is gone, and `1230`'s rollback refuses once any spend evidence row exists. Then roll `1229` back: it restores the four-argument `tw4_rfl_pilot_cover` that `1219`, `1225` and the rest expect, and refuses once any cover evidence row exists (evidence is permanent, so after the first real pilot approval the SQL stays and only the app rolls back). Roll `1228` back before `1221` (it replaces `tw4_prov_observe` as `1221` left it); it refuses once a `ki1_released` audit row exists.
7. **After `1229`, `1219` cannot be re-applied** unless `1229` is rolled back first: `1219`'s precondition expects the four-argument `tw4_rfl_pilot_cover`. Likewise a re-apply of `1225` expects the four-argument body. Never re-run an earlier file on a database that has `1229`. Likewise, after `1230` the four-argument `tw4_pilot_exception_create` and seven-argument `tw4_spend_authorize` no longer exist, so earlier files that reference those signatures cannot be re-applied until `1230` is rolled back.
8. **`1229` and `1230` are application-visible signature changes** (`tw4_rfl_pilot_cover` 4 to 11 arguments; `tw4_spend_authorize` 7 to 14; `tw4_pilot_exception_create` 4 to 10): the application build and the SQL must be released together in the order the release plan sets, and a rollback of the SQL needs the application rolled back first (rule 1).

## 6. Per-migration appendix (generated)

Generated from the blobs by `gen_manifest_data.mjs`; regenerate, do not hand-edit. "Created" counts functions this file defines for the first time in the chain; "replaced" names an existing function re-created; "dropped" names functions removed. Client-exposed grants are those to `anon`/`authenticated`/`PUBLIC`.


#### 20261119090000_twilio_tw4a_sms_onboarding.sql

- sha256 (LF-normalized): `f792c351933e1dc15085048a088e6d11291c631d38baa9e1c1f8ecacd7a059af`  (812 lines)
- header: TW-4 slice 4A: studio SMS onboarding foundation (database only; NO Twilio calls anywhere).
- created: 4 tables (`studio_sms_onboarding_access`, `studio_sms_onboarding`, `studio_sms_provisioning_steps`, `studio_sms_onboarding_audit`), 21 functions, 0 views, 10 indexes/triggers/constraints
  - new functions: `_sms_onb_is_platform_admin`, `_sms_onb_studio_role`, `_sms_onb_access_enabled`, `_sms_onb_transition_allowed`, `_sms_onb_integrity`, `_sms_onb_append_only`, `_sms_onb_refuse_truncate`, `_sms_onb_steps_guard`, `_sms_onb_audit`, `_sms_onb_missing`, `set_sms_onboarding_access`, `list_sms_onboardings`, `get_studio_sms_status`, `get_sms_onboarding_draft`, `save_sms_onboarding_draft`, `submit_sms_onboarding`, `cancel_sms_onboarding`, `store_sms_onboarding_ein`, `purge_sms_onboarding_ein`, `purge_due_sms_onboarding_eins`, `get_sms_legal_context`
- client-exposed grants (anon/authenticated/PUBLIC): 
  - `GRANT EXECUTE public.set_sms_onboarding_access(uuid, boolean, text), public.list_sms_onboardings(), public.get_studio_sms_status(uuid), public.get_sms_onboarding_draft(uuid), public.save_sms_onboarding_draft(uuid, jsonb), public.submit_sms_onboarding(uuid, jsonb), public.cancel_sms_onboarding(uuid) to authenticated`
- one-off data statements: none at top level
- rollback: `rollback/20261119090000_twilio_tw4a_sms_onboarding_rollback.sql` sha256 `b0f9d5c522342dd4f84069851d56ad1800ba77aba81b8d20367b7811844b019b`
  - refusal conditions: "TW-4A rollback refused: onboarding, pilot-access, ledger or audit rows exist; forward-fix instead [55000]"; "TW-4A rollback self-check failed: objects remain"

#### 20261119091000_twilio_tw4a1_paused_status_and_legal_continuity.sql

- sha256 (LF-normalized): `9ca53d4d32215e6a527a0278782d38576180b8fdcb06e32e255bd453d9df503a`  (120 lines)
- header: TW-4A.1 (forward fix on top of 20261119090000; function bodies only, no table, index, trigger or privilege change).
- created: 0 tables, 0 functions, 0 views, 0 indexes/triggers/constraints
- replaced (CREATE OR REPLACE / re-created): `get_studio_sms_status`, `get_sms_legal_context`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261119091000_twilio_tw4a1_paused_status_and_legal_continuity_rollback.sql` sha256 `a6144565c3fd0875946f6bfb98cee0d28cff33533783686e5ef5180f3208067c`
  - refusal conditions: "TW-4A.1 rollback self-check failed: new bodies remain"

#### 20261119092000_twilio_tw4_r1_brand_runner.sql

- sha256 (LF-normalized): `63ba6947ab87e506d2e643f20154e3210dd3dfa4da65ecb7dd4341fbec40f099`  (536 lines)
- header: TW-4 slice R1 ("brand submission runner"): the service-role database functions the runner needs. The 4A tables have no API
- created: 1 tables (`studio_sms_runner_windows`), 15 functions, 0 views, 2 indexes/triggers/constraints
  - new functions: `_tw4_r1_is_platform_admin`, `_tw4_r1_lease`, `_tw4_r1_step_ok`, `_tw4_r1_audit`, `tw4_runner_set_window`, `tw4_runner_claim`, `tw4_runner_release`, `tw4_runner_get_inputs`, `tw4_runner_get_ein`, `tw4_runner_begin_step`, `tw4_runner_finish_step`, `tw4_runner_transition`, `tw4_runner_record_brand`, `tw4_runner_brand_approved`, `tw4_runner_status`
- replaced (CREATE OR REPLACE / re-created): `purge_sms_onboarding_ein`, `purge_due_sms_onboarding_eins`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261119092000_twilio_tw4_r1_brand_runner_rollback.sql` sha256 `e4cb9698afa10b12d17d14bbf52ac3d194008e9f574c2d6361546165a6bb63a6`
  - refusal conditions: "R1 rollback refused: TW-4F-1b (20261120090000) is applied; roll that back first (it replaces functions this script would overwrite) [55000]"; "R1 rollback refused: runner ledger, window or audit rows exist; forward-fix instead [55000]"; "R1 rollback self-check failed: functions remain"; "R1 rollback self-check failed: 4A purge function not restored"

#### 20261119092100_twilio_tw4_r1_1_window_and_sid_guards.sql

- sha256 (LF-normalized): `1a57dd9a963dfd3daefe064842c9c41007d7ed439dccf3b8394ba7e8200d4826`  (134 lines)
- header: TW-4 R1.1 (forward fix on top of 20261119092000; function bodies only, no table, column or privilege change). Found by the R1 dry run
- created: 0 tables, 0 functions, 0 views, 0 indexes/triggers/constraints
- replaced (CREATE OR REPLACE / re-created): `tw4_runner_begin_step`, `_sms_onb_steps_guard`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261119092100_twilio_tw4_r1_1_window_and_sid_guards_rollback.sql` sha256 `299dfc10c3b1e14a501fe6bc71b62b855c808c13f923588b6e45bdcabb205e32`
  - refusal conditions: "R1.1 rollback refused: TW-4F-1b (20261120090000) is applied; roll that back first (it replaces functions this script would overwrite) [55000]"; "R1.1 rollback self-check failed: new bodies remain"

#### 20261120090000_twilio_tw4f1b_gate_evidence.sql

- sha256 (LF-normalized): `eb9d51375779e2ffc3038314e1196f142e5f52ef4bafeab68bc301f36c239696`  (424 lines)
- header: TW-4F-1b ("gate evidence"): durable, database-enforced authorization for the two IRREVERSIBLE Twilio submissions (S11 = submit the business
- created: 1 tables (`studio_sms_submission_confirmations`), 5 functions, 0 views, 6 indexes/triggers/constraints
  - new functions: `_tw4f1b_confirmations_guard`, `_tw4f1b_submission_check`, `tw4_runner_confirm_submission`, `tw4_runner_record_evaluation`, `_tw4f1b_confirmations_truncate_guard`
- replaced (CREATE OR REPLACE / re-created): `tw4_runner_begin_step`, `tw4_runner_finish_step`, `_sms_onb_steps_guard`, `tw4_runner_status`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261120090000_twilio_tw4f1b_gate_evidence_rollback.sql` sha256 `548edba284361b56620ee17a2b7bf615ca67707cb3583b8301022373c0cade73`
  - refusal conditions: "TW-4F-1b rollback refused: submission confirmations or evaluation evidence exist [55000]"

#### 20261121090000_twilio_tw4f3a_subaccounts.sql

- sha256 (LF-normalized): `214dc97d4a5877fa7d32a3c11fe77aa7f88ba70b57d5776bb52a26e3a04c0a8f`  (596 lines)
- header: TW-4F-3a (D2 revised): one Twilio SUBACCOUNT per studio LEGAL BUSINESS. This file adds the database side only; NO Twilio call is made by anything in it.
- created: 6 tables (`studio_sms_legal_entities`, `studio_sms_location_requests`, `studio_sms_entity_studios`, `studio_sms_twilio_accounts`, `studio_sms_subaccount_confirmations`, `studio_sms_spend_events`), 16 functions, 0 views, 12 indexes/triggers/constraints
  - new functions: `_tw4f3a_name_key`, `_tw4f3a_steps_account_guard`, `_tw4f3a_audit`, `tw4_entity_create_for_studio`, `sms_location_attest`, `tw4_entity_decide_link`, `_tw4f3a_committed`, `tw4_entity_set_spend_cap`, `tw4_spend_authorize`, `tw4_spend_reserve`, `tw4_subaccount_confirm`, `tw4_subaccount_begin`, `tw4_subaccount_finish`, `tw4_runner_account`, `tw4_entity_for_studio`, `_tw4f3a_evidence_guard`
- client-exposed grants (anon/authenticated/PUBLIC): 
  - `GRANT EXECUTE public.sms_location_attest(uuid, text, text, text) to authenticated`
- one-off data statements: none at top level
- rollback: `rollback/20261121090000_twilio_tw4f3a_subaccounts_rollback.sql` sha256 `dbb937119d9280b728d0f5dd6efe620bb93262fddc571661dedf0f07624a8dfe`
  - refusal conditions: "TW-4F-3a rollback: not applied"; "TW-4F-3a rollback refused: entities, subaccounts, spend or account evidence exist [55000]"

#### 20261122090000_twilio_tw4f3b0_prepaid_credits.sql

- sha256 (LF-normalized): `b1bbc7c0725fdbfaa444bda08a1bb4c0bdaa87b45777b6d1ef0de4abb21a544f`  (1051 lines)
- header: TW-4F-3b-0 (prepaid SMS credits are the billing model). Owner decision 1: ONE prepaid balance per VERIFIED LEGAL BUSINESS (the TW-4F-3a legal entity), with
- created: 7 tables (`studio_sms_price_list`, `studio_sms_credit_accounts`, `studio_sms_credit_reservations`, `studio_sms_credit_ledger`, `studio_sms_pilot_exceptions`, `studio_sms_credit_topups`, `studio_sms_provider_charges`), 28 functions, 0 views, 23 indexes/triggers/constraints
  - new functions: `_tw4c_immutable_guard`, `_tw4c_truncate_guard`, `_tw4c_pilot_cap_guard`, `_tw4c_lock`, `_tw4c_any_location`, `_tw4c_post`, `_tw4c_admin`, `_tw4c_require_funds`, `tw4_price_set`, `tw4_credit_topup_pending`, `tw4_credit_settle_topup`, `tw4_credit_reverse_topup`, `tw4_credit_topup_failed`, `tw4_credit_adjust`, `tw4_pilot_exception_create`, `tw4_credit_set_hold`, `tw4_credit_set_threshold`, `tw4_credit_debit_usage`, `tw4_credit_refund_usage`, `tw4_credit_record_provider_charge`, `tw4_credit_verify`, `tw4_spend_settle`, `tw4_credit_resolve_reservation`, `tw4_credit_open_reservations`, `tw4_spend_withdraw`, `sms_credit_overview`, `sms_credit_history`, `sms_price_list`
- dropped functions: `tw4_spend_authorize`
- replaced (CREATE OR REPLACE / re-created): `_tw4f3a_evidence_guard`, `tw4_spend_authorize`, `_tw4f3a_committed`, `tw4_spend_reserve`
- client-exposed grants (anon/authenticated/PUBLIC): 
  - `GRANT EXECUTE public.sms_credit_overview(uuid), public.sms_credit_history(uuid, int, bigint), public.sms_price_list() to authenticated`
- one-off data statements: none at top level
- rollback: `rollback/20261122090000_twilio_tw4f3b0_prepaid_credits_rollback.sql` sha256 `523db03abd647c0ac0ad8c9c3d70df801c2178318f02fe9cdd0120ccdbcc44c2`
  - refusal conditions: "TW-4F-3b-0 rollback: not applied"; "TW-4F-3b-0 rollback refused: prices, credit accounts, ledger entries, reservations, payments or provider charges exist [55000]"

#### 20261123090000_twilio_tw4f3b_pay_stripe_credit_purchases.sql

- sha256 (LF-normalized): `e7afd0a3657e335c8d761bc04156167cc55e7bfd6ed3fff5073189d72ebf28bc`  (350 lines)
- header: TW-4F-3b-pay: prepaid SMS credit purchases through Stripe (platform account). Database side only; NO Stripe call is made by anything in this file.
- created: 0 tables, 4 functions, 0 views, 3 indexes/triggers/constraints
  - new functions: `tw4_credit_checkout_context`, `tw4_credit_topup_lookup`, `tw4_credit_apply_refund`, `tw4_credit_apply_dispute`
- dropped functions: `tw4_credit_topup_pending`, `tw4_credit_settle_topup`, `tw4_credit_reverse_topup`
- replaced (CREATE OR REPLACE / re-created): `_tw4c_immutable_guard`, `sms_credit_overview`, `tw4_credit_topup_pending`, `tw4_credit_settle_topup`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: 
  - `update public.studio_sms_credit_topups set refunded_cents = reversed_cents where reversed_cents > 0`
- rollback: `rollback/20261123090000_twilio_tw4f3b_pay_stripe_credit_purchases_rollback.sql` sha256 `308cbee6516da7c38b81b369676b86ce87a016cc0d3f1c15947cd1328ff13add`
  - refusal conditions: "TW-4F-3b-pay rollback: not applied"; "TW-4F-3b-pay rollback refused: purchase bindings, refunds, disputes or live pending checkouts exist [55000]"

#### 20261124090000_twilio_tw4f3b_ui_credit_reads.sql

- sha256 (LF-normalized): `3476092b32f8f4e7b0324161c059860d3c2542f309b74eecbd7be526d3f15186`  (77 lines)
- header: TW-4F-3b-UI: read-only functions for the prepaid-credit screens. No table, constraint, trigger or existing function changes; nothing here can move money.
- header dependencies: Requires 20261123090000 (TW-4F-3b-pay)
- created: 0 tables, 2 functions, 0 views, 0 indexes/triggers/constraints
  - new functions: `sms_credit_purchases`, `sms_credit_admin_overview`
- client-exposed grants (anon/authenticated/PUBLIC): 
  - `GRANT EXECUTE public.sms_credit_purchases(uuid, int), public.sms_credit_admin_overview() to authenticated`
- one-off data statements: none at top level
- rollback: `rollback/20261124090000_twilio_tw4f3b_ui_credit_reads_rollback.sql` sha256 `7438d468eb5a2f7cddc35118cdc038405ec288937fd34688e1cc4334fc143809`
  - refusal conditions: none declared (no raise exception mentioning "rollback")

#### 20261125090000_twilio_pay_integrity_hardening.sql

- sha256 (LF-normalized): `10ef2b00c4831702cbb6e5b6939495557db69165d62aede43ef4a72d857f13a1`  (198 lines)
- header: Prepaid-credit payment-integrity hardening (after TW-4F-3b-pay / TW-4F-3b-UI).
- header dependencies: Requires 20261123090000
- created: 1 tables (`studio_sms_credit_disputes`), 0 functions, 0 views, 0 indexes/triggers/constraints
- replaced (CREATE OR REPLACE / re-created): `tw4_credit_checkout_context`, `tw4_credit_topup_pending`, `tw4_credit_apply_dispute`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: 
  - `insert into public.studio_sms_credit_disputes (topup_id, legal_entity_id, dispute_id, claim_cents, withdrawn_cents, rein`
- rollback: `rollback/20261125090000_twilio_pay_integrity_hardening_rollback.sql` sha256 `746f3bfdf411ab6f3fda0e0db59018e04dde70d82921180ec3db07dd08637a5f`
  - refusal conditions: "pay-integrity rollback: not applied"; "pay-integrity rollback refused: dispute records exist [55000]"

#### 20261126090000_twilio_recurring_authorization.sql

- sha256 (LF-normalized): `9fa3000f06d5ad7b8547d7a80d17b33a18818e488ac6bd396aa82ad7af3625ab`  (445 lines)
- header: TW-4F recurring SMS service-charge authorization (phone-number rent and campaign monthly fee).
- header dependencies: Requires 20261122090000 (prepaid credits) and 20261125090000 (hold enforcement)
- created: 2 tables (`studio_sms_recurring_authorizations`, `studio_sms_recurring_charges`), 11 functions, 0 views, 7 indexes/triggers/constraints
  - new functions: `_tw4rc_guard`, `_tw4rc_usd`, `tw4_recurring_authorize`, `tw4_recurring_revoke`, `_tw4rc_service_state`, `_tw4rc_service_issue`, `tw4_recurring_service_state`, `sms_recurring_overview`, `tw4_recurring_due`, `tw4_recurring_charge`, `sms_recurring_admin_overview`
- client-exposed grants (anon/authenticated/PUBLIC): 
  - `GRANT EXECUTE public.sms_recurring_overview(uuid), public.sms_recurring_admin_overview() to authenticated`
- one-off data statements: none at top level
- rollback: `rollback/20261126090000_twilio_recurring_authorization_rollback.sql` sha256 `c23f8e87c8e1b7464f75f5b44e7cf0bff9b453d2b13548061aec31d9d4b90c2c`
  - refusal conditions: "recurring-authorization rollback: not applied"; "recurring-authorization rollback refused: authorizations, charges or audit evidence exist [55000]"

#### 20261127090000_twilio_recurring_execution.sql

- sha256 (LF-normalized): `8decf51801b640f10d8a7adfb2180d1179446c8a757de33a441a3499f7d3a480`  (474 lines)
- header: Recurring-charge EXECUTION: the owner's direction that recurring fees count toward the legal business's spending limits, and the safe scheduler.
- header dependencies: Requires 20261126090000
- created: 2 tables (`studio_sms_recurring_runs`, `studio_sms_recurring_switch_log`), 6 functions, 0 views, 6 indexes/triggers/constraints
  - new functions: `_tw4rc_run_guard`, `tw4_recurring_set_switch`, `tw4_recurring_run_begin`, `tw4_recurring_run_finish`, `_tw4rc_reconciliation_gaps`, `_tw4rc_promised`
- dropped functions: `tw4_recurring_charge`
- replaced (CREATE OR REPLACE / re-created): `_tw4f3a_committed`, `tw4_recurring_authorize`, `tw4_recurring_charge`, `_tw4rc_service_state`, `_tw4rc_service_issue`, `sms_recurring_overview`, `sms_recurring_admin_overview`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261127090000_twilio_recurring_execution_rollback.sql` sha256 `d0900f28995fd04e3804f531ec63df493ae88bcdb178c3de6f8043ec3e540dd3`
  - refusal conditions: "recurring-execution rollback: not applied"; "recurring-execution rollback refused: scheduler runs, switch changes or run-stamped charges exist [55000]"

#### 20261128090000_twilio_monthly_spending_limits.sql

- sha256 (LF-normalized): `2b211559cb0a25facfe8c1e2dcd0dc1cb3854814d58f16856e55b56cb6a50f4c`  (960 lines)
- header: Calendar-month spending limits for routine messaging costs (owner direction 2026-10-19), replacing the use of the cumulative spend cap for ongoing operations.
- header dependencies: Requires 20261127090000
- created: 3 tables (`studio_sms_entity_timezones`, `studio_sms_monthly_limits`, `studio_sms_limit_ceilings`), 26 functions, 0 views, 13 indexes/triggers/constraints
  - new functions: `_tw4ml_guard`, `_tw4ml_key_add`, `_tw4ml_valid_tz`, `_tw4ml_default_tz`, `_tw4ml_tz_for`, `_tw4ml_month_start`, `_tw4ml_month_key`, `_tw4ml_ensure_tz`, `_tw4ml_limit_for`, `_tw4ml_ceiling_for`, `_tw4ml_effective_limit`, `_tw4ml_month_parts`, `_tw4ml_month_spend`, `_tw4ml_require_room`, `_tw4ml_apply_limit`, `tw4_monthly_limit_set`, `tw4_monthly_limit_set_admin`, `_tw4ml_apply_timezone`, `tw4_entity_timezone_set`, `tw4_entity_timezone_set_admin`, `tw4_limit_ceiling_set_platform`, `tw4_limit_ceiling_approve_entity`, `sms_monthly_limit_overview`, `_tw4rc_release_commitment`, `tw4_recurring_release_ended`, `tw4_recurring_due_list`
- dropped functions: `tw4_recurring_due`, `_tw4rc_promised`
- replaced (CREATE OR REPLACE / re-created): `_tw4rc_guard`, `tw4_credit_resolve_reservation`, `_tw4f3a_committed`, `tw4_credit_debit_usage`, `tw4_recurring_authorize`, `tw4_recurring_revoke`, `tw4_recurring_charge`, `_tw4rc_service_state`, `_tw4rc_service_issue`, `_tw4rc_reconciliation_gaps`
- client-exposed grants (anon/authenticated/PUBLIC): 
  - `GRANT EXECUTE public.sms_monthly_limit_overview(uuid) to authenticated`
- one-off data statements: none at top level
- rollback: `rollback/20261128090000_twilio_monthly_spending_limits_rollback.sql` sha256 `30dd965d38046bcc70680b791cf32442974347d12c6f635b4eeb04994205c2e5`
  - refusal conditions: "monthly-limits rollback: not applied"; "monthly-limits rollback refused: limits, ceilings, timezone changes or set-aside commitments exist [55000]"

#### 20261129090000_twilio_tw4f_provider_integration.sql

- sha256 (LF-normalized): `5e9395e47c655eaa18c7b5445b515d052548c706b22a464c987c825f37361278`  (183 lines)
- header: TW-4F provider integration (Twilio ticket #29647095 answers, 2026-10-19). Database side only; NO Twilio call is made by anything in it.
- created: 2 tables (`sms_webhook_receipts`, `studio_sms_tier_decisions`), 6 functions, 0 views, 5 indexes/triggers/constraints
  - new functions: `tw4_webhook_account`, `_sms_webhook_receipts_guard`, `sms_webhook_receipt_seen`, `sms_webhook_receipt_record`, `tw4_onboarding_set_tier`, `tw4_runner_tier`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261129090000_twilio_tw4f_provider_integration_rollback.sql` sha256 `c0f9954e71a3ac595844ae714039449d2cda854d51fb46ea0be5324595a68881`
  - refusal conditions: "rollback refused: 20261129090000 is not applied"; "rollback refused: webhook receipts or tier decisions exist (evidence)"; "rollback refused: an onboarding has a chosen tier"

#### 20261130090000_twilio_tw4f_admin_panel.sql

- sha256 (LF-normalized): `2b7796173739138e1fb57aade02c3df04f946b85423a2cb79c9cbdf63298fae2`  (299 lines)
- header: TW-4F platform-admin subaccount onboarding panel (supervised pilot). Database side only; NO Twilio call is made by anything in it.
- created: 1 tables (`studio_sms_panel_requests`), 5 functions, 0 views, 3 indexes/triggers/constraints
  - new functions: `_tw4p_append_only_guard`, `tw4_panel_subaccount_confirm`, `_tw4p_lvs_checklist_complete`, `tw4_onboarding_decide_tier`, `tw4_panel_overview`
- replaced (CREATE OR REPLACE / re-created): `tw4_onboarding_set_tier`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261130090000_twilio_tw4f_admin_panel_rollback.sql` sha256 `1ca56f470097d65af9bdc0142945abea2d54e676e6d2edc9b883b78bdc7fd55a`
  - refusal conditions: "rollback refused: 20261130090000 is not applied"; "rollback refused: panel requests or eligibility records exist (evidence)"

#### 20261201090000_twilio_sms_usage_financials.sql

- sha256 (LF-normalized): `849fda85d353d74cfd66509d86cfd22bd87726f754886ada846081d52d74c561`  (860 lines)
- header: SMS usage financial integration (owner direction 2026-10-20; design docs/twilio/TW-4F_Usage_Financials_Design.md v2).
- header dependencies: Requires 20261128090000 (monthly limits)
- created: 3 tables (`studio_sms_usage_switch_log`, `studio_sms_billed_senders`, `studio_sms_usage_attempts`), 25 functions, 0 views, 10 indexes/triggers/constraints
  - new functions: `_tw4us_append_only`, `_tw4us_attempt_guard`, `_tw4us_segments`, `_tw4us_switch_on`, `_tw4us_write`, `_tw4us_rank`, `_tw4us_release_reservation`, `_tw4us_charge`, `_tw4us_lock_attempt`, `tw4_usage_set_switch`, `tw4_usage_billed_sender_set`, `tw4_usage_studio_mode`, `tw4_usage_begin`, `tw4_usage_dispatching`, `tw4_usage_submitted`, `tw4_usage_rejected`, `tw4_usage_uncertain`, `tw4_usage_record_callback`, `tw4_usage_settle`, `tw4_usage_release_unsent`, `tw4_usage_resolve`, `tw4_usage_due`, `tw4_usage_touch`, `_tw4us_reconciliation_gaps`, `sms_usage_admin_overview`
- replaced (CREATE OR REPLACE / re-created): `_tw4ml_month_parts`, `tw4_credit_resolve_reservation`, `tw4_credit_debit_usage`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261201090000_twilio_sms_usage_financials_rollback.sql` sha256 `6d1e536fdf97788debc4a2f33b9590bde8a6f8edb57ad027d08e92a2fd197a40`
  - refusal conditions: "usage-financials rollback: not applied"; "usage-financials rollback refused: usage attempts, billed senders, switch rows or usage reservations exist [55000]"

#### 20261202090000_twilio_tw4f_financial_integrity.sql

- sha256 (LF-normalized): `f1fc7e81e60c4001654708e4726c446148566699f5946787451dc85155dd59fe`  (784 lines)
- header: TW-4F financial-integrity follow-up (two items). Database side; NO Twilio or Stripe call is made by anything in it. NO price is published.
- created: 1 tables (`studio_sms_approval_refs`), 15 functions, 0 views, 13 indexes/triggers/constraints
  - new functions: `_tw4fi_ref_norm`, `_tw4fi_append_only`, `_tw4fi_register`, `_tw4fi_spend_ref_trigger`, `_tw4fi_pilot_ref_trigger`, `_tw4fi_ceiling_ref_trigger`, `_tw4fi_location_path_nolock`, `_tw4fi_require_path_kind`, `_tw4fi_reservation_path_trigger`, `_tw4fi_spend_path_trigger`, `_tw4fi_open_path_commitments`, `tw4_location_fee_kinds`, `tw4_runner_fee_kinds`, `sms_location_fee_kinds`, `tw4_approval_ref_trace`
- replaced (CREATE OR REPLACE / re-created): `tw4_spend_authorize`, `tw4_spend_reserve`, `tw4_spend_settle`, `tw4_onboarding_decide_tier`, `tw4_onboarding_set_tier`, `tw4_recurring_authorize`
- client-exposed grants (anon/authenticated/PUBLIC): 
  - `GRANT EXECUTE public.sms_location_fee_kinds(uuid) to authenticated`
- one-off data statements: 
  - `insert into public.studio_sms_approval_refs (ref_norm, approval_ref, source, legal_entity_id, studio_id, spend_event_id,`
  - `insert into public.studio_sms_approval_refs (ref_norm, approval_ref, source, legal_entity_id, approved_by, created_at) s`
- rollback: `rollback/20261202090000_twilio_tw4f_financial_integrity_rollback.sql` sha256 `cfde042e52b2a3071656661015b274cf8b8a8556f81204d6ef879d1b319e8628`
  - refusal conditions: "rollback refused: 20261202090000 is not applied"; "rollback refused: roll back 20261203090000 (inbound usage recording) first"; "rollback refused: a Low-Volume Standard fee kind has been used (evidence)"

#### 20261202140000_twilio_tw4ml_default_tz_perf.sql

- sha256 (LF-normalized): `eb75f67320f9dc0532e4854fea546d1adf5774094abfb3f3c6359ed596d79cf5`  (35 lines)
- header: PERFORMANCE ONLY, same results: _tw4ml_default_tz (20261128090000) let the planner run _tw4ml_valid_tz -- a scan of pg_timezone_names, ~130 ms --
- created: 0 tables, 0 functions, 0 views, 0 indexes/triggers/constraints
- replaced (CREATE OR REPLACE / re-created): `_tw4ml_default_tz`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261202140000_twilio_tw4ml_default_tz_perf_rollback.sql` sha256 `691dba3d934bdc1a8673d3ec4f803d3f7bff4a33c9cd7cf4cca583037db8afda`
  - refusal conditions: none declared (no raise exception mentioning "rollback")

#### 20261202150000_twilio_tw4f_panel_monthly_limits.sql

- sha256 (LF-normalized): `dd9d4f210867c1dcae307e99d6969e918cbf23a4f5ab529cd08add2d440a064d`  (64 lines)
- header: TW-4F platform-admin panel follow-up: the monthly spending limit of each legal business, READ-ONLY, for the supervised-pilot panel.
- created: 0 tables, 1 functions, 0 views, 0 indexes/triggers/constraints
  - new functions: `tw4_panel_monthly_limits`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261202150000_twilio_tw4f_panel_monthly_limits_rollback.sql` sha256 `786cfacaa3ab573cb865c9bd9ce4bcf639d835236967f360cc1fa8ea984bde0d`
  - refusal conditions: none declared (no raise exception mentioning "rollback")

#### 20261203090000_twilio_inbound_usage_recording.sql

- sha256 (LF-normalized): `a21074c58bb07ecd2e76d730de8a658ab359feb3be5ae47c538b8e2a26728212`  (531 lines)
- header: Inbound SMS usage RECORDING (owner decisions D1-D4 of 2026-10-20; docs/twilio/TW-4F_Inbound_Pricing_Assessment.md). No price is published by this file.
- header dependencies: Requires 20261201090000 (usage)
- created: 3 tables (`studio_sms_inbound_exposure_ceilings`, `studio_sms_inbound_usage`, `sms_inbound_reply_counters`), 7 functions, 0 views, 6 indexes/triggers/constraints
  - new functions: `_tw4in_ceiling`, `tw4_inbound_record`, `tw4_inbound_reply_allowed`, `tw4_inbound_exposure_set`, `_tw4in_reconciliation_gaps`, `sms_inbound_admin_overview`, `_tw4in_spend_without_inbound`
- replaced (CREATE OR REPLACE / re-created): `_tw4ml_month_parts`, `tw4_credit_debit_usage`, `tw4_recurring_charge`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261203090000_twilio_inbound_usage_recording_rollback.sql` sha256 `b621ee50dc090a314ce68275288d6950eac0d079efa6919fe8d8f3fc513575a9`
  - refusal conditions: "inbound-recording rollback: not applied"; "inbound-recording rollback refused: inbound records, ceilings or inbound prices exist [55000]"

#### 20261204090000_twilio_sender_readiness.sql

- sha256 (LF-normalized): `6671ed7ab4a896c5c25ce36fd1ec047a35758704298399b4ce8f1a3964e3f122`  (710 lines)
- header: Sender readiness and dispatch integrity (owner direction 2026-10-20, option 1; design docs/twilio/TW-4F_Sender_Readiness_Design.md incl. section 9).
- header dependencies: Requires 20261203090000
- created: 1 tables (`studio_sms_sender_verifications`), 17 functions, 0 views, 11 indexes/triggers/constraints
  - new functions: `_tw4sr_lock`, `_tw4sr_latest`, `_tw4sr_fake_allowed`, `_tw4sr_ready`, `_tw4sr_append`, `_tw4sr_audit`, `tw4_sender_record`, `_tw4sr_judge`, `_tw4sr_apply`, `tw4_sender_verify`, `tw4_sender_reverify`, `tw4_sender_revoke`, `_tw4sr_flag`, `tw4_inbound_studio_for`, `tw4_sender_overview`, `tw4_sender_due_reverify`, `tw4_usage_release_unprepared`
- replaced (CREATE OR REPLACE / re-created): `tw4_usage_begin`, `tw4_usage_dispatching`, `tw4_usage_record_callback`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261204090000_twilio_sender_readiness_rollback.sql` sha256 `1c36772025edf1bdc65b1bcd864b20c67d116a543895934cd3d36e48fb888e55`
  - refusal conditions: "sender-readiness rollback: not applied"; "sender-readiness rollback refused: sender records or verifications exist [55000]"

#### 20261205090000_twilio_usage_reconciliation.sql

- sha256 (LF-normalized): `2e8f122800477af9d241b9989042445095a28a5d7dcc31a525653995c18c515e`  (793 lines)
- header: Scheduled SMS usage reconciliation and stale-reservation recovery (owner handoff "TW-4F - Scheduled SMS Reconciliation & Financial Integrity",
- header dependencies: Requires 20261204090000
- created: 5 tables (`studio_sms_reconcile_runs`, `studio_sms_inbound_scan_cursors`, `studio_sms_inbound_recoveries`, `studio_sms_inbound_unresolved`, `studio_sms_usage_attempt_events`), 16 functions, 0 views, 22 indexes/triggers/constraints
  - new functions: `_tw4ur_guard`, `_tw4ur_attempt_event`, `_tw4ur_fence`, `_tw4ur_account_of`, `_tw4ur_instant`, `tw4_reconcile_run_begin`, `tw4_reconcile_run_finish`, `tw4_usage_release_stale`, `tw4_usage_evidence_failed`, `tw4_usage_escalate`, `tw4_inbound_scan_targets`, `tw4_inbound_recover`, `tw4_inbound_unrecorded`, `tw4_inbound_note_unresolved`, `tw4_inbound_scan_advance`, `tw4_usage_reconcile_overview`
- replaced (CREATE OR REPLACE / re-created): `tw4_usage_settle`, `tw4_usage_due`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261205090000_twilio_usage_reconciliation_rollback.sql` sha256 `0e496d748a080296c1733e99f2b487ca1ff4b7d0c2a571f747232945b1bb39d5`
  - refusal conditions: "usage-reconciliation rollback: not applied"; "usage-reconciliation rollback refused: reconciliation evidence exists [55000]"

#### 20261206090000_twilio_sender_reverification.sql

- sha256 (LF-normalized): `7e766d021d478d8615c88134e41f62dd5bae7eb4379583fff1b10aa3f89b0b0e`  (326 lines)
- header: Automated sender re-verification (owner handoff "DanceFlow TW-4F - Automated Sender Re-Verification", 2026-10-20; design
- header dependencies: Requires 20261205090000
- created: 0 tables, 2 functions, 0 views, 0 indexes/triggers/constraints
  - new functions: `tw4_sender_reverify_run`, `tw4_sender_health`
- replaced (CREATE OR REPLACE / re-created): `tw4_sender_due_reverify`, `_tw4sr_judge`, `tw4_sender_reverify`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261206090000_twilio_sender_reverification_rollback.sql` sha256 `2932f6b70b4b49a95d77f9a4dca753727349ac5eeff5870ea83b5a5cccc4145d`
  - refusal conditions: "sender-reverification rollback: not applied"; "sender-reverification rollback refused: re-verification evidence exists [55000]"

#### 20261207090000_twilio_r2a_messaging_service_campaign.sql

- sha256 (LF-normalized): `8321fabb802623e766636087681a5b758af0aefa0dc5f76650eabf5aacda8d6b`  (950 lines)
- header: TW-4F R2a: provisioning ledger for the studio's Twilio Messaging Service and A2P campaign (design docs/twilio/TW-4F_R2_Provisioning_Design.md).
- header dependencies: Requires 20261204090000 (sender readiness)
- created: 2 tables (`studio_sms_prov_operations`, `studio_sms_prov_resources`), 15 functions, 0 views, 8 indexes/triggers/constraints
  - new functions: `_tw4prov_guard`, `_tw4prov_use_case`, `_tw4prov_brand`, `_tw4prov_reserve`, `_tw4prov_settle`, `_tw4prov_campaign_requirements`, `tw4_prov_claim`, `tw4_prov_context`, `tw4_prov_begin`, `tw4_prov_finish`, `tw4_prov_observe`, `tw4_prov_resolve`, `tw4_prov_reopen`, `tw4_prov_settle_admin`, `tw4_prov_status`
- replaced (CREATE OR REPLACE / re-created): `tw4_credit_resolve_reservation`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261207090000_twilio_r2a_messaging_service_campaign_rollback.sql` sha256 `5fa293415ce5e3aba4bc9cffa048a3838fc4196f5c4bea10b270bf4f9f0cad25`
  - refusal conditions: "R2a rollback: not applied"; "R2a rollback refused: provisioning evidence exists [55000]"

#### 20261208090000_twilio_r2b_number_activation.sql

- sha256 (LF-normalized): `7551885c236bbe5d41a76fca6c3926ee9ba176ded8bdaf99baf9111e99c93b42`  (2102 lines)
- header: TW-4F R2b: phone-number provisioning and sender activation (design docs/twilio/TW-4F_R2b_Number_Activation_Design.md).
- header dependencies: Requires 20261207090000 (R2a) and its predecessors
- created: 9 tables (`studio_sms_number_offers`, `studio_sms_number_selections`, `studio_sms_num_operations`, `studio_sms_num_resources`, `studio_sms_optout_attestations`, `studio_sms_compliance_checks`, `studio_sms_inbound_route_pins`, `studio_sms_num_inventory_acks`, `studio_sms_num_inventory_checks`), 47 functions, 0 views, 30 indexes/triggers/constraints
  - new functions: `_tw4num_guard`, `_tw4num_account`, `_tw4num_service`, `_tw4num_campaign`, `_tw4num_price`, `_tw4num_taken`, `_tw4sr_ready_core`, `_tw4num_reserve`, `_tw4num_credit_funded`, `_tw4num_requirements`, `tw4_num_offer_record`, `tw4_num_select`, `tw4_num_withdraw`, `tw4_num_claim`, `_tw4num_known`, `tw4_num_context`, `_tw4num_settle_if_held`, `_tw4num_free_selection`, `tw4_num_begin`, `tw4_num_finish`, `tw4_num_observe`, `tw4_num_resolve`, `tw4_num_settle_admin`, `tw4_num_reopen`, `tw4_num_retire`, `tw4_num_record_sender`, `tw4_num_status`, `tw4_act_attest`, `tw4_act_compliance_record`, `tw4_act_verify_sender`, `_tw4act_funding`, `_tw4act_items`, `tw4_act_check`, `_tw4act_lock_funding`, `_tw4act_require`, `tw4_act_mark_ready`, `tw4_act_activate`, `tw4_act_suspend`, `tw4_act_exposure`, `tw4_num_select_as_owner`, `tw4_num_withdraw_as_owner`, `tw4_inbound_route_pin_set`, `tw4_num_inventory_observe`, `tw4_num_inventory_ack`, `_tw4num_rent_basis_core`, `tw4_num_rent_basis`, `tw4_num_registration_facts`
- replaced (CREATE OR REPLACE / re-created): `_tw4sr_ready`
- client-exposed grants (anon/authenticated/PUBLIC): 
  - `GRANT EXECUTE public.tw4_num_select_as_owner(uuid, uuid, text, int), public.tw4_num_withdraw_as_owner(uuid, uuid, text) to authenticated`
- one-off data statements: none at top level
- rollback: `rollback/20261208090000_twilio_r2b_number_activation_rollback.sql` sha256 `a765c4e4d930d7dbb3fa93927c48e587d42332aa3156c2884ec264cf0f46168b`
  - refusal conditions: "R2b rollback: not applied"; "R2b rollback refused: number provisioning evidence exists [55000]"; "R2b rollback refused: number approval references exist [55000]"

#### 20261209090000_twilio_recurring_fee_lifecycle.sql

- sha256 (LF-normalized): `d5f3af102b4ccc23e951c7735213846231748d97f369ffc27edcd25bd4a84c9e`  (1623 lines)
- header: TW-4F recurring provider-fee lifecycle integrity (design docs/twilio/TW-4F_Recurring_Fee_Lifecycle_Design.md).
- header dependencies: Requires 20261205090000 (and its predecessors)
- created: 5 tables (`studio_sms_provider_resources`, `studio_sms_provider_cover`, `studio_sms_provider_exposure`, `studio_sms_provider_cancel_ops`, `studio_sms_provider_alerts`), 33 functions, 0 views, 20 indexes/triggers/constraints
  - new functions: `_tw4rfl_guard`, `_tw4rfl_audit`, `_tw4rfl_lock`, `_tw4rfl_charge_kinds`, `_tw4rfl_due_from`, `_tw4rfl_cover`, `_tw4rfl_retired`, `_tw4rfl_replacement`, `_tw4rfl_live_sender`, `_tw4rfl_gate_suspended`, `_tw4rfl_alert`, `_tw4rfl_df_sending`, `_tw4rfl_oneoff_guard`, `_tw4rfl_auth_guard`, `tw4_rfl_register`, `tw4_rfl_pilot_cover`, `tw4_rfl_scan_entities`, `tw4_rfl_scan_entity`, `tw4_rfl_inventory_gaps`, `tw4_rfl_observe_provider_bill`, `tw4_rfl_exposure_dispose`, `tw4_rfl_suspend_df`, `_tw4rfl_mark_cancelled`, `tw4_rfl_cancel_authorize`, `tw4_rfl_cancel_withdraw`, `tw4_rfl_cancel_begin`, `tw4_rfl_cancel_finish`, `tw4_rfl_cancel_resolve`, `tw4_rfl_studio_ready`, `tw4_rfl_alerts_claim`, `tw4_rfl_alert_finish`, `tw4_rfl_admin_overview`, `sms_rfl_owner_overview`
- replaced (CREATE OR REPLACE / re-created): `_tw4rc_service_state`, `tw4_recurring_charge`
- client-exposed grants (anon/authenticated/PUBLIC): 
  - `GRANT EXECUTE public.sms_rfl_owner_overview(uuid) to authenticated`
- one-off data statements: none at top level
- rollback: `rollback/20261209090000_twilio_recurring_fee_lifecycle_rollback.sql` sha256 `4716984c1773c5edf6f11bd7e7e61fe7bcaed1a0df4297271518bc24b9ddead1`
  - refusal conditions: "recurring-fee-lifecycle rollback: not applied"; "recurring-fee-lifecycle rollback refused: lifecycle evidence exists [55000]"; "recurring-fee-lifecycle rollback: could not remove the cancellation clause from %"

#### 20261210090000_twilio_r2c_owner_provisioning_read.sql

- sha256 (LF-normalized): `a77e7f9762864ea12ba356a2386daf35c854600d224356fa349d24b629e6a918`  (127 lines)
- header: TW-4F R2c-I2: owner-safe, session-bound read of the studio's Messaging Service and campaign provisioning status.
- header dependencies: Requires 20261207090000 (R2a)
- created: 0 tables, 1 functions, 0 views, 0 indexes/triggers/constraints
  - new functions: `get_studio_sms_provisioning`
- client-exposed grants (anon/authenticated/PUBLIC): 
  - `GRANT EXECUTE public.get_studio_sms_provisioning(uuid) to authenticated`
- one-off data statements: none at top level
- rollback: `rollback/20261210090000_twilio_r2c_owner_provisioning_read_rollback.sql` sha256 `98dc89ee2666d4cd2869ea1cc0174c369a6b5052357a6efa9ca4f69f20795690`
  - refusal conditions: none declared (no raise exception mentioning "rollback")

#### 20261211090000_twilio_rfl_ops.sql

- sha256 (LF-normalized): `75e470601359e6bf18eec1141f94fb0af085ebda6bcdfa54b9b97e6241621d7f`  (1313 lines)
- header: TW-4F recurring-fee lifecycle: operational database controls (PR 1 of 3; design docs/twilio/TW-4F_RFL_Ops_Design.md). Dark: nothing here is scheduled, enabled or delivered.
- header dependencies: Requires 20261209090000
- created: 6 tables (`studio_sms_rfl_switch_log`, `studio_sms_rfl_runs`, `studio_sms_rfl_alert_deliveries`, `studio_sms_provider_variance_acks`, `studio_sms_rfl_dual_requests`, `studio_sms_rfl_fact_epochs`), 23 functions, 0 views, 26 indexes/triggers/constraints
  - new functions: `_tw4rflops_guard`, `_tw4rflops_request_insert`, `tw4_rfl_switch_enabled`, `tw4_rfl_set_switch`, `tw4_rfl_scan_begin`, `tw4_rfl_scan_finish`, `tw4_rfl_health`, `tw4_rfl_exposure_report`, `tw4_rfl_variance_report`, `tw4_rfl_variance_ack`, `tw4_rfl_alert_recipients`, `tw4_rfl_alert_delivery_record`, `tw4_rfl_escalate_delivery`, `_tw4rflops_facts`, `_tw4rflops_epoch`, `_tw4rflops_consume`, `tw4_rfl_dual_request`, `tw4_rfl_dual_approve`, `tw4_rfl_dual_reject`, `tw4_rfl_dual_list`, `_tw4rflops_demotion`, `_tw4rflops_lock_parties`, `tw4_rfl_alert_release`
- replaced (CREATE OR REPLACE / re-created): `tw4_rfl_alerts_claim`, `tw4_rfl_scan_entity`, `tw4_rfl_exposure_dispose`, `tw4_rfl_cancel_authorize`, `tw4_rfl_admin_overview`, `_tw4rfl_guard`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261211090000_twilio_rfl_ops_rollback.sql` sha256 `e612b9bb0cf78f8e87c376265648118ec6727e2dd7ebeead8c29142ca1168b48`
  - refusal conditions: "rfl-ops rollback: not applied"; "rfl-ops rollback refused: operational evidence exists [55000]"

#### 20261212090000_twilio_prov_fee_resolution_evidence.sql

- sha256 (LF-normalized): `280adc409572d185bc2a67c0802b30131e16164cdb740116c9d187bd36e99df3`  (840 lines)
- header: TW-4F: evidence-backed resolution of FEE-BEARING provisioning operations (R2a ledger). Closes the gap that a held fee could be released on an administrator's word.
- header dependencies: Requires 20261207 (R2a), 20261208 (R2b ledger table) and 20261209 (recurring-fee lifecycle)
- created: 3 tables (`studio_sms_prov_listings`, `studio_sms_prov_orphans`, `studio_sms_prov_dispositions`), 16 functions, 0 views, 16 indexes/triggers/constraints
  - new functions: `_tw4prov2_guard`, `_tw4prov2_is_pilot`, `_tw4prov2_is_pilot_op`, `_tw4prov2_proof`, `_tw4prov2_orphan_block`, `_tw4prov2_refusal_disposition`, `_tw4prov2_refusal_guard`, `_tw4prov2_reservation_disposition`, `_tw4prov2_orphan_scan`, `_tw4prov2_close_scan`, `tw4_prov_listing_record`, `tw4_prov_orphan_register`, `_tw4prov2_orphan_gone`, `tw4_prov_orphan_close`, `tw4_prov_evidence`, `tw4_prov_evidence_claim`
- replaced (CREATE OR REPLACE / re-created): `tw4_prov_resolve`, `tw4_prov_settle_admin`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261212090000_twilio_prov_fee_resolution_evidence_rollback.sql` sha256 `142048860b0c78516538f4b749d0860239a64b3853130b97040fd6649d69666d`
  - refusal conditions: "fee-resolution evidence rollback: not applied"; "fee-resolution evidence rollback refused: evidence exists [55000]"

#### 20261213090000_twilio_r2b_p1_identity_evidence.sql

- sha256 (LF-normalized): `3cb2f083bd59e6b6d7f48096c8d85119245e944ca2dca754fc29dc370659087b`  (542 lines)
- header: TW-4F R2b-P1: provider-derived number identity (L1) and authoritative post-attempt provider evidence before a fee-bearing purchase is declared not created (L2).
- header dependencies: Requires 20261208090000 (R2b)
- created: 2 tables (`studio_sms_num_identity_reads`, `studio_sms_num_history_reads`), 4 functions, 0 views, 8 indexes/triggers/constraints
  - new functions: `_tw4p1_guard`, `tw4_num_identity_observe`, `tw4_num_history_observe`, `_tw4num_absence_evidence`
- dropped functions: `tw4_num_inventory_ack`
- replaced (CREATE OR REPLACE / re-created): `tw4_num_inventory_ack`, `tw4_num_resolve`, `tw4_num_settle_admin`, `tw4_num_inventory_observe`, `tw4_num_claim`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261213090000_twilio_r2b_p1_identity_evidence_rollback.sql` sha256 `393df0bca1befd50aecf226d0c2b55e3d2dfe8135435d196fd9fb93d58ce118a`
  - refusal conditions: "R2b-P1 rollback: not applied"; "R2b-P1 rollback refused: provider identity evidence exists [55000]"; "R2b-P1 rollback refused: a function it installed has been changed since (fingerprint) [55000]"

#### 20261214090000_twilio_r2b_p2_orphans_reconciliation.sql

- sha256 (LF-normalized): `9978f3a7fa9f99fa5460be98dd59301ed02278fbf14168f0fb8e39c1ab8ecc87`  (706 lines)
- header: TW-4F R2b-P2: orphan numbers, scheduled per-subaccount reconciliation, fail-closed inventory health and send-time safeguards (L3, L4). STACKED ON 20261213090000 (R2b-P1: identity evidence).
- header dependencies: Requires 20261208090000 (R2b) and 20261213090000 (R2b-P1)
- created: 3 tables (`studio_sms_num_orphans`, `studio_sms_num_recon_attempts`, `studio_sms_num_orphan_events`), 14 functions, 0 views, 11 indexes/triggers/constraints
  - new functions: `_tw4p2_guard`, `_tw4p2_event`, `_tw4num_send_blocked`, `tw4_num_orphan_resolve`, `_tw4num_health`, `tw4_num_inventory_status`, `tw4_num_orphan_exposure`, `_tw4num_has_resources`, `tw4_num_recon_manual`, `tw4_num_recon_targets`, `tw4_num_recon_claim`, `_tw4p2_no_recon_ops`, `tw4_num_recon_mark`, `tw4_num_orphan_escalate`
- dropped functions: `tw4_num_inventory_observe`
- replaced (CREATE OR REPLACE / re-created): `_tw4num_known`, `tw4_num_inventory_observe`, `_tw4num_health`, `_tw4sr_ready`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261214090000_twilio_r2b_p2_orphans_reconciliation_rollback.sql` sha256 `de8d74383285941edeca005487aa05a7f81f913d6830fc61baba73b63b5df8d3`
  - refusal conditions: "R2b-P2 rollback: not applied"; "R2b-P2 rollback refused: orphan findings exist [55000]"; "R2b-P2 rollback refused: a function it installed has been changed since (fingerprint) [55000]"

#### 20261215090000_twilio_prov_evidence_targets.sql

- sha256 (LF-normalized): `2a3308aa1b1d4425d1d49263c4b94806b68051be42c6fef963d20f03c58f5277`  (71 lines)
- header: matters, the provider account and the Messaging Service the OPERATION WAS REGISTERED UNDER (its own recorded params), never the studio's current service.
- header dependencies: Requires 20261212090000 (the evidence recorder it serves)
- created: 0 tables, 1 functions, 0 views, 0 indexes/triggers/constraints
  - new functions: `tw4_prov_evidence_targets`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261215090000_twilio_prov_evidence_targets_rollback.sql` sha256 `a0d2430de1ae7cb6ab5090094f387559ce02180cb5a7237a2d362f17298fd42d`
  - refusal conditions: none declared (no raise exception mentioning "rollback")

#### 20261216090000_twilio_prov_orphan_exposure.sql

- sha256 (LF-normalized): `e7f240e2279eaec0b5202b81d48ae76963c6b4417f79ff07ea819224102bf3d8`  (164 lines)
- header dependencies: Requires 20261212090000 (orphans) and 20261211090000 (RFL ops: delivery switch and delivery records)
- created: 0 tables, 2 functions, 0 views, 0 indexes/triggers/constraints
  - new functions: `tw4_prov_orphan_exposure`, `tw4_prov_orphan_alert_status`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261216090000_twilio_prov_orphan_exposure_rollback.sql` sha256 `e56a6d6530e040a14cea7a456600f96364ab5c606c95a044e701ce7651bca98a`
  - refusal conditions: none declared (no raise exception mentioning "rollback")

#### 20261217090000_twilio_r2b_rfl_lifecycle_integration.sql

- sha256 (LF-normalized): `0c832ffe4848c6642288fc994d20c54046bbb4e52165c5221dddbfbd64ac086f`  (643 lines)
- header: TW-4F: R2b / recurring-fee-lifecycle financial integration (dark; Git-only until separately authorized).
- header dependencies: Requires 20261208..20261214
- created: 0 tables, 8 functions, 0 views, 0 indexes/triggers/constraints
  - new functions: `_tw4num_ledger_active`, `_tw4num_ledger_reservation`, `_tw4num_register_owned`, `_tw4num_rent_hold`, `_tw4num_on_number_cancelled`, `tw4_num_registration_retry`, `tw4_num_registration_gaps`, `_tw4rfl_register_core`
- replaced (CREATE OR REPLACE / re-created): `tw4_rfl_register`, `_tw4rfl_mark_cancelled`, `tw4_recurring_charge`, `tw4_num_observe`, `tw4_num_retire`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261217090000_twilio_r2b_rfl_lifecycle_integration_rollback.sql` sha256 `0d1bd3d27e87aaaf2fb16400e9f43e5fd006b54b09ad1587d632b0827ff84471`
  - refusal conditions: "lifecycle-integration rollback precondition failed: the migration is not applied"; "lifecycle-integration rollback precondition failed: a replaced function was changed after this migration (roll back the later migration first)"; "lifecycle-integration rollback failed: public.tw4_recurring_charge(uuid,text,uuid) was not restored byte-exactly"; "lifecycle-integration rollback failed: public._tw4rfl_mark_cancelled(public.studio_sms_provider_resources,uuid,text,uuid,timestamptz) was not restored byte-exactly"; "lifecycle-integration rollback failed: public.tw4_rfl_register(uuid,uuid,text,text,text,text,text,uuid,uuid) was not restored byte-exactly"; "lifecycle-integration rollback failed: public.tw4_num_observe(uuid,text,uuid,jsonb,text,text) was not restored byte-exactly"; "lifecycle-integration rollback failed: public.tw4_num_retire(uuid,uuid,text) was not restored byte-exactly"

#### 20261218090000_twilio_usage_reconciler_readiness.sql

- sha256 (LF-normalized): `c85bfafc7d8b15840fb9da18daff74f02d663681e49f7d51cb92952acf311af5`  (253 lines)
- header: TW-4F F3 (completion tracker F-5, P1): billed texting needs a healthy usage reconciler (dark; Git-only until separately authorized).
- header dependencies: Requires 20261205090000 (and 20261204090000)
- created: 0 tables, 2 functions, 0 views, 1 indexes/triggers/constraints
  - new functions: `_tw4usage_run_proved`, `_tw4usage_reconciler_ready`
- replaced (CREATE OR REPLACE / re-created): `tw4_usage_set_switch`, `tw4_usage_begin`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261218090000_twilio_usage_reconciler_readiness_rollback.sql` sha256 `ef10b282a193662eb21ca8b04d5ad146eff4386e3b4933329be758429f59ce43`
  - refusal conditions: "reconciler-readiness rollback precondition failed: the migration is not applied"; "reconciler-readiness rollback precondition failed: a replaced function was changed after this migration (roll back the later migration first)"; "reconciler-readiness rollback refused: billed texting is switched on (switch it off with tw4_usage_set_switch first)"; "reconciler-readiness rollback refused: another function calls public._tw4usage_reconciler_ready() (roll that migration back first)"; "reconciler-readiness rollback failed: public.tw4_usage_begin(text,uuid,uuid,uuid,text,text,text,text,uuid,uuid) was not restored byte-exactly"; "reconciler-readiness rollback failed: public.tw4_usage_set_switch(boolean,uuid,text) was not restored byte-exactly"

#### 20261219090000_twilio_act_pilot_funding_lock_order.sql

- sha256 (LF-normalized): `f1a7268bad4f6df513c5f3dcfab2d73836d6b60868692cdbc8301143546a8887`  (370 lines)
- header: TW-4F F1: pilot funding continuity and activation lock order (dark; Git-only until separately authorized). Tracker F-1 (P1) and F-10.
- header dependencies: Requires 20261208..20261217 (and 20261218 for any activation to pass)
- created: 0 tables, 1 functions, 0 views, 0 indexes/triggers/constraints
  - new functions: `_tw4act_pilot_funding`
- replaced (CREATE OR REPLACE / re-created): `_tw4act_funding`, `_tw4act_items`, `tw4_act_mark_ready`, `tw4_act_activate`, `tw4_act_suspend`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261219090000_twilio_act_pilot_funding_lock_order_rollback.sql` sha256 `bb3301f53e3453e02644f8a4569b2848b0045f3bc70fc9655fe577129185f25f`
  - refusal conditions: "act-pilot-funding rollback precondition failed: the migration is not applied"; "act-pilot-funding rollback precondition failed: a replaced function was changed after this migration (roll back the later migration first)"; "act-pilot-funding rollback postcondition failed: a restored body differs from 20261208090000"

#### 20261221090000_twilio_admin_recovery_tooling.sql

- sha256 (LF-normalized): `7dfcfcfa718ba297dc956bb56770c0b844cd30f335c72da7eebeb639f0b803c3`  (595 lines)
- header: TW-4F F4: administrative evidence, orphan exposure and operational recovery tooling (dark; Git-only until separately authorized).
- header dependencies: Requires 20261207 .. 20261221 (20261215 optional) (corrected by hand: the generator stops at the first period)
- created: 0 tables, 11 functions, 0 views, 0 indexes/triggers/constraints
  - new functions: `_tw4prov_ledger_reservation`, `_tw4prov_register_verified`, `_tw4f4_retry_target`, `_tw4f4_retry`, `tw4_admin_registration_retry`, `tw4_admin_registration_gaps`, `_tw4f4_sender_status`, `tw4_admin_deferred_retirements`, `tw4_admin_deferred_retire`, `tw4_admin_exposure`, `tw4_admin_prov_proof`
- replaced (CREATE OR REPLACE / re-created): `tw4_num_registration_retry`, `tw4_prov_observe`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261221090000_twilio_admin_recovery_tooling_rollback.sql` sha256 `9d7368ed0e418b098ac41c4b1d394ec81f1a68f85dee5058ab7d4851f479d765`
  - refusal conditions: "recovery-tooling rollback precondition failed: the migration is not applied"; "recovery-tooling rollback precondition failed: a replaced function was changed after this migration (roll back the later migration first)"; "recovery-tooling rollback postcondition failed: a restored body differs from its main definition"; "recovery-tooling rollback postcondition failed: unexpected privileges on a restored function"

#### 20261222090000_twilio_owner_texting_status.sql

- sha256 (LF-normalized): `d4bbc183aae7fc8489abff4ed45a28753039a873dac6bd03f853a909e2a60748`  (250 lines)
- header: TW-4F J2 (tracker O-2, O-4): the studio OWNER's texting status beyond the campaign: number, sender, compliance, the activation checklist and the recurring
- header dependencies: Requires 20261208 (R2b), 20261209 (RFL), 20261212 (campaign orphans), 20261214 (number orphans)
- created: 0 tables, 1 functions, 0 views, 0 indexes/triggers/constraints
  - new functions: `get_studio_sms_texting_status`
- client-exposed grants (anon/authenticated/PUBLIC): 
  - `GRANT EXECUTE public.get_studio_sms_texting_status(uuid) to authenticated`
- one-off data statements: none at top level
- rollback: `rollback/20261222090000_twilio_owner_texting_status_rollback.sql` sha256 `21f4c0e66cb228bef2d3ac055cf57f8684d3febbec5f3a0aec4c6130672c89b7`
  - refusal conditions: none declared (no raise exception mentioning "rollback")

#### 20261223090000_twilio_inventory_reconcile_run.sql

- sha256 (LF-normalized): `f3db1425ba82bfa79363889abaab3bc6b92efc7f71a5eacd277a5f147dc480de`  (88 lines)
- header: TW-4F A9: the scheduled per-subaccount number-inventory reconciliation runs under the shared reconciliation run lease (studio_sms_reconcile_runs, 20261205).
- header dependencies: Requires 20261205090000
- created: 0 tables, 1 functions, 0 views, 0 indexes/triggers/constraints
  - new functions: `tw4_reconcile_run_alive`
- replaced (CREATE OR REPLACE / re-created): `tw4_reconcile_run_begin`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261223090000_twilio_inventory_reconcile_run_rollback.sql` sha256 `4a5a7dabbfe2a701c59aebfaec467a703efa30df6d206cd7980485a11d3d86e0`
  - refusal conditions: "inventory-reconcile-run rollback precondition failed: the migration is not applied"; "inventory-reconcile-run rollback refused: inventory reconciliation runs exist [55000]"; "inventory-reconcile-run rollback precondition failed: a later migration added a job (roll it back first)"; "inventory-reconcile-run rollback precondition failed: tw4_reconcile_run_begin was changed after this migration (roll back the later migration first)"; "inventory-reconcile-run rollback postcondition failed: tw4_reconcile_run_begin differs from its main definition"; "inventory-reconcile-run rollback postcondition failed: unexpected privileges"

#### 20261224090000_twilio_rfl_cancel_target.sql

- sha256 (LF-normalized): `59b03309d0e72441b9f17b83f993ee5a9b630709082a1be25705b10ce3671bee`  (80 lines)
- header: TW-4F F5: ONE new READ-ONLY function for the cancellation runner (src/lib/sms/twilioIsv/cancelRunner.ts). Design: docs/twilio/TW-4F_F5_Release_Adapters.md.
- header dependencies: Requires 20261209090000 and 20261211090000
- created: 0 tables, 1 functions, 0 views, 0 indexes/triggers/constraints
  - new functions: `tw4_rfl_cancel_target`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261224090000_twilio_rfl_cancel_target_rollback.sql` sha256 `8321de6ad70dfd91f30c8c7750604afda08058380c5195caf63c3b55aca0d296`
  - refusal conditions: none declared (no raise exception mentioning "rollback")

#### 20261225090000_twilio_rfl_d5_cover.sql

- sha256 (LF-normalized): `f3c7700ef11879ea51c7c1215e775d41b4a1cbc64bddddf4d7a10af5093f5dfc`  (399 lines)
- header: TW-4F RFL decision D5 (Git-only until separately authorized; dark): a resource's own pilot reservation counts as the REGISTRATION period's cover only while it is
- header dependencies: Requires 20261209..20261217
- created: 0 tables, 0 functions, 0 views, 2 indexes/triggers/constraints
- replaced (CREATE OR REPLACE / re-created): `_tw4rfl_guard`, `_tw4rfl_cover`, `_tw4rfl_register_core`, `tw4_rfl_pilot_cover`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261225090000_twilio_rfl_d5_cover_rollback.sql` sha256 `f6a5288276b413ac5d36d72ffaca6a01a81d446b94d81c55c50457e791bcdd40`
  - refusal conditions: "d5-cover rollback precondition failed: the migration is not applied"; "d5-cover rollback refused: superseded cover evidence exists and is permanent"; "d5-cover rollback precondition failed: a replaced function was changed after this migration (roll back the later migration first)"; "d5-cover rollback failed: public._tw4rfl_guard() was not restored byte-exactly"; "d5-cover rollback failed: public._tw4rfl_cover(public.studio_sms_provider_resources,text) was not restored byte-exactly"; "d5-cover rollback failed: public._tw4rfl_register_core(uuid,uuid,text,text,text,text,text,uuid,uuid,boolean) was not restored byte-exactly"; "d5-cover rollback failed: public.tw4_rfl_pilot_cover(uuid,text,text,uuid) was not restored byte-exactly"

#### 20261226090000_twilio_act_console_gates.sql

- sha256 (LF-normalized): `09588758d7739eebce82405c70d03a93a1e3c0080c93d95e0d749a0e51cc0723`  (226 lines)
- header: TW-4F J4 (activation console), database half (dark; Git-only until separately authorized). Replaces two F1 (20261219) bodies; nothing else.
- header dependencies: Requires 20261219 (bodies fingerprint-checked) and 20261225 (studio_sms_provider_cover.superseded_at)
- created: 0 tables, 0 functions, 0 views, 0 indexes/triggers/constraints
- replaced (CREATE OR REPLACE / re-created): `_tw4act_pilot_funding`, `_tw4act_items`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261226090000_twilio_act_console_gates_rollback.sql` sha256 `8c275fc7ffffa2e2da617c9c6fdebc06ec9734d35757ef176eecc2f0b091f35d`
  - refusal conditions: "act-console-gates rollback precondition failed: the migration is not applied, or a later migration changed a body"; "act-console-gates rollback postcondition failed: a restored body differs from 20261219090000"

#### 20261227090000_twilio_owner_number_offers.sql

- sha256 (LF-normalized): `0c8e77b2a6693f6fce87fa9d432aed954eb0f466696c388f5705efeb01612c03`  (343 lines)
- header: TW-4F J3 (tracker O-3): the studio OWNER's view of the texting numbers DanceFlow offered, the owner's own open approval, and whether approving can lead to a
- header dependencies: Requires 20261208 (R2b); its precondition also requires the 20261222 body of `get_studio_sms_texting_status` (corrected by hand)
- created: 0 tables, 1 functions, 0 views, 0 indexes/triggers/constraints
  - new functions: `get_studio_sms_number_offers`
- replaced (CREATE OR REPLACE / re-created): `get_studio_sms_texting_status`
- client-exposed grants (anon/authenticated/PUBLIC): 
  - `GRANT EXECUTE public.get_studio_sms_number_offers(uuid) to authenticated`
- one-off data statements: none at top level
- rollback: `rollback/20261227090000_twilio_owner_number_offers_rollback.sql` sha256 `20d6210d2038bf48429880a72047e4519f3bbaed446d2884429c60a71695626c`
  - refusal conditions: "rollback precondition failed: get_studio_sms_texting_status is neither the 20261227 nor the 20261222 body"; "rollback postcondition failed: the 20261222 body was not restored exactly"

#### 20261228090000_twilio_ki1_cross_month_release.sql

- sha256 (LF-normalized): `643b6c9e712c7813e68afdb88490a420fc4529f99306e878a94d18cb7d516514`  (204 lines)
- header: TW-4F KI-1: a pilot campaign's first-month reservation made in one business month and approved by the provider in a LATER month is RELEASED on approval,
- header dependencies: Requires 20261207 .. 20261221 (`tw4_prov_observe` as 20261221 left it)
- created: 0 tables, 0 functions, 0 views, 0 indexes/triggers/constraints
- replaced (CREATE OR REPLACE / re-created): `tw4_prov_observe`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261228090000_twilio_ki1_cross_month_release_rollback.sql` sha256 `ad26215a88a8f8b71fd78a2acf5276033d2f59d725ea404d27d0864d35f5a10c`
  - refusal conditions: "KI-1 rollback precondition failed: tw4_prov_observe is not the 20261228 body (not applied, or replaced later: roll that back first)"; "KI-1 rollback refused: a cross-month pilot reservation has been released under this rule [55000]"; "KI-1 rollback postcondition failed: tw4_prov_observe differs from its 20261221 definition"; "KI-1 rollback postcondition failed: unexpected privileges"

#### 20261229090000_twilio_rfl_pilot_evidence.sql

- sha256 (LF-normalized): `c9295ed40d54a6931fde47e75aede01b85fc382672bfbce9172f0fc1f3edd283`  (276 lines)
- header: TW-4F pilot approval evidence (owner decision U-4) and approval-reference length consistency (Git-only until separately authorized; dark).
- header dependencies: Requires 20261209..20261226 (the 20261225 D5 body is fingerprint-checked); drops the four-argument and creates the eleven-argument `tw4_rfl_pilot_cover`
- created: 1 tables (`studio_sms_provider_cover_evidence`), 1 functions, 0 views, 3 indexes/triggers/constraints
  - new functions: `_tw4rfl_evid_guard`
- dropped functions: `tw4_rfl_pilot_cover`
- replaced (CREATE OR REPLACE / re-created): `tw4_rfl_pilot_cover`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261229090000_twilio_rfl_pilot_evidence_rollback.sql` sha256 `3d0fc8bc0364710d8be244033e2d14966f247681079bfa41c8813914dabb6922`
  - refusal conditions: "pilot-evidence rollback precondition failed: the migration is not applied"; "pilot-evidence rollback precondition failed: the four-argument signature already exists"; "pilot-evidence rollback precondition failed: public.tw4_rfl_pilot_cover (eleven arguments) differs from its 20261229 definition; roll back the later migration first"; "pilot-evidence rollback refused: approval evidence exists and is permanent"; "pilot-evidence rollback refused: an approval reference longer than 120 characters exists"; "pilot-evidence rollback precondition failed: the widened approval_ref check is missing"; "pilot-evidence rollback failed: public.tw4_rfl_pilot_cover(uuid,text,text,uuid) was not restored byte-exactly"

#### 20261230090000_twilio_rfl_pilot_spend_evidence.sql

- sha256 (LF-normalized): `e3275cd720bd044029e3caed553e60211a7c20949e84be06dce3049f2a5667e8`  (484 lines)
- header: TW-4F pilot SPEND approval evidence (owner decision U-4, every pilot spend approval; Git-only until separately authorized; dark).
- header dependencies: Requires 20261209..20261229 (predecessor function bodies md5-checked)
- created: 1 tables (`studio_sms_pilot_spend_evidence`), 1 functions, 0 views, 3 indexes/triggers/constraints
  - new functions: `_tw4pse_guard`
- dropped functions: `tw4_spend_authorize`, `tw4_pilot_exception_create`
- replaced (CREATE OR REPLACE / re-created): `tw4_spend_authorize`, `tw4_pilot_exception_create`, `tw4_rfl_pilot_cover`
- client-exposed grants (anon/authenticated/PUBLIC): none
- one-off data statements: none at top level
- rollback: `rollback/20261230090000_twilio_rfl_pilot_spend_evidence_rollback.sql` sha256 `92e691e2bff80de1d1daae01259880ee30f65ea8594f251f45de90af77055d84`
  - refusal conditions: "pilot-spend-evidence rollback precondition failed: the migration is not applied"; "pilot-spend-evidence rollback precondition failed: an old signature already exists"; "pilot-spend-evidence rollback precondition failed: public.tw4_spend_authorize (fourteen arguments) differs from its 20261230 definition; roll back the later migration first"; "pilot-spend-evidence rollback precondition failed: public.tw4_pilot_exception_create (ten arguments) differs from its 20261230 definition; roll back the later migration first"; "pilot-spend-evidence rollback precondition failed: public.tw4_rfl_pilot_cover differs from its 20261230 definition; roll back the later migration first"; "pilot-spend-evidence rollback refused: approval evidence exists and is permanent"; "pilot-spend-evidence rollback failed: public.tw4_spend_authorize was not restored byte-exactly"; "pilot-spend-evidence rollback failed: public.tw4_pilot_exception_create was not restored byte-exactly"; "pilot-spend-evidence rollback failed: public.tw4_rfl_pilot_cover was not restored byte-exactly"

## 7. Read-only probes

Files: `scripts/hosted/tw4f/probe_objects.sql`, `probe_fingerprint.sql`. Each is one `SELECT` statement and carries a header repeating the conditions below.

Conditions for any hosted run:

1. **Read-only and owner-authorized.** A written authorization names the project (DEV or PROD) and the probe. Authorization for one project is not authorization for the other.
2. **Never from the primary checkout.** Create a fresh scratch workdir outside the repository, copy the two `.sql` files in (hash them), link to the authorized project there, run, save the output, delete the workdir.
3. **Verify the project ref first**: DEV `epdrtzcydvnoidwrepqz`, PROD `hvsujyfbftfffxpfmlpb`. The SQL cannot prove which project it ran on; write the ref you verified next to the saved output.
4. One statement per call, wrapped in a read-only transaction where the client allows it (`begin read only; … rollback;`); `00_env.read_only_txn` shows whether it was.
5. Never print env values, keys or tokens. Output is names, counts and md5 prefixes only.

How to read the output:

- `probe_objects.sql` sections: `00_env`, `10_table` (+ `11_table_unlisted`), `20_function` (+ `21_function_unlisted`), `30_trigger`, `40_policy`, `50_dependency`, `60_migration_history`. `MISSING` is the correct answer for objects whose migration has not been applied; `UNEXPECTED` flags objects not created by a migration on main (for example `studio_sms_registrations`, which is TW-3, or objects from `1206`/`1215`/Wave 1 until the expected lists are regenerated with `--sync-probes`). `rows=` are exact only for a role that bypasses RLS (the hosted `postgres` role).
- `probe_fingerprint.sql` rows are `(scope, object, fp)`. Compare `rollup:ALL` first, then per-scope rollups, then objects. `other_sms_functions` is the pre-TW-4 SMS function set, which TW-4 migrations must leave unchanged (the 2026-10 release readiness plan compares it before and after each apply).
- Expected sizes on a database with the whole main chain through `1227` are recorded in section 9 row 8 (measured on the local run). Counts on a partially applied database are smaller by the unapplied layers; derive them from section 6 rather than from a fixed number.

## 8. Runbooks

Every numbered step needs its own explicit authorization from the owner (a step may be batched only if the authorization says so). Stop on the first unexpected result; do not retry a failing apply, diagnose it.

Common setup for every hosted step:

- Fresh scratch workdir outside the repo; nothing run from the primary checkout. Verify the project ref before each session of commands; never print env values.
- Files are exported from Git (`git show <ref>:<path> > file.sql`), hashed, and compared with section 3 before use. Use the same `<ref>` for the whole run and record it.
- Fingerprint = run `probe_fingerprint.sql` and keep the full output (`rollup:*` plus per-object rows). Probe = `probe_objects.sql`.

### 8.1 DEV (`epdrtzcydvnoidwrepqz`)

**D0. Authorization and preparation.** Owner authorizes: project DEV, `<ref>`, the exact list of files, and that nothing else (no flags, no deploy, no cron) changes. Export and hash the files. Confirm no TW-4F deployment on DEV has real-call flags set.

**D1. Preflight probe (read-only).** Run both probes. Record: which of `1119_090 … 1122` exist; every `studio_sms_*` table's row count (expect 0 on all; any row stops the plan and goes to the owner); the baseline `rollup:other_sms_functions`; base dependencies all `PRESENT`; and the migration-history list (informational). Resolve the section 2 conflict here: the first file to apply is the first one whose objects are `MISSING`. A partly applied layer (some objects of a file present) stops the plan.

**D2. Apply, one file at a time.** For each file `F` in section 4 order, starting at the first missing one, with the previous after-fingerprint as this file's before-fingerprint: **HOSTED APPLY-ORDER GATE for `1230`.** Apply `1230` before any pilot exception or pilot approval is created: its forward precondition refuses while any pilot exception exists, or any live evidence-free pilot-funded spend approval (authorized or reserved, and not a `1229` cover that carries cover evidence) exists. No platform-admin pilot action (`tw4_pilot_exception_create`, `tw4_spend_authorize` with pilot funding, `tw4_rfl_pilot_cover`, `tw4_panel_*` approvals) may run during the apply. Hosted DEV and PROD held none at the 2026-10-24 probe, so apply `1229` and `1230` together as the last two files, then create pilot approvals only through the evidence-carrying functions. After the first approval, `1230` can no longer be rolled back (evidence is permanent).

1. Before: run `probe_fingerprint.sql`; confirm it equals the previous step's after (no drift).
2. Apply: `supabase db query --linked -f F.sql` (the file begins and commits its own transaction). Expect a final `COMMIT` and no `precondition failed`.
3. After: run `probe_fingerprint.sql`. Compare to the before: only objects listed for `F` in section 6 changed — new objects appear, replaced functions change body md5, dropped functions disappear — and `rollup:other_sms_functions` is **unchanged**. Anything else stops the run.
4. Save before, after and the SQL output under the step name with the verified ref.

**D3. Reverse-rollback round trip (only while rows are 0).** Applies to the layers applied in D2 only. Layers that were already on DEV before D2 are not rolled back.

1. Confirm every `studio_sms_*` table has 0 rows (probe).
2. Roll back in reverse order, each from its `rollback/…_rollback.sql` (hash-checked), taking the fingerprint after each. After rolling back file `F`, the fingerprint must equal the before-fingerprint recorded for `F` in D2. A refusal (`55000`) means rows or a later layer exist: stop and report; never edit the rollback.
3. Re-apply forward in order and compare the final fingerprint with the first full-chain after-fingerprint: they must be identical.
4. The round trip is not repeated on PROD.

**D4. Grants and RLS probe (read-only).** From `probe_objects.sql` on the final state: every `studio_sms_*` table has RLS on and `api privs` empty for `anon`/`authenticated`/`service_role` (access is through `SECURITY DEFINER` functions); `40_policy` has no rows; every `20_function` row has a pinned `search_path` and `anon:false`; `public:false`; `authenticated:true` for exactly the client-exposed set in section 5 and nowhere else. Role probes as `anon`/`authenticated` against a service-role-only function must get `permission denied`. Never call a REVOKEd function through PostgREST on the local QA image (it segfaults); on hosted, prefer `has_function_privilege` from the probe.

**D5. Flags and switches off (read-only).** Confirm, without printing values, every item of the section 8.5 list: no env var in the list is set to an enabling value on the DEV deployment, every DB switch is off, and no TW-4F cron is registered. Adapters are fakes only, and only on a local database. Record the result.

### 8.2 PROD (`hvsujyfbftfffxpfmlpb`)

Prerequisites, all separately authorized and recorded: DEV D1-D5 complete and clean for the same `<ref>`; the PR set merged by the owner; the candidate build exists on qfem but is **not promoted**; the previous production deployment id is recorded as the app rollback target; the pilot switch for ConfiDance stays OFF.

**P0. Authorization.** Owner names project PROD, `<ref>`, the file list and order, and that the apply is database-only (no promotion in the same step).

**P1. Preflight probe (read-only).** As D1, on PROD. Expect the recorded state (through `20261119092100`, 0 rows) but treat it as unverified. Capture the baseline `rollup:other_sms_functions` and `studio_sms_registrations` facts. Any row in a `studio_sms_*` table, any unexpected object, or a drift from the DEV-verified starting state stops the plan.

**P2. Apply, one file at a time**, exactly as D2 (before-fingerprint, apply, after-fingerprint, compare, save), from the first missing file. Apply with every switch off so every rollback stays available. No reverse round trip on PROD. **HOSTED APPLY-ORDER GATE for `1230`.** Apply `1230` before any pilot exception or pilot approval is created: its forward precondition refuses while any pilot exception exists, or any live evidence-free pilot-funded spend approval (authorized or reserved, and not a `1229` cover that carries cover evidence) exists. No platform-admin pilot action (`tw4_pilot_exception_create`, `tw4_spend_authorize` with pilot funding, `tw4_rfl_pilot_cover`, `tw4_panel_*` approvals) may run during the apply. Hosted DEV and PROD held none at the 2026-10-24 probe, so apply `1229` and `1230` together as the last two files, then create pilot approvals only through the evidence-carrying functions. After the first approval, `1230` can no longer be rolled back (evidence is permanent).

**P3. Postflight (read-only).** As D4 and D5 on PROD, plus all tables still 0 rows. The database is now ahead of the live app: this is safe because every object is additive and dark, and the live (older) app does not call the new objects. Confirm that on the specific files applied before relying on it (replaced bodies: section 6).

**P4. App promotion** is a separate authorization (`vercel promote` of the recorded candidate; rollback = promote the recorded previous deployment). After promotion run the public smoke from `TW-4F_Smoke_Checklist.md`, with all flags off. Observe, then stop. Promotion does not enable any feature.

**P5. Rollback posture.** While all tables hold 0 rows: app first (promote previous), then SQL in reverse order with fingerprints. After the first evidence row exists anywhere: app first only; SQL stays; forward-fix.

### 8.3 ConfiDance pilot gates (tracker section 8, P)

The pilot is not a database event. Each step is separately authorized in writing, and none runs before P1-P4 are complete and clean:

1. PROD SQL then app promotion (8.2).
2. Prices published (decision U-2). No migration seeds prices.
3. Stage B draft handled (U-10).
4. **Per-fee and per-period written approvals (U-4), within the ConfiDance $150 cumulative ceiling.** `1230` extends the evidence rule to every pilot spend approval and to the pilot exception itself (see the `1230` apply-order gate in section 3.0: apply it before the first exception or approval exists). With `1229` each per-period cover is recorded with dated written-authorization evidence (date, role, scope, amount equal to the published price, period, document reference, sha256 of the retained text; the text itself is never stored) via the eleven-argument `tw4_rfl_pilot_cover`; an evidence-free cover no longer counts, and `1229` will not apply while one exists. The ceiling is a non-spendable authorization, not credit; each period needs its own written approval; no standing recurring authorization for the pilot business.
5. Real-provider validation, one call at a time, each authorized.
6. Scheduled jobs registered only after authorization, and only after **healthy reconciliation**: the usage reconciler, inventory reconciliation, sender re-verification, RFL scan and RFL delivery. Until then `vercel.json` has no TW-4F cron and the switches stay off. Activation requires reconciliation to report healthy (F3's `_tw4usage_reconciler_ready()` once `1218` is merged and applied); an unhealthy or unverified reconciler blocks activation.
7. Alert recipients verified and the delivery runbook (`TW-4F_RFL_Delivery_Runbook.md` section 7) executed; **delivery switches stay off** until then.
8. Manual activation (decision D8). **With `1226` (J4) applied, pilot activation is blocked by design** (`pilot_ki1_redecided` fails closed) until the owner re-decides pilot-ceiling issue KI-1 and a later migration lifts the item; do not plan a pilot activation on a hosted database that has `1226` before then.
9. First real SMS to a consented test recipient.

### 8.4 General production gates (tracker section 8, L)

Pilot retrospective; decisions on U-3, U-5, U-7 and U-9; funding-exposure monitoring live; real cancellation validated; per-studio gating for self-service onboarding. Schedulers and delivery switches remain off for every studio until the owner authorizes them for that studio.

### 8.5 Activation reads, and what must stay off on hosted DEV

Activation (`tw4_act_*`) needs provider evidence about the campaign and the Messaging Service route. Since A9b (#300) those compliance reads are gated by **`TW4_NUMBER_READS`**, the same read-only gate the scheduled inventory reconciliation route uses; they no longer need `TW4_NUMBER_REAL_CALLS`. In production the read adapter exists only when `TW4_ISV_REAL_CALLS=on` **and** `TW4_NUMBER_READS=on` and the configuration is complete; it makes GET requests only. It is deliberately independent of `TW4_PROVISIONING_REAL_CALLS` and of the purchase switch `TW4_NUMBER_REAL_CALLS`: activation never needs the purchase switch.

`TW4_NUMBER_READS` still means real Twilio GETs, so it needs its own owner authorization and stays **off on hosted DEV**. Separately, with `1226` applied, pilot activation is blocked by the KI-1 checklist item (section 8.3) regardless of any flag.

**Must stay off (unset or not `on`) on hosted DEV:**

- Env flags: `SMS_CREDIT_PURCHASES`, `SMS_MONTHLY_LIMITS`, `SMS_RECURRING_AUTHORIZATION`, `SMS_RECURRING_SCHEDULER`, `SMS_USAGE_BILLING`, `SMS_USAGE_RECONCILER`, `SMS_INBOUND_RECORDING`, `SMS_FEE_LIFECYCLE_SCAN`, `SMS_FEE_LIFECYCLE_DELIVERY`, `SMS_USAGE_EVIDENCE_READS`, `SMS_SENDER_VERIFY_READS`, `SMS_BILLED_REAL_SEND`, `SMS_SENDER_REVERIFY`, `SMS_INVENTORY_RECONCILE` (the inventory route answers 404 unless it is `on`), `TW4_ISV_REAL_CALLS`, `TW4_PROVISIONING_REAL_CALLS`, `TW4_NUMBER_REAL_CALLS`, `TW4_NUMBER_READS`, `TW4_CANCEL_RELEASE` (irreversible provider release), `TW4_SUBACCOUNT_WEBHOOKS`.
- Fake and mock flags: `TW4_ISV_FAKE` and `TW4_ISV_MOCK_BRAND` are for local databases only; never set them on a hosted project.
- Code constant: `FEE_RELEASE_ENABLED=false`.
- DB switches (no row means OFF; verify with the switch-log row counts and the switch-reading functions' answers): `tw4_recurring_set_switch` (`studio_sms_recurring_switch_log`), `tw4_usage_set_switch` (`studio_sms_usage_switch_log`), `tw4_rfl_set_switch('scan')` and `('delivery')` (`studio_sms_rfl_switch_log`). No runner window open (`tw4_runner_set_window`), no studio pilot access enabled (`set_sms_onboarding_access`) except as separately authorized, no sender activated (`tw4_act_activate` never run), credit hold untouched, monthly limits at their default $0, pilot ceiling unspent.
- Crons: `vercel.json` registers only `/api/cron/sms-onboarding-purge` among the SMS routes; the recurring, usage-reconcile, fee-lifecycle, sender-reverify and inventory-reconcile routes stay unscheduled.

If any item is found on, stop and report; do not turn it off as a side effect of a probe (probes are read-only).

## 9. QA record for this package (developer-owned QA)

Environments: **L1** = `postgres:17` (17.9) container `tw4f-h1-probe-pg`, started by this session, vanilla Postgres with synthetic roles and fixture. **L2** = container `tw4f-h1-realschema`, started by this session from the local image `df-isoqa/base:20261205090000` (a private copy; the shared stacks were not used), schema through `1205`, with `1207`-`1214`, `1216`, `1217` applied from main by `psql -v ON_ERROR_STOP=1`. **Git** = repository blobs. **Hosted** = DEV/PROD (not touched).

| # | Workflow | Env | Execution | Expected | Observed | Result |
|---|---|---|---|---|---|---|
| 1 | Every migration on main in `20261119090000..20261230090000` appears exactly once | Git | `verify_manifest_hashes.sh 67bb64f2` | 46 files, no duplicate, none missing | 46 forward files on main `67bb64f2`, 46 manifest rows, no duplicate, none missing: `MANIFEST HASHES OK` | PASS |
| 2 | sha256 in section 3 equals `git show` (forward and rollback) | Git | same script | all match | 46 forward and 46 rollback sha256 values recomputed from `git show 67bb64f2:<path>` (CR stripped) equal the table | PASS |
| 3 | Probes run without error on an empty database | L1 | `validate_local.sh` | every expected object `MISSING`, no error | rollup:ALL `(0 objects)`, objects probe 474 rows, no error | PASS |
| 4 | Probes see objects, RLS, ACLs, row counts, triggers, unlisted objects | L1 | `validate_local.sh` fixture assertions | facts match the fixture | all assertions matched | PASS |
| 5 | Probes do not write | L1 | read-only wrapper; catalog/data digest before vs after; negative control write refused | digest equal; write refused | equal; write refused | PASS |
| 6 | CRLF-stored function body fingerprints like its LF twin | L1 | fixture function with CR in `prosrc` | same md5 | equal; flagged `(CR in stored body)` | PASS |
| 7 | Fingerprint is deterministic | L1 | two runs, `cmp` | identical | identical | PASS |
| 8 | Probes run on the real TW-4 schema, read-only | L2 | both probes inside `begin read only` | no error; all tables 0 rows | both probes returned rc 0 inside `begin read only` (`read_only_txn = on`) on the isolated QA base image with `1206`..`1230` applied (all 46 migrations present); 75 studio_sms-type tables PRESENT, all `rows=0`; fingerprint rollup:ALL `5c8ef234` over 1218 objects (410 tw4 + 9 other-SMS function signatures) | PASS |
| 9 | Expected-object lists match a database with the main chain applied | L2 | `probe_objects.sql` `MISSING` count | 0 `MISSING` for objects still defined at the end of the chain | 0 MISSING; 1 UNEXPECTED (`studio_sms_registrations`, the TW-3 table); the functions executable by `authenticated` are exactly the 23 in section 5 (`1228`, `1229` and `1230` add none); 0 executable by `anon` or PUBLIC; 0 unpinned `search_path`; every studio_sms table (including the two evidence tables) shows no API-role privilege | PASS |
| 10 | Probes against DEV | Hosted | executed 2026-10-24 by the owner-authorized probe session (#303), not by this slice | probe runs read-only | results recorded in section 2; not re-executed here | PASS (as recorded in section 2) |
| 11 | Probes against PROD | Hosted | executed 2026-10-24 by the owner-authorized probe session (#303), not by this slice | probe runs read-only | results recorded in section 2; not re-executed here | PASS (as recorded in section 2) |
| 12 | DEV apply, reverse-rollback round trip, grants/RLS probe | Hosted | not executed | n/a | not executed: owner authorization required (section 8) | BLOCKED |
| 13 | Rollback round trip with real files | L2 | not executed by this package | n/a | not executed (owner of the rollback suites is Q1/F-slices); the runbook specifies it for DEV only | BLOCKED |
| 14 | Hashes of the Wave 1 and follow-up migrations (`1206`, `1215`, `1218`, `1219`, `1221`..`1230`) | Git | `git show` from main | rows hashed from main after each merge | all merged and hashed from main; each equals its last PR-head hash except `1206` and `1221`, whose forward files changed before merge (section 3.0) | PASS (Git only) |

Limits of this QA: the hash verifier's failure path (a deliberately corrupted hash) was not exercised, so a PASS in rows 1-2 shows agreement, not that the script detects every kind of drift; and L1 and L2 are local Postgres 17 containers, not Supabase-hosted databases (no managed-role differences, no PostgREST, no hosted-only extensions). The measured fingerprints in L2 are for a database built from the isolated QA base image, so they are not comparable with DEV/PROD fingerprints.

## 10. Open items

- Run D1/P1 when authorized and replace section 2 with observed state; settle the Onboarding Plan section 9a conflict.
- `1220` (F2) is not started and has no row. Every other migration in the chain is merged; none is applied to any hosted database.
- `sms_webhook_receipts` and `sms_inbound_reply_counters` are defined without the `studio_sms_` prefix; the probes list them by name, so a future rename needs `--sync-probes`.
- The recorded 2026-10-19 Phase A fingerprint (`7d4442fa`) has no reproducible query; take a fresh baseline.
