-- Membership benefits remove/save fix
-- Allows studio users who can access the parent membership plan to fully sync
-- membership_plan_benefits rows during create/edit actions.

alter table if exists public.membership_plan_benefits enable row level security;

drop policy if exists "membership_plan_benefits_select_by_studio" on public.membership_plan_benefits;
drop policy if exists "membership_plan_benefits_insert_by_studio" on public.membership_plan_benefits;
drop policy if exists "membership_plan_benefits_update_by_studio" on public.membership_plan_benefits;
drop policy if exists "membership_plan_benefits_delete_by_studio" on public.membership_plan_benefits;

create policy "membership_plan_benefits_select_by_studio"
on public.membership_plan_benefits
for select
to authenticated
using (
  exists (
    select 1
    from public.membership_plans mp
    join public.user_studio_roles usr
      on usr.studio_id = mp.studio_id
    where mp.id = membership_plan_benefits.membership_plan_id
      and usr.user_id = auth.uid()
  )
);

create policy "membership_plan_benefits_insert_by_studio"
on public.membership_plan_benefits
for insert
to authenticated
with check (
  exists (
    select 1
    from public.membership_plans mp
    join public.user_studio_roles usr
      on usr.studio_id = mp.studio_id
    where mp.id = membership_plan_benefits.membership_plan_id
      and usr.user_id = auth.uid()
  )
);

create policy "membership_plan_benefits_update_by_studio"
on public.membership_plan_benefits
for update
to authenticated
using (
  exists (
    select 1
    from public.membership_plans mp
    join public.user_studio_roles usr
      on usr.studio_id = mp.studio_id
    where mp.id = membership_plan_benefits.membership_plan_id
      and usr.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.membership_plans mp
    join public.user_studio_roles usr
      on usr.studio_id = mp.studio_id
    where mp.id = membership_plan_benefits.membership_plan_id
      and usr.user_id = auth.uid()
  )
);

create policy "membership_plan_benefits_delete_by_studio"
on public.membership_plan_benefits
for delete
to authenticated
using (
  exists (
    select 1
    from public.membership_plans mp
    join public.user_studio_roles usr
      on usr.studio_id = mp.studio_id
    where mp.id = membership_plan_benefits.membership_plan_id
      and usr.user_id = auth.uid()
  )
);
