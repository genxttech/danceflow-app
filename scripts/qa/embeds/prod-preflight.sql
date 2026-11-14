-- Website Embeds PROD PREFLIGHT (read-only, single statement; run through `sb.sh prod-read` / `sb.sh dev-read`, which wrap it in a read-only transaction).
-- Returns {"ready": true, "checks": {...}}. ready is true only when the migration is NOT yet applied and everything it depends on exists with the columns it uses.
-- Run it again right before applying (drift check). After applying, use postflight.sql instead.
select jsonb_build_object(
  'ready', (c.target_absent and c.deps_tables and c.deps_columns and c.deps_type and c.no_fixtures),
  'checks', to_jsonb(c)
) as embeds_preflight
from (
  select
    -- the migration must not already be applied (table and all five functions absent)
    (to_regclass('public.studio_embed_settings') is null
      and not exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('_embed_can_manage', 'public_studio_embed_settings', 'get_studio_embed_settings', 'set_studio_embed_settings', 'public_group_class_extras')
      )) as target_absent,
    -- tables the migration and the embed pages read
    (to_regclass('public.studios') is not null
      and to_regclass('public.appointments') is not null
      and to_regclass('public.group_class_series') is not null
      and to_regclass('public.group_class_enrollment_policies') is not null
      and to_regclass('public.user_studio_roles') is not null
      and to_regclass('public.events') is not null) as deps_tables,
    -- every column the migration's functions touch
    (select count(*) = 24 from (values
        ('studios', 'id'), ('studios', 'slug'), ('studios', 'name'), ('studios', 'timezone'), ('studios', 'subscription_status'), ('studios', 'public_directory_enabled'),
        ('appointments', 'id'), ('appointments', 'studio_id'), ('appointments', 'appointment_type'), ('appointments', 'group_class_series_id'),
        ('group_class_series', 'id'), ('group_class_series', 'studio_id'), ('group_class_series', 'description'),
        ('group_class_enrollment_policies', 'appointment_id'), ('group_class_enrollment_policies', 'publicly_discoverable'), ('group_class_enrollment_policies', 'self_enrollment_allowed'),
        ('group_class_enrollment_policies', 'accepted_funding_types'), ('group_class_enrollment_policies', 'direct_payment_amount'),
        ('user_studio_roles', 'user_id'), ('user_studio_roles', 'studio_id'), ('user_studio_roles', 'role'), ('user_studio_roles', 'active'),
        ('events', 'visibility'), ('events', 'public_directory_enabled')
      ) as need(t, col)
      where exists (select 1 from information_schema.columns ic where ic.table_schema = 'public' and ic.table_name = need.t and ic.column_name = need.col)
    ) as deps_columns,
    (exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'appointment_type')) as deps_type,
    -- the fictional DEV fixtures must never exist on the target
    (not exists (select 1 from public.studios where slug like 'embed-qa-fictional%')) as no_fixtures
) c;
