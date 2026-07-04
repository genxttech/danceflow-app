alter table public.clients
  add column if not exists dance_goals text[],
  add column if not exists partner_client_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'clients_partner_client_id_fkey'
  ) then
    alter table public.clients
      add constraint clients_partner_client_id_fkey
      foreign key (partner_client_id)
      references public.clients(id)
      on delete set null;
  end if;
end $$;

create index if not exists clients_partner_client_id_idx
on public.clients (partner_client_id);

create index if not exists clients_dance_goals_gin_idx
on public.clients using gin (dance_goals);
