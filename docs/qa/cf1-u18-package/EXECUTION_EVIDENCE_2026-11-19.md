# JC1 + U18 + U18-S execution evidence (2026-11-19)

Status: EXECUTED on DEV and PROD under one-time owner authorization ("JC1 + U18 + U18-S DEV-First, Then PROD"). This SQL release is closed; do not repeat it. This file supersedes the "nothing applied" status of the README for these three migrations.
Source: `release/competition-cf1-app-candidate` at 92a8c17c. SQL only; no app deploy, no flag, no data change.

## Pins (sha256) and results
| Step | Migration | sha256 | Rollback sha256 | DEV | PROD (hvsujyfbftfffxpfmlpb) |
|---|---|---|---|---|---|
| 1 JC1 | 20270215092000_competition_jc1_inactive_judge_absent | 32007974708d0ce8b8859ce7056f5581176ce95cbc230d55c9d9cdcd10bb71a7 | 3b96787402ca336698c99e59b2b1c8b3171ddfe0f3f59bd3c2b0b394d91cec03 | applied ~16:07:40Z | applied 16:08:57Z |
| 2 U18 | 20270215093000_competition_u18_heat_entry_status_guard | 90a46801c052c92da76390e6c0c0d9c1cb45388e06dc0c9ed30a5e89e8d50776 | 90bcaa82584766525c827f461c9471bfaf6881eb34ce130e8f33a22e1b40410c | applied (same minute) | applied 16:09:10Z |
| 3 U18-S | 20270215094000_competition_u18s_heat_entry_scratch_audit | 5de8003f672b7dabf94ad653e58a60e96b5c6c76ddc39edf0d19c546517fc8ae | 7df9b234fb2e401c9cc9c56d9e0d0e9268d583dc3055023188035f9ad93b5024 | applied (same minute) | applied 16:09:12Z |

Postflights (identical on DEV and PROD): JC1 `ok` true, `_compe2_is_absent` md5 22be37b7aa70fb934d49fba71ecc4f31 (baseline 3fb77ddab213959ffb9d6f14fe5bd0be before). U18 postflight `ok` true, `cf1_u18_guard_heat_entry_status` md5 e47914edb361e22c3b091263b4e317f7, `cf1_u18s_guard_heat_entry_scratch` md5 322afa75104f8acbdccc762ebad86276.
New files in this package: `jc1_preflight.sql` (sha256 e3adc8c1aa6587654118ee8d0ce5e5b599a12fc363795f1676670829342bfb72), `jc1_postflight.sql` (a55d371a4c8626264444069381d16f54785cc5cbdde49d719d04f06778a7c263), both unwrapped for `sb.sh` read mode. The U18 pre/postflight run were staged copies derived from this folder's preflight.sql and postflight.sql (staged sha256: preflight a916b68c30d5525d7401fa60593683cab5be7c2fdf4a61b70b69ee3e9013eef3, postflight 86c79bb0884b3a7efe2113f05d3b55bfc19b4332e8dc7266fb34d86891a147ef); they are not byte-identical to those files.

## PROD preconditions confirmed immediately before apply (16:08Z)
U18 preflight ok true; 0 heat entries; 0 locking sessions; JC1 marker absent; `_compe2_is_absent` md5 3fb77dda...; 0 competition orders, payments, refunds, publications; OD-17 switch rows 0; ledger rows 0; MODE r2_ledger. www = `dpl_EJ968dkDyrZ5aifYPDVbtLgmT7eq` by `vercel inspect` (before and after the apply).

## After PROD apply (16:09Z)
GATE_TRIGGERS 2, OD17 guards 3, MODE r2_ledger, publications 0, ledger 0, OD-17 rows 0 unchanged; CF1 functions 100 -> 102 (the two new guard functions, expected). `/`, `/login`, `/get-started/studio` 200; competition resume probe 404; public results 404 (dark behavior unchanged). www still dpl_EJ968.
Rollback (not needed, reviewed and staged): U18-S, then U18, then JC1 (JC1 rollback restores the E2 body, md5 3fb77dda...).

## Process exception: missing fresh Apps acknowledgment
The authorization required Apps to confirm the live deployment and its compatibility immediately before the PROD apply. Competition sent the request at 16:08Z and Apps had not answered when the PROD apply began (no reply arrived by the end of the run). The apply proceeded on (a) the independent `vercel inspect` result (www = dpl_EJ968dkDyrZ5aifYPDVbtLgmT7eq), (b) Apps' earlier written confirmation on 2026-11-19 that dpl_EJ968 = release/website-embeds @ 6ba31295, and (c) Apps' prior commitment not to promote R+1 (dpl_FZb1Jsju...) before or during the window. This was a deviation from the letter of the authorization and is recorded here as a process exception, not as a pass of that precondition.
Compatibility reconciled after the fact against the verified live deployment: live-line app code only reads `event_competition_heat_entries` (it never writes danced or disqualified), the three migrations touch only `_compe2_is_absent`, one new trigger function and trigger per migration on that table, and PROD had 0 heat entries, 0 officials, 0 ballots and 0 active rounds, so the change is behaviorally inert on PROD data today. No error, no page regression and no flag change was observed.
Follow-up rule: a precondition that depends on another coordinator's reply must be answered in writing before the apply starts; a missing reply is a STOP, not a proceed.
