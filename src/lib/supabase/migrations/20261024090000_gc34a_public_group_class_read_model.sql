-- GC-3.4A -- anonymous-safe public read model for canonical group classes.
--
-- Public Group Class discovery needs signed-out reads, but the existing appointments row-level security
-- is authenticated-only (and exposes whole rows to linked portal users). This migration deliberately does NOT widen any
-- table policy. It adds three narrow, read-only functions that return only a fixed list of safe columns and apply the
-- public rules inside the database:
--
--   public_group_class_occurrences(studio_slug, series_id, appointment_id, limit)
--       upcoming, publicly discoverable occurrences (or ONE occurrence by id, with its public state, so a shared link to a
--       cancelled / past class can say so instead of 404-ing);
--   public_group_class_series(series_id)
--       a read-only grouping summary for the series lineage (S1C-5 successor chain) that the given series belongs to.
--
-- Public rules (all enforced here, never in the caller):
--   * appointment_type = 'group_class' AND group_class_enrollment_policies.publicly_discoverable = true for THAT occurrence
--     (the occurrence policy is authoritative; no policy row = not public);
--   * the studio is publicly listed: studios.public_directory_enabled AND subscription_status in (active, trialing)
--     (the same rule every other public studio page applies);
--   * listings contain only future, not-cancelled (scheduled / confirmed) occurrences;
--   * the instructor display name is returned only for an ACTIVE instructor who enabled a public profile (the existing public
--     instructor rule);
--   * a single-occurrence lookup returns a public_state ('upcoming' | 'cancelled' | 'past') but only for a discoverable
--     occurrence of a publicly listed studio -- nothing hidden is exposed to keep an old link alive.
--
-- Safe columns only: ids, studio public identity, title, times, instructor display name (ONLY when the instructor chose a
-- public profile), a location label, capacity and a derived spots_remaining, and derived availability / enrollment / public
-- states. Never returned: attendees, attendance, notes, client ids, funding or pricing, accepted funding types, policy
-- internals, series definitions, contact data, or any other appointments column.
--
-- Posture: SECURITY DEFINER with a pinned search_path (the functions read tables anonymous roles cannot), STABLE, EXECUTE
-- revoked from PUBLIC and granted to anon and authenticated only. No data is written. Helpers get no grants.

begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- Internal helpers (no grants)
-- ---------------------------------------------------------------------------------------------------------------------

-- The first series of a lineage: follow split_from_series_id upward (successors point at their predecessor).
create function public._gc34a_series_root(p_series_id uuid)
returns uuid
language sql
stable
security definer
set search_path = 'public'
as $$
  with recursive up(id, parent_id, depth) as (
    select s.id, s.split_from_series_id, 0 from public.group_class_series s where s.id = p_series_id
    union all
    select s.id, s.split_from_series_id, u.depth + 1
    from public.group_class_series s
    join up u on s.id = u.parent_id
    where u.depth < 60
  )
  select up.id from up order by up.depth desc limit 1;
$$;

revoke all on function public._gc34a_series_root(uuid) from public, anon, authenticated, service_role;

-- A whole lineage: the root and every successor, with its depth.
create function public._gc34a_series_family(p_series_id uuid)
returns table (series_id uuid, depth integer)
language sql
stable
security definer
set search_path = 'public'
as $$
  with recursive fam(series_id, depth) as (
    select s.id, 0 from public.group_class_series s where s.id = public._gc34a_series_root(p_series_id)
    union all
    select c.id, f.depth + 1
    from public.group_class_series c
    join fam f on c.split_from_series_id = f.series_id
    where f.depth < 60
  )
  select fam.series_id, fam.depth from fam;
$$;

revoke all on function public._gc34a_series_family(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- Public read functions
-- ---------------------------------------------------------------------------------------------------------------------

create function public.public_group_class_occurrences(
  p_studio_slug text default null,
  p_series_id uuid default null,
  p_appointment_id uuid default null,
  p_limit integer default 60
)
returns table (
  appointment_id uuid,
  series_id uuid,
  series_root_id uuid,
  studio_slug text,
  studio_name text,
  studio_logo_url text,
  studio_city text,
  studio_state text,
  time_zone text,
  title text,
  starts_at timestamptz,
  ends_at timestamptz,
  instructor_name text,
  location_label text,
  capacity integer,
  spots_remaining integer,
  availability text,
  enrollment_state text,
  public_state text
)
language sql
stable
security definer
set search_path = 'public'
as $$
  with base as (
    select
      a.id,
      a.group_class_series_id,
      a.title,
      a.starts_at,
      a.ends_at,
      a.status::text as status,
      a.roster_capacity,
      a.location_name,
      st.slug as studio_slug,
      coalesce(nullif(btrim(st.public_name), ''), st.name) as studio_name,
      st.public_logo_url as studio_logo_url,
      st.city as studio_city,
      st.state as studio_state,
      coalesce(nullif(btrim(ss.timezone), ''), nullif(btrim(st.timezone), ''), 'America/New_York') as time_zone,
      case when i.public_profile_enabled = true and i.active = true
        then nullif(btrim(coalesce(i.first_name, '') || ' ' || coalesce(i.last_name, '')), '')
      end as instructor_name,
      coalesce(nullif(btrim(a.location_name), ''), nullif(btrim(r.name), '')) as location_label,
      gcep.self_enrollment_allowed
    from public.appointments a
    join public.group_class_enrollment_policies gcep on gcep.appointment_id = a.id
    join public.studios st on st.id = a.studio_id
    left join lateral (select s2.timezone from public.studio_settings s2 where s2.studio_id = a.studio_id limit 1) ss on true
    left join public.instructors i on i.id = a.instructor_id and i.studio_id = a.studio_id
    left join public.rooms r on r.id = a.room_id and r.studio_id = a.studio_id
    where a.appointment_type = 'group_class'::public.appointment_type
      and gcep.publicly_discoverable = true
      and st.public_directory_enabled = true
      and lower(btrim(coalesce(st.subscription_status, ''))) in ('active', 'trialing')
      and (p_studio_slug is null or st.slug = p_studio_slug)
      and (p_appointment_id is null or a.id = p_appointment_id)
      and (
        p_series_id is null
        or a.group_class_series_id in (select f.series_id from public._gc34a_series_family(p_series_id) f)
      )
      and (
        p_appointment_id is not null
        or (a.starts_at > now() and a.status::text in ('scheduled', 'confirmed'))
      )
    -- order and limit BEFORE the seat count so an anonymous caller can never make the database count seats for more than
    -- the (clamped) number of rows it asked for
    order by a.starts_at, a.id
    limit least(greatest(coalesce(p_limit, 60), 1), 100)
  ),
  counted as (
    select
      b.*,
      case when b.roster_capacity is null then null
           else greatest(b.roster_capacity - public._group_class_roster_reserved_count(b.id), 0)
      end as remaining,
      case
        when b.status = 'cancelled' then 'cancelled'
        when b.starts_at <= now() or b.status not in ('scheduled', 'confirmed') then 'past'
        else 'upcoming'
      end as pstate
    from base b
  )
  select
    c.id,
    c.group_class_series_id,
    case when c.group_class_series_id is null then null else public._gc34a_series_root(c.group_class_series_id) end,
    c.studio_slug,
    c.studio_name,
    c.studio_logo_url,
    c.studio_city,
    c.studio_state,
    c.time_zone,
    coalesce(nullif(btrim(c.title), ''), 'Group class'),
    c.starts_at,
    c.ends_at,
    c.instructor_name,
    c.location_label,
    c.roster_capacity,
    c.remaining,
    case when c.remaining is null then 'unlimited' when c.remaining = 0 then 'full' else 'available' end,
    case
      when c.pstate <> 'upcoming' then 'closed'
      when c.remaining = 0 then 'full'
      when c.self_enrollment_allowed is not true then 'unavailable'
      else 'open'
    end,
    c.pstate
  from counted c
  order by c.starts_at, c.id
  limit least(greatest(coalesce(p_limit, 60), 1), 100);
$$;

revoke all on function public.public_group_class_occurrences(text, uuid, uuid, integer) from public, service_role;
grant execute on function public.public_group_class_occurrences(text, uuid, uuid, integer) to anon, authenticated;

create function public.public_group_class_series(p_series_id uuid)
returns table (
  series_root_id uuid,
  studio_slug text,
  studio_name text,
  studio_logo_url text,
  studio_city text,
  studio_state text,
  time_zone text,
  title text,
  upcoming_count integer
)
language sql
stable
security definer
set search_path = 'public'
as $$
  with fam as (
    select f.series_id, f.depth from public._gc34a_series_family(p_series_id) f
  ),
  visible as (
    -- the lineage is public only if at least one of its occurrences is publicly discoverable in a public studio
    select a.id, a.studio_id, a.starts_at, a.status::text as status
    from public.appointments a
    join public.group_class_enrollment_policies gcep on gcep.appointment_id = a.id
    join public.studios st on st.id = a.studio_id
    where a.appointment_type = 'group_class'::public.appointment_type
      and a.group_class_series_id in (select fam.series_id from fam)
      and gcep.publicly_discoverable = true
      and st.public_directory_enabled = true
      and lower(btrim(coalesce(st.subscription_status, ''))) in ('active', 'trialing')
  )
  select
    public._gc34a_series_root(p_series_id),
    st.slug,
    coalesce(nullif(btrim(st.public_name), ''), st.name),
    st.public_logo_url,
    st.city,
    st.state,
    coalesce(nullif(btrim(ss.timezone), ''), nullif(btrim(st.timezone), ''), 'America/New_York'),
    -- the title of the most recent non-cancelled series in the lineage
    coalesce(
      (select s.title from public.group_class_series s join fam on fam.series_id = s.id
        where s.status <> 'cancelled' order by fam.depth desc limit 1),
      (select s.title from public.group_class_series s join fam on fam.series_id = s.id
        order by fam.depth desc limit 1)
    ),
    (select count(*)::integer from visible v where v.starts_at > now() and v.status in ('scheduled', 'confirmed'))
  from public.studios st
  left join lateral (select s2.timezone from public.studio_settings s2 where s2.studio_id = st.id limit 1) ss on true
  where st.id = (select v.studio_id from visible v limit 1);
$$;

revoke all on function public.public_group_class_series(uuid) from public, service_role;
grant execute on function public.public_group_class_series(uuid) to anon, authenticated;

commit;
