-- Website Embeds: studio-controlled settings, kill switch, and public class details (description, price).
--
-- Git-only until the owner authorizes applying it. The app tolerates this migration being absent (class details are simply omitted, the
-- builder shows defaults) EXCEPT for the kill switch: when the settings function errors, embeds fail CLOSED (404). Apply this before
-- the app release that serves embeds publicly.
--
-- Design
--   * public.studio_embed_settings: one row per studio. RLS is enabled with NO policies, and no role is granted table privileges, so
--     the table is reachable only through the SECURITY DEFINER functions below. No client can read or write another studio's row.
--   * Everything is opt-in except "embeds on": a studio with no row has embeds enabled (they only exist once someone pastes a snippet)
--     and shows no class description and no price until the owner turns those on.
--   * public_studio_embed_settings(slug): anon-callable, returns the flags of a PUBLIC (directory-listed, active/trialing) studio only.
--   * get/set_studio_embed_settings(studio): authenticated, active studio_owner or studio_admin of THAT studio only.
--   * public_group_class_extras(slug, ids): description and price for classes the public read model already exposes, and only when the
--     studio turned the matching flag on. The price rule mirrors the existing purchase flow (self enrollment allowed, direct_payment
--     accepted, amount > 0), so the embed never advertises a price the registration flow would not charge. Single (non-series) classes
--     have no description column, and appointments.notes is private and is never read here.

create table if not exists public.studio_embed_settings (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  embeds_enabled boolean not null default true,
  show_events boolean not null default true,
  show_class_description boolean not null default false,
  show_class_price boolean not null default false,
  default_view text not null default 'agenda' check (default_view in ('agenda', 'week', 'month')),
  default_theme text not null default 'light' check (default_theme in ('light', 'dark')),
  default_accent text check (default_accent is null or default_accent ~ '^#[0-9a-fA-F]{6}$'),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

alter table public.studio_embed_settings enable row level security;
revoke all on table public.studio_embed_settings from public, anon, authenticated, service_role;

create or replace function public._embed_can_manage(p_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and exists (
    select 1 from public.user_studio_roles r
    where r.user_id = auth.uid() and r.studio_id = p_studio_id and r.active = true
      and r.role::text in ('studio_owner', 'studio_admin')
  );
$$;
revoke all on function public._embed_can_manage(uuid) from public, anon, authenticated, service_role;

-- Public flags for a public studio. Zero rows for anything else (unknown slug, private studio, inactive subscription).
create or replace function public.public_studio_embed_settings(p_studio_slug text)
returns table (
  embeds_enabled boolean,
  show_events boolean,
  show_class_description boolean,
  show_class_price boolean,
  default_view text,
  default_theme text,
  default_accent text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(s.embeds_enabled, true),
    coalesce(s.show_events, true),
    coalesce(s.show_class_description, false),
    coalesce(s.show_class_price, false),
    coalesce(s.default_view, 'agenda'),
    coalesce(s.default_theme, 'light'),
    s.default_accent
  from public.studios st
  left join public.studio_embed_settings s on s.studio_id = st.id
  where st.slug = p_studio_slug
    and st.public_directory_enabled = true
    and lower(btrim(coalesce(st.subscription_status, ''))) in ('active', 'trialing')
  limit 1;
$$;
revoke all on function public.public_studio_embed_settings(text) from public, service_role;
grant execute on function public.public_studio_embed_settings(text) to anon, authenticated;

create or replace function public.get_studio_embed_settings(p_studio_id uuid)
returns table (
  embeds_enabled boolean,
  show_events boolean,
  show_class_description boolean,
  show_class_price boolean,
  default_view text,
  default_theme text,
  default_accent text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public._embed_can_manage(p_studio_id) then
    raise exception 'Not allowed to manage website embeds for this studio.' using errcode = '42501';
  end if;
  return query
    select coalesce(s.embeds_enabled, true), coalesce(s.show_events, true), coalesce(s.show_class_description, false),
           coalesce(s.show_class_price, false), coalesce(s.default_view, 'agenda'), coalesce(s.default_theme, 'light'), s.default_accent
    from (select 1) one
    left join public.studio_embed_settings s on s.studio_id = p_studio_id;
end;
$$;
revoke all on function public.get_studio_embed_settings(uuid) from public, anon, service_role;
grant execute on function public.get_studio_embed_settings(uuid) to authenticated;

create or replace function public.set_studio_embed_settings(
  p_studio_id uuid,
  p_embeds_enabled boolean,
  p_show_events boolean,
  p_show_class_description boolean,
  p_show_class_price boolean,
  p_default_view text,
  p_default_theme text,
  p_default_accent text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public._embed_can_manage(p_studio_id) then
    raise exception 'Not allowed to manage website embeds for this studio.' using errcode = '42501';
  end if;
  insert into public.studio_embed_settings as s (
    studio_id, embeds_enabled, show_events, show_class_description, show_class_price,
    default_view, default_theme, default_accent, updated_by, updated_at
  ) values (
    p_studio_id, coalesce(p_embeds_enabled, true), coalesce(p_show_events, true), coalesce(p_show_class_description, false),
    coalesce(p_show_class_price, false), coalesce(p_default_view, 'agenda'), coalesce(p_default_theme, 'light'),
    nullif(btrim(p_default_accent), ''), auth.uid(), now()
  )
  on conflict (studio_id) do update set
    embeds_enabled = excluded.embeds_enabled,
    show_events = excluded.show_events,
    show_class_description = excluded.show_class_description,
    show_class_price = excluded.show_class_price,
    default_view = excluded.default_view,
    default_theme = excluded.default_theme,
    default_accent = excluded.default_accent,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;
end;
$$;
revoke all on function public.set_studio_embed_settings(uuid, boolean, boolean, boolean, boolean, text, text, text) from public, anon, service_role;
grant execute on function public.set_studio_embed_settings(uuid, boolean, boolean, boolean, boolean, text, text, text) to authenticated;

-- Description and price for classes that are already public. At most 100 ids per call.
create or replace function public.public_group_class_extras(p_studio_slug text, p_appointment_ids uuid[])
returns table (
  appointment_id uuid,
  description text,
  price_amount numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id,
    case when coalesce(s.show_class_description, false) then nullif(btrim(gcs.description), '') end,
    case
      when coalesce(s.show_class_price, false)
        and gcep.self_enrollment_allowed = true
        and 'direct_payment' = any (coalesce(gcep.accepted_funding_types, '{}'::text[]))
        and coalesce(gcep.direct_payment_amount, 0) > 0
      then gcep.direct_payment_amount
    end
  from public.appointments a
  join public.group_class_enrollment_policies gcep on gcep.appointment_id = a.id
  join public.studios st on st.id = a.studio_id
  left join public.studio_embed_settings s on s.studio_id = st.id
  left join public.group_class_series gcs on gcs.id = a.group_class_series_id and gcs.studio_id = a.studio_id
  where a.appointment_type = 'group_class'::public.appointment_type
    and gcep.publicly_discoverable = true
    and st.public_directory_enabled = true
    and lower(btrim(coalesce(st.subscription_status, ''))) in ('active', 'trialing')
    and st.slug = p_studio_slug
    and coalesce(s.embeds_enabled, true) = true
    and a.id = any (p_appointment_ids[1:100])
  limit 100;
$$;
revoke all on function public.public_group_class_extras(text, uuid[]) from public, service_role;
grant execute on function public.public_group_class_extras(text, uuid[]) to anon, authenticated;
