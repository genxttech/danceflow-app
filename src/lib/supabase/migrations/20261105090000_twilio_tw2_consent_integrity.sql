-- 20261105090000_twilio_tw2_consent_integrity.sql
--
-- TWILIO PHASE 2 -- TW-2: SMS consent integrity.
--
-- Goal: stored SMS consent is trustworthy and auditable.
--
--   1. Consumer STOP is authoritative. A studio+phone opted out by an inbound STOP
--      (Twilio Advanced Opt-Out, or a fallback STOP-equivalent keyword) cannot be
--      re-enabled by staff. Only the consumer can re-enable it, by texting START.
--      A fresh public opt-in does NOT clear a consumer STOP: Twilio keeps the number
--      blocked at the carrier until the consumer texts START, so clearing it locally
--      would make DanceFlow disagree with Twilio's block state.
--   2. A STOP is stored even when the phone matches no client: a studio-scoped
--      "phone-level" row in sms_contact_permissions (studio_id + phone_e164, no
--      client/contact identity, never opted_in). Every STOP also refreshes this row,
--      so a later client association with that phone stays blocked.
--   3. sms_consent_history -- a pre-existing table (present in DEV and PROD, not
--      previously tracked in the repo) written by trigger log_sms_consent_history --
--      becomes append-only evidence:
--        * UPDATE / DELETE / TRUNCATE refused for everyone by trigger;
--        * no write grants (SELECT only); existing select policies kept;
--        * FKs that would delete or rewrite evidence (permission cascade, client /
--          contact / actor set-null) are dropped; the ids stay as plain values;
--        * actor evidence is frozen on the row: actor_type, actor_role, actor_name
--          (changed_by keeps the actor id), plus opted_out_source;
--        * existing rows are preserved untouched.
--   4. Every consent write goes through a canonical SECURITY DEFINER function, which
--      sets a transaction-local event/actor context. The history trigger REQUIRES
--      that context, so an unattributed write cannot happen, and the current-state
--      change and its history row commit or fail together (same statement).
--        * upsert_sms_contact_permission  (staff; signature unchanged) -- now checks
--          the client belongs to the named studio / the contact belongs to the named
--          organizer, requires an ACTIVE studio / organizer role (inactive members
--          could previously edit), requires an E.164 phone, records the acting
--          staff member's id, display name and role, and refuses to clear a
--          consumer STOP.
--        * record_sms_inbound_opt_event   (service_role; inbound webhook STOP/START)
--        * record_sms_public_opt_in       (service_role; public lead/booking forms)
--   5. Direct INSERT / UPDATE / DELETE / TRUNCATE on sms_contact_permissions are
--      revoked from anon, authenticated and service_role; the write policies are
--      dropped. SELECT and the existing select policies are unchanged.
--
-- Send gating (unchanged contract, now complete): a send is allowed only when the
-- recipient client's row is opted_in AND no row for the same studio + phone
-- (client-level or phone-level) is opted_out. sms_contact_permissions stays the
-- operational source of truth; history is evidence, never replayed for sends.
--
-- DEV and PROD were compared before authoring: identical catalog fingerprint
-- (84 items, abc05513f8cd63f51786e5a71b5a175b), identical function bodies, and
-- aggregate-only legacy checks all 0 (bad phones, cross-studio client links,
-- cross-organizer contact links, phone-level rows, duplicate rows).

begin;

-- ---------------------------------------------------------------------------
-- Preflight: exact reviewed pre-state
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
  v_count int;
begin
  select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) into v_md5
  from pg_proc where oid = 'public.upsert_sms_contact_permission(uuid,uuid,uuid,uuid,text,text,text,text)'::regprocedure;
  if v_md5 is distinct from '795755677dfb5e0a3ee6818f649a7876' then
    raise exception 'TW-2 preflight: upsert_sms_contact_permission is not the reviewed definition (%).', v_md5;
  end if;

  select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) into v_md5
  from pg_proc where oid = 'public.log_sms_consent_history()'::regprocedure;
  if v_md5 is distinct from 'ae4e5bff871b8eca97be2fb7d66bf3cf' then
    raise exception 'TW-2 preflight: log_sms_consent_history is not the reviewed definition (%).', v_md5;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_sms_consent_history' and tgrelid = 'public.sms_contact_permissions'::regclass
  ) then
    raise exception 'TW-2 preflight: trg_sms_consent_history is missing.';
  end if;

  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'sms_consent_history';
  if v_count <> 14 then
    raise exception 'TW-2 preflight: sms_consent_history has % columns, expected 14.', v_count;
  end if;

  if to_regprocedure('public.record_sms_inbound_opt_event(uuid,text,text)') is not null
     or to_regprocedure('public.record_sms_public_opt_in(uuid,uuid,text,text,text)') is not null
     or to_regclass('public.uq_sms_permission_studio_phone_level') is not null
     or exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'sms_consent_history' and column_name = 'actor_type') then
    raise exception 'TW-2 preflight: TW-2 objects already exist.';
  end if;

  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sms_consent_history' and cmd <> 'SELECT') then
    raise exception 'TW-2 preflight: unexpected write policy on sms_consent_history.';
  end if;

  -- Adopted (previously untracked) history table: pin the observed DEV/PROD shape so the
  -- changes below cannot run against anything different.
  if not (select relrowsecurity from pg_class where oid = 'public.sms_consent_history'::regclass)
     or (select count(*) from pg_policies where schemaname = 'public' and tablename = 'sms_consent_history') <> 2
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sms_consent_history'
                    and policyname = 'sms_consent_history_studio_select' and cmd = 'SELECT')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sms_consent_history'
                    and policyname = 'sms_consent_history_organizer_select' and cmd = 'SELECT') then
    raise exception 'TW-2 preflight: sms_consent_history RLS/policies are not the reviewed shape.';
  end if;

  select count(*) into v_count
  from pg_constraint c
  join (values
    ('sms_consent_history_changed_by_fkey', 'auth.users'::regclass, 'n'),
    ('sms_consent_history_client_id_fkey', 'public.clients'::regclass, 'n'),
    ('sms_consent_history_organizer_contact_id_fkey', 'public.organizer_contacts'::regclass, 'n'),
    ('sms_consent_history_sms_contact_permission_id_fkey', 'public.sms_contact_permissions'::regclass, 'c'),
    ('sms_consent_history_studio_id_fkey', 'public.studios'::regclass, 'c'),
    ('sms_consent_history_organizer_id_fkey', 'public.organizers'::regclass, 'c')
  ) as e(conname, confrelid, deltype)
    on c.conname = e.conname and c.confrelid = e.confrelid and c.confdeltype::text = e.deltype
  where c.conrelid = 'public.sms_consent_history'::regclass and c.contype = 'f';
  if v_count <> 6
     or (select count(*) from pg_constraint where conrelid = 'public.sms_consent_history'::regclass and contype = 'f') <> 6 then
    raise exception 'TW-2 preflight: sms_consent_history foreign keys are not the reviewed shape.';
  end if;

  if not exists (select 1 from pg_constraint where conrelid = 'public.sms_consent_history'::regclass
                 and conname = 'sms_consent_history_event_type_check')
     or exists (select 1 from pg_trigger where tgrelid = 'public.sms_consent_history'::regclass and not tgisinternal) then
    raise exception 'TW-2 preflight: sms_consent_history constraints/triggers are not the reviewed shape.';
  end if;

  -- Aggregate only: every existing history row must satisfy the widened event_type check.
  select count(*) into v_count from public.sms_consent_history
  where event_type not in ('created', 'status_change', 'note_update');
  if v_count <> 0 then
    raise exception 'TW-2 preflight: % history rows have an unexpected event_type.', v_count;
  end if;

  -- Aggregate-only legacy safety (no row content is read or returned).
  select count(*) into v_count from public.sms_contact_permissions where phone_e164 !~ '^\+[1-9][0-9]{9,14}$';
  if v_count <> 0 then
    raise exception 'TW-2 preflight: % consent rows have a non-E.164 phone.', v_count;
  end if;

  select count(*) into v_count from public.sms_contact_permissions where client_id is null and organizer_contact_id is null;
  if v_count <> 0 then
    raise exception 'TW-2 preflight: % consent rows have no client/contact identity.', v_count;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. sms_contact_permissions: phone-level opt-out rows + phone format
-- ---------------------------------------------------------------------------
alter table public.sms_contact_permissions
  drop constraint sms_contact_permissions_contact_check;

-- A row identifies a client or organizer contact, or it is a studio-scoped
-- phone-level row, which can never grant consent (only opted_out / unknown).
alter table public.sms_contact_permissions
  add constraint sms_contact_permissions_contact_check check (
    client_id is not null
    or organizer_contact_id is not null
    or (studio_id is not null and consent_status <> 'opted_in')
  );

alter table public.sms_contact_permissions
  add constraint sms_contact_permissions_phone_e164_check
  check (phone_e164 ~ '^\+[1-9][0-9]{9,14}$') not valid;
alter table public.sms_contact_permissions
  validate constraint sms_contact_permissions_phone_e164_check;

create unique index uq_sms_permission_studio_phone_level
  on public.sms_contact_permissions (studio_id, phone_e164)
  where studio_id is not null and client_id is null and organizer_contact_id is null;

drop policy sms_permissions_studio_insert on public.sms_contact_permissions;
drop policy sms_permissions_studio_update on public.sms_contact_permissions;
drop policy sms_permissions_organizer_insert on public.sms_contact_permissions;
drop policy sms_permissions_organizer_update on public.sms_contact_permissions;

revoke all on public.sms_contact_permissions from public, anon, authenticated, service_role;
grant select on public.sms_contact_permissions to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. sms_consent_history: append-only evidence with frozen actor
-- ---------------------------------------------------------------------------
alter table public.sms_consent_history
  drop constraint sms_consent_history_sms_contact_permission_id_fkey,
  drop constraint sms_consent_history_client_id_fkey,
  drop constraint sms_consent_history_organizer_contact_id_fkey,
  drop constraint sms_consent_history_changed_by_fkey;

alter table public.sms_consent_history
  add column actor_type text,
  add column actor_role text,
  add column actor_name text,
  add column opted_out_source text;

alter table public.sms_consent_history
  add constraint sms_consent_history_actor_type_check
  check (actor_type is null or actor_type in ('staff', 'consumer', 'system'));

alter table public.sms_consent_history
  drop constraint sms_consent_history_event_type_check;
alter table public.sms_consent_history
  add constraint sms_consent_history_event_type_check check (
    event_type in (
      -- legacy (pre-TW-2) values
      'created', 'status_change', 'note_update',
      -- TW-2
      'staff_opt_in', 'staff_opt_out', 'staff_consent_update',
      'public_opt_in', 'inbound_stop', 'unknown_phone_stop', 'inbound_start'
    )
  );

comment on table public.sms_consent_history is
  'TW-2: append-only SMS consent evidence. Written only by trigger log_sms_consent_history from the canonical consent functions; UPDATE/DELETE/TRUNCATE refused.';

create or replace function public.prevent_sms_consent_history_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'SMS consent history is immutable.' using errcode = '42501';
end;
$$;

revoke all on function public.prevent_sms_consent_history_change() from public, anon, authenticated, service_role;

create trigger trg_sms_consent_history_immutable
  before update or delete on public.sms_consent_history
  for each row execute function public.prevent_sms_consent_history_change();

create trigger trg_sms_consent_history_no_truncate
  before truncate on public.sms_consent_history
  for each statement execute function public.prevent_sms_consent_history_change();

revoke all on public.sms_consent_history from public, anon, authenticated, service_role;
grant select on public.sms_consent_history to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Event/actor context + history trigger
-- ---------------------------------------------------------------------------
create or replace function public._sms_consent_set_context(
  p_event_type text,
  p_actor_type text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_actor_name text
)
returns void
language plpgsql
set search_path = public
as $$
begin
  perform set_config(
    'danceflow.sms_consent_context',
    jsonb_build_object(
      'event_type', p_event_type,
      'actor_type', p_actor_type,
      'actor_user_id', p_actor_user_id,
      'actor_role', p_actor_role,
      'actor_name', p_actor_name
    )::text,
    true
  );
end;
$$;

create or replace function public._sms_consent_clear_context()
returns void
language plpgsql
set search_path = public
as $$
begin
  perform set_config('danceflow.sms_consent_context', '', true);
end;
$$;

revoke all on function public._sms_consent_set_context(text, text, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public._sms_consent_clear_context() from public, anon, authenticated, service_role;

-- Same trigger/name as before; it now requires the canonical context, records the
-- frozen actor, and skips updates that change nothing meaningful.
create or replace function public.log_sms_consent_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx jsonb := nullif(current_setting('danceflow.sms_consent_context', true), '')::jsonb;
begin
  -- An update that changes no consent fact is not a consent event. This is also what lets
  -- the created_by / updated_by ON DELETE SET NULL actions run when a staff user is deleted.
  if tg_op = 'UPDATE'
     and old.consent_status is not distinct from new.consent_status
     and old.consent_source is not distinct from new.consent_source
     and old.consent_note is not distinct from new.consent_note
     and old.consent_at is not distinct from new.consent_at
     and old.opted_out_at is not distinct from new.opted_out_at
     and old.opted_out_source is not distinct from new.opted_out_source
     and old.studio_id is not distinct from new.studio_id
     and old.organizer_id is not distinct from new.organizer_id
     and old.client_id is not distinct from new.client_id
     and old.organizer_contact_id is not distinct from new.organizer_contact_id
     and old.phone_e164 is not distinct from new.phone_e164 then
    return new;
  end if;

  if v_ctx is null or coalesce(v_ctx->>'event_type', '') = '' or coalesce(v_ctx->>'actor_type', '') = '' then
    raise exception 'SMS consent changes must go through the canonical consent functions.'
      using errcode = '42501';
  end if;

  insert into public.sms_consent_history (
    sms_contact_permission_id,
    studio_id,
    organizer_id,
    client_id,
    organizer_contact_id,
    phone_e164,
    previous_consent_status,
    new_consent_status,
    consent_source,
    consent_note,
    opted_out_source,
    changed_by,
    changed_at,
    event_type,
    actor_type,
    actor_role,
    actor_name
  )
  values (
    new.id,
    new.studio_id,
    new.organizer_id,
    new.client_id,
    new.organizer_contact_id,
    new.phone_e164,
    case when tg_op = 'UPDATE' then old.consent_status else null end,
    new.consent_status,
    new.consent_source,
    new.consent_note,
    new.opted_out_source,
    nullif(v_ctx->>'actor_user_id', '')::uuid,
    now(),
    v_ctx->>'event_type',
    v_ctx->>'actor_type',
    nullif(v_ctx->>'actor_role', ''),
    nullif(v_ctx->>'actor_name', '')
  );

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Staff consent edits (signature unchanged)
-- ---------------------------------------------------------------------------
create or replace function public.upsert_sms_contact_permission(
  p_studio_id uuid,
  p_organizer_id uuid,
  p_client_id uuid,
  p_organizer_contact_id uuid,
  p_phone_e164 text,
  p_consent_status text,
  p_consent_source text default null,
  p_consent_note text default null
)
returns public.sms_contact_permissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_phone text := trim(coalesce(p_phone_e164, ''));
  v_role text;
  v_name text;
  v_existing public.sms_contact_permissions;
  v_result public.sms_contact_permissions;
  v_event text;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if v_phone !~ '^\+[1-9][0-9]{9,14}$' then
    raise exception 'A valid phone number is required' using errcode = '22023';
  end if;

  if p_consent_status is null or p_consent_status not in ('unknown', 'opted_in', 'opted_out') then
    raise exception 'Invalid SMS consent status' using errcode = '22023';
  end if;

  if (p_studio_id is null) = (p_organizer_id is null) then
    raise exception 'Provide either a studio or organizer workspace' using errcode = '22023';
  end if;

  if p_consent_note is not null and char_length(p_consent_note) > 1000 then
    raise exception 'SMS consent note is too long' using errcode = '22023';
  end if;

  if p_studio_id is not null then
    if p_client_id is null or p_organizer_contact_id is not null then
      raise exception 'A studio consent record must reference one of the studio''s clients' using errcode = '22023';
    end if;

    select usr.role::text into v_role
    from public.user_studio_roles usr
    where usr.studio_id = p_studio_id
      and usr.user_id = v_user_id
      and usr.active = true
      and usr.role::text in ('studio_owner', 'studio_admin', 'front_desk')
    order by case usr.role::text when 'studio_owner' then 1 when 'studio_admin' then 2 else 3 end
    limit 1;

    if v_role is null then
      raise exception 'You do not have permission to update SMS consent' using errcode = '42501';
    end if;

    if not exists (select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id) then
      raise exception 'Client not found for this studio' using errcode = 'P0002';
    end if;
  else
    if p_organizer_contact_id is null or p_client_id is not null then
      raise exception 'An organizer consent record must reference one of the organizer''s contacts' using errcode = '22023';
    end if;

    select ou.role::text into v_role
    from public.organizer_users ou
    where ou.organizer_id = p_organizer_id
      and ou.user_id = v_user_id
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin')
    order by case ou.role when 'organizer_owner' then 1 else 2 end
    limit 1;

    if v_role is null then
      raise exception 'You do not have permission to update SMS consent' using errcode = '42501';
    end if;

    if not exists (
      select 1 from public.organizer_contacts oc
      where oc.id = p_organizer_contact_id and oc.organizer_id = p_organizer_id
    ) then
      raise exception 'Contact not found for this organizer' using errcode = 'P0002';
    end if;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('sms_consent:' || coalesce(p_studio_id, p_organizer_id)::text || ':' || v_phone, 0)
  );

  select * into v_existing
  from public.sms_contact_permissions scp
  where scp.studio_id is not distinct from p_studio_id
    and scp.organizer_id is not distinct from p_organizer_id
    and scp.client_id is not distinct from p_client_id
    and scp.organizer_contact_id is not distinct from p_organizer_contact_id
    and scp.phone_e164 = v_phone
  order by scp.updated_at desc
  limit 1
  for update;

  -- Consumer STOP is authoritative: staff can never clear it, and a staff opt-out
  -- request leaves the consumer's opt-out evidence untouched.
  if p_studio_id is not null and exists (
    select 1 from public.sms_contact_permissions scp
    where scp.studio_id = p_studio_id
      and scp.phone_e164 = v_phone
      and scp.consent_status = 'opted_out'
      and scp.opted_out_source = 'twilio_inbound_stop'
  ) then
    if p_consent_status <> 'opted_out' then
      raise exception 'This number opted out by replying STOP. Only the contact can resubscribe, by texting START.'
        using errcode = '42501', hint = 'sms_consumer_opt_out_locked';
    end if;

    if v_existing.id is not null and v_existing.consent_status = 'opted_out' then
      return v_existing;
    end if;
  end if;

  if v_existing.id is not null
     and v_existing.consent_status = p_consent_status
     and v_existing.consent_source is not distinct from p_consent_source
     and v_existing.consent_note is not distinct from p_consent_note then
    return v_existing;
  end if;

  v_event := case
    when p_consent_status = 'opted_in' and v_existing.consent_status is distinct from 'opted_in' then 'staff_opt_in'
    when p_consent_status = 'opted_out' and v_existing.consent_status is distinct from 'opted_out' then 'staff_opt_out'
    else 'staff_consent_update'
  end;

  select coalesce(nullif(trim(p.full_name), ''), 'Studio staff') into v_name
  from public.profiles p where p.id = v_user_id;

  perform public._sms_consent_set_context(v_event, 'staff', v_user_id, v_role, coalesce(v_name, 'Studio staff'));

  if v_existing.id is not null then
    update public.sms_contact_permissions
    set consent_status = p_consent_status,
        consent_source = p_consent_source,
        consent_note = p_consent_note,
        consent_at = case when p_consent_status = 'opted_in' then now() else consent_at end,
        opted_out_at = case
          when p_consent_status = 'opted_out' then now()
          when p_consent_status = 'opted_in' then null
          else opted_out_at
        end,
        opted_out_source = case
          when p_consent_status = 'opted_out' then coalesce(p_consent_source, 'manual')
          when p_consent_status = 'opted_in' then null
          else opted_out_source
        end,
        updated_by = v_user_id,
        updated_at = now()
    where id = v_existing.id
    returning * into v_result;
  else
    insert into public.sms_contact_permissions (
      studio_id, organizer_id, client_id, organizer_contact_id, phone_e164,
      consent_status, consent_source, consent_note, consent_at, opted_out_at, opted_out_source,
      created_by, updated_by
    )
    values (
      p_studio_id, p_organizer_id, p_client_id, p_organizer_contact_id, v_phone,
      p_consent_status, p_consent_source, p_consent_note,
      case when p_consent_status = 'opted_in' then now() else null end,
      case when p_consent_status = 'opted_out' then now() else null end,
      case when p_consent_status = 'opted_out' then coalesce(p_consent_source, 'manual') else null end,
      v_user_id, v_user_id
    )
    returning * into v_result;
  end if;

  perform public._sms_consent_clear_context();
  return v_result;
end;
$$;

revoke all on function public.upsert_sms_contact_permission(uuid, uuid, uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.upsert_sms_contact_permission(uuid, uuid, uuid, uuid, text, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Inbound consumer STOP / START (trusted webhook, service_role only)
-- ---------------------------------------------------------------------------
create or replace function public.record_sms_inbound_opt_event(
  p_studio_id uuid,
  p_phone_e164 text,
  p_event text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := trim(coalesce(p_phone_e164, ''));
  v_has_identity boolean;
  v_rows int := 0;
  v_phone_level int := 0;
begin
  if p_studio_id is null or not exists (select 1 from public.studios s where s.id = p_studio_id) then
    raise exception 'Studio not found' using errcode = 'P0002';
  end if;

  if v_phone !~ '^\+[1-9][0-9]{9,14}$' then
    raise exception 'A valid phone number is required' using errcode = '22023';
  end if;

  if p_event is null or p_event not in ('stop', 'start') then
    raise exception 'Unsupported inbound consent event' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sms_consent:' || p_studio_id::text || ':' || v_phone, 0));

  if p_event = 'stop' then
    select exists (
      select 1 from public.sms_contact_permissions scp
      where scp.studio_id = p_studio_id and scp.phone_e164 = v_phone
        and (scp.client_id is not null or scp.organizer_contact_id is not null)
    ) into v_has_identity;

    perform public._sms_consent_set_context('inbound_stop', 'consumer', null, null, 'Contact (text reply)');

    -- consent_source / consent_at are kept so the original opt-in evidence survives.
    update public.sms_contact_permissions scp
    set consent_status = 'opted_out',
        opted_out_at = now(),
        opted_out_source = 'twilio_inbound_stop',
        updated_by = null,
        updated_at = now()
    where scp.studio_id = p_studio_id
      and scp.phone_e164 = v_phone
      and (scp.client_id is not null or scp.organizer_contact_id is not null)
      and not (scp.consent_status = 'opted_out' and scp.opted_out_source = 'twilio_inbound_stop');
    get diagnostics v_rows = row_count;

    perform public._sms_consent_set_context(
      case when v_has_identity then 'inbound_stop' else 'unknown_phone_stop' end,
      'consumer', null, null, 'Contact (text reply)'
    );

    insert into public.sms_contact_permissions (studio_id, phone_e164, consent_status, opted_out_at, opted_out_source)
    values (p_studio_id, v_phone, 'opted_out', now(), 'twilio_inbound_stop')
    on conflict (studio_id, phone_e164)
      where studio_id is not null and client_id is null and organizer_contact_id is null
    do update set
      consent_status = 'opted_out',
      opted_out_at = now(),
      opted_out_source = 'twilio_inbound_stop',
      updated_by = null,
      updated_at = now()
    where not (
      public.sms_contact_permissions.consent_status = 'opted_out'
      and public.sms_contact_permissions.opted_out_source = 'twilio_inbound_stop'
    );
    get diagnostics v_phone_level = row_count;
  else
    perform public._sms_consent_set_context('inbound_start', 'consumer', null, null, 'Contact (text reply)');

    -- START only restores rows with recorded prior consent; it never creates consent.
    update public.sms_contact_permissions scp
    set consent_status = 'opted_in',
        consent_at = now(),
        consent_source = 'twilio_inbound_start',
        opted_out_at = null,
        opted_out_source = null,
        updated_by = null,
        updated_at = now()
    where scp.studio_id = p_studio_id
      and scp.phone_e164 = v_phone
      and (scp.client_id is not null or scp.organizer_contact_id is not null)
      and scp.consent_status = 'opted_out'
      and scp.consent_at is not null;
    get diagnostics v_rows = row_count;

    -- The phone-level block is lifted; it never becomes consent.
    update public.sms_contact_permissions scp
    set consent_status = 'unknown',
        opted_out_at = null,
        opted_out_source = null,
        updated_by = null,
        updated_at = now()
    where scp.studio_id = p_studio_id
      and scp.phone_e164 = v_phone
      and scp.client_id is null
      and scp.organizer_contact_id is null
      and scp.consent_status = 'opted_out';
    get diagnostics v_phone_level = row_count;
  end if;

  perform public._sms_consent_clear_context();

  return jsonb_build_object('event', p_event, 'rows_changed', v_rows, 'phone_level_changed', v_phone_level);
end;
$$;

revoke all on function public.record_sms_inbound_opt_event(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.record_sms_inbound_opt_event(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Public form opt-in (trusted server action, service_role only)
-- ---------------------------------------------------------------------------
create or replace function public.record_sms_public_opt_in(
  p_studio_id uuid,
  p_client_id uuid,
  p_phone_e164 text,
  p_source text,
  p_note text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := trim(coalesce(p_phone_e164, ''));
  v_existing public.sms_contact_permissions;
  v_count int;
begin
  if p_source is null or p_source not in ('public_lead_form', 'public_booking_form') then
    raise exception 'Unsupported public consent source' using errcode = '22023';
  end if;

  if v_phone !~ '^\+[1-9][0-9]{9,14}$' then
    raise exception 'A valid phone number is required' using errcode = '22023';
  end if;

  if p_note is not null and char_length(p_note) > 1000 then
    raise exception 'SMS consent note is too long' using errcode = '22023';
  end if;

  if p_studio_id is null or p_client_id is null or not exists (
    select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id
  ) then
    raise exception 'Client not found for this studio' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sms_consent:' || p_studio_id::text || ':' || v_phone, 0));

  -- Any opt-out for this studio + phone wins: a web form never reverses an opt-out.
  if exists (
    select 1 from public.sms_contact_permissions scp
    where scp.studio_id = p_studio_id and scp.phone_e164 = v_phone and scp.consent_status = 'opted_out'
  ) then
    return 'opted_out';
  end if;

  select * into v_existing
  from public.sms_contact_permissions scp
  where scp.studio_id = p_studio_id and scp.client_id = p_client_id and scp.phone_e164 = v_phone
  for update;

  if v_existing.id is not null and v_existing.consent_status = 'opted_in' then
    return 'already_opted_in';
  end if;

  perform public._sms_consent_set_context('public_opt_in', 'consumer', null, null, 'Contact (public form)');

  if v_existing.id is not null then
    update public.sms_contact_permissions
    set consent_status = 'opted_in',
        consent_source = p_source,
        consent_at = now(),
        consent_note = p_note,
        opted_out_at = null,
        opted_out_source = null,
        updated_by = null,
        updated_at = now()
    where id = v_existing.id and consent_status = 'unknown';
    get diagnostics v_count = row_count;
    perform public._sms_consent_clear_context();
    return case when v_count = 1 then 'upgraded' else 'duplicate' end;
  end if;

  insert into public.sms_contact_permissions (
    studio_id, client_id, phone_e164, consent_status, consent_source, consent_at, consent_note
  )
  values (p_studio_id, p_client_id, v_phone, 'opted_in', p_source, now(), p_note)
  on conflict (studio_id, client_id, phone_e164) where studio_id is not null and client_id is not null
  do nothing;
  get diagnostics v_count = row_count;

  perform public._sms_consent_clear_context();
  return case when v_count = 1 then 'inserted' else 'duplicate' end;
end;
$$;

revoke all on function public.record_sms_public_opt_in(uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.record_sms_public_opt_in(uuid, uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['sms_contact_permissions', 'sms_consent_history'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'TW-2 postflight: RLS is off on %.', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and cmd <> 'SELECT') then
      raise exception 'TW-2 postflight: % still has a write policy.', t;
    end if;
    if exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = t
        and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
        and privilege_type <> 'SELECT'
    ) or exists (
      select 1 from information_schema.role_table_grants
      where table_schema = 'public' and table_name = t and grantee in ('anon', 'PUBLIC')
    ) then
      raise exception 'TW-2 postflight: % grants are too broad.', t;
    end if;
  end loop;

  if (select count(*) from pg_trigger
      where tgrelid = 'public.sms_consent_history'::regclass
        and tgname in ('trg_sms_consent_history_immutable', 'trg_sms_consent_history_no_truncate')) <> 2 then
    raise exception 'TW-2 postflight: history immutability triggers missing.';
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.sms_consent_history'::regclass and contype = 'f'
      and conname not in ('sms_consent_history_studio_id_fkey', 'sms_consent_history_organizer_id_fkey')
  ) then
    raise exception 'TW-2 postflight: evidence-rewriting FKs remain on sms_consent_history.';
  end if;

  if not (select convalidated from pg_constraint where conname = 'sms_contact_permissions_phone_e164_check') then
    raise exception 'TW-2 postflight: phone check not validated.';
  end if;

  if not (select prosecdef from pg_proc where oid = 'public.record_sms_inbound_opt_event(uuid,text,text)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.record_sms_public_opt_in(uuid,uuid,text,text,text)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.upsert_sms_contact_permission(uuid,uuid,uuid,uuid,text,text,text,text)'::regprocedure) then
    raise exception 'TW-2 postflight: consent functions must be SECURITY DEFINER.';
  end if;

  if has_function_privilege('authenticated', 'public.record_sms_inbound_opt_event(uuid,text,text)', 'execute')
     or has_function_privilege('anon', 'public.record_sms_inbound_opt_event(uuid,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.record_sms_public_opt_in(uuid,uuid,text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.record_sms_public_opt_in(uuid,uuid,text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.upsert_sms_contact_permission(uuid,uuid,uuid,uuid,text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public._sms_consent_set_context(text,text,uuid,text,text)', 'execute')
     or has_function_privilege('service_role', 'public._sms_consent_set_context(text,text,uuid,text,text)', 'execute') then
    raise exception 'TW-2 postflight: consent function grants are too broad.';
  end if;
end $$;

commit;
