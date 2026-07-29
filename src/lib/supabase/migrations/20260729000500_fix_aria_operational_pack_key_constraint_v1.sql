-- Fix ARIA operational pack key constraints and migrate legacy pack keys.
--
-- The failed prior version attempted to add the current 11-pack CHECK before
-- converting rows that still contained legacy pack keys.
--
-- Because that statement failed, the migration was not successfully applied.
-- Replace the prior local migration file with this version and rerun it.
--
-- Run in dev first, verify Save ARIA setup, then run the same migration in prod.

begin;

-- ---------------------------------------------------------------------------
-- 1. Remove existing pack-key CHECK constraints before converting legacy rows.
-- ---------------------------------------------------------------------------

alter table public.aria_automation_pack_preferences
  drop constraint if exists aria_automation_pack_preferences_pack_key_check;

alter table if exists public.aria_action_policies
  drop constraint if exists aria_action_policies_pack_key_check;

alter table if exists public.automation_rules
  drop constraint if exists automation_rules_pack_key_check;

-- ---------------------------------------------------------------------------
-- 2. Convert legacy preference rows to the current operational pack model.
--
-- Legacy -> current:
--   front_desk              -> front_desk
--   lead_follow_up          -> client_relations
--   schedule_readiness      -> scheduling
--   client_retention        -> sales_retention
--   documents               -> documents
--   membership_package_care -> sales_retention
--   post_lesson_closeout    -> client_relations
--   payment_follow_up       -> billing_payments
--
-- Multiple legacy packs can map to the same current pack. Insert/upsert first,
-- then remove the obsolete rows. Existing current-pack settings take
-- precedence, while missing legacy settings are retained through JSON merge.
-- ---------------------------------------------------------------------------

insert into public.aria_automation_pack_preferences (
  studio_id,
  pack_key,
  enabled,
  settings,
  updated_by,
  updated_at
)
select
  legacy.studio_id,
  legacy.current_pack_key,
  bool_or(legacy.enabled),
  coalesce(
    jsonb_object_agg(settings_entry.key, settings_entry.value)
      filter (where settings_entry.key is not null),
    '{}'::jsonb
  ),
  (array_agg(legacy.updated_by order by legacy.updated_at desc nulls last))[1],
  max(legacy.updated_at)
from (
  select
    p.studio_id,
    case p.pack_key
      when 'front_desk' then 'front_desk'
      when 'lead_follow_up' then 'client_relations'
      when 'schedule_readiness' then 'scheduling'
      when 'client_retention' then 'sales_retention'
      when 'documents' then 'documents'
      when 'membership_package_care' then 'sales_retention'
      when 'post_lesson_closeout' then 'client_relations'
      when 'payment_follow_up' then 'billing_payments'
      else p.pack_key
    end as current_pack_key,
    coalesce(p.enabled, true) as enabled,
    coalesce(p.settings, '{}'::jsonb) as settings,
    p.updated_by,
    p.updated_at
  from public.aria_automation_pack_preferences p
  where p.pack_key in (
    'front_desk',
    'lead_follow_up',
    'schedule_readiness',
    'client_retention',
    'documents',
    'membership_package_care',
    'post_lesson_closeout',
    'payment_follow_up'
  )
) legacy
left join lateral jsonb_each(legacy.settings) settings_entry on true
group by legacy.studio_id, legacy.current_pack_key
on conflict (studio_id, pack_key)
do update set
  enabled = public.aria_automation_pack_preferences.enabled,
  settings =
    coalesce(excluded.settings, '{}'::jsonb)
    || coalesce(public.aria_automation_pack_preferences.settings, '{}'::jsonb),
  updated_by = coalesce(
    public.aria_automation_pack_preferences.updated_by,
    excluded.updated_by
  ),
  updated_at = greatest(
    coalesce(public.aria_automation_pack_preferences.updated_at, '-infinity'::timestamptz),
    coalesce(excluded.updated_at, '-infinity'::timestamptz)
  );

delete from public.aria_automation_pack_preferences
where pack_key in (
  'lead_follow_up',
  'schedule_readiness',
  'client_retention',
  'membership_package_care',
  'post_lesson_closeout',
  'payment_follow_up'
);

-- ---------------------------------------------------------------------------
-- 3. Convert legacy pack keys on policy/rule rows.
-- ---------------------------------------------------------------------------

update public.aria_action_policies
set pack_key = case pack_key
  when 'lead_follow_up' then 'client_relations'
  when 'schedule_readiness' then 'scheduling'
  when 'client_retention' then 'sales_retention'
  when 'membership_package_care' then 'sales_retention'
  when 'post_lesson_closeout' then 'client_relations'
  when 'payment_follow_up' then 'billing_payments'
  else pack_key
end
where pack_key in (
  'lead_follow_up',
  'schedule_readiness',
  'client_retention',
  'membership_package_care',
  'post_lesson_closeout',
  'payment_follow_up'
);

update public.automation_rules
set pack_key = case pack_key
  when 'lead_follow_up' then 'client_relations'
  when 'schedule_readiness' then 'scheduling'
  when 'client_retention' then 'sales_retention'
  when 'membership_package_care' then 'sales_retention'
  when 'post_lesson_closeout' then 'client_relations'
  when 'payment_follow_up' then 'billing_payments'
  else pack_key
end
where pack_key in (
  'lead_follow_up',
  'schedule_readiness',
  'client_retention',
  'membership_package_care',
  'post_lesson_closeout',
  'payment_follow_up'
);

-- ---------------------------------------------------------------------------
-- 4. Ensure all 11 current operational pack rows exist for every studio that
--    already has ARIA pack preferences.
-- ---------------------------------------------------------------------------

with current_studios as (
  select distinct studio_id
  from public.aria_automation_pack_preferences
),
current_packs(pack_key) as (
  values
    ('front_desk'::text),
    ('client_relations'::text),
    ('scheduling'::text),
    ('sales_retention'::text),
    ('marketing'::text),
    ('billing_payments'::text),
    ('documents'::text),
    ('events'::text),
    ('staff_payroll'::text),
    ('retail_inventory'::text),
    ('studio_health'::text)
)
insert into public.aria_automation_pack_preferences (
  studio_id,
  pack_key,
  enabled,
  settings,
  updated_at
)
select
  s.studio_id,
  p.pack_key,
  true,
  '{}'::jsonb,
  now()
from current_studios s
cross join current_packs p
on conflict (studio_id, pack_key) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Recreate constraints using only current pack keys.
-- ---------------------------------------------------------------------------

alter table public.aria_automation_pack_preferences
  add constraint aria_automation_pack_preferences_pack_key_check
  check (
    pack_key in (
      'front_desk',
      'client_relations',
      'scheduling',
      'sales_retention',
      'marketing',
      'billing_payments',
      'documents',
      'events',
      'staff_payroll',
      'retail_inventory',
      'studio_health'
    )
  );

alter table if exists public.aria_action_policies
  add constraint aria_action_policies_pack_key_check
  check (
    pack_key is null
    or pack_key in (
      'front_desk',
      'client_relations',
      'scheduling',
      'sales_retention',
      'marketing',
      'billing_payments',
      'documents',
      'events',
      'staff_payroll',
      'retail_inventory',
      'studio_health'
    )
  );

alter table if exists public.automation_rules
  add constraint automation_rules_pack_key_check
  check (
    pack_key is null
    or pack_key in (
      'front_desk',
      'client_relations',
      'scheduling',
      'sales_retention',
      'marketing',
      'billing_payments',
      'documents',
      'events',
      'staff_payroll',
      'retail_inventory',
      'studio_health'
    )
  );

commit;
