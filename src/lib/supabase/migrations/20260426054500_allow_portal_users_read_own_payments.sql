alter table payments enable row level security;

drop policy if exists "Portal users can view their own payments"
on payments;

create policy "Portal users can view their own payments"
on payments
for select
using (
  exists (
    select 1
    from clients c
    where c.id = payments.client_id
      and c.studio_id = payments.studio_id
      and c.portal_user_id = auth.uid()
  )
);