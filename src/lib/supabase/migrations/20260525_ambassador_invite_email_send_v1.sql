begin;

alter table public.platform_invites
add column if not exists recipient_name text,
add column if not exists sent_at timestamptz,
add column if not exists last_sent_at timestamptz,
add column if not exists send_count integer not null default 0,
add column if not exists last_send_error text,
add column if not exists last_sent_by_user_id uuid references auth.users(id) on delete set null;

create index if not exists idx_platform_invites_last_sent_at
on public.platform_invites (last_sent_at);

create or replace function public.get_platform_invite_public_preview(p_token_hash text)
returns table (
  email text,
  invite_type text,
  granted_plan text,
  billing_override_reason text,
  duration_months integer,
  expires_at timestamptz,
  used_at timestamptz,
  active boolean
)
language sql
security definer
set search_path = public
as $$
  select
    pi.email,
    pi.invite_type,
    pi.granted_plan::text,
    pi.billing_override_reason,
    pi.duration_months,
    pi.expires_at,
    pi.used_at,
    pi.active
  from public.platform_invites pi
  where pi.token_hash = p_token_hash
  limit 1;
$$;

grant execute on function public.get_platform_invite_public_preview(text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
