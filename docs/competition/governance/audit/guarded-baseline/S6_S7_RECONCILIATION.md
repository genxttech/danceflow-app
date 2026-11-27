# S6 / S7: reconciliation of finding F1 with the hosted guard state, and the shipping-path verification

Owner tasks of 2026-11-24, **investigation and design only**: no correction is authorized, no migration file is created, nothing is merged, cherry-picked or applied. Labels as in the README: **[EXEC]** executed (local database run or hosted read-only query), **[INSP]** inspection, **[REC]** repository record or engineering note not re-verified here.
This file is appended to the OD-31 directory; it changes none of the earlier rows. Section numbers of earlier files are unchanged.

## S6(a). What was tested, exactly

| Item | Value |
|---|---|
| Source | live line `release/website-embeds` `49dbaee1b4183aa70c5782a72425e392d65b2e7b` (all Competition migrations) + JC1 / U18 / U18-S files from `release/competition-cf1-app-candidate` `92a8c17c6d0ee43540858402a647485c50476549` (blob-identical to the candidate, see S7) |
| Database | disposable container, image `cf1host:found` id `sha256:a9ff85eb573976875d23c01be6114e7ed57a99764b345f024f1c80b5a343afd3`, PostgreSQL 17.6, no network |
| Migrations | 37 Competition files composed, fingerprint `d87e42858e6ca50ffef5779fe6d203bfa62992616d5ed8c694a75b397c52ba5d`; **23 applied in version order, 0 failed** (R2, R2 gate, CF1 A1..F3, desk gate, check-in balance, PV1, OJ1, JC1, U18, U18-S); the rest of the foundation is in the image |
| Connection role | `supabase_admin` (real superuser). **Caller roles are simulated with `SET LOCAL ROLE`** (`anon`, `authenticated` with a manager JWT claim, `service_role`, and a probe role that is a member of `authenticated`). This reproduces the table privileges, RLS policy and trigger behaviour PostgREST relies on, but **no PostgREST/HTTP request was made**; the candidate's own QA addendum keeps "U18 and U28 (browser/PostgREST)" open and that is still true. |
| Evidence | `evidence/s6-negative-suite-run.log`, `evidence/s6-catalog-local.json`; hosted `evidence/s6-catalog-dev.json`, `s6-catalog-prod.json` (query `queries/q7_guard_catalog_both_tables.sql`) |

### Trigger, function and grant coverage on the two tables (local vs hosted DEV vs hosted PROD) [EXEC]

DEV and PROD catalogs for these two tables are **byte-identical** (`cmp`). The local container equals them in **trigger set, trigger definitions (`pg_get_triggerdef`), enabled flags, function md5 of every trigger function, function security, table owner, RLS flags, relacl, per-role privileges, policy text and status CHECKs** (JSON key order aside). No object exists on one side and not the other. **One difference (found by the independent reviewer):** the owner and ACL of five trigger functions (`cf1_guard_final_heat_entry`, `cf1_guard_withdrawn_heat_entry`, `cf1_od17_guard_heat_entry`, `cf1_u18_guard_heat_entry_status`, `cf1_u18s_guard_heat_entry_scratch`) are `supabase_admin` with ACL `{supabase_admin=X/supabase_admin,postgres=X/supabase_admin}` locally, versus `postgres` with `{postgres=X/postgres}` on DEV and PROD. Both are in the guards' allowlist, so guard behaviour is unaffected, but local definer functions ran as `supabase_admin`, not `postgres`.

`public.event_competition_heat_entries` (owner `postgres`, RLS on not forced, policy `competition_manage` FOR ALL to `authenticated`; anon, authenticated, service_role hold SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES, **TRIGGER revoked**):

| Trigger | Timing | Enabled | Function security | md5 |
|---|---|---|---|---|
| `cf1_guard_final_heat_entry` | BEFORE | A (always) | DEFINER | `047fa000…` |
| `cf1_guard_withdrawn_heat_entry` | BEFORE | A | DEFINER | `e3018180…` |
| `cf1_od17_guard_heat_entry` | BEFORE | A | DEFINER | `8450cdc2…` |
| **`cf1_u18_guard_heat_entry_status`** | AFTER | A | INVOKER | `e47914edb361e22c3b091263b4e317f7` |
| **`cf1_u18s_guard_heat_entry_scratch`** | AFTER | A | INVOKER | `322afa75104f8acbdccc762ebad86276` |
| `comp10d_guard_heat_entry` | BEFORE | O (origin only) | DEFINER | `0f53177c…` |
| `comp10d_heat_entry_floor_integrity` | AFTER | O | DEFINER | `b9455594…` |
| `protect_locked_competition_heat_entry` | BEFORE | O | INVOKER | `7997313d…` |
| `set_event_competition_updated_at` | BEFORE | O | INVOKER | `204b9b93…` |

`public.event_competition_entries` (owner `postgres`, RLS on not forced, the same `competition_manage` policy; anon, authenticated, service_role hold SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES **and TRIGGER**; status CHECK allows `pending, confirmed, waitlisted, scratched, withdrawn, disqualified, complete`):

| Trigger | Timing | Enabled | Function security | md5 |
|---|---|---|---|---|
| `audit_competition_entry_change` | AFTER UPDATE/DELETE | **O (origin only)** | DEFINER (execute: postgres, service_role) | `31caa224…` |
| `set_event_competition_updated_at` | BEFORE UPDATE | O | INVOKER | `204b9b93…` |
| `validate_competition_entry_registration_links` | (registration links) | O | INVOKER | `9a4f8601…` |

**There is no status guard on the entries table**; the audit trigger records a change but refuses nothing, and it is not even ENABLE ALWAYS. A search of every trigger created on `event_competition_entries` across all candidate migrations finds only the audit and the registration-links trigger [EXEC `git grep`].

### Caller role per assertion (negative suite, all in `evidence/s6-negative-suite-run.log`)

All 29 result rows printed `ok = t` (0 rows with `f`): A1/A1b `anon`; A2a–c, A4b `service_role`; A3a, A3b, A3d, A3f, A4a, A4c, A5, B3, B4, C1, C1b, C1c, C3, C5, A6, D1 `authenticated` (manager); A4d `anon`; B1, B2, A3e, C2, C4 catalog/superuser reads or owner writes. **Further limits of the suite, disclosed after review:** A6 (upsert to `danced`) passes on any refusal cause and its in-file comment about a marker for entry A vs B is **not tested**; C5 asserts a literal `true` and both refusals shown are the published-schedule guard (a note, not a test); matrix rows cover only a fresh `confirmed` entry in an open heat, so **reverse transitions (back to `confirmed`) and entries in locked/certified heats are untested**. **One defect of mine, disclosed:** the closing summary block of that run did not execute (a JavaScript `$$` substitution turned `do $$` into `do $` in my edit), so the run ended with a syntax error instead of the "PASS (n checks)" line. Every check row above it was computed and printed before that; the defect is fixed in the file but **the suite was not re-run after the fix** (each re-run costs another heavy-lock queue slot of about an hour). The earlier version of the same suite, before the S6 section was added, ended with `OD31 NEGATIVE SUITE PASS (28 checks)`.

## S6(b). F1 / F2 / F3 / F7 now evidenced with captured detail [EXEC]

| Finding | Captured result |
|---|---|
| **F1** direct parent-entry write by a manager (`authenticated`) | `update event_competition_entries set status = …` returned **OK for all six values** tried: `disqualified, scratched, withdrawn, complete, waitlisted, pending` (matrix below). |
| **F2** `TRIGGER` on `event_competition_entries` | `has_table_privilege('authenticated', …, 'trigger') = true`; in the catalog: anon/authenticated/service_role all hold `trigger` on entries, none on heat entries (also true on DEV and PROD, `s6-catalog-*.json`). |
| **F3** forged workflow marker, SQL session only | `forge_parent = OK`, **`forge_heat = OK`**: after an audited parent-entry scratch and `set_config('app.competition_entry_change_type','scratch', true)`, a direct heat-entry scratch by `authenticated` returned no error (no RPC). **The suite did not read back that the heat entry became `scratched` (an UPDATE can succeed on 0 rows), so this is evidenced as "no refusal", plausible from the U18-S code (it needs parent scratched + audit row + marker, all satisfiable), not proven as a state change.** No PostgREST path is known to set that setting (inference, not executed). A re-run with a read-back is needed before calling it confirmed. |
| **F7** non-status changes / DELETE on heat entries | in this fixture both `update … set floor_order` on a danced row and `delete` of a scratched row were refused by the **published-schedule guard** (`COMP10D_SCHEDULE_PUBLISHED`), not by U18/U18-S. The residual therefore applies only where the heat's schedule version is not published (draft, or null version), which this fixture did not model; classification stays P3 and unexecuted for that case. |
| A1 (anon) | `anon_upd=OK`, `anon_upd_scr=OK`: the statements run without error (grants exist, no policy for anon, so 0 rows); the row was verified unchanged. |
| A2 (service_role) | UPDATE to `disqualified`, un-dance and direct scratch refused **with the guard's own error text** (A2b, A2c, A4b). A2a (service_role INSERT) and A1b (anon INSERT) assert only "not OK and no row", so the refusal there is not attributed to a specific guard. The service key gives no extra reach on heat entries; it **does** have the same reach as a manager on the parent entry table. |

### Direct parent-entry status writes by a client manager: matrix [EXEC]

Fresh entry per row, fixture heat entry `scheduled` and unlocked. `r2_class` is `_r2_entry_participation_class`; `in_heat_set` is membership in `_compe2_heat_entries` (the ballot/results ranking set).

| Written status | Outcome | Audit row (`entry_changes`) | Reason | Heat entry after | R2 class | In results heat set |
|---|---|---|---|---|---|---|
| `disqualified` | OK | `status_change`, by the manager | none | `scheduled` (untouched) | `open` | yes |
| `scratched` | OK | `scratch` | none | `scheduled` (**not** scratched) | `open` | yes |
| `withdrawn` | OK | `withdraw` | none | `scheduled` | `open` | yes |
| `complete` | OK | `status_change` | none | `scheduled` | `open` | yes |
| `waitlisted` | OK | `status_change` | none | `scheduled` | `open` | yes |
| `pending` | OK | `status_change` | none | `scheduled` | `open` | yes |

So a direct write is **audited but never blocked, never carries a reason or fee handling, and never touches the heat entry or the results set**. A scratched/withdrawn parent with a still-scheduled heat entry is an inconsistent state the lifecycle RPC would not produce.

## S6(c). Classification of F1: DISTINCT VULNERABILITY (never covered), previously owner-accepted

Evidence for each alternative:

* **Not "missing release-line integration".** No guard on the parent entry exists anywhere: none in the candidate's migrations (the only triggers ever created on `event_competition_entries` are the audit and the registration-links trigger), none on hosted DEV/PROD (identical catalogs), none in the PR 492 execution evidence. The guards that exist are present on the hosted databases and absent only from the shipping Git line (finding F5, S7).
* **Not an "ineffective guard".** U18 and U18-S fire and pass (21/21, 17/17 and 28+ negative checks; function md5 and trigger definitions identical on local, DEV and PROD). They are `AFTER` row triggers on `event_competition_heat_entries` only; their migration headers and suites say so.
* **Distinct, by design of the earlier work and recorded then.** U18's header states `scratched` is deliberately not covered there; `cf1-gate-refresh-2026-11-13.md` (candidate line) lists as an owner-accepted residual: "a manager can still change `event_competition_entries.status` directly (audited by the entry audit trigger, reason optional)"; PR 492's README repeats it ("direct `event_competition_entries.status` writes are audited with an optional reason"), and the CF1 design table row 21 says the same. **That acceptance (2026-11-13) predates and is not an answer to OD-20 item 4 (2026-11-23)**, which asks that `disqualified` not be reachable through an unintended bypass. The acceptance covered audited-but-allowed status edits; OD-20 now asks for no client route to `disqualified` at all. Whether the earlier acceptance still stands for `disqualified` is the owner's call.

## S6(d). Actual bypass and downstream effects, per status value

Reach: a studio manager as `authenticated` through the table API (policy `competition_manage` + UPDATE grant) [EXEC under simulated role]; `service_role` key holders have the same reach (BYPASSRLS, same grants); `anon` has none (no policy). **Not re-executed through PostgREST.** No hosted data exists to be affected today: DEV and PROD both hold **0 entries, 0 heat entries and 0 audit rows** (query `q8_entry_counts.sql`, [EXEC] 2026-11-24).

| Status | What changes downstream (code read, plus the executed matrix above) |
|---|---|
| `disqualified` | **R2:** `_r2_apply_participation` marks the entry `not_applicable` for withdraw (line 712), `_r2_withdraw_entry` skips it (677), `_r2_record_unattributed` / `_r2_record_reversal` exclude it from locked-entry exception recording (1135, 1161). **Registration sync** (`sync_competition_entries_from_registration`, which also creates entries from registrations) skips it on later registration changes (filters at 1423 and 1450; the same filter exists in the earlier 10A/bridge versions of that function). **Participant label:** the status page shows "Not eligible" (`register/status/page.tsx`); `competitionRefundSummary.ts` marks it not active. **Eligibility predicate P** (`status <> 'confirmed'`) is used **unconditionally** by the A5 exclusion action (`..._a5_exclusion_action.sql` 297, 407, 500, 603), the A6 withdrawal (`..._a6_withdrawal.sql` 282) and the callback-final advancement flagging/correction (`..._callback_final_advancement.sql` 949-955, 1096, 1214, 1367-1370); only the lock/start/publish/place gates are behind the per-event OD-17 switch (`..._od17_enforcement.sql` 250-296; ships dark, 0 switch rows on PROD [REC]). So a direct non-confirmed write changes A5/A6/advancement behaviour even with the switch off [INSP, line refs verified by the reviewer; not executed]. **Not changed:** heat entry, ballots, results ranking set, placements. |
| `scratched` / `withdrawn` | audited as `scratch`/`withdraw`; same R2 and sync filters as above; label "Released" for `withdrawn`; **heat entry stays scheduled and in the ranking set**, so ballots keep including the entry (the lifecycle RPC would have scratched it). **R2 scope resolution:** `withdrawn_after_unlock` is satisfied by an entry status of `withdrawn` or `scratched` (R2 migration 1298-1301), so a direct write satisfies that gate with no heat scratch and no reason. **Locked heats:** the lifecycle RPC refuses entries in locked/certified heats (`generation_operations` 341-349); a direct write has no such check (untested). **Reinstatement:** a direct write back to `confirmed` re-enters the sync and R2 filters (untested). |
| `complete` | **as consequential as `disqualified`** for R2: skipped by the withdraw cascade (677) and by locked-entry refund exception recording (1135, 1161); label "Complete"; no heat effect. The proposed guard does not cover it. |
| `waitlisted` / `pending` | predicate P unavailable (when OD-17 is on); labels "Waitlisted" / "Not confirmed yet". |

## S6(e). Smallest necessary correction (DESIGN ONLY, nothing created or applied)

Scope chosen to satisfy OD-20 item 4 and no more, and **not** to duplicate U18/U18-S: those guard `event_competition_heat_entries`; this would guard the other table and only the value OD-20 names. No legitimate writer of `disqualified` exists anywhere (grep of every migration and the app: none), so refusing every non-owner write loses nothing. Definer writers (R2, A6, registration sync) run as `postgres` and are exempt by the same `current_user` allowlist U18 uses. Reviewer check: no migration function writes `disqualified` or moves a row out of it (the writers are the lifecycle RPC, `mark_competition_entry_late`, the sync trigger, `_r2_withdraw_entry`, and `finalize_`/`start_competition_registration`); A6 reads the parent status but does not write it. The hosted owner of the registration `start_`/`finalize_` functions was not in my q3 filter and should be added to the postflight.

```sql
-- DESIGN ONLY. Proposed 20270215095000_competition_u18e_entry_disqualified_guard.sql (not created).
create function public.cf1_u18e_guard_entry_disqualified()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;
  if tg_op = 'INSERT' and new.status = 'disqualified' then
    raise exception 'COMP_U18E_ENTRY_DISQUALIFIED_WRITER: an entry cannot be created as disqualified by a direct table write.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.status is distinct from new.status
     and (new.status = 'disqualified' or old.status = 'disqualified') then
    raise exception 'COMP_U18E_ENTRY_DISQUALIFIED_WRITER: entry status disqualified cannot be set or cleared by a direct table write.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_u18e_guard_entry_disqualified() from public, anon, authenticated, service_role;

create trigger cf1_u18e_guard_entry_disqualified
  after insert or update on public.event_competition_entries
  for each row execute function public.cf1_u18e_guard_entry_disqualified();
alter table public.event_competition_entries enable always trigger cf1_u18e_guard_entry_disqualified;

revoke trigger on public.event_competition_entries from anon, authenticated, service_role;   -- closes F2 for this table
```

Rollback (data-free):

```sql
-- DESIGN ONLY rollback
drop trigger if exists cf1_u18e_guard_entry_disqualified on public.event_competition_entries;
drop function if exists public.cf1_u18e_guard_entry_disqualified();
grant trigger on public.event_competition_entries to anon, authenticated, service_role;
```

Design notes from review: the trigger is plain `AFTER INSERT OR UPDATE` (not `UPDATE OF status`) for parity with U18, which must see the final status even if a BEFORE trigger rewrites it; a recreated table would regain default grants, so the postflight must pin `relacl`; a client can **DELETE a disqualified entry and re-INSERT it as confirmed** (audited as a delete), which this guard does not stop. Test list (a suite parallel to U18's, plus: a refusal also rolls back the audit row written earlier in the statement; the lifecycle RPC on an already-disqualified entry is refused (behaviour change, check the UI message); a write under `session_replication_role = replica`; entries in locked/certified heats; owner roles exempt; fixtures under a new UUID block): `authenticated`, `service_role`, `anon` and a probe member role are each refused for `update status = 'disqualified'`, INSERT as `disqualified`, un-disqualify, bulk update touching a disqualified row, `ON CONFLICT DO UPDATE` into and out of `disqualified`; row unchanged after each; **other statuses still writable by the manager** (the guard must not change `scratched`/`withdrawn`/`complete` behaviour; the existing audit row appears); same-value rewrite allowed; a `SECURITY DEFINER` writer owned by `postgres` still sets/clears it; the owner session still writes; trigger is `ENABLE ALWAYS`, AFTER, function not executable by clients, TRIGGER privilege gone for the three roles on this table; a client `CREATE TRIGGER` on the table is refused; the R2 and A6 suites and the registration-sync path are re-run unchanged. Preflight/postflight in the PR 492 style (pins, function md5, trigger flags). Rollback implication: removes only the guard and restores the previous privilege; no data repair.

Explicitly **out of scope** of the smallest correction and left for an owner decision: (1) routing direct `scratched`/`withdrawn` edits of the parent entry through the lifecycle RPC (needs the marker, which is forgeable in a SQL session, F3, and would change an accepted behaviour); (2) a **wider alternative the owner should be shown**: the review found direct `complete`, `scratched` and `withdrawn` parent writes matter at least as much as `disqualified` for R2 refunds and advancement, so a guard on the whole status column (client transitions only through the lifecycle RPC) is the alternative to the narrow one; (2b) F3 itself (tying the marker to the entry/actor); (3) F7 draft-schedule DELETE/re-INSERT; (4) `TRUNCATE`; (5) a reason requirement on audited status edits. A correction would also be a new PROD SQL file: PROD apply is an owner gate, the tables are empty (0 rows), and apply order is after the already-applied U18/U18-S.

## S7. Authoritative shipping path and byte-identity verification

### Shipping path (read-only evidence)

* **Live app = Vercel project `danceflow-app-qfem`, source `cli`; production is reached only by a manual `vercel promote` of a branch build** (`docs/embeds/Release_Readiness.md` section 3: `autoAssignCustomDomains=false`, the ignored-build command skips every production build from `main`, a release-branch build is a preview until promoted; no GitHub workflow deploys or promotes) [INSP repo doc; settings inspection dated 2026-11-14 by that doc, not repeated]. `vercel.json` in the repo contains cron definitions only; there is no `.vercel` directory, no deploy workflow (`.github/workflows` has one e2e workflow), and CODEOWNERS exists on `main` only [EXEC].
* The same doc records on 2026-11-14 that "Competition ships from `release/competition-cf1-app-candidate` (live key-setup base), not main". **That statement is superseded by events since**: the live line `release/website-embeds` (cut from live `c0172455`) has taken 33 later commits (including the Competition settlement / Stripe-guard work #745, #781, #798) that the candidate branch does not have, every OD draft targets the live line, and the candidate branch has had no new commit since 2026-11-13. The current and last recorded promotions (R+1 `dpl_FZb1Jsju…`, R+3b `dpl_CTZfSRaJ…`, R+4 `dpl_ERsjXn2R…`) are from the live line **[REC engineering notes; not in repository docs; today's live deployment not verified here]**.
* Therefore the production application artifact is a build of a **`release/website-embeds`-lineage commit**; the Competition **database** is changed separately through `sb.sh` with owner approval.

### Byte-identity: sha256 per file and location [EXEC `git show … | sha256sum`]

Prefix of sha256 shown; full values in `evidence/s7-sha256-candidate.txt`. "PR 492 pin" = the sha256 recorded in PR 492's README / execution evidence (JC1, U18, U18-S, and the two rollbacks per environment are listed there); `composed` = the copy the local run applied.

| File | candidate `92a8c17c6` | PR 492 branch `5136bd133` | PR 492 recorded pin | composed (local run) | live line `49dbaee1b` | `main` (`38b6277bf` when first checked; now `dfd204abf`, a descendant, same result) | Match |
|---|---|---|---|---|---|---|---|
| JC1 migration `20270215092000_…` | `32007974…` | `32007974…` | `32007974…` | `32007974…` | **absent** | **absent** | yes (not on shipping line) |
| JC1 rollback | `3b967874…` | `3b967874…` | `3b967874…` | not applied | absent | absent | yes |
| JC1 SQL test | `362779e4…` | `362779e4…` | n/a | `362779e4…` | absent | absent | yes |
| U18 migration `20270215093000_…` | `90a46801…` | `90a46801…` | `90a46801…` | `90a46801…` | **absent** | **absent** | yes |
| U18 rollback | `90bcaa82…` | `90bcaa82…` | `90bcaa82…` | not applied | absent | absent | yes |
| U18 SQL test | `02cfc30d…` | `02cfc30d…` | n/a | `02cfc30d…` | absent | absent | yes |
| U18-S migration `20270215094000_…` | `5de8003f…` | `5de8003f…` | `5de8003f…` | `5de8003f…` | **absent** | **absent** | yes |
| U18-S rollback | `7df9b234…` | `7df9b234…` | `7df9b234…` | not applied | absent | absent | yes |
| U18-S SQL test | `ff95a63d…` | `ff95a63d…` | n/a | `ff95a63d…` | absent | absent | yes |

Also identical on the two original PR branches (`claude/cf1-u18-heat-entry-status-guard` for U18, `claude/cf1-u18s-scratch-audit` head `e0dff54cc` for U18-S).

**Verdict (1) source control:** the nine files are byte-identical everywhere they exist (candidate = PR 492 branch = PR 492 pins = composed copy = the original PR branches). **They exist on no shipping line**: absent from `release/website-embeds` and `main`. This is exactly finding F5.

### Hosted objects vs the Git definitions [EXEC]

Local objects (created from the Git files in a fresh database) vs hosted: function md5 of `cf1_u18_guard_heat_entry_status` `e47914edb361e22c3b091263b4e317f7` and of `cf1_u18s_guard_heat_entry_scratch` `322afa75104f8acbdccc762ebad86276`, `_compe2_is_absent` `22be37b7aa70fb934d49fba71ecc4f31`, trigger definitions (`AFTER INSERT OR UPDATE … FOR EACH ROW …`), enabled flag `A`, function security (INVOKER), function security, enabled flag, trigger definitions and the revoked TRIGGER privilege are **identical on local, DEV and PROD**; function owner/ACL are `postgres` on DEV and PROD and `supabase_admin` locally (see S6(a)) (`s6-catalog-*.json`; PR 492's postflights `ok: true` on all three, query files `q5`/`q6`). So the hosted objects equal what the pinned files create.

### Verdict (2): is there an integrated release artifact containing them?

**No.** There is no commit, branch or build that contains JC1 + U18 + U18-S **and** the live line's later work. Candidate branch: has the files, lacks 33 live-line commits. Live line: has the 33 commits, lacks the files. Production database: already has the three migrations. So today a build from the shipping lineage is **schema-compatible with the databases but not self-describing**: re-creating the chain from the shipping line's migration directory would silently omit all three guards (and JC1's `_compe2_is_absent` change). What would be needed: the nine files (migrations, rollbacks, SQL tests; byte-identical, pins above) landed on `release/website-embeds` through a normal PR, **documentation-of-state only, no PROD apply**, since PROD and DEV already carry them; plus a postflight run recorded after landing.

### Owner decision needed

1. **Approve landing the three migrations (JC1, U18, U18-S) with their rollbacks and SQL suites on `release/website-embeds` as a separate PR** (byte-identical, pins above; no hosted apply). Until then OD-31 sign-off stays blocked on the integrated artifact.
2. **F1 / OD-20 item 4:** choose (a) the design above as a new owner-gated SQL slice (empty tables, owner-approved PROD apply), (b) a narrower or wider guard (add routing of direct `scratched`/`withdrawn`), or (c) record continued acceptance of the 2026-11-13 residual for `disqualified` and relabel OD-20 item 4 as not satisfied by design.
3. Whether SC1 (#306) is ported to the live line (open since OD-31).

## Independent review (S6/S7), applied above

A reviewer subagent that had not seen the classification re-derived it from the migrations and catalogs. **Agreed:** F1 is class (C), a distinct gap; S7 byte-identity (it recomputed all nine hashes at the candidate and PR 492 refs and confirmed absence from the live line and main). **Corrections applied in this file:** local vs hosted catalogs differ in function owner/ACL of five trigger functions (not "identical"); F3 is "no refusal", not a proven state change; A2a/A1b/A6/C5 over-claims; predicate P is unconditional for A5, A6 and advancement (only lock/start/publish/place are OD-17-gated); R2 `withdrawn_after_unlock` and `complete` effects; locked-heat and reinstatement cases untested; design uses plain `AFTER INSERT OR UPDATE`, notes the DELETE+INSERT gap, and a wider whole-column alternative is presented; `main` moved to `dfd204abf`. Reviewer statements were verified by reading or by its own `git`/`node` runs, not by executing SQL.
