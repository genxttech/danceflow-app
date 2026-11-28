-- 20270122090000_competition_f3_publication.sql
--
-- PHASE 10 -- F3: result publication exit (release blocker RB2, CF1 gate U66). Contract: docs/competition/scoring-results-contract.md
-- sections 3 (publications table), 4 (approved -> published, corrections, supersede, withdraw), 4.1 (exceptions), 7 (reader matrix),
-- 8 (audit kinds result_published / result_superseded / result_withdrawn). The reserved K0 slot 20270105090000 sorts before F2, so F3 ships
-- here, after CF1 A7 (20270120095500). LOCAL ONLY until separately authorized; nothing here is applied to a hosted project.
--
-- Adds
--   event_competition_result_publications   insert-only evidence; only the three withdraw / supersede stamps may be set, once each,
--                                           by the RPCs below (guard triggers). Column names are the ones F2 (complete), E2 (reopen), O1 (cancel)
--                                           and CF1 A5 already read: round_id, withdrawn_at, superseded_by.
--   publish_competition_round_result(round, version, visibility, request)         approved -> published (the K0 edge; one writer)
--   withdraw_competition_round_result(round, publication, reason, request)        hides a CURRENT publication from every non-manager reader
--   competition_round_publications(round)                                          manager history (all publications, reasons)
--   competition_round_results_public(round), competition_event_results_public(event)   public reader (visibility = 'public' only; anon + authenticated)
--   (INT5-SECFIX P2-2) all three readers also require _compf3_live(): the publication is current AND the round is published / complete with no open
--   correction AND the version is the round's latest approved one. A correction opened on a published round hides the stale result at once
--   (the round reader answers {published:false, under_review:true}); it reappears only as the superseding publication of the corrected result.
--   competition_my_results(event)                                                  entrant reader (own entries; others' names hidden unless public)
-- Redefines (anchors that must occur exactly once; otherwise this file raises and rolls back)
--   cf1_guard_advancement_correction()   A0: the "published needs F3" refusal now applies only while a CURRENT publication exists (or no publication row exists at all: fail closed)
--   _a5_cf1_require_no_publication(uuid) A5: the exclusion refusal now applies only while a CURRENT publication exists
--   event_competition_result_events_kind_check   + result_published, result_superseded, result_withdrawn
--
-- Publication rules (all enforced in the RPC; the table triggers are a backstop for any other writer):
--   * manager of the event with a verified email; request id required; idempotent on the request id (same request -> replayed result)
--   * round must be `approved`; the version must be the round's latest, `approved`, approved by a recorded approval, and its input hash must
--     still equal the hash of the current ballots (COMP_RESULT_STALE) -- a correction after approval invalidates the version, so it cannot be published
--   * a callback result with an undecided row (a tie over the Final's capacity) cannot be published (COMP_PUBLICATION_UNRESOLVED)
--   * an active advancement must belong to the version being published (COMP_PUBLICATION_UNRESOLVED)
--   * an unresolved competitive refund exception scoped to the round blocks publication (COMP_PUBLICATION_BLOCKED_BY_EXCEPTION; R2 table looked up
--     at call time, an unknown shape fails closed)
--   * the roster must still be eligible (the same CF1 check approve runs), so a refund after approval stops publication
--   * a version is published at most once, ever (a withdrawn version is never republished: recovery is correction -> recalculate -> approve -> publish)
--   * visibility defaults to `entrants`; `public` must be chosen explicitly (there is no program-level public_results column in this tree)
-- Withdraw: a manager with a reason (3-500 visible characters) withdraws the CURRENT publication while the round is published, COMPLETE (owner
--   decision, CF1 integration-4: a completed round may have its publication withdrawn), or in correction (ballots_locked, calculated, approved).
--   It hides the publication from entrants and the public at once, keeps it for managers, and never edits the result, the result version, its
--   rows or the round (a complete round stays complete). The publication row keeps who published it and when; the withdraw stamp (who, when, reason)
--   and one result_withdrawn audit row (publication id, version, input hash, round status at withdrawal) are added, nothing is deleted or rewritten. It is not an unpublish-and-restore: a withdrawn publication stays withdrawn. A new publication (supersede) is the exit.
-- Supersede: publishing a corrected version while an older publication is still current stamps the older one `superseded_by` in the same
--   transaction (publication_version + 1, one result_superseded audit row for the old publication).
--
-- Rollback: rollback/20270122090000_competition_f3_publication_rollback.sql (refuses once any publication row exists; app first).

begin;

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_kinds text;
begin
  if to_regclass('public.event_competition_result_publications') is not null then
    raise exception 'F3 preflight: event_competition_result_publications already exists (roll back or clean up a partial earlier run first).';
  end if;
  if to_regprocedure('public.approve_competition_round_result(uuid,uuid,text,uuid)') is null
     or to_regprocedure('public.complete_competition_round(uuid,uuid)') is null
     or to_regprocedure('public._compf2_event(uuid,uuid,uuid,text,uuid,text,text,uuid,text,jsonb)') is null
     or to_regprocedure('public._compf2_input_hash(uuid,text,text)') is null
     or to_regprocedure('public._compe2_round_role(uuid)') is null THEN
    raise exception 'F3 preflight: F2 / E2 results lifecycle is missing.';
  end if;
  if to_regprocedure('public.cf1_guard_advancement_correction()') is null
     or to_regprocedure('public._cf1_callback_successor(uuid)') is null
     or to_regprocedure('public._cf1_active_advancement(uuid)') is null
     or to_regprocedure('public._cf1_excluded_entries(uuid)') is null
     or to_regprocedure('public._cf1_require_roster_eligible(uuid,text)') is null
     or to_regprocedure('public._a5_cf1_require_no_publication(uuid)') is null
     or to_regprocedure('public._a5_cf1_reason_ok(text)') is null
     or to_regclass('public.event_competition_round_advancements') is null THEN
    raise exception 'F3 preflight: CF1 (A0, A1, A5) is missing; F3 stacks on CF1 A7.';
  end if;
  select pg_get_constraintdef(c.oid) into v_kinds from pg_constraint c
   where c.conrelid = 'public.event_competition_result_events'::regclass and c.conname = 'event_competition_result_events_kind_check';
  if v_kinds is null or position('advancement_revoked' in v_kinds) = 0 or position('result_published' in v_kinds) > 0 then
    raise exception 'F3 preflight: the result-events kind check is not the post-CF1-A0 shape (%).', coalesce(v_kinds, '(absent)');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Audit kinds
-- ---------------------------------------------------------------------------
alter table public.event_competition_result_events drop constraint event_competition_result_events_kind_check;
alter table public.event_competition_result_events add constraint event_competition_result_events_kind_check
  check (kind = any (array['round_state_changed', 'result_calculated', 'result_approved', 'result_approval_override', 'result_invalidated',
                           'advancement_applied', 'advancement_revoked',
                           'result_published', 'result_superseded', 'result_withdrawn']));

-- ---------------------------------------------------------------------------
-- 2. Table
-- ---------------------------------------------------------------------------
create table public.event_competition_result_publications (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null,
  result_version_id uuid not null,
  publication_version integer not null,
  visibility text not null default 'entrants',
  published_by uuid not null,
  published_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  withdrawn_by uuid,
  withdrawn_reason text,
  superseded_by uuid,
  request_id uuid not null,
  transaction_id bigint not null default txid_current(),
  constraint event_competition_result_publications_round_fk
    foreign key (round_id, event_id) references public.event_competition_rounds(id, event_id) on delete cascade,
  constraint event_competition_result_publications_version_fk
    foreign key (result_version_id, event_id) references public.event_competition_result_versions(id, event_id) on delete cascade,
  constraint event_competition_result_publications_id_event_key unique (id, event_id),
  constraint event_competition_result_publications_superseded_fk
    foreign key (superseded_by, event_id) references public.event_competition_result_publications(id, event_id)
    deferrable initially deferred,
  constraint event_competition_result_publications_visibility_check check (visibility in ('entrants', 'public')),
  constraint event_competition_result_publications_version_check check (publication_version >= 1),
  constraint event_competition_result_publications_withdrawn_check check (
    (withdrawn_at is null and withdrawn_by is null and withdrawn_reason is null)
    or (withdrawn_at is not null and withdrawn_by is not null and length(btrim(coalesce(withdrawn_reason, ''))) between 1 and 500)),
  constraint event_competition_result_publications_one_exit_check check (not (withdrawn_at is not null and superseded_by is not null)),
  constraint event_competition_result_publications_no_self_supersede check (superseded_by is distinct from id),
  unique (round_id, publication_version),
  unique (result_version_id),
  unique (request_id)
);
-- At most one CURRENT publication per round.
create unique index event_competition_result_publications_current_uidx
  on public.event_competition_result_publications(round_id) where withdrawn_at is null and superseded_by is null;
create index event_competition_result_publications_event_idx on public.event_competition_result_publications(event_id, round_id);

comment on table public.event_competition_result_publications is
  'F3: one row per publication of an approved result version. Insert-only evidence: the only changes are the once-only withdraw stamp (withdrawn_*) or the supersede stamp (superseded_by), written by withdraw_competition_round_result / publish_competition_round_result with their audit row in the same transaction. A current publication is withdrawn_at is null and superseded_by is null. Managers read this table; entrants and the public read only through the F3 read RPCs.';

create trigger protect_event_competition_result_publications_delete
  before delete on public.event_competition_result_publications
  for each row execute function public.protect_competition_history_evidence();
create trigger protect_event_competition_result_publications_truncate
  before truncate on public.event_competition_result_publications
  for each statement execute function public.protect_competition_history_evidence();

-- ---------------------------------------------------------------------------
-- 3. Guards (backstop for any writer other than the RPCs; the RPCs satisfy them by writing the audit row first)
-- ---------------------------------------------------------------------------
create function public._compf3_guard_publication_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ver public.event_competition_result_versions;
begin
  if new.withdrawn_at is not null or new.withdrawn_by is not null or new.withdrawn_reason is not null or new.superseded_by is not null then
    raise exception 'COMPF3_PUBLICATION_INSERT: a publication is inserted current; it is withdrawn or superseded later.' using errcode = '23514';
  end if;
  select * into v_ver from public.event_competition_result_versions v
   where v.id = new.result_version_id and v.event_id = new.event_id and v.round_id = new.round_id;
  if not found or v_ver.status <> 'approved'
     or not exists (select 1 from public.event_competition_result_approvals a where a.result_version_id = v_ver.id and a.event_id = v_ver.event_id) then
    raise exception 'COMPF3_PUBLICATION_VERSION: only an approved result version of the round can be published.' using errcode = '23514';
  end if;
  if not exists (select 1 from public.event_competition_result_events e
                 where e.kind = 'result_published' and e.event_id = new.event_id and e.round_id = new.round_id
                   and e.result_version_id = new.result_version_id and e.request_id = new.request_id
                   and e.actor_user_id = new.published_by and e.transaction_id = txid_current()
                   and e.refs ->> 'publication_id' = new.id::text) then
    raise exception 'COMPF3_PUBLICATION_WRITER: a publication is written only by publish_competition_round_result.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public._compf3_guard_publication_insert() from public, anon, authenticated, service_role;
create trigger compf3_guard_publication_insert
  before insert on public.event_competition_result_publications
  for each row execute function public._compf3_guard_publication_insert();

create function public._compf3_guard_publication_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (to_jsonb(new) - 'withdrawn_at' - 'withdrawn_by' - 'withdrawn_reason' - 'superseded_by')
     is distinct from (to_jsonb(old) - 'withdrawn_at' - 'withdrawn_by' - 'withdrawn_reason' - 'superseded_by') then
    raise exception 'COMPF3_PUBLICATION_IMMUTABLE: a publication is insert-only; only its withdraw or supersede stamp is written, once.' using errcode = '42501';
  end if;
  if old.withdrawn_at is not null or old.superseded_by is not null then
    raise exception 'COMPF3_PUBLICATION_FINAL: a withdrawn or superseded publication does not change again.' using errcode = '42501';
  end if;
  if new.superseded_by is not null and new.withdrawn_at is null then
    if not exists (select 1 from public.event_competition_result_events e
                   where e.kind = 'result_superseded' and e.event_id = old.event_id and e.round_id = old.round_id
                     and e.result_version_id = old.result_version_id and e.transaction_id = txid_current()
                     and e.refs ->> 'publication_id' = old.id::text and e.refs ->> 'superseded_by' = new.superseded_by::text) then
      raise exception 'COMPF3_PUBLICATION_WRITER: superseding is written only by publish_competition_round_result.' using errcode = '42501';
    end if;
  elsif new.withdrawn_at is not null and new.superseded_by is null then
    if not exists (select 1 from public.event_competition_result_events e
                   where e.kind = 'result_withdrawn' and e.event_id = old.event_id and e.round_id = old.round_id
                     and e.result_version_id = old.result_version_id and e.transaction_id = txid_current()
                     and e.actor_user_id = new.withdrawn_by
                     and e.refs ->> 'publication_id' = old.id::text) then
      raise exception 'COMPF3_PUBLICATION_WRITER: withdrawal is written only by withdraw_competition_round_result.' using errcode = '42501';
    end if;
  else
    raise exception 'COMPF3_PUBLICATION_STAMP: set exactly one of the withdraw stamp or the supersede stamp.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public._compf3_guard_publication_update() from public, anon, authenticated, service_role;
create trigger compf3_guard_publication_update
  before update on public.event_competition_result_publications
  for each row execute function public._compf3_guard_publication_update();

-- approved -> published is written only by publish_competition_round_result (F2/O1 guard the other edges).
create function public._compf3_guard_round_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status = 'approved' and new.status = 'published' then
    if not exists (select 1 from public.event_competition_result_events e
                   where e.round_id = old.id and e.event_id = old.event_id and e.kind = 'result_published'
                     and e.from_state = 'approved' and e.to_state = 'published' and e.transaction_id = txid_current()) then
      raise exception 'COMPF3_ROUND_WRITER: approved -> published is written only by publish_competition_round_result.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public._compf3_guard_round_status() from public, anon, authenticated, service_role;
create trigger compf3_guard_round_status
  before update of status on public.event_competition_rounds
  for each row execute function public._compf3_guard_round_status();

-- ---------------------------------------------------------------------------
-- 4. RLS and grants (managers read the table; everyone else goes through the read RPCs)
-- ---------------------------------------------------------------------------
alter table public.event_competition_result_publications enable row level security;
create policy competition_result_publications_manager_read on public.event_competition_result_publications
  for select to authenticated using (public.can_manage_event_competition(event_id));
revoke all on public.event_competition_result_publications from public, anon, authenticated, service_role;
grant select on public.event_competition_result_publications to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Helpers (no grants)
-- ---------------------------------------------------------------------------
-- INT5-SECFIX P2-2: a publication is READABLE (live) only while it is current AND its result is still the round's current approved result:
-- round published / complete, no open correction, the version approved and the round's latest. A correction opened after publishing (refund,
-- exclusion, judge error) turns the version stale and moves the round to ballots_locked, so the readers stop showing it at once; the publication
-- row itself is not withdrawn (a manager still decides that) and a recalculated + republished result supersedes it. Fail-closed: anything unknown is not live.
create function public._compf3_live(p_publication_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.event_competition_result_publications p
    join public.event_competition_rounds r on r.id = p.round_id and r.event_id = p.event_id
    join public.event_competition_result_versions v on v.id = p.result_version_id and v.event_id = p.event_id
    where p.id = p_publication_id and p.withdrawn_at is null and p.superseded_by is null
      and r.status in ('published', 'complete') and r.correction_open is not true
      and v.status = 'approved'
      and v.version = (select max(x.version) from public.event_competition_result_versions x where x.round_id = p.round_id and x.event_id = p.event_id));
$$;
revoke all on function public._compf3_live(uuid) from public, anon, authenticated, service_role;

create function public._compf3_current_publication(p_round_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id from public.event_competition_result_publications p
  where p.round_id = p_round_id and p.withdrawn_at is null and p.superseded_by is null;
$$;
revoke all on function public._compf3_current_publication(uuid) from public, anon, authenticated, service_role;

-- The reader payload of one publication. p_mine = entries the viewer owns (null for the public / manager-less callers);
-- p_names: show other couples' display names (never an excluded couple's, except to the couple itself). Never emits scores, traces, hashes, judges, approver identities or reasons.
create function public._compf3_payload(p_publication_id uuid, p_mine uuid[], p_names boolean)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'publication', jsonb_build_object('id', p.id, 'version', p.publication_version, 'published_at', p.published_at, 'visibility', p.visibility),
    'event_id', p.event_id,
    'round', jsonb_build_object('id', r.id, 'name', r.name, 'round_type', r.round_type, 'division_id', r.division_id,
                                'division_name', d.name, 'program_name', pr.name),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entry_number', e.entry_number,
        'display_name', case when e.id = any (coalesce(p_mine, '{}'::uuid[])) or (p_names and not exists (select 1 from public._cf1_excluded_entries(p.round_id) xx where xx.entry_id = e.id)) then e.display_name else null end,
        'placement', rr.placement, 'tie_group', rr.tie_group, 'advanced', rr.advanced, 'rating_band', rr.rating_band,
        'mine', e.id = any (coalesce(p_mine, '{}'::uuid[])))
        order by rr.placement nulls last, e.entry_number, rr.entry_id)
      from public.event_competition_result_rows rr
      join public.event_competition_entries e on e.id = rr.entry_id and e.event_id = rr.event_id
      where rr.result_version_id = p.result_version_id and rr.event_id = p.event_id), '[]'::jsonb),
    'excluded', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entry_number', e.entry_number,
        'display_name', case when e.id = any (coalesce(p_mine, '{}'::uuid[])) then e.display_name else null end,
        'mine', e.id = any (coalesce(p_mine, '{}'::uuid[]))) order by e.entry_number, x.entry_id)
      from public._cf1_excluded_entries(p.round_id) x
      join public.event_competition_entries e on e.id = x.entry_id and e.event_id = p.event_id), '[]'::jsonb))
  from public.event_competition_result_publications p
  join public.event_competition_rounds r on r.id = p.round_id and r.event_id = p.event_id
  left join public.event_competition_divisions d on d.id = r.division_id
  left join public.event_competition_programs pr on pr.id = r.program_id
  where p.id = p_publication_id;
$$;
revoke all on function public._compf3_payload(uuid, uuid[], boolean) from public, anon, authenticated, service_role;

-- The viewer's anchored entries in an event (competitor user, or a competitor / participant client linked to the viewer as self).
create function public._compf3_viewer_entries(p_event_id uuid, p_uid uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct ep.entry_id), '{}'::uuid[])
  from public.event_competition_entry_participants ep
  left join public.event_competition_competitors c on c.id = ep.competitor_id and c.event_id = ep.event_id
  where ep.event_id = p_event_id and p_uid is not null
    and (c.user_id = p_uid
         or exists (select 1 from public.client_account_links l
                    join public.events ev on ev.id = p_event_id and ev.studio_id = l.studio_id
                    where l.user_id = p_uid and l.status = 'linked' and l.relationship_type = 'self'
                      and l.client_id in (c.client_id, ep.client_id)));
$$;
revoke all on function public._compf3_viewer_entries(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. publish_competition_round_result: approved -> published
-- ---------------------------------------------------------------------------
create function public.publish_competition_round_result(
  p_round_id uuid, p_result_version_id uuid, p_visibility text, p_request_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_round public.event_competition_rounds;
  v_prev public.event_competition_result_events;
  v_ver public.event_competition_result_versions;
  v_visibility text := coalesce(nullif(btrim(p_visibility), ''), 'entrants');
  v_old public.event_competition_result_publications;
  v_pub_id uuid := gen_random_uuid();
  v_next integer;
  v_successor uuid;
  v_adv uuid;
  v_blocked boolean := false;
  v_hash text;
begin
  if v_uid is null or p_round_id is null or public._compe2_round_role(p_round_id) is distinct from 'manager' then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_VERIFIED_EMAIL_REQUIRED: a verified email credential is required to publish results.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if v_visibility not in ('entrants', 'public') then
    raise exception 'COMP_PUBLICATION_VISIBILITY: choose entrants or public.' using errcode = 'P0001';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for update;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;

  select * into v_prev from public.event_competition_result_events e where e.request_id = p_request_id;
  if found then
    if v_prev.kind = 'result_published' and v_prev.actor_user_id = v_uid and v_prev.round_id = p_round_id
       and v_prev.result_version_id is not distinct from p_result_version_id and v_prev.refs ->> 'visibility' = v_visibility then
      return jsonb_build_object('replayed', true, 'round_id', p_round_id, 'result_version_id', p_result_version_id,
        'publication_id', v_prev.refs ->> 'publication_id', 'publication_version', (v_prev.refs ->> 'publication_version')::integer,
        'visibility', v_visibility, 'status', 'published');
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status <> 'approved' then
    raise exception 'COMP_RESULT_INVALID_TRANSITION: only an approved round can be published (round is %).', v_round.status using errcode = 'P0001';
  end if;
  select * into v_ver from public.event_competition_result_versions v
   where v.id = p_result_version_id and v.round_id = p_round_id and v.event_id = v_round.event_id for update;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if v_ver.status <> 'approved' or v_ver.version <> (select max(x.version) from public.event_competition_result_versions x where x.round_id = p_round_id) then
    raise exception 'COMP_RESULT_STALE: this result version is not the round''s latest approved version (status %).', v_ver.status using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.event_competition_result_approvals a where a.result_version_id = v_ver.id and a.event_id = v_ver.event_id) then
    raise exception 'COMP_PUBLICATION_REQUIRES_APPROVAL: this result version has no recorded approval.' using errcode = 'P0001';
  end if;
  v_hash := public._compf2_input_hash(p_round_id, v_ver.engine_key, v_ver.engine_version);
  if v_hash is distinct from v_ver.input_hash then
    raise exception 'COMP_RESULT_STALE: the ballots changed after this result was approved; it cannot be published.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.event_competition_result_publications p where p.result_version_id = v_ver.id) then
    raise exception 'COMP_PUBLICATION_VERSION_USED: this result version was already published (and possibly withdrawn); a corrected, newly approved version is needed.'
      using errcode = 'P0001';
  end if;

  -- Unresolved callback result: an undecided row (tie over the Final's capacity) is never published.
  v_successor := public._cf1_callback_successor(p_round_id);
  if v_successor is not null then
    if exists (select 1 from public.event_competition_result_rows rr where rr.result_version_id = v_ver.id and rr.advanced is null) then
      raise exception 'COMP_PUBLICATION_UNRESOLVED: this callback result has an undecided row (a tie at the cut-off); it cannot be published.' using errcode = 'P0001';
    end if;
    v_adv := public._cf1_active_advancement(v_successor);
    if v_adv is not null and not exists (select 1 from public.event_competition_round_advancements a
                                         where a.id = v_adv and a.source_result_version_id = v_ver.id) then
      raise exception 'COMP_PUBLICATION_UNRESOLVED: the Final''s advancement was applied from a different result version.' using errcode = 'P0001';
    end if;
  end if;

  -- Owner Q2 (K0 4.1): an unresolved competitive refund exception scoped to this round blocks it. R2 owns the table; an unknown shape fails closed.
  if to_regclass('public.event_competition_refund_exception_scopes') is not null then
    begin
      execute 'select exists (select 1 from public.event_competition_refund_exception_scopes s where s.round_id = $1 and s.competitive_effect and s.resolved_at is null)'
        into v_blocked using p_round_id;
    exception when undefined_table or undefined_column or datatype_mismatch or syntax_error or invalid_text_representation or wrong_object_type then
      -- Only a wrong SHAPE fails closed here; a deadlock (40P01), lock timeout (55P03) or cancel propagates so the app can retry with the same request id.
      raise exception 'COMP_PUBLICATION_BLOCKED_BY_EXCEPTION: refund exception state could not be verified; publication is refused.' using errcode = 'P0001';
    end;
    if v_blocked then
      raise exception 'COMP_PUBLICATION_BLOCKED_BY_EXCEPTION: an unresolved refund exception affects this round; resolve it before publishing.' using errcode = 'P0001';
    end if;
  end if;

  -- The same roster check approve runs: a refund or ineligibility after approval stops publication.
  perform public._cf1_require_roster_eligible(p_round_id, 'approve');

  select coalesce(max(p.publication_version), 0) + 1 into v_next from public.event_competition_result_publications p where p.round_id = p_round_id;
  select * into v_old from public.event_competition_result_publications p
   where p.round_id = p_round_id and p.withdrawn_at is null and p.superseded_by is null for update;

  perform public._compf2_event(v_round.event_id, p_round_id, v_ver.id, 'result_published', v_uid, 'approved', 'published', p_request_id, null,
    jsonb_build_object('publication_id', v_pub_id, 'publication_version', v_next, 'visibility', v_visibility, 'version', v_ver.version,
                       'input_hash', v_ver.input_hash, 'supersedes_publication_id', v_old.id));
  if v_old.id is not null then
    -- The old row is stamped before the new row exists (the one-current index), so the self-reference is checked at commit whatever the caller's SET CONSTRAINTS says.
    set constraints public.event_competition_result_publications_superseded_fk deferred;
    perform public._compf2_event(v_round.event_id, p_round_id, v_old.result_version_id, 'result_superseded', v_uid, 'current', 'superseded',
      gen_random_uuid(), null,
      jsonb_build_object('publication_id', v_old.id, 'publication_version', v_old.publication_version, 'superseded_by', v_pub_id,
                         'superseded_by_version_id', v_ver.id, 'request_id', p_request_id));
    update public.event_competition_result_publications set superseded_by = v_pub_id where id = v_old.id;
  end if;
  insert into public.event_competition_result_publications
    (id, event_id, round_id, result_version_id, publication_version, visibility, published_by, request_id)
  values (v_pub_id, v_round.event_id, p_round_id, v_ver.id, v_next, v_visibility, v_uid, p_request_id);
  update public.event_competition_rounds set status = 'published', updated_at = now() where id = p_round_id;
  return jsonb_build_object('replayed', false, 'round_id', p_round_id, 'result_version_id', v_ver.id, 'publication_id', v_pub_id,
                            'publication_version', v_next, 'visibility', v_visibility, 'status', 'published',
                            'superseded_publication_id', v_old.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. withdraw_competition_round_result: hide a CURRENT publication (reason required, never edits the result)
-- ---------------------------------------------------------------------------
create function public.withdraw_competition_round_result(
  p_round_id uuid, p_publication_id uuid, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_round public.event_competition_rounds;
  v_prev public.event_competition_result_events;
  v_pub public.event_competition_result_publications;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_ver public.event_competition_result_versions;
begin
  if v_uid is null or p_round_id is null or p_publication_id is null or public._compe2_round_role(p_round_id) is distinct from 'manager' then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_VERIFIED_EMAIL_REQUIRED: a verified email credential is required to withdraw results.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if not public._a5_cf1_reason_ok(v_reason) then
    raise exception 'COMP_RESULT_REASON_REQUIRED: withdrawing a publication needs a reason (3-500 characters).' using errcode = 'P0001';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for update;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;

  select * into v_prev from public.event_competition_result_events e where e.request_id = p_request_id;
  if found then
    if v_prev.kind = 'result_withdrawn' and v_prev.actor_user_id = v_uid and v_prev.round_id = p_round_id
       and v_prev.refs ->> 'publication_id' = p_publication_id::text then
      return jsonb_build_object('replayed', true, 'round_id', p_round_id, 'publication_id', p_publication_id, 'status', 'withdrawn');
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status not in ('published', 'complete', 'ballots_locked', 'calculated', 'approved') then
    raise exception 'COMP_RESULT_INVALID_TRANSITION: a publication is withdrawn only while the round is published, complete or being corrected (round is %).', v_round.status
      using errcode = 'P0001';
  end if;
  select * into v_pub from public.event_competition_result_publications p
   where p.id = p_publication_id and p.round_id = p_round_id and p.event_id = v_round.event_id for update;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if v_pub.withdrawn_at is not null or v_pub.superseded_by is not null then
    raise exception 'COMP_PUBLICATION_NOT_CURRENT: that publication is already withdrawn or superseded.' using errcode = 'P0001';
  end if;

  select * into v_ver from public.event_competition_result_versions v where v.id = v_pub.result_version_id and v.event_id = v_pub.event_id;
  perform public._compf2_event(v_round.event_id, p_round_id, v_pub.result_version_id, 'result_withdrawn', v_uid, 'current', 'withdrawn', p_request_id, v_reason,
    jsonb_build_object('publication_id', v_pub.id, 'publication_version', v_pub.publication_version, 'visibility', v_pub.visibility,
                       'round_status', v_round.status, 'correction_open', v_round.correction_open,
                       'published_by', v_pub.published_by, 'published_at', v_pub.published_at,
                       'version', v_ver.version, 'input_hash', v_ver.input_hash, 'result_version_status', v_ver.status));
  update public.event_competition_result_publications
     set withdrawn_at = now(), withdrawn_by = v_uid, withdrawn_reason = v_reason
   where id = v_pub.id;
  return jsonb_build_object('replayed', false, 'round_id', p_round_id, 'publication_id', v_pub.id, 'publication_version', v_pub.publication_version,
                            'status', 'withdrawn');
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Reads
-- ---------------------------------------------------------------------------
-- Manager history: every publication of a round with its state and audit facts (reasons are managers' only).
create function public.competition_round_publications(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if public._compe2_round_role(p_round_id) is distinct from 'manager' then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'publication_version', p.publication_version, 'result_version_id', p.result_version_id, 'visibility', p.visibility,
      'published_by', p.published_by, 'published_at', p.published_at, 'withdrawn_at', p.withdrawn_at, 'withdrawn_by', p.withdrawn_by,
      'withdrawn_reason', p.withdrawn_reason, 'superseded_by', p.superseded_by,
      'state', case when p.withdrawn_at is not null then 'withdrawn' when p.superseded_by is not null then 'superseded' else 'current' end)
      order by p.publication_version desc)
    from public.event_competition_result_publications p
    where p.round_id = p_round_id), '[]'::jsonb);
end;
$$;

-- Public reader: only a CURRENT publication chosen as public, of a published public event. Anything else answers {published:false}; when a
-- public publication was withdrawn and nothing replaced it, under_review is true (K0 O4: a generic notice, never the reason).
create function public.competition_round_results_public(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_pub uuid;
  v_review boolean;
begin
  if p_round_id is null then
    return jsonb_build_object('published', false);
  end if;
  select p.id into v_pub
  from public.event_competition_result_publications p
  join public.events ev on ev.id = p.event_id and ev.status = 'published' and ev.visibility = 'public'
  where p.round_id = p_round_id and p.visibility = 'public' and p.withdrawn_at is null and p.superseded_by is null
    and public._compf3_live(p.id);
  if v_pub is not null then
    return jsonb_build_object('published', true, 'under_review', false) || public._compf3_payload(v_pub, null, true);
  end if;
  select exists (
    select 1 from public.event_competition_result_publications p
    join public.events ev on ev.id = p.event_id and ev.status = 'published' and ev.visibility = 'public'
    where p.round_id = p_round_id and p.visibility = 'public' and p.superseded_by is null
      and not exists (select 1 from public.event_competition_result_publications q
                      where q.round_id = p.round_id and q.publication_version > p.publication_version)
  ) into v_review;  -- the latest public publication is withdrawn, or current but no longer live (correction / stale): no data, only the notice
  return jsonb_build_object('published', false, 'under_review', coalesce(v_review, false));
end;
$$;

create function public.competition_event_results_public(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(public._compf3_payload(p.id, null, true) order by r.sequence_number, r.id), '[]'::jsonb)
  from public.event_competition_result_publications p
  join public.events ev on ev.id = p.event_id and ev.status = 'published' and ev.visibility = 'public'
  join public.event_competition_rounds r on r.id = p.round_id and r.event_id = p.event_id
  where p.event_id = p_event_id and p.visibility = 'public' and p.withdrawn_at is null and p.superseded_by is null
    and public._compf3_live(p.id);
$$;

-- Entrant reader: current publications (entrants or public) of rounds in which the caller's own entry competed. Other couples' names are
-- shown only when the publication is public; the caller's own rows are flagged `mine`.
create function public.competition_my_results(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_mine uuid[];
begin
  if v_uid is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  v_mine := public._compf3_viewer_entries(p_event_id, v_uid);
  if coalesce(array_length(v_mine, 1), 0) = 0 then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(public._compf3_payload(p.id, v_mine, p.visibility = 'public') order by r.sequence_number, r.id)
    from public.event_competition_result_publications p
    join public.event_competition_rounds r on r.id = p.round_id and r.event_id = p.event_id
    where p.event_id = p_event_id and p.withdrawn_at is null and p.superseded_by is null and public._compf3_live(p.id)
      and exists (select 1 from public.event_competition_result_rows rr
                  where rr.result_version_id = p.result_version_id and rr.event_id = p.event_id and rr.entry_id = any (v_mine))), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Redefine the two CF1 consumers so a WITHDRAWN publication no longer blocks the recovery route (anchors must occur exactly once)
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_old constant text := E'    if old.status = ''published'' then\n      raise exception ''COMP_ADVANCEMENT_PUBLISHED_NEEDS_F3';
  v_new constant text := E'    if old.status = ''published'' and (public._compf3_current_publication(new.id) is not null or not exists (select 1 from public.event_competition_result_publications pz where pz.round_id = new.id)) then\n      raise exception ''COMP_ADVANCEMENT_PUBLISHED_NEEDS_F3';
begin
  v_def := replace(pg_get_functiondef('public.cf1_guard_advancement_correction()'::regprocedure), E'\r', '');
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'F3 preflight: A0 cf1_guard_advancement_correction does not contain the expected published-needs-F3 anchor exactly once.';
  end if;
  execute replace(v_def, v_old, v_new);
  if position('_compf3_current_publication' in pg_get_functiondef('public.cf1_guard_advancement_correction()'::regprocedure)) = 0 then
    raise exception 'F3: cf1_guard_advancement_correction was not redefined.';
  end if;
end $$;

do $$
declare
  v_def text;
  v_old constant text := 'select exists (select 1 from public.event_competition_result_publications p where p.round_id = $1)';
  v_new constant text := 'select exists (select 1 from public.event_competition_result_publications p where p.round_id = $1 and p.withdrawn_at is null and p.superseded_by is null)';
begin
  v_def := replace(pg_get_functiondef('public._a5_cf1_require_no_publication(uuid)'::regprocedure), E'\r', '');
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'F3 preflight: A5 _a5_cf1_require_no_publication does not contain the expected publication-row anchor exactly once.';
  end if;
  execute replace(v_def, v_old, v_new);
  if position('superseded_by is null' in pg_get_functiondef('public._a5_cf1_require_no_publication(uuid)'::regprocedure)) = 0 then
    raise exception 'F3: _a5_cf1_require_no_publication was not redefined.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 10. Function grants (explicit; anon only on the two public readers)
-- ---------------------------------------------------------------------------
revoke all on function public.publish_competition_round_result(uuid, uuid, text, uuid) from public, anon, service_role;
revoke all on function public.withdraw_competition_round_result(uuid, uuid, text, uuid) from public, anon, service_role;
revoke all on function public.competition_round_publications(uuid) from public, anon, service_role;
revoke all on function public.competition_my_results(uuid) from public, anon, service_role;
revoke all on function public.competition_round_results_public(uuid) from public, anon, service_role;
revoke all on function public.competition_event_results_public(uuid) from public, anon, service_role;
grant execute on function public.publish_competition_round_result(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.withdraw_competition_round_result(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.competition_round_publications(uuid) to authenticated;
grant execute on function public.competition_my_results(uuid) to authenticated;
grant execute on function public.competition_round_results_public(uuid) to anon, authenticated;
grant execute on function public.competition_event_results_public(uuid) to anon, authenticated;

commit;
