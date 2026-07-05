create table if not exists public.platform_alerts (
  id uuid primary key default gen_random_uuid(),

  title text not null,
  message text not null,

  alert_type text not null default 'info',
  audience text not null default 'all_workspace_users',

  active boolean not null default true,
  dismissible boolean not null default true,

  starts_at timestamp with time zone null,
  ends_at timestamp with time zone null,

  read_more_url text null,
  read_more_label text not null default 'Read more',

  created_by uuid null references auth.users(id) on delete set null,

  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  constraint platform_alerts_alert_type_check
    check (
      alert_type in (
        'info',
        'success',
        'warning',
        'maintenance',
        'critical'
      )
    ),

  constraint platform_alerts_audience_check
    check (
      audience in (
        'all_workspace_users',
        'studio_owners',
        'organizers',
        'instructors',
        'independent_instructors',
        'portal_users',
        'all_users'
      )
    )
);

create table if not exists public.platform_alert_dismissals (
  id uuid primary key default gen_random_uuid(),

  alert_id uuid not null references public.platform_alerts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  dismissed_at timestamp with time zone not null default now(),

  constraint platform_alert_dismissals_unique_user_alert
    unique (alert_id, user_id)
);

create index if not exists platform_alerts_active_idx
on public.platform_alerts(active);

create index if not exists platform_alerts_audience_idx
on public.platform_alerts(audience);

create index if not exists platform_alerts_active_window_idx
on public.platform_alerts(active, starts_at, ends_at);

create index if not exists platform_alert_dismissals_alert_id_idx
on public.platform_alert_dismissals(alert_id);

create index if not exists platform_alert_dismissals_user_id_idx
on public.platform_alert_dismissals(user_id);

alter table public.platform_alerts enable row level security;
alter table public.platform_alert_dismissals enable row level security;

drop policy if exists "Platform admins can manage platform alerts"
on public.platform_alerts;

drop policy if exists "Authenticated users can view active platform alerts"
on public.platform_alerts;

create policy "Platform admins can manage platform alerts"
on public.platform_alerts
for all
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.active = true
      and usr.role = 'platform_admin'
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.active = true
      and usr.role = 'platform_admin'
  )
);

create policy "Authenticated users can view active platform alerts"
on public.platform_alerts
for select
using (
  auth.uid() is not null
  and active = true
  and (starts_at is null or starts_at <= now())
  and (ends_at is null or ends_at >= now())
);

drop policy if exists "Users can view their own alert dismissals"
on public.platform_alert_dismissals;

drop policy if exists "Users can dismiss their own platform alerts"
on public.platform_alert_dismissals;

create policy "Users can view their own alert dismissals"
on public.platform_alert_dismissals
for select
using (
  user_id = auth.uid()
);

create policy "Users can dismiss their own platform alerts"
on public.platform_alert_dismissals
for insert
with check (
  user_id = auth.uid()
);

notify pgrst, 'reload schema';