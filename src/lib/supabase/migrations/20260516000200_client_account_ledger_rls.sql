drop policy if exists "Studio users can read client account ledger"
on public.client_account_ledger;

create policy "Studio users can read client account ledger"
on public.client_account_ledger
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = client_account_ledger.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio users can insert client account ledger"
on public.client_account_ledger;

create policy "Studio users can insert client account ledger"
on public.client_account_ledger
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = client_account_ledger.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner',
        'studio_admin',
        'front_desk',
        'independent_instructor'
      )
  )
);

drop policy if exists "Studio users can update client account ledger"
on public.client_account_ledger;

create policy "Studio users can update client account ledger"
on public.client_account_ledger
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = client_account_ledger.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner',
        'studio_admin'
      )
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = client_account_ledger.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner',
        'studio_admin'
      )
  )
);