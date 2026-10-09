-- Rollback for 20261105090000_twilio_tw2_consent_integrity.sql
--
-- Restores the exact pre-TW-2 catalog (fingerprint 84 items,
-- abc05513f8cd63f51786e5a71b5a175b) ONLY when no TW-2 consent evidence exists.
-- It refuses (and changes nothing) if any TW-2-attributed history row or any
-- phone-level opt-out row exists: restoring the old FKs/grants/trigger would let
-- that evidence be rewritten or deleted and would drop phone-level STOP records.
-- Roll the APPLICATION back first; this SQL is only for an unused TW-2 database.
-- No history row is deleted or modified by this file.

begin;

do $$
declare
  v_history int;
  v_phone_level int;
begin
  select count(*) into v_history from public.sms_consent_history where actor_type is not null;
  select count(*) into v_phone_level
  from public.sms_contact_permissions where client_id is null and organizer_contact_id is null;

  if v_history > 0 or v_phone_level > 0 then
    raise exception 'TW-2 rollback refused: % TW-2 consent history rows and % phone-level opt-out rows exist; they are compliance evidence and must not be lost.',
      v_history, v_phone_level;
  end if;
end $$;

-- New functions
drop function public.record_sms_public_opt_in(uuid, uuid, text, text, text);
drop function public.record_sms_inbound_opt_event(uuid, text, text);

-- Original staff consent function (20260601_sms_compliance_foundation.sql)
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
  v_existing public.sms_contact_permissions;
  v_result public.sms_contact_permissions;
  v_can_manage boolean := false;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_phone_e164 is null or length(trim(p_phone_e164)) < 8 then
    raise exception 'A valid phone number is required';
  end if;

  if p_consent_status not in ('unknown', 'opted_in', 'opted_out') then
    raise exception 'Invalid SMS consent status';
  end if;

  if (p_studio_id is null and p_organizer_id is null)
     or (p_studio_id is not null and p_organizer_id is not null) then
    raise exception 'Provide either a studio or organizer workspace';
  end if;

  if p_client_id is null and p_organizer_contact_id is null then
    raise exception 'A contact reference is required';
  end if;

  if p_studio_id is not null then
    select exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = p_studio_id
        and usr.user_id = v_user_id
        and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
    )
    into v_can_manage;
  else
    select exists (
      select 1
      from public.organizer_users ou
      where ou.organizer_id = p_organizer_id
        and ou.user_id = v_user_id
        and ou.role in ('organizer_owner', 'organizer_admin')
    )
    into v_can_manage;
  end if;

  if not v_can_manage then
    raise exception 'You do not have permission to update SMS consent';
  end if;

  select *
  into v_existing
  from public.sms_contact_permissions scp
  where coalesce(scp.studio_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(p_studio_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and coalesce(scp.organizer_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(p_organizer_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and coalesce(scp.client_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(p_client_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and coalesce(scp.organizer_contact_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(p_organizer_contact_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and scp.phone_e164 = p_phone_e164
  order by scp.updated_at desc
  limit 1;

  if v_existing.id is not null then
    update public.sms_contact_permissions
    set consent_status = p_consent_status,
        consent_source = p_consent_source,
        consent_note = p_consent_note,
        consent_at = case
          when p_consent_status = 'opted_in' then now()
          else consent_at
        end,
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
    returning *
    into v_result;

    return v_result;
  end if;

  insert into public.sms_contact_permissions (
    studio_id,
    organizer_id,
    client_id,
    organizer_contact_id,
    phone_e164,
    consent_status,
    consent_source,
    consent_note,
    consent_at,
    opted_out_at,
    opted_out_source,
    created_by,
    updated_by
  )
  values (
    p_studio_id,
    p_organizer_id,
    p_client_id,
    p_organizer_contact_id,
    p_phone_e164,
    p_consent_status,
    p_consent_source,
    p_consent_note,
    case when p_consent_status = 'opted_in' then now() else null end,
    case when p_consent_status = 'opted_out' then now() else null end,
    case when p_consent_status = 'opted_out' then coalesce(p_consent_source, 'manual') else null end,
    v_user_id,
    v_user_id
  )
  returning *
  into v_result;

  return v_result;
end;
$$;

-- Rebuild the original ACL in its original entry order:
-- {=X/postgres, postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres}
revoke all on function public.upsert_sms_contact_permission(uuid, uuid, uuid, uuid, text, text, text, text)
  from public, postgres, anon, authenticated, service_role;
grant execute on function public.upsert_sms_contact_permission(uuid, uuid, uuid, uuid, text, text, text, text) to public;
grant execute on function public.upsert_sms_contact_permission(uuid, uuid, uuid, uuid, text, text, text, text) to postgres;
grant execute on function public.upsert_sms_contact_permission(uuid, uuid, uuid, uuid, text, text, text, text) to anon;
grant execute on function public.upsert_sms_contact_permission(uuid, uuid, uuid, uuid, text, text, text, text) to authenticated;
grant execute on function public.upsert_sms_contact_permission(uuid, uuid, uuid, uuid, text, text, text, text) to service_role;

-- Original history trigger function (pre-TW-2 DEV/PROD definition)
create or replace function public.log_sms_consent_history()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event_type text := 'status_change';
begin
  if tg_op = 'INSERT' then
    v_event_type := 'created';

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
      changed_by,
      changed_at,
      event_type
    )
    values (
      new.id,
      new.studio_id,
      new.organizer_id,
      new.client_id,
      new.organizer_contact_id,
      new.phone_e164,
      null,
      new.consent_status,
      new.consent_source,
      new.consent_note,
      coalesce(new.updated_by, new.created_by),
      now(),
      v_event_type
    );

    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.consent_status is distinct from new.consent_status then
      v_event_type := 'status_change';
    elsif old.consent_note is distinct from new.consent_note
       or old.consent_source is distinct from new.consent_source then
      v_event_type := 'note_update';
    else
      return new;
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
      changed_by,
      changed_at,
      event_type
    )
    values (
      new.id,
      new.studio_id,
      new.organizer_id,
      new.client_id,
      new.organizer_contact_id,
      new.phone_e164,
      old.consent_status,
      new.consent_status,
      new.consent_source,
      new.consent_note,
      new.updated_by,
      now(),
      v_event_type
    );

    return new;
  end if;

  return new;
end;
$function$;

drop function public._sms_consent_set_context(text, text, uuid, text, text);
drop function public._sms_consent_clear_context();

-- sms_consent_history
drop trigger trg_sms_consent_history_immutable on public.sms_consent_history;
drop trigger trg_sms_consent_history_no_truncate on public.sms_consent_history;
drop function public.prevent_sms_consent_history_change();

comment on table public.sms_consent_history is null;

alter table public.sms_consent_history drop constraint sms_consent_history_event_type_check;
alter table public.sms_consent_history
  add constraint sms_consent_history_event_type_check
  check (event_type = any (array['created'::text, 'status_change'::text, 'note_update'::text]));

alter table public.sms_consent_history drop constraint sms_consent_history_actor_type_check;
alter table public.sms_consent_history
  drop column actor_type,
  drop column actor_role,
  drop column actor_name,
  drop column opted_out_source;

alter table public.sms_consent_history
  add constraint sms_consent_history_changed_by_fkey
    foreign key (changed_by) references auth.users(id) on delete set null,
  add constraint sms_consent_history_client_id_fkey
    foreign key (client_id) references public.clients(id) on delete set null,
  add constraint sms_consent_history_organizer_contact_id_fkey
    foreign key (organizer_contact_id) references public.organizer_contacts(id) on delete set null,
  add constraint sms_consent_history_sms_contact_permission_id_fkey
    foreign key (sms_contact_permission_id) references public.sms_contact_permissions(id) on delete cascade;

grant all on public.sms_consent_history to anon, authenticated, service_role;

-- sms_contact_permissions
drop index public.uq_sms_permission_studio_phone_level;
alter table public.sms_contact_permissions drop constraint sms_contact_permissions_phone_e164_check;
alter table public.sms_contact_permissions drop constraint sms_contact_permissions_contact_check;
alter table public.sms_contact_permissions
  add constraint sms_contact_permissions_contact_check check (
    client_id is not null
    or organizer_contact_id is not null
  );

create policy sms_permissions_studio_insert on public.sms_contact_permissions
for insert
with check (
  studio_id is not null
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = sms_contact_permissions.studio_id
      and usr.user_id = auth.uid()
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
);

create policy sms_permissions_studio_update on public.sms_contact_permissions
for update
using (
  studio_id is not null
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = sms_contact_permissions.studio_id
      and usr.user_id = auth.uid()
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
)
with check (
  studio_id is not null
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = sms_contact_permissions.studio_id
      and usr.user_id = auth.uid()
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
);

create policy sms_permissions_organizer_insert on public.sms_contact_permissions
for insert
with check (
  organizer_id is not null
  and exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = sms_contact_permissions.organizer_id
      and ou.user_id = auth.uid()
      and ou.role in ('organizer_owner', 'organizer_admin')
  )
);

create policy sms_permissions_organizer_update on public.sms_contact_permissions
for update
using (
  organizer_id is not null
  and exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = sms_contact_permissions.organizer_id
      and ou.user_id = auth.uid()
      and ou.role in ('organizer_owner', 'organizer_admin')
  )
)
with check (
  organizer_id is not null
  and exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = sms_contact_permissions.organizer_id
      and ou.user_id = auth.uid()
      and ou.role in ('organizer_owner', 'organizer_admin')
  )
);

grant all on public.sms_contact_permissions to anon, authenticated, service_role;

commit;
