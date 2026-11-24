# R-10 part 3: Studio panel readiness correction and mid-round recovery (design only)

**Status: investigation + correction DESIGN. Nothing implemented. No migration file, no SQL applied, no engine change, no hosted write.**
Read at base `origin/release/website-embeds` (49dbaee1b). Applies to **Studio/Custom** events only (DanceFlow policy). Governing-body panel rules
(NDCA III.B.1.a-d, WSDC 3.4.7, UCWDC Rule #3 odd/even) are **separate future-profile items** and stay in PR #834 section 6C/6D; they are not used here.

**Release blocker (owner, 2026-11-23, R-10 part 3): OPEN.** The readiness default of 1, and readiness checks that accept a panel the ballot lock or the
scoring engine will refuse, are a mandatory Studio/Custom release blocker. It stays open until the enforcement is corrected **and independently
verified** and the DEV/PROD counts are reported (section 4, done). A display-label correction alone does not close it.

Register entries: `R10-DF-0001` (readiness must agree with lock and engine, status `inconsistent`), `R10-DF-0002` (mid-round recovery, `unsupported`),
`R10-DF-0003` (guest judge membership and identity, part 2, `requires_interpretation`). Closing criteria: section 12.

## 1. Owner decision R-10 (2026-11-23), as it constrains this design

1. RATIFIED: Studio ballot lock needs at least **three present, eligible judges and an odd panel** for the supported scoring methods.
2. RATIFIED: an outside guest judge first needs authorized team membership and verified identity; OJ-1 least privilege is kept; team membership must not grant unrelated studio-management permissions.
3. NOT RATIFIED: the readiness default of 1 and readiness that accepts an even panel the engine cannot use. Mandatory release blocker.
4. Odd-panel and minimum-count safeguards are **never weakened** to make readiness pass (this design only makes readiness stricter or equal, never the lock looser).

## 2. Lifecycle trace (inspected vs executed)

"Inspected" = read in the migration/source at the base commit. "Executed" = run against a database. Only the hosted read-only counts (section 4) were executed;
the local isolated-Postgres reproduction is **PENDING** (section 11).

| # | Stage | Object (file) | What it does today | Disagreement with lock/engine | Evidence |
|---|---|---|---|---|---|
| L1 | Initial configuration | `createCompetitionRoundAction` (`src/app/app/events/[id]/competition/actions.ts:303`); 10B/K1 `add_competition_division`; 10C.5 wizard | Round inserted with no `configuration` (so `{}`), default `scoring_method = 'none'`; wizard writes `ordinal_majority` / `proficiency_rating`. **No code writes `min_panel_judges`.** Template copy carries `minimum_panel_size` (WCS: 5) which nothing reads. | default minimum 1; dead second knob | inspected; DEV 9 rounds carry `minimum_panel_size = 5`, none a `min_panel_judges` (section 4) |
| L2 | Config write | RLS `competition_manage` (`for all` to managers, `20260620`), E2 `_compe2_guard_round_config` | A manager can write `configuration` directly. E2 guard fires only on `UPDATE OF scoring_method, target_advancement_count`; `configuration` and `minimum_panel_size` are unguarded, **also after start**. SS1 freezes `scoring_method` only after program lock. | any value, any time | inspected |
| L3 | Config parse | E1 `competition_round_panel_status` | `configuration->>'min_panel_judges'` is used only if it matches `^[0-9]{1,2}$`; **anything else (`3.0`, `"x"`, `100`) silently falls back to 1**. | a second silent default path | inspected |
| L4 | Panel assignment | E1 `assign_competition_panel_member`, `guard_competition_panel_assignment` | Active, verified, team-member official, letter shape by role; frozen once the round leaves draft/scheduled (`COMP_PANEL_FROZEN`). No size or parity logic (correct: mid-edit states are legal). | none (by design) | inspected |
| L5 | Official lifecycle | `add_competition_official`, `deactivate_competition_official` | Add needs OJ-1 team membership + verified email. Deactivation removes assignments from draft/scheduled rounds, **keeps them on started rounds**. | an inactive judge stays lettered on a started round | inspected |
| L6 | Readiness | `competition_round_panel_status/ready` (`20270101090000`, never redefined) | `ready = eligible_assigned >= greatest(1, cfg)`. No scoring method, no parity, no attendance. | **core defect** (D1-D4) | inspected |
| L7 | Attendance before start | E2 `record_competition_judge_attendance` (scheduled or active) | Audited absence (reason 1-500), reversible by a `present` row, refused if the judge has any ballot. Readiness ignores it. | D5 | inspected |
| L8 | Round start | O1 `start_competition_round` | Round `FOR UPDATE`; needs `competition_round_panel_ready`; callback target check; no panel size/parity/attendance check of its own. | trusts L6 | inspected |
| L9 | Absence after start | same RPC | Allowed while active; unlimited; no warning; panel is frozen so nobody can be added. | D6 (strands the round) | inspected |
| L10 | Partial ballots then departure | same RPC | `COMP_ABSENCE_HAS_BALLOTS` refuses absence for a judge who balloted any heat; lock then needs that judge's ballot for **every** heat. | D7 (strands the round even with a valid panel size) | inspected |
| L11 | Ballot lock | E2 `lock_competition_round_ballots`, `_compe2_round_blockers`, `_compe2_panel_rule`, `_compe2_round_judges` (+HL1, CF1-A2 text patches) | Present (non-absent) lettered judges: `ordinal_majority`/`callback_tally` >= 3 and odd; `proficiency_rating` >= 1; **any other method: rule unknown, never locks**. Counts do not filter eligibility, but an ineligible judge without a ballot is a `missing_ballots` entry, so it cannot pass until recorded absent. | the reference behavior | inspected |
| L12 | Engines | `engines/common.ts:271-272`; PV1 `_comppv1_panel`; `scoring/registry.ts checkPanelSize` | `judges < 3 || even` fails closed (`panel_size`); F2 builds the engine panel from **non-absent lettered judges** (same set as the lock). | agrees with L11 | inspected |
| L13 | Recovery | O1 `cancel_competition_round` | The only exit from an active round whose panel cannot lock; refused once a publication exists. | D8 | inspected |
| L14 | UI | `officials/contract.ts:84-93` (`need = max(0, (min_judges ?? 1) - judge_count)`), `officials/page.tsx:71`, `ballots/actions.ts:169` | Label says "Panel ready" for 1 judge; no parity text. | D9 | inspected |

Also inspected and **not changed**: the round-level scoring override (`scoring_override_key`, REG `competition_round_scoring_effective`) and the division selection. E2 and
readiness both key on the legacy `scoring_method` column. Implementation must confirm, with a test, that an override to a method whose registry `panel_rule` is not
`studio_x3` makes readiness fail closed (`scoring_method_unsupported`) rather than pass on the legacy column.

## 3. Defect catalogue (what is wrong, precisely)

- **D1 Default of 1.** `v_min := 1` with no config (L6). A single judge is READY for `ordinal_majority`/`callback_tally`; lock raises `COMP_PANEL_SIZE`.
- **D2 No parity rule.** 2 or 4 judges are READY; lock and engine refuse an even panel.
- **D3 Unknown scoring method accepted.** `none` (the action default), `relative_placement`, `majority_rules`, etc.: readiness passes, `_compe2_panel_rule` returns `known = false`, lock never succeeds. The panel is frozen, so the round is stranded.
- **D4 Silent fallback.** A malformed `min_panel_judges` falls back to 1 (L3). A low explicit value (1, 2, 4) is accepted (L2). A setter trigger alone (as #834 proposed) cannot fix D1, D2, D3 or D4's fallback because defaults never pass through a setter.
- **D5 Absence ignored at start.** Attendance recorded while `scheduled` is invisible to readiness (an absent judge still counts).
- **D6 Absence after start unbounded.** No warning, no confirmation, no path back to a valid panel (panel frozen). *Race:* two sessions each recording an individually acceptable absence can jointly break the panel; today nothing serializes them.
- **D7 Departure after partial ballots.** The judge cannot be recorded absent, yet lock needs their ballot for every heat. Panel size is irrelevant; the round is stranded.
- **D8 Cancellation is the only recovery** (and it is refused after publication).
- **D9 Copy.** The organizer UI tells a 1-judge panel that nothing more is needed and says "Panel not ready" for an even panel without a reason.
- **D10 Two competing knobs.** `minimum_panel_size` (template value 5) is dead; `min_panel_judges` is undocumented in the UI.
- **D11 Post-start configuration drift.** `configuration` (including `min_panel_judges`) can be edited after the round started (L2).

The #834 recommendation (readiness reads the E2 rule; optional setter trigger) is **directionally right and insufficient**: it left D5-D7, D11 and the fallback in D4 open, and its fix item 3
("leave E2 unchanged") needs the reasoning in section 5.4 to be sound.

## 4. DEV and PROD: read-only counts (EXECUTED)

Run 2026-11-24 02:57Z (DEV `epdrtzcydvnoidwrepqz`) and 02:58Z (PROD `hvsujyfbftfffxpfmlpb`) through `danceflow-ops/sb.sh dev-read` / `prod-read` (server-enforced
`BEGIN READ ONLY ... ROLLBACK`). Counts only; no identifiers, keys or personal data were printed or stored.

| Measure | DEV | PROD |
|---|---|---|
| Rounds total | 73 (all `draft`: 56 `ordinal_majority`, 8 `none`, 9 `relative_placement`) | 8 (all `draft`, `skating`) |
| Rounds with any panel assignment | 0 | 0 |
| Rounds whose E1 readiness is TRUE but panel cannot lock (misleading READY), any cause | **0** | **0** |
| Rounds `active` with an unlockable panel (stuck) | **0** | **0** |
| Rounds in `scheduled` / `active` / `ballots_locked` or later | 0 | 0 |
| Rounds carrying `configuration.min_panel_judges` | 0 | 0 |
| Rounds with `minimum_panel_size` set | 9 (all 5, `relative_placement`, draft) | 0 |
| Recorded judge-absence rows | 0 | 0 |

Interpretation: **no hosted round is currently misleading or stuck**; the defect is latent (Competition OS is dark, PROD has no assigned panel). The DEV `relative_placement`
and `none` drafts are D3 candidates the moment they gain a panel and are scheduled. PROD's 8 rounds use the legacy `skating` value (no E2 rule at all, also D3).

Exact queries (identical on both hosts; the file is `r10_counts.sql`, reproduced here in full so the audit can be re-run at any time):

```sql
-- R-10 read-only audit: counts only, no identifiers, no personal data.
with base as (
  select r.id, r.status, r.scoring_method,
         case when (r.configuration ->> 'min_panel_judges') ~ '^[0-9]{1,2}$' then (r.configuration ->> 'min_panel_judges')::int end as cfg_min,
         (r.configuration ? 'min_panel_judges') as has_cfg,
         r.minimum_panel_size,
         (select count(*) from public.event_competition_panel_assignments a where a.round_id = r.id and a.judge_letter is not null) as assigned,
         (select count(*) from public.event_competition_panel_assignments a where a.round_id = r.id and a.judge_letter is not null
             and public._compe2_is_absent(r.id, a.official_id)) as absent,
         (public.competition_round_panel_status(r.id) ->> 'ready')::boolean as e1_ready
  from public.event_competition_rounds r
), cls as (
  select b.*, (b.assigned - b.absent) as present,
         (b.scoring_method in ('ordinal_majority','callback_tally')) as odd3_method,
         (b.scoring_method in ('ordinal_majority','callback_tally','proficiency_rating')) as known_method,
         case when b.scoring_method in ('ordinal_majority','callback_tally') then ((b.assigned - b.absent) >= 3 and (b.assigned - b.absent) % 2 = 1)
              when b.scoring_method = 'proficiency_rating' then ((b.assigned - b.absent) >= 1)
              else false end as lockable_panel
  from base b
)
select 'A_rounds_total' as q, status as k1, scoring_method as k2, count(*) as n from cls group by 1,2,3
union all select 'B_has_cfg_min', status, coalesce(cfg_min::text,'(absent)'), count(*) from cls where has_cfg group by 1,2,3
union all select 'C_minimum_panel_size_column', status, coalesce(minimum_panel_size::text,'null'), count(*) from cls where minimum_panel_size is not null group by 1,2,3
union all select 'D_e1_ready_but_panel_unlockable', status, scoring_method, count(*) from cls where e1_ready and not lockable_panel group by 1,2,3
union all select 'E_misleading_ready_by_cause', status,
  case when not known_method then 'unknown_method_rule' when assigned = 0 then 'no_judges'
       when absent > 0 and (assigned >= 3 and assigned % 2 = 1) then 'absence_breaks_panel'
       when assigned % 2 = 0 and odd3_method then 'even_panel' when assigned < 3 and odd3_method then 'below_3' else 'other' end,
  count(*) from cls where e1_ready and not lockable_panel group by 1,2,3
union all select 'F_stuck_active_unlockable', status, scoring_method, count(*) from cls where status = 'active' and not lockable_panel group by 1,2,3
union all select 'G_not_ready_e1_but_lockable', status, scoring_method, count(*) from cls where not coalesce(e1_ready,false) and lockable_panel group by 1,2,3
union all select 'H_with_assignments', status, scoring_method, count(*) from cls where assigned > 0 group by 1,2,3
union all select 'I_attendance_absent_rows', 'all', 'n', count(*) from public.event_competition_judge_attendance where status = 'absent'
order by 1,2,3;
```

Limits: counts say nothing about rounds created later; the preflight of each migration below must re-run this query and refuse to proceed if any `D`/`F` row is non-zero (the correction never edits rows).

## 5. Correction design (bounded)

Principle: **one source of truth for what a panel must satisfy**, `_compe2_panel_rule(scoring_method)` (already immutable, E2). Readiness, start, attendance and the UI
read it; the lock and engines are not loosened and (section 5.4) not edited.

### 5.1 Readiness v2 (replaces D1-D4, D5, D10): `competition_round_panel_status`

Effective requirement for a round: `known, rule_min, odd` from `_compe2_panel_rule(round.scoring_method)`. Effective minimum
`v_min = greatest(rule_min, configured min_panel_judges, minimum_panel_size)` (configured values can only **raise**; `minimum_panel_size` becomes a live raise-only knob so a template that says 5 is honored).
Counts: `eligible` = assigned lettered judge/chair that are active, verified, team members (unchanged E1 filter); `present` = eligible and not absent (`_compe2_is_absent`).

```sql
-- DESIGN ONLY (md5-pinned replace of the E1 body; see 8). Same signature, same grants, same output keys plus new ones.
create or replace function public.competition_round_panel_status(p_round_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_round public.event_competition_rounds;
  v_known boolean; v_rule_min integer; v_odd boolean;
  v_cfg_raw text; v_cfg integer; v_cfg_bad boolean := false;
  v_min integer; v_eligible integer; v_present integer; v_absent integer; v_scorers integer; v_chair boolean;
  v_missing text[] := '{}'; v_ready boolean;
begin
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  if not found or (auth.uid() is not null and not public.can_manage_event_competition(v_round.event_id)) then
    return jsonb_build_object('ready', false, 'missing', jsonb_build_array('unavailable'));
  end if;
  select pr.known, pr.min_judges, pr.odd_required into v_known, v_rule_min, v_odd from public._compe2_panel_rule(v_round.scoring_method) pr;
  v_known := coalesce(v_known, false);
  if v_round.configuration ? 'min_panel_judges' then
    v_cfg_raw := v_round.configuration ->> 'min_panel_judges';
    if jsonb_typeof(v_round.configuration -> 'min_panel_judges') = 'number' and v_cfg_raw ~ '^[0-9]{1,2}$' then v_cfg := v_cfg_raw::integer;
    else v_cfg_bad := true; end if;            -- fail closed: never fall back to a default
  end if;
  v_min := greatest(coalesce(v_rule_min, 1), coalesce(v_cfg, 1), coalesce(v_round.minimum_panel_size, 1));
  select count(*) filter (where o.role in ('judge','chair') and a.judge_letter is not null),
         count(*) filter (where o.role in ('judge','chair') and a.judge_letter is not null and not public._compe2_is_absent(p_round_id, o.id)),
         count(*) filter (where o.role = 'scorer')
    into v_eligible, v_present, v_scorers
  from public.event_competition_panel_assignments a
  join public.event_competition_officials o on o.id = a.official_id and o.event_id = a.event_id
  where a.round_id = p_round_id and o.status = 'active'
    and public.verified_email_for_user(o.user_id) is not null and public._comp_e1_is_team_member(o.event_id, o.user_id);
  v_absent := v_eligible - v_present;
  select exists (select 1 from public.event_competition_officials o where o.event_id = v_round.event_id and o.role = 'chair' and o.status = 'active'
                 and public.verified_email_for_user(o.user_id) is not null and public._comp_e1_is_team_member(o.event_id, o.user_id)) into v_chair;
  if not v_known then v_missing := array_append(v_missing, 'scoring_method_unsupported'); end if;
  if v_cfg_bad then v_missing := array_append(v_missing, 'configured_minimum_invalid'); end if;
  if v_present < v_min then v_missing := array_append(v_missing, 'judges'); end if;
  if v_known and coalesce(v_odd, false) and v_present % 2 = 0 then v_missing := array_append(v_missing, 'panel_even'); end if;
  v_ready := coalesce(array_length(v_missing, 1), 0) = 0;
  return jsonb_build_object('ready', v_ready, 'judge_count', v_eligible, 'present_judge_count', v_present, 'absent_judge_count', v_absent,
    'min_judges', v_min, 'rule_min_judges', v_rule_min, 'odd_required', coalesce(v_odd, false), 'rule_known', v_known,
    'scoring_method', v_round.scoring_method, 'scorer_count', v_scorers, 'chair_designated', v_chair, 'missing', to_jsonb(v_missing));
end; $$;
```

- `competition_round_panel_ready` is unchanged (reads `ready`), so O1 `start_competition_round` needs **no edit** and now evaluates the corrected rule under its existing `FOR UPDATE` round lock.
- Behavior change to approve (Q-R10-1): rounds whose method has no Studio panel rule (`none`, `relative_placement`, `skating`, ...) can no longer **start**. They could never lock; today they only strand.
- Existing consumers of keys keep working (`ready`, `judge_count`, `min_judges`, `missing`, `chair_designated`, `scorer_count`).
- After start, the same function reports the *current* satisfaction. The organizer-raised portion (configured min above the rule) is **advisory after start**; the lock enforces the rule minimum (it is the engine prerequisite). The UI marks the difference.

### 5.2 Configuration guard (D4, D11; defense in depth, not the fix)

```sql
-- DESIGN ONLY. New trigger function and trigger; fires only when one of the listed columns appears in the SET list or on INSERT.
create function public._comp_r10_guard_round_panel_config() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_known boolean; v_rule_min integer; v_odd boolean; v_n integer; v_raw text;
begin
  if tg_op = 'UPDATE' and new.configuration is not distinct from old.configuration and new.scoring_method is not distinct from old.scoring_method
     and new.minimum_panel_size is not distinct from old.minimum_panel_size then return new; end if;
  if tg_op = 'UPDATE' and old.status not in ('draft','scheduled')
     and (new.configuration -> 'min_panel_judges') is distinct from (old.configuration -> 'min_panel_judges') then
    raise exception 'COMP_ROUND_CONFIG_FROZEN: the panel minimum cannot change once the round has started (status: %).', old.status using errcode = 'P0001';
  end if;
  select pr.known, pr.min_judges, pr.odd_required into v_known, v_rule_min, v_odd from public._compe2_panel_rule(new.scoring_method) pr;
  if new.configuration ? 'min_panel_judges' then
    v_raw := new.configuration ->> 'min_panel_judges';
    if jsonb_typeof(new.configuration -> 'min_panel_judges') <> 'number' or v_raw !~ '^[0-9]{1,2}$' then
      raise exception 'COMP_PANEL_MIN_INVALID: min_panel_judges must be a whole number from 1 to 99.' using errcode = 'P0001'; end if;
    v_n := v_raw::integer;
    if coalesce(v_known, false) and (v_n < v_rule_min or (v_odd and v_n % 2 = 0)) then
      raise exception 'COMP_PANEL_MIN_BELOW_RULE: this scoring method needs at least % judges and an odd panel; the minimum cannot be set to %.', v_rule_min, v_n using errcode = 'P0001'; end if;
  end if;
  return new;
end; $$;
create trigger compr10_guard_round_panel_config before insert or update of configuration, scoring_method, minimum_panel_size
  on public.event_competition_rounds for each row execute function public._comp_r10_guard_round_panel_config();
```

It never blocks assigning or unassigning judges (the mid-edit state "2 of 3 assigned" stays legal). It fires on `scoring_method` (the #834 gap: a low value set first, method switched later). Rows already holding a bad value are not rewritten and are neutralized by readiness v2 (`greatest`, fail closed).

### 5.3 Attendance: evaluate at every change, serialize, confirm the break (D5, D6, race)

New signature (the 5-arg function is dropped in the same migration so PostgREST sees one candidate; an old app still calling with 5 named args resolves to the new function with `p_confirm_panel_break = false`, so SQL-before-app is safe):

`record_competition_judge_attendance(p_round_id, p_official_id, p_status, p_reason, p_request_id, p_confirm_panel_break boolean default false)`

Inserted after the `COMP_ABSENCE_HAS_BALLOTS` check (md5-pinned text replace, same technique as HL1/CF1-A2):

1. `perform pg_advisory_xact_lock(hashtextextended('comp_r10_panel:' || p_round_id::text, 0));` taken **before** the evaluation. Serializes concurrent attendance calls (two individually acceptable absences can no longer jointly break the panel unnoticed); the existing round `FOR SHARE` already serializes attendance against `start_competition_round` and `lock_competition_round_ballots` (both take the round `FOR UPDATE`).
2. For `absent`: compute the post-change `present` and the rule (as in 5.1) **excluding this official**.
   - Round `scheduled`: accept (truth is recorded). Readiness v2 now reads not-ready, so start is blocked until the organizer fixes the panel. No case needed.
   - Round `active` and the panel stays valid: accept.
   - Round `active` and the panel would break (below rule minimum, or even for an odd-required method): refuse with `COMP_PANEL_BREAK_CONFIRM_REQUIRED` and a JSON detail (`present_after`, `min`, `odd_required`, what recovery exists) unless `p_confirm_panel_break = true`. With confirmation: record the absence **and open a panel recovery case** (section 6) in the same transaction. Rationale: refusing to record a true absence would make the data lie; the confirmation forces the organizer to see that the round is now stranded and routes them to recovery instead of silent stranding.
3. For `present` (restoring a judge): if an open recovery case exists and the panel is valid again, close the case `resolved_restored` (audited).
4. Same audit event kinds as today plus `panel_break_confirmed`; request-id idempotency, fingerprint (`md5(p_status || '|' || reason)`) extended with the confirm flag so a replay with a different flag is `COMP_REQUEST_REUSED`.

### 5.4 Lock and engines: deliberately NOT changed (no loosening, no pin of `lock_competition_round_ballots`)

- Lock `P` = non-absent lettered judges (`_compe2_round_judges` minus `_compe2_is_absent`); the engine input panel (`_compf2_evidence` `officialIds`/`judges`, lines 604-619) is the same set; `common.ts` and PV1 `_comppv1_panel` apply the same odd >= 3 rule. They agree with each other.
- E2 counts judges without the active/verified/team filter. That is safe because a judge who is ineligible and has no ballot appears in `missing_ballots` and the lock refuses until they are recorded absent (then they leave `P`). A judge who was eligible when they balloted and is deactivated later keeps their ballots, which is the correct historical reading of "present and eligible".
  **Verify, do not assume:** negative test N-LOCK-3 (section 10) proves an ineligible judge without a ballot cannot lock.
- The only strictness gap left is "eligible at start" (5.1) which is a start-time rule by decision R-10 part 1; the lock rule stays the engine prerequisite.
- Consequence: no edit to `lock_competition_round_ballots`, `_compe2_round_blockers`, `_compe2_panel_rule`, `_compf2_evidence`, the engines, `registry.ts`. `src/lib/competition/results/engines/common.ts` and PV1 are the **reference**; a drift test (section 10, N-PARITY) asserts SQL rule == TS rule for every supported method.

## 6. Recovery (R-10 requirement 7): a judge becomes unavailable after the round started

Goal: cancellation must not be the only exit; existing ballots and historical assignments are preserved; every step authorized and audited; coordinated with OD-17 (#834 6D) and OD-05/OD-06.

**Why a naive "swap the judge" is wrong.** Studio engines require the **same panel in every heat** (X-7) and a judge cannot score a heat they did not watch. A replacement therefore cannot inherit earlier heats. The recovery paths are classified by what evidence already exists.

### 6.1 Case record (new, append-only, evidence-protected)

`event_competition_panel_recovery_cases` (one open case per round): `id, event_id, round_id, status ('open','resolved_restored','resolved_returned_to_scheduled','resolved_withdrawn','resolved_rerun','closed_cancelled'),
opened_by, opened_at, trigger ('absence_after_start','official_deactivated','manual'), reason (1-500), panel_snapshot jsonb (assignments with letters, attendance, eligibility at open), ballot_snapshot jsonb (ballot ids/versions per judge and heat at open),
resolution jsonb, resolved_by, resolved_at, request_id unique`. Companion immutable `event_competition_panel_recovery_events` (every step, with request id). Same conventions as E1/E2 audit
(`protect_competition_history_evidence()`, RLS: managers and the chair read; **no judge and no other role reads**, OJ-1 least privilege preserved; writes only through definer RPCs). Forward compatible with #834 6D.4 `event_competition_panel_changes` (NDCA profile): the NDCA table later references a case id; Studio never needs the NDCA fields.

### 6.2 Classes and actions (manager only; chair may open a case, not resolve it; each RPC takes a reason and a request id)

| Class | Evidence state | Action (RPC, design names) | Preserves |
|---|---|---|---|
| **A** | Round `active`; **no ballot exists** in the round; no heat is `staging`/`active`/`complete` | `return_competition_round_to_scheduled(round, reason, request)`: active -> scheduled, **only** in class A. The organizer uses normal E1 assignment (frozen guard lifts because status is `scheduled`), readiness v2 re-checks, then the normal start. Needs the O1 transition-kind CHECK extended with `round_returned_to_scheduled` (dependency, section 8). | all assignments (removed rows stay in E1 audit + case snapshot), attendance rows, round history |
| **B1** | Ballots exist; the remaining present panel **still satisfies the rule** (e.g. 5 judges, 1 left after balloting some heats) | `withdraw_judge_after_ballots(case, official, reason, request)`: records the judge as absent **despite** ballots, only through the case (the `COMP_ABSENCE_HAS_BALLOTS` refusal stays for the normal RPC). The judge's ballots are **kept, never superseded or deleted**, and are excluded from the calculation. | all ballots and marks (immutable); audit |
| **B2** | Ballots exist and the remaining panel **cannot** satisfy the rule | **No in-place continuation exists under X-3/X-7.** Option: `retire_and_rerun` (retire all current ballots of the round as evidence, new panel epoch, affected heats danced again). Requires owner policy and reader changes (6.4). **Not designed to implementation depth here.** Until the owner decides B2, the supported exits are cancellation or organizer handling outside DanceFlow, but the case record and snapshot are kept. | everything (ballots retained as retired evidence) |

Authorization: `can_manage_event_competition` and the existing `_compe2_round_role = 'manager'` check; no new permission, no team-membership escalation (R-10 part 2). Replacement judges must already be E1 officials (verified identity, authorized team member, OJ-1) before any panel edit. A guest outside judge follows the existing path: team membership first, then `add_competition_official`, then assignment; recovery never short-circuits it.

### 6.3 B1 is the common mid-round case; what must be verified before it can ship

B1 makes `_compe2_is_absent` true for a judge who has ballots. Required reading checks (each a test): the lock's `missing_ballots` ignores them (it does, via `_compe2_is_absent`); `_compf2_evidence` panel (`officialIds`, `judges`) excludes them (it does); **the `cur`/`marks` ballot set in `_compf2_evidence` and the engine input must also exclude a withdrawn judge's ballots**, otherwise the engine sees marks from an official outside the panel. That filter must be confirmed or added (a small pinned patch to `_compf2_evidence`, which F2/CF1-A3 own), and PV1 recompute (`_comppv1_*`) must use the same set. Until proven, B1 stays unshipped and the case stays at "open, exits: cancel".

### 6.4 B2 reader inventory (for the owner decision; not authorized to build)

Retiring ballots changes the reader set: `_compe2_round_blockers` (stale/missing), `_compf2_evidence`, `lock`/`reopen` (E2), PV1 recompute, F3 publication evidence, OD-10 ballot visibility (#842), OD-11 judge-confirmed corrections (#843), OD-04 delete guard (#844). OD-11 already owns "changes to ballots"; B2 should be expressed as an OD-11 correction-class operation rather than a second ballot writer. **Q-R10-4 for the owner.**

### 6.5 Coordination

- **OD-17 (#834 6D):** Option B now = Studio unchanged. 6D.6 says a post-ballot substitution "is not designed and fails closed". This design **supersedes that sentence for Studio only**: Studio gets the case-based recovery above. The NDCA profile (Option A, N1-N7) is untouched; its `emergency_substitution` records later attach to the same case id. Substitution at class A uses the existing E1 assign path (no new assignment writer).
- **OD-05/06:** a recusal that empties a seat is a panel break; it must open the same case (same `opened_by`/`trigger` vocabulary). OD-05's shared aggregator `_compoc_blockers_panel_size` calls `competition_round_panel_status` (5.1): one source of truth, no second panel-size rule. OD-06 role designations are WSDC-only; not used here.
- **OD-10 (#842):** the case and snapshots are manager/chair-read only; a judge never reads another judge's identity or ballots through recovery.
- **OD-16 (#834 6C):** Studio rule = this document; body rules remain separate future profiles.

## 7. App surfaces (what changes, when implemented)

| Surface | Change |
|---|---|
| `src/lib/competition/officials/contract.ts` `PanelStatus`, `panelStatusLabel` | add `present_judge_count`, `absent_judge_count`, `odd_required`, `rule_known`, `rule_min_judges`, `scoring_method`; copy from `missing` codes: "Needs N more present judges", "Needs an odd number of judges (3, 5, 7...)", "This scoring method has no supported panel rule; choose Ordinal Majority or Callback Tally" (Q-R10-1), "N judge(s) recorded absent". Mid-edit guidance (2 of 3, 4 after adding one) is guidance, never an error; never blocks saving a draft panel. Label: "Studio policy (DanceFlow), not a governing-body rule." |
| `officials/page.tsx` | show the corrected status; link to the recovery case when open |
| `competition/ballots/actions.ts:169` and its page | pass `p_confirm_panel_break`, show the confirm dialog with the computed consequence, and the open-case banner |
| Tests | `officials.e1.test.ts` (new copy matrix), new TS/SQL parity test, E1/E2/O1 SQL fixtures (section 10) |
| Wizard / template | no write of `min_panel_judges`; copy states the Studio minimum; `minimum_panel_size` documented as raise-only |

## 8. Migration slot proposal, idempotency, rollback

**Slots.** Latest on base: `20270218090000`. Open design PRs reserve: #834 `20270220089000`, `20270220090000`-`20270220100000` (OD-05/06/15/16/17), #838 `20270219090000`/`20270220090000`/`20270221*`, #842 `...0219/0220/0221`, #843 `...0219-0222`, #844 `20270218/0219`, #845 `...0222/0223`, #854 `...0218-0225`, #857 `...0220089/0222190/0223/0227`. The ids `20270219080000`-`20270219084000` appear in **none** of them (verified by diff scan). The fix depends only on E1/E2/O1, so it can precede every other block.

| Slot | Name | Contents | Redefines (md5-pinned) |
|---|---|---|---|
| `20270219080000` | `competition_r10_1_panel_readiness_v2` | 5.1 | `competition_round_panel_status` (E1 text, never redefined since) |
| `20270219081000` | `competition_r10_2_round_panel_config_guard` | 5.2 | none (new trigger) |
| `20270219082000` | `competition_r10_3_attendance_panel_break` | 5.3 + case tables (6.1) | `record_competition_judge_attendance` (E2 text; drop 5-arg, create 6-arg) |
| `20270219083000` | `competition_r10_4_recovery_class_a` | 6.2 class A, transition-kind CHECK extension | O1 `event_competition_round_transition_events_kind_check` (constraint swap) |
| `20270219084000` | `competition_r10_5_recovery_class_b1` | 6.2 B1 (after 6.3 proof) | possibly `_compf2_evidence` (F2/A3 text; pin the installed post-A3 text) |

**Retire** the `20270220089000` "Studio readiness fix" reservation in #834/#854/#857: this design replaces it (it is a superset). `20270219080000` has no dependency on any OD-05 slot.

**Ordering/gates.** SQL before app (old app keeps working: 5.1 keeps all old keys; 5.3 default false). Each file: single transaction, preflight (objects exist, installed function md5 equals the pinned value taken from an **applied chain** on the QA Postgres, anchor occurs exactly once, post-replace md5 verified, CR stripped: the CRLF function-body gotcha), the section 4 query must return zero `D`/`F` rows. Idempotency: `create or replace`/guarded `drop ... if exists` for functions; tables/trigger created only if absent (preflight refuses a half-applied earlier run, as E2 does); request ids make RPCs replay-safe.
**Rollback.** Per file, `rollback/<name>_rollback.sql` restoring the pinned prior text by md5 (status function; attendance 5-arg), dropping the trigger, dropping case tables **only if empty** (otherwise forward-fix: evidence is never destroyed), restoring the O1 CHECK. App rollback first, then SQL in reverse order. No data migration, no row edit anywhere (hosted counts are zero anyway).

## 9. Precise list of what needs correcting

| Kind | Object | Action |
|---|---|---|
| SQL function | `competition_round_panel_status` (E1 20270101090000:768) | redefine (5.1) |
| SQL function | `record_competition_judge_attendance` (E2 20270102090000:1093) | replace with 6-arg (5.3) |
| SQL trigger | `event_competition_rounds` | add `compr10_guard_round_panel_config` (5.2) |
| SQL tables | `event_competition_panel_recovery_cases/events` | add (6.1) |
| SQL constraint | O1 transition kind CHECK | extend (class A) |
| Config defaults | absent `min_panel_judges`, `minimum_panel_size`, action default `scoring_method = 'none'` | default now = the method's rule; `none` cannot start (Q-R10-1) |
| App | `contract.ts`, `officials/page.tsx`, `ballots/actions.ts:169` | section 7 |
| NOT changed (reference) | `lock_competition_round_ballots`, `_compe2_round_blockers`, `_compe2_panel_rule`, `common.ts`, PV1 `_comppv1_panel`, `registry.ts checkPanelSize` | agreement tests only |

## 10. Negative tests (to be written with the implementation; specified now)

Each is an SQL fixture (E1/E2/O1 chain, QA Postgres) plus a TS unit where noted. "Expect" is the required outcome.

| ID | Case | Expect |
|---|---|---|
| N-DEF-1 | `ordinal_majority`, config `{}`, 1 / 2 judges | readiness false (`judges`); `start_competition_round` -> `COMPO1_PANEL_NOT_READY` |
| N-DEF-2 | same, 3 and 5 judges | ready; start OK; lock OK (no regression) |
| N-DEF-3 | `callback_tally` as N-DEF-1; `proficiency_rating` with 1 judge | callback false; proficiency true (rule min 1) |
| N-EVEN-1 | 4 judges, 6 judges | `panel_even`, not ready |
| N-METH-1 | `none`, `relative_placement`, `skating`, null | `scoring_method_unsupported`, cannot start (Q-R10-1) |
| N-CFG-1 | `min_panel_judges` = 1, 2, 4, 0, "3", 3.5, 100, `null`, object | trigger rejects (`COMP_PANEL_MIN_INVALID`/`BELOW_RULE`); rows forced in with `session_replication_role = replica` still read not-ready or `configured_minimum_invalid` |
| N-CFG-2 | set low value first, then switch `scoring_method` | rejected on the method switch (trigger fires on `scoring_method`) |
| N-CFG-3 | change `min_panel_judges` after start | `COMP_ROUND_CONFIG_FROZEN` |
| N-CFG-4 | `minimum_panel_size = 5`, 3 judges | not ready (raise-only) |
| N-ATT-1 | 3 judges, one absent while `scheduled` | readiness false; start refused |
| N-ATT-2 | active round, absence that leaves 2 / leaves an even count | `COMP_PANEL_BREAK_CONFIRM_REQUIRED`; no attendance row, no case |
| N-ATT-3 | same with `p_confirm_panel_break = true` | absence recorded, case opened, audit rows, snapshot present |
| N-ATT-4 | absence that keeps the panel valid (5 present -> 4 is even and breaks; 7 -> 5 keeps) | 7 -> 5 accepted, no case; 5 -> 4 needs confirmation |
| N-ATT-5 | judge with ballots recorded absent via the normal RPC | still `COMP_ABSENCE_HAS_BALLOTS` |
| N-ATT-6 | restoring presence closes the case `resolved_restored` | status + audit |
| N-AUTH-1 | non-manager, judge, other event's manager, anon: attendance, case, recovery RPCs, readiness | all refused; no existence oracle; judge cannot read cases |
| N-AUTH-2 | direct writes to attendance, cases, assignments of a started round, `configuration` of another event | refused by grants/RLS/guard |
| N-AUTH-3 | recovery replacement with a non-member, unverified or inactive official | refused (OJ-1, `COMP_OFFICIAL_*`); assigning a guest without membership impossible; membership does not grant any studio permission (assert permission set unchanged) |
| N-RACE-1 | two sessions: absence A and absence B, each acceptable alone, jointly breaking | second sees the first (advisory lock) and requires confirmation |
| N-RACE-2 | `start_competition_round` vs `record_competition_judge_attendance(absent)` | serialized by the round lock; start sees final attendance; never starts on a stale panel |
| N-RACE-3 | `lock_competition_round_ballots` vs attendance | lock sees the final present set or waits |
| N-RACE-4 | two sessions open a case / return-to-scheduled / withdraw for the same round | one wins, the other `COMP_RECOVERY_NOT_OPEN` or replay; request-id replay idempotent |
| N-LOCK-1 | ordinal round with 1, 2, 4 present at lock | `COMP_PANEL_SIZE` (unchanged) |
| N-LOCK-2 | 3 judges, 1 absent (2 present) | lock refused |
| N-LOCK-3 | judge deactivated after start without ballots | lock refused (`missing_ballots`) until recorded absent; then panel rule re-applied |
| N-LOCK-4 | lock refused panel never passes readiness: property test over 0..9 judges x methods x absence masks: `readiness_ready(start-time set) => lock_panel_ok(same set)` | holds for every combination |
| N-PARITY | SQL `_compe2_panel_rule` vs TS `checkPanelSize`/`common.ts` for n = 0..11 | identical outcome |
| N-REC-A1 | class A: active, zero ballots; `return_competition_round_to_scheduled` | scheduled; assignments, attendance, audit intact; case resolved; re-assign and start works |
| N-REC-A2 | same with one ballot or a heat on the floor | refused (`COMP_RECOVERY_CLASS`) |
| N-REC-A3 | after a publication exists | refused |
| N-REC-B1 | 5-judge panel; one judge balloted 2 of 4 heats then leaves; B1 withdraw | that judge's ballots untouched (content hash equal before/after) and excluded from lock `missing_ballots` and from `_compf2_evidence` marks; the remaining 4 present is even, so lock stays refused (`COMP_PANEL_SIZE`) and the case stays open (see N-REC-B1b for the passing case) |
| N-REC-B1b | 6-judge panel, two judges withdrawn after ballots (4 left, even) then one more (3 left) | lock refused at 4, succeeds at 3 with all remaining ballots present |
| N-REC-B2 | B1 requested when the remaining panel breaks the rule | refused; case stays open; only cancel is offered until Q-R10-4 |
| N-REC-HIST | any recovery | no row of ballots/marks/attendance/assignment history deleted or mutated (row counts + content hashes before/after) |

## 11. Non-production verification of CURRENT behavior: PENDING

Requested: reproduce D1-D3, D5-D7 on a local isolated Postgres (`cf1host:found`, runner pattern of `scripts/qa/cf1-db-settlement.mjs`, test-only, no repo SQL change) under the heavy-lock FIFO rules.
**Not executed.** At 02:58Z the `C:\dfr\heavy.queue` held six tickets ahead (fin-b ~4 min, business-pulse ~25, tw4f-fin-d ~45, tw4f-fin-a ~70, student-vc3 ~30, comp-od31 ~25; the lock was held by fin-b) =
about 3 h 20 min of queued work, well beyond the 45-minute limit. No ticket was taken and the queue was not displaced. **Status: PENDING.**
Specified run (for whoever takes a ticket; ~15 min): install the E1, E2, O1 (+ F2 for lock) chain on a scratch database; as the fixtures of `sql-tests/test_T_competition_e1_officials.sql` / `test_T_competition_o1_day_of.sql` do, create a published ordinal round with heats; (a) 1 judge: assert `competition_round_panel_ready = true`, start, ballot, `lock_competition_round_ballots` -> `COMP_PANEL_SIZE`; (b) 2 and 4 judges; (c) 3 judges then one absence, via `record_competition_judge_attendance`; (d) judge with a ballot -> `COMP_ABSENCE_HAS_BALLOTS`, then lock `COMP_BALLOTS_INCOMPLETE`; (e) round with `scoring_method = 'none'` starts then never locks; (f) `cancel_competition_round` as the only exit. Everything above in this document that says "inspected" stays **unproven by execution** until that run.

## 12. Closing criteria for the release blocker (R-10 part 3)

The blocker closes only when ALL hold, each evidenced in the tracker:
1. Migrations R10-1 to R10-3 (and class A of R10-4) implemented per section 5-6 and reviewed; the lock and engines unchanged or, if touched, with an owner-approved exception.
2. Negative tests of section 10 pass on QA Postgres (N-DEF..N-RACE, N-LOCK, N-PARITY, N-REC-A*), with a run report.
3. **Independent verification** by a reviewer who did not write the fix (the owner's rule: Claude QA matrix, independent review).
4. DEV and PROD counts re-run after the change and at release preflight: zero misleading-ready, zero stuck (section 4 query).
5. Section 11 reproduction executed and recorded (before: defect shows; after: fixed).
6. Recovery: class A shipped, B1 either shipped with the 6.3 proofs or explicitly accepted by the owner as a release limitation with cancellation + case record, B2 owner decision Q-R10-4 recorded.
7. Register entries `R10-DF-0001/0002/0003` moved to `verified_compliant` only with cited implementation paths and tests.

## 13. Open questions for the owner

- **Q-R10-1** Confirm that a round whose scoring method has no Studio panel rule (`none`, `relative_placement`, legacy `skating`, ...) must not start (today it starts and can never lock).
- **Q-R10-2** After start, should the organizer-raised minimum (above the rule) be advisory (this design) or blocking at lock?
- **Q-R10-3** Dual control for recovery (a second manager or the chair co-signs) or manager-plus-reason only (this design)?
- **Q-R10-4** B2 policy: when the remaining panel cannot satisfy the rule and ballots exist, is "retire ballots and re-dance the affected heats" acceptable Studio policy, expressed through OD-11 corrections?
- **Q-R10-5** The chair currently counts as a voting judge (OD-16 non-voting-chair question): unchanged here; confirm.

## 14. Independent review

Independent review by a subagent that had not seen this document's conclusions (read-only, formed its view from the source first). It found two blockers, five majors and several minors. **Status of each: ACCEPTED, and the design text in sections 5-6 is superseded by the amendments below wherever they conflict; the SQL blocks above are NOT yet corrected** (usage limit reached; fold these in before implementation).

| # | Sev | Finding | Required amendment |
|---|---|---|---|
| 1 | blocker | 5.2 trigger is SECURITY INVOKER and calls , revoked from  (e2:601); every manager round insert/update would fail. | Make it , revoke from all roles, ; add N-AUTH test that a plain manager can still update . |
| 2 | blocker | Class A active to scheduled is refused by  (o1 ~176-205, ); needs a pinned redefinition, a matching transition-events row, event lock then round FOR UPDATE; other status triggers (, , , F3) must be reviewed; CHECK rollback fails if rows exist. | Add the guard redefinition to slot 4 and section 9; forward-fix or NOT VALID instead of a plain constraint swap. |
| 3 | major |  is rejected in the TS registry (, ) and E2 approves only / ballot formats, so a 1-judge proficiency round starts but can never ballot or lock; N-PARITY would also fail. | Readiness keys on format approved AND engine registered AND panel rule verified = ,  only. Move proficiency to N-METH-1. Do not change . Also fix the section 4 query ( treats proficiency as lockable); re-run counts (expected unchanged: all rounds are empty drafts). |
| 4 | major | 5.4 hole: readiness counts only eligible judges, the lock counts all lettered non-absent judges. 3 eligible plus 1 team-removed lettered judge is READY (3, odd) but lock sees 4 (even). | Readiness evaluates parity and minimum over the lock's set (all lettered, non-absent) and adds a  blocker for any lettered, non-absent judge failing the E1 filter (organizer must record absent first). N-LOCK-4 must use this set. |
| 5 | major | B1 is empty for single departures: a valid panel is odd, removing one always breaks parity; B1 text, N-REC-B1/B1b and N-ATT-4 are inconsistent; a case is closed only on . | B1 must act on a set of judges atomically (7 to 5, 5 to 3) or be stated as helping panels of 5+ only; close a case when the panel becomes valid by any route; rewrite N-ATT-4/B1/B1b. A single departure with ballots on a 3-judge panel is B2: move Q-R10-4 forward as the key owner decision. |
| 6 | major | B1 reader inventory incomplete: the  stale check is not absence-filtered (a withdrawn judge's stale ballot blocks lock forever; the judge cannot correct, e2:860); PV1 raises  for marks of non-panel officials (pv1:271-274, confirmed);  ballots array and F3 publication evidence read them too. | B1 needs pinned patches to  and  (so 5.4 "not edited" holds for class A only); B1 stays unshipped until proven. |
| 7 | minor | Readiness v2 breaks existing fixtures:  (default method ), , o1_day_of, o1_concurrency, e2_p1fix, , likely F2/CF1/HL1 suites. | List the inventory and use method plus a 3-judge panel in fixtures. |
| 8 | minor | Attendance: add the confirm flag to the fingerprint only when true (else pre-migration replays hit ); explicit revoke/grant on the 6-arg signature; drop+create is not a plain pinned replace (pin the 5-arg text for rollback); panel-break set must be the lock's set. | Apply. |
| 9 | minor | 5.2: reject 0 uniformly; unrelated config edits on a legacy bad value would raise (validate only when the key changed); even configured minimum is harmless UX only. | Apply. |
| 10 | minor | After start,  should be evaluated against the rule only, with a separate . | Apply (resolves Q-R10-2 toward advisory). |
| 11 | minor | Counts query cannot detect D7, the ineligible-lettered disagreement or unstartable scheduled rounds;  mislabels malformed as absent; zeros prove emptiness, not that the query works; preflight has no remediation path. | Extend the query; treat the hosted zeros as emptiness only (stated in section 4); preflight failure = stop and report. |
| 12 | minor | #834/#854/#857 pins of the E1/E2 text must be rebased onto the new md5s; PROD may not yet hold . | Note in the slot table. |

Verified correct by the reviewer: readiness default/parse/fallback; lock and engine judge sets agree; D7 stranding; attendance and round locks serialize with start/lock, advisory lock justified, no deadlock cycle in the proposed order; 5.1 SQL logic and grants;  semantics;  is dead; no owner-decision weakening and body rules kept separate.
