-- Competition CF1 package A1: eligibility / refund predicate, callback-Final helpers, exclusion table and error-code catalogue.
--
-- Design: docs/competition/callback-to-final-advancement-design.md (4.6 predicate P, 4.7 OD-20 exclusion, A.9.1 / A.9.2 package A1).
-- A1 adds NEW objects only. It redefines no existing function (E2 / F2 / NS1 / O1 / HL1 are untouched; A2 / A3 own those changes).
--
--   Predicate (4.6), read only, per entry, from the entry's own links:
--     _cf1_entry_unavailable_reason(entry)     first matching reason, or null when the entry is available   (A1 extra, see contract)
--     _cf1_entry_unavailable(entry)            boolean P
--     _cf1_round_roster_problems(round)        (entry_id, reason) for every ranking-set entry of the round that is unavailable
--     _cf1_require_roster_eligible(round, stage)  raises COMP_ROSTER_ENTRY_UNAVAILABLE / COMP_ROSTER_BELOW_MINIMUM  (A1 extra)
--   Callback Final (4.6 b, section 5 definition):
--     _cf1_is_callback_final(round), _cf1_eligible_roster_count(round), _cf1_final_minimum_ok(round),
--     _cf1_count_available_entries(uuid[])     (A1 extra: apply / start count over an explicit entry list)
--   Exclusion (4.7):
--     table event_competition_round_exclusions (insert-only, RLS on, no policies, no grants, ENABLE ALWAYS history triggers)
--     _cf1_heat_entry_is_excluded(heat_entry), _cf1_excluded_entries(round)
--   Catalogue:
--     _cf1_error_codes()                       the codes A1 owns, SQLSTATE, retryability, thrown-by package
--
-- Every function is SECURITY DEFINER (the table has no grants and the readers must reach evidence the caller cannot), VOLATILE
-- unless stated, search_path = public, pg_temp, and carries NO grant to anon, authenticated or service_role (design U70).
-- Locking: every function here is a plain reader and takes no locks of its own; callers hold their own (entries FOR SHARE in id
-- order, then a fresh revalidation statement, 4.6 / A.3). The reader result is only as stable as the caller's locks.
--
-- Apply order: slot 20270120085000, after HL1 (20270119090000), before the CF1 core (20270120090000), SQL before app.
-- Rollback: rollback/20270120085000_competition_cf1_a1_eligibility_helpers_rollback.sql, LAST of the CF1 rollbacks; refused once
-- an exclusion row exists (roll forward only).

begin;

do $$
begin
  if to_regprocedure('public._compe2_round_entries(uuid)') is null
     or to_regprocedure('public._compe2_round_role(uuid)') is null then
    raise exception 'CF1-A1 preflight: E2 ballots (20270102) are missing.';
  end if;
  if to_regprocedure('public.competition_heat_entry_is_no_show(uuid)') is null then
    raise exception 'CF1-A1 preflight: NS1 (20270115) is missing.';
  end if;
  if to_regprocedure('public._hl1_heat_is_danced(uuid,text)') is null then
    raise exception 'CF1-A1 preflight: HL1 (20270119) is missing.';
  end if;
  if to_regprocedure('public.protect_competition_history_evidence()') is null then
    raise exception 'CF1-A1 preflight: 10A competition authority is missing.';
  end if;
  if to_regclass('public.event_orders') is null or to_regclass('public.event_registrations') is null then
    raise exception 'CF1-A1 preflight: registration / order tables are missing.';
  end if;
  if to_regclass('public.event_competition_round_exclusions') is not null then
    raise exception 'CF1-A1 preflight: event_competition_round_exclusions already exists.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Exclusion table (4.7). Insert-only; written only by the A5 functions (definer). No direct grants of any kind.
-- ---------------------------------------------------------------------------
create table public.event_competition_round_exclusions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null,
  entry_id uuid not null,
  evidence_heat_entry_ids uuid[] not null default '{}'::uuid[],
  kind text not null,
  reason_kind text not null,
  reason text not null,
  actor uuid not null,
  actor_role text not null,
  at timestamptz not null default now(),
  request_id uuid not null,
  transaction_id bigint not null default txid_current(),
  seq integer not null,
  decision_id uuid references public.event_competition_round_exclusions(id),
  reverses_id uuid references public.event_competition_round_exclusions(id),
  constraint event_competition_round_exclusions_round_fk
    foreign key (round_id, event_id) references public.event_competition_rounds(id, event_id),
  constraint event_competition_round_exclusions_entry_fk
    foreign key (entry_id, event_id) references public.event_competition_entries(id, event_id),
  constraint event_competition_round_exclusions_kind_check
    check (kind in ('exclude_requested', 'exclude_cosigned', 'reverse_requested', 'reverse_cosigned')),
  constraint event_competition_round_exclusions_reason_kind_check
    check (reason_kind in ('ineligible', 'refunded', 'other')),
  constraint event_competition_round_exclusions_reason_check
    -- at least 3 VISIBLE characters: ASCII whitespace, NBSP (U+00A0), U+200B-U+200D, U+FEFF, LRM/RLM (U+200E/F) and the soft hyphen (U+00AD)
    -- are not counted, so a blank or invisible-only reason cannot become permanent audit text
    check (length(regexp_replace(reason, '[[:space:]\u00A0\u200B-\u200D\uFEFF\u200E\u200F\u00AD]', '', 'g')) >= 3 and length(btrim(reason)) <= 500),
  constraint event_competition_round_exclusions_actor_role_check
    check (actor_role in ('chair', 'manager')),
  constraint event_competition_round_exclusions_seq_check check (seq >= 1),
  constraint event_competition_round_exclusions_decision_check
    check ((kind in ('exclude_requested', 'reverse_requested')) = (decision_id is null)),
  constraint event_competition_round_exclusions_reverses_check
    check ((kind = 'reverse_requested' and reverses_id is not null)
           or (kind in ('exclude_requested', 'exclude_cosigned') and reverses_id is null)
           or kind = 'reverse_cosigned'),
  constraint event_competition_round_exclusions_not_self_check
    check (decision_id is distinct from id and reverses_id is distinct from id),
  unique (request_id),
  unique (round_id, seq)
);
create index event_competition_round_exclusions_effective_idx
  on public.event_competition_round_exclusions(round_id, entry_id, seq desc)
  where kind in ('exclude_cosigned', 'reverse_cosigned');
create index event_competition_round_exclusions_entry_idx on public.event_competition_round_exclusions(entry_id);

comment on table public.event_competition_round_exclusions is
  'CF1 OD-20: insert-only "Excluded, with reason" decisions keyed by (round, entry). A decision takes effect only when its co-sign row exists; the effective state of a couple is its highest-seq co-signed row. Written only by the A5 definer functions; no direct grants.';

alter table public.event_competition_round_exclusions enable row level security;
revoke all on public.event_competition_round_exclusions from public, anon, authenticated, service_role;

create trigger protect_event_competition_round_exclusions_history
  before update or delete on public.event_competition_round_exclusions
  for each row execute function public.protect_competition_history_evidence();
create trigger protect_event_competition_round_exclusions_history_truncate
  before truncate on public.event_competition_round_exclusions
  for each statement execute function public.protect_competition_history_evidence();
-- ENABLE ALWAYS: fire under session_replication_role = replica as well (4.7).
alter table public.event_competition_round_exclusions enable always trigger protect_event_competition_round_exclusions_history;
alter table public.event_competition_round_exclusions enable always trigger protect_event_competition_round_exclusions_history_truncate;

-- ---------------------------------------------------------------------------
-- 2. Predicate P (4.6). One definition; unavailable = any of
--    (i) entry status <> 'confirmed', (ii) eligibility_status = 'ineligible',
--    (iii-a) its own registration has status in (cancelled, refunded) or payment_status in (failed, refunded),
--    (iii-b) its own order has payment_status in (failed, refunded).
--    A partially_refunded order excludes nobody; a per-entry refund inside a still-paid order and an entry with neither link are
--    accepted false negatives until R2. event_registrations.status / payment_status have no CHECK, so only the listed values count.
-- ---------------------------------------------------------------------------
create function public._cf1_entry_unavailable_reason(p_entry_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when e.id is null then 'entry_missing'
    when e.status is distinct from 'confirmed' then 'entry_not_confirmed'
    when e.eligibility_status = 'ineligible' then 'entry_ineligible'
    when r.status = 'cancelled' then 'registration_cancelled'
    when r.status = 'refunded' then 'registration_refunded'
    when r.payment_status = 'failed' then 'registration_payment_failed'
    when r.payment_status = 'refunded' then 'registration_payment_refunded'
    when o.payment_status = 'failed' then 'order_payment_failed'
    when o.payment_status = 'refunded' then 'order_payment_refunded'
    else null
  end
  from (select 1) one
  left join public.event_competition_entries e on e.id = p_entry_id
  left join public.event_registrations r on r.id = e.registration_id
  left join public.event_orders o on o.id = e.order_id;
$$;
revoke all on function public._cf1_entry_unavailable_reason(uuid) from public, anon, authenticated, service_role;

create function public._cf1_entry_unavailable(p_entry_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public._cf1_entry_unavailable_reason(p_entry_id) is not null;
$$;
revoke all on function public._cf1_entry_unavailable(uuid) from public, anon, authenticated, service_role;

-- The ranking set is E2's (_compe2_round_entries); it is never re-derived here. Excluded and no-show couples are already out of it.
create function public._cf1_round_roster_problems(p_round_id uuid)
returns table(entry_id uuid, reason text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select x.entry_id, x.reason
  from (select u.entry_id, public._cf1_entry_unavailable_reason(u.entry_id) as reason
        from unnest(public._compe2_round_entries(p_round_id)) as u(entry_id)) x
  where x.reason is not null
  order by x.entry_id;
$$;
revoke all on function public._cf1_round_roster_problems(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Callback Final and the minimum of two (4.6 b). Callback Finals ONLY: never a Final-only division.
-- ---------------------------------------------------------------------------
create function public._cf1_is_callback_final(p_round_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.event_competition_rounds f
    join public.event_competition_rounds p
      on p.division_id = f.division_id and p.program_id = f.program_id and p.event_id = f.event_id
     and p.sequence_number = f.sequence_number - 1
    join public.event_competition_programs g on g.id = p.program_id and g.event_id = p.event_id
    where f.id = p_round_id
      and f.round_type = 'final'
      and p.round_type = 'preliminary'
      and g.advancement_method = 'promote_callback'
  );
$$;
revoke all on function public._cf1_is_callback_final(uuid) from public, anon, authenticated, service_role;

-- Number of couples in the list that are available (not P). Duplicates and nulls count once / not at all.
create function public._cf1_count_available_entries(p_entry_ids uuid[])
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from (select distinct u.entry_id from unnest(coalesce(p_entry_ids, '{}'::uuid[])) as u(entry_id) where u.entry_id is not null) d
  where not public._cf1_entry_unavailable(d.entry_id);
$$;
revoke all on function public._cf1_count_available_entries(uuid[]) from public, anon, authenticated, service_role;

-- Eligible couples of a round: its ranking set (non-scratched, and once A3 lands not excluded and not no-show) minus P.
create function public._cf1_eligible_roster_count(p_round_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public._cf1_count_available_entries(public._compe2_round_entries(p_round_id));
$$;
revoke all on function public._cf1_eligible_roster_count(uuid) from public, anon, authenticated, service_role;

-- true when the minimum holds or does not apply; false only for a callback Final with fewer than two eligible couples.
create function public._cf1_final_minimum_ok(p_round_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not public._cf1_is_callback_final(p_round_id) or public._cf1_eligible_roster_count(p_round_id) >= 2;
$$;
revoke all on function public._cf1_final_minimum_ok(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Exclusion readers (4.7). The effective state of a couple in a round is its highest-seq CO-SIGNED row; a request alone
--    has no effect. True for every heat entry of the excluded entry in that round.
-- ---------------------------------------------------------------------------
create function public._cf1_heat_entry_is_excluded(p_heat_entry_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select x.kind = 'exclude_cosigned'
    from public.event_competition_heat_entries he
    join public.event_competition_heats h on h.id = he.heat_id and h.event_id = he.event_id
    join lateral (
      select ex.kind
      from public.event_competition_round_exclusions ex
      where ex.round_id = h.round_id and ex.entry_id = he.entry_id
        and ex.kind in ('exclude_cosigned', 'reverse_cosigned')
      order by ex.seq desc
      limit 1
    ) x on true
    where he.id = p_heat_entry_id
  ), false);
$$;
revoke all on function public._cf1_heat_entry_is_excluded(uuid) from public, anon, authenticated, service_role;

-- One row per currently excluded entry of the round: the effective (highest-seq co-signed) row.
create function public._cf1_excluded_entries(p_round_id uuid)
returns table(entry_id uuid, exclusion_id uuid, decision_id uuid, reason_kind text, reason text, seq integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select l.entry_id, l.id, l.decision_id, l.reason_kind, l.reason, l.seq
  from (
    select distinct on (ex.entry_id) ex.entry_id, ex.id, ex.decision_id, ex.reason_kind, ex.reason, ex.seq, ex.kind
    from public.event_competition_round_exclusions ex
    where ex.round_id = p_round_id and ex.kind in ('exclude_cosigned', 'reverse_cosigned')
    order by ex.entry_id, ex.seq desc
  ) l
  where l.kind = 'exclude_cosigned'
  order by l.entry_id;
$$;
revoke all on function public._cf1_excluded_entries(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Error-code catalogue and the shared raiser used by the lock / calculate / approve insertions (A2, A3).
-- ---------------------------------------------------------------------------
create function public._cf1_error_codes()
returns table(code text, sqlstate_code text, retryable boolean, raised_by text, meaning text)
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select * from (values
    ('COMP_ROSTER_ENTRY_UNAVAILABLE', 'P0001', false, 'A2 (lock), A3 (calculate, approve)', 'A ranking-set entry is unavailable by predicate P; detail holds the stage and the entries with reasons'),
    ('COMP_ROSTER_BELOW_MINIMUM', 'P0001', false, 'A2 (lock), A3 (calculate, approve)', 'A callback Final has fewer than two eligible couples'),
    ('COMP_ADVANCEMENT_BELOW_MINIMUM', 'P0001', false, 'A0 (apply), A6 (withdrawal)', 'Apply or a withdrawal would leave a callback Final with fewer than two eligible couples'),
    ('COMP_ADVANCEMENT_ROSTER_STALE', 'P0001', false, 'A0 (Final start guard)', 'A non-scratched roster entry is unavailable by predicate P at the first start'),
    ('COMP_ADVANCEMENT_ROSTER_INCOMPLETE', 'P0001', false, 'A0 (Final start guard)', 'The Final heat roster differs from the advancement entries minus effective withdrawals'),
    ('COMP_EXCLUSION_NOT_DANCED', 'P0001', false, 'A5 (exclusion action)', 'The couple has no heat entry in a danced heat of the round (HL1 rule); use a scratch, a withdrawal or an NS1 no-show'),
    ('COMP_CALLBACK_TARGET_BELOW_MINIMUM', 'P0001', false, 'A4a (F2 setup guard)', 'A callback round of a callback-plus-Final program has target_advancement_count below 2 (OD-21)')
  ) as t(code, sqlstate_code, retryable, raised_by, meaning);
$$;
revoke all on function public._cf1_error_codes() from public, anon, authenticated, service_role;

-- Raises the OD-17 D errors. Call after the caller's replay branch and its own locks. p_stage in ('lock', 'calculate', 'approve').
-- Unavailable entries first (all of them, with reasons, in detail); then, for a callback Final only, the minimum of two.
create function public._cf1_require_roster_eligible(p_round_id uuid, p_stage text)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_problems jsonb;
  v_count integer;
begin
  if p_stage is null or p_stage not in ('lock', 'calculate', 'approve') then
    raise exception 'CF1-A1: unknown roster stage %.', coalesce(p_stage, '(null)') using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('entry_id', p.entry_id, 'reason', p.reason) order by p.entry_id), '[]'::jsonb)
    into v_problems
  from public._cf1_round_roster_problems(p_round_id) p;
  if jsonb_array_length(v_problems) > 0 then
    raise exception 'COMP_ROSTER_ENTRY_UNAVAILABLE: % couple(s) in the ranking set are ineligible, refunded or cancelled.', jsonb_array_length(v_problems)
      using errcode = 'P0001',
            detail = jsonb_build_object('stage', p_stage, 'round_id', p_round_id, 'entries', v_problems)::text;
  end if;
  if public._cf1_is_callback_final(p_round_id) then
    v_count := public._cf1_eligible_roster_count(p_round_id);
    if v_count < 2 then
      raise exception 'COMP_ROSTER_BELOW_MINIMUM: a callback Final needs at least two eligible couples; it has %.', v_count
        using errcode = 'P0001',
              detail = jsonb_build_object('stage', p_stage, 'round_id', p_round_id, 'eligible', v_count, 'minimum', 2)::text;
    end if;
  end if;
end;
$$;
revoke all on function public._cf1_require_roster_eligible(uuid, text) from public, anon, authenticated, service_role;

commit;
