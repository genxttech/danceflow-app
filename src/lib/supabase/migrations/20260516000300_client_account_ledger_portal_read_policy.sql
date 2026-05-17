drop policy if exists "Clients can read their own account ledger"
on public.client_account_ledger;

create policy "Clients can read their own account ledger"
on public.client_account_ledger
for select
to authenticated
using (
  exists (
    select 1
    from public.clients c
    where c.id = client_account_ledger.client_id
      and c.studio_id = client_account_ledger.studio_id
      and lower(c.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
);
