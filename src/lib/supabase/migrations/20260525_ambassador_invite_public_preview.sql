begin;

create or replace function public.get_platform_invite_preview(
  p_token_hash text
)
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

grant execute on function public.get_platform_invite_preview(text) to anon;
grant execute on function public.get_platform_invite_preview(text) to authenticated;

notify pgrst, 'reload schema';

commit;
