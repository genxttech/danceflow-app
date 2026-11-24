# Guarded-baseline results (OD-31): APPENDED to the retrospective audit

**This file only appends.** The original rows of the retrospective audit inventories (W-01 … W-13, S-15, O-02, O-13, X-11 and the rest, as classified
before OD-31) are **not edited and are not restated here as re-tested**: they were produced against a tree that did **not** contain U18 / U18-S, and nothing below claims otherwise.
Where this file gives a result, it names the baseline it applies to, the evidence label, and the artifact.

Baseline for this file: **partial guarded baseline** = live line `release/website-embeds` `49dbaee1b` + JC1/U18/U18-S migrations from `92a8c17c6` (Competition database identical to the candidate branch, see README section 2).
It is **not** the integrated release candidate (README section 4). Final sign-off: **BLOCKED**.
Labels: **[EXEC]** executed test or hosted read-only query; **[INSP]** inspection only; **[PENDING]** a local run is queued (see "Executed local test results").

## A. Classification (OD-31 item 9)

| Gate | Object | Rulebook basis | Release class |
|---|---|---|---|
| U18 | migration `20270215093000`, trigger `cf1_u18_guard_heat_entry_status` | **NOT SPECIFIED IN PROVIDED SOURCE** (DanceFlow integrity guard) | **MANDATORY release gate for Studio/Custom**, independent of governing-body profile readiness |
| U18-S | migration `20270215094000`, trigger `cf1_u18s_guard_heat_entry_scratch` | **NOT SPECIFIED IN PROVIDED SOURCE** (DanceFlow integrity guard) | **MANDATORY release gate for Studio/Custom**, independent of governing-body profile readiness |
| JC1 | migration `20270215092000` (`_compe2_is_absent`) | not a body rule (DanceFlow judging policy, as recorded) | already applied to PROD; keep on the same path |

Their absence from a baseline blocks Studio/Custom activation regardless of which body profiles are ready. Status of the gates on hosted databases: present on DEV and PROD (README section 3, [EXEC]); **not in the Git line that ships the app** (README section 2).

## B. Every writer and reader of `danced` / `disqualified` / `scratched`

Method: `git grep` over all migrations on `origin/release/competition-cf1-app-candidate` and all non-test app source on `origin/release/website-embeds`, plus the hosted catalog (query q3, 48 functions on each environment touching these statuses or the table, the same set apart from the md5/presence drift noted in the README) [INSP + EXEC read-only].

**Heat entry `status = 'danced'`:** writers: **none**. No migration function or app path sets it; only the table CHECK permits it and the U18 comment documents it. After U18, a client role can never set it; only the table owner (`postgres` / `supabase_admin`) can, by hand. Readers: `_hl1_heat_is_danced` (HL1 ballot locking and heat reopen guard), `_a5_cf1_entry_danced` (A5 exclusion window), NS1 `mark_competition_heat_no_show` (refuses), `_r2_entry_participation_class` / `_r2_apply_participation` / R2 cascade (class `locked`), `_cf1_error_codes`, `_compe2_round_blockers`, `_compe2_validate_callback`, `_hl1_guard_heat_reopen`.

**Heat entry `status = 'disqualified'`:** writers: **none** (same as above). This corrects inventory row W-05's wording "written only by owner-role functions": **no function writes it**; only a manual owner-role write can. Readers: the same set plus `sync_competition_entries_from_registration` (definer; mentions disqualified in its entry-status filter), `_r2_withdraw_entry`, `_r2_record_*`.

**Heat entry `status = 'scratched'`:** writers (all SECURITY DEFINER or the INVOKER lifecycle RPC): `change_competition_entry_lifecycle` (INVOKER, sets the workflow GUCs; U18-S allows it), `_r2_withdraw_entry` and the R2 cascade (definer, owner), A6 `apply`/reinstate (definer, `20270120095000` lines 577 and 595), `sync_competition_entries_from_registration` (definer). Any other writer is a direct table write by a client, which U18-S now refuses.
Readers: results engines (`_compe2_heat_entries`, `_compe2_round_entries` use `status <> 'scratched'`), A5, NS1, A6, R2, F2 `_compf2_no_show_entries`.

**Parent entry `event_competition_entries.status = 'disqualified'`:** writers: **no function and no app code**; the table CHECK allows it and the `competition_manage` policy plus the client UPDATE grant allow a direct write (finding F1). Readers: generation/registration sync filters (`status not in ('withdrawn','disqualified','complete')`), R2 (`withdraw_entry` outcome `not_applicable`, exception recording excluded), the public registration status label "Not eligible" (`register/status/page.tsx`), `competitionRefundSummary.ts` (`active` flag). **Not read by the results engines**: ballot/results sets come from heat entries.

## C. Re-run of the affected audit findings against the partial guarded baseline

| Audit row / topic | Result on the partial guarded baseline | Label |
|---|---|---|
| W-12 guards absent | **Resolved as an evidence statement**: both guards exist on DEV and PROD catalogs (md5 and postflights match the 2026-11-19 pins); still absent from the shipping Git line. Governed by OD-31: mandatory gates. | [EXEC] hosted reads |
| W-11 direct heat-entry scratch without audit | Direct client/service-role scratch refused (`COMP_U18S_SCRATCH_UNAUDITED`), un-scratch refused (`COMP_U18S_UNSCRATCH_WRITER`); the audited RPC still scratches with one audit row. **Remaining:** no in-app workflow (SC1 unmerged, `scratchHref` page absent); F3 (GUC marker, SQL-session only). | shipped suites + OD31 suite **[PENDING]**; design [INSP] |
| W-05 `disqualified` / OD-20 item 4 | Heat-entry `disqualified` is unreachable by any client role (refused by U18 for anon/authenticated/service_role; no function writes it). **Not satisfied at the parent-entry level:** F1. | heat entry: shipped suite **[PENDING]**; F1 [INSP] (+ OD31 suite C1 **[PENDING]**) |
| W-01 exclusion (A5) | A5 writes the exclusion tables, not heat-entry status; reads danced evidence via `_a5_cf1_entry_danced` → `_hl1_heat_is_danced`, whose inputs a client can no longer forge. No behaviour change from the guards. | [INSP]; A5 suite **[PENDING]** |
| W-03 no-show (NS1) | `mark_competition_heat_no_show` refuses scratched/danced/disqualified entries (NS1 line 272); the guards only remove the client route to those states. | [INSP]; NS1 suite **[PENDING]** |
| W-04 / W-10 advancement, withdrawal (A4/A6) | A6 writes `scratched` as definer (owner role, exempt); `cf1_guard_withdrawn_heat_entry` still BEFORE-guards the pair. Guards add no refusal to A6. | [INSP]; A6 suite **[PENDING]** |
| HL1 ballot locking | `_hl1_heat_is_danced` can no longer be satisfied by a client writing `danced`/`disqualified` (the U18 problem statement). | shipped U18 suite **[PENDING]**; [INSP] |
| R2 refunds | R2 treats `danced`/`disqualified` heat entries as locked; a client can no longer set or clear them. **F1 remains:** parent-entry `disqualified` by direct write makes R2 mark the entry `not_applicable` for withdraw and omits it from locked-entry exception recording. | [INSP]; R2 suites **[PENDING]** |
| S-15 scratched/no-show excluded from calculation | Unchanged; scratch is now only reachable through the audited path (plus F3 caveat). | [INSP] |
| O-02, O-13, X-11 | Unaffected by the guards (authority/override/minimum-participation logic; no heat-entry status writes). Listed only because they were requested. | [INSP] |
| Evidence integrity | `event_competition_entry_changes` is written only by the definer audit trigger; U18-S depends on it. Heat-entry history protection triggers (final/withdrawn/OD-17/10D) untouched. | [INSP] |

## D. Findings on the guarded baseline (new; original rows untouched)

| ID | Severity | Finding | Reach | Evidence |
|---|---|---|---|---|
| **F1** | P2 (OD-20 item 4) | **A manager can set `event_competition_entries.status = 'disqualified'` by direct table write.** U18/U18-S guard heat entries only. The only control is the audit trigger (`status_change`, reason optional). It does not change scoring (results use heat entries) but changes **refund handling (R2)**, heat generation/registration-sync filters and the participant-visible label "Not eligible" without a reviewed workflow, so `disqualified` *can* be presented as a disciplinary outcome and is reachable by an unintended bypass. The same table accepts direct writes of `scratched`/`withdrawn` (audited, no heat-entry or fee handling). | PostgREST table write as a studio manager (policy `competition_manage`, UPDATE grant) | policies/grants [EXEC q4 DEV+PROD]; code [INSP]; behaviour **[PENDING]** OD31 suite C1 |
| **F2** | P3 | `authenticated` still holds `TRIGGER` on `event_competition_entries` (U18 revoked it on `event_competition_heat_entries` only). Not exploitable through PostgREST (no DDL), but it is the privilege U18 removes elsewhere because it allows a client-created trigger that rewrites a status. | SQL session only | [EXEC q4 DEV+PROD]; OD31 suite C2 **[PENDING]** |
| **F3** | P3 | The U18-S workflow marker is a plain custom GUC (`app.competition_entry_change_type`). In a session that can run arbitrary SQL a manager can audited-scratch the parent entry directly, set the GUC and scratch the heat entry without the RPC. The audit row still exists (parent write), but not the RPC's reason/fee handling. Not reachable through PostgREST (`set_config` is in `pg_catalog`, not an exposed schema). | SQL session only | [INSP]; OD31 suite C3 **[PENDING]** |
| **F4** | info | Accepted residuals recorded by the owner 2026-11-13 stay: draft-schedule DELETE/re-INSERT of heat entries; `TRUNCATE` granted to clients (no row triggers; not exposed by PostgREST); COPY/MERGE/pg_dump not verified in tooling. | | PR 492 README; OD31 suite C4 **[PENDING]** |
| **F5** | info | Git/DB drift: the three Competition guard migrations are applied on DEV and PROD but absent from the shipping Git line; DEV has a stale history table (1 row), PROD has none. | | README sections 2-3 [EXEC] |
| **F6** | info | `service_role` is **not** exempt from U18/U18-S (the allowlist is `postgres`/`supabase_admin` by `current_user`), so server code using the service key cannot write these statuses either; the only legitimate writers are SECURITY DEFINER owner functions. Any future SC1/OD code path must call the lifecycle RPC as the manager, not write the table. | | [INSP]; OD31 suite A2 **[PENDING]** |

| **F7** | P3 | Found by the independent reviewer: the guards watch the `status` column only. A client can still DELETE a `danced`/`disqualified`/`scratched` heat entry, or change `heat_id`/`entry_id`/`floor_order` with status unchanged; protection is only the other triggers (published schedule version, locked/certified heats, A6/Final guards). `_comp10d_version_editable` returns true for a null version. Known residual for `danced`; not previously recorded for `scratched` (deleting a scratched row changes the ranking set). | `authenticated` / `service_role` via PostgREST DELETE/PATCH | [INSP] by reviewer; OD31 suite C5 **[PENDING]** |
| **F8** | info | Reviewer: `20261111090000_phase10d_heats_floor_schedule.sql` ~line 362 still says check-in, scratch and danced status updates stay allowed on published heats; stale for scratch/danced on the table-write path (comment only). | | [INSP] |
| **F9** | info (closed) | Reviewer asked for proof the real definer writers are owned by an exempt role (suites only use `pg_temp` stand-ins). Hosted q3 shows `_r2_withdraw_entry`, `sync_competition_entries_from_registration`, `cosign_final_withdrawal_request`, `apply_competition_round_advancement` and the other 44 listed functions are owned by `postgres` on DEV and PROD. | | [EXEC] q3 |

None of F1-F3 is a regression from the guards. F1 is the open item against OD-20(4); the proposed correction (owner decision, not implemented here, no SQL authorized): a parent-entry status guard analogous to U18 for `disqualified` (and scratch/withdraw routed through the lifecycle RPC), or an explicit documented acceptance.

## D3. Owner decisions made since the investigation started (recorded 2026-11-24)

* **OD-20 (2026-11-23):** organizer exclusion only; item 4 requires that existing `disqualified` handling cannot be misrepresented as a disciplinary action or reached through an unintended bypass. Status on this baseline: heat-entry `disqualified` is client-unreachable (U18; no function writes it); **parent-entry `disqualified` is reachable by a manager direct write (F1): item 4 is NOT yet satisfied.** Wording work is the stacked draft #853 on #848 (OD-19); it must not change exclusion, withdrawal, no-show, scoring or placement behaviour.
* **R-08 (ratified 2026-11-23, DanceFlow policy):** Scratch, No-show, Excluded and Disqualified stay distinct statuses; scratched/no-show entries are excluded from calculation and not automatically placed last; ballots naming an entry later scratched or marked no-show are stale and must be corrected before lock; the exact scope across multi-dance events (per heat, dance, round or entry) is to be verified; coordinated with OD-20 and OD-31 including U18/U18-S; negative regression tests requested (scratched entry still on ballots, stale ballots after no-show, unauthorized status changes, Multi-Dance with one missed dance). **Status here:** policy ratified; implementation verification open. This baseline covers unauthorized status changes (OD31 suite A/B, U18/U18-S suites) and, once the queued run completes, the NS1/F2/E2 regression suites for stale ballots; **Multi-Dance semantics are NOT verified here** and stay open.
* **PR chain:** #835 (OD-02) targets the live line; #837 (OD-03) is stacked on #835; #846 (OD-18) is stacked on #837. None is merged; the integrated candidate must carry the whole chain (README section 4).

## D2. Independent review (2026-11-24)

A reviewer subagent that had not seen these conclusions was given the candidate ref, the two guard migrations, the catalog facts and the question set, and read the code (no database access). Result: **no P1**; it independently found F1 (P2), TRUNCATE/grants, the GUC marker caveat, and raised F7 (DELETE/non-status changes), F8 and the owner-role check (F9, closed by hosted q3). It listed missing negative cases (anon, upsert, insert disqualified, service_role insert, entry-level disqualified, DELETE, marker-for-entry-A vs B, real definer writers under the guard, lifecycle RPC on an entry scratched earlier with a non-scratch audit type); the OD31 suite adds the first six and the upsert/delete characterization. **Not added** (need SC1/real writers or a heavier fixture, listed as open): marker-for-A-vs-B, real R2/A6/sync writers under the guard (covered by the R2 and A6 regression suites in the run), lifecycle RPC after an earlier non-scratch audit row. Reviewer statements were verified by reading; none was executed.

## E. Tests added (docs-only PR, local-only, no new SQL objects)

`test_T_od31_guarded_baseline_negative.sql` (same directory): sections A refusals, B legitimate operations preserved, C characterization of F1-F4. It reuses the U18 suite's fixture shape under a distinct UUID block (`…cf1031…`), creates only TEMP objects and rolls back. Existing shipped suites (`test_T_competition_u18_*`, `u18s_*`, `jc1_*`) are unchanged.

## F. Executed local test results

**[PENDING]**: the local database run is queued behind other sessions' heavy jobs under `C:\dfr\HEAVY_LOCK_RULES.md` rules 7-8 (this session's ticket `20261124T020036-comp-od31.txt`). Until the run completes, **no row in section C is marked executed except the hosted read-only catalog checks**, and the results below are not claimed.

| Item | Value |
|---|---|
| Runner | `run-guarded-baseline.sh` (this directory) |
| Image / id | `cf1host:found` / _filled from the run_ |
| Composed migration set fingerprint | _filled from the run_ |
| Suites and counts | _filled from the run_ |
