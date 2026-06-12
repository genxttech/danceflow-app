create table if not exists public.instructor_compensation_rules (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  private_lesson_pay_mode text not null default 'none'
    check (private_lesson_pay_mode in ('none', 'flat', 'percentage')),
  private_lesson_flat_amount numeric not null default 0,
  private_lesson_percentage numeric not null default 0,
  group_class_pay_mode text not null default 'none'
    check (group_class_pay_mode in ('none', 'flat', 'percentage', 'per_attendee')),
  group_class_flat_amount numeric not null default 0,
  group_class_percentage numeric not null default 0,
  group_class_per_attendee_amount numeric not null default 0,
  active boolean not null default true,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (studio_id, instructor_id)
);

create table if not exists public.instructor_earnings (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  earning_date date not null,
  source_type text not null default 'appointment'
    check (source_type in ('appointment', 'manual_adjustment')),
  appointment_type text,
  gross_revenue_basis numeric not null default 0,
  pay_mode text not null default 'none',
  pay_rate_amount numeric not null default 0,
  pay_percentage numeric not null default 0,
  attendance_count integer not null default 0,
  earning_amount numeric not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'paid', 'void')),
  notes text,
  approved_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  paid_at timestamptz,
  paid_by uuid references public.profiles(id) on delete set null,
  payment_method text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id, instructor_id)
);

create index if not exists idx_instructor_compensation_rules_studio
  on public.instructor_compensation_rules (studio_id, instructor_id);

create index if not exists idx_instructor_earnings_studio_date
  on public.instructor_earnings (studio_id, earning_date desc);

create index if not exists idx_instructor_earnings_instructor_status
  on public.instructor_earnings (instructor_id, status);

alter table public.instructor_compensation_rules enable row level security;
alter table public.instructor_earnings enable row level security;

drop policy if exists instructor_compensation_rules_select on public.instructor_compensation_rules;
drop policy if exists instructor_compensation_rules_insert on public.instructor_compensation_rules;
drop policy if exists instructor_compensation_rules_update on public.instructor_compensation_rules;
drop policy if exists instructor_compensation_rules_delete on public.instructor_compensation_rules;

create policy instructor_compensation_rules_select on public.instructor_compensation_rules
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_compensation_rules.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
);

create policy instructor_compensation_rules_insert on public.instructor_compensation_rules
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_compensation_rules.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
);

create policy instructor_compensation_rules_update on public.instructor_compensation_rules
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_compensation_rules.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_compensation_rules.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
);

create policy instructor_compensation_rules_delete on public.instructor_compensation_rules
for delete
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_compensation_rules.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
);

drop policy if exists instructor_earnings_select on public.instructor_earnings;
drop policy if exists instructor_earnings_insert on public.instructor_earnings;
drop policy if exists instructor_earnings_update on public.instructor_earnings;
drop policy if exists instructor_earnings_delete on public.instructor_earnings;

create policy instructor_earnings_select on public.instructor_earnings
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_earnings.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
);

create policy instructor_earnings_insert on public.instructor_earnings
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_earnings.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
  )
);

create policy instructor_earnings_update on public.instructor_earnings
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_earnings.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_earnings.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
);

create policy instructor_earnings_delete on public.instructor_earnings
for delete
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = instructor_earnings.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
);
