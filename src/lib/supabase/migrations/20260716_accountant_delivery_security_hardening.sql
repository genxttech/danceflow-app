begin;

create or replace function public.record_accountant_delivery_download(
  p_delivery_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_time timestamptz := now();
begin
  update public.studio_accountant_deliveries
  set
    download_count = download_count + 1,
    first_downloaded_at = coalesce(first_downloaded_at, current_time),
    last_downloaded_at = current_time
  where id = p_delivery_id
    and status in ('queued', 'sent')
    and expires_at > current_time;

  if not found then
    raise exception 'Accountant delivery is not available';
  end if;
end;
$$;

revoke all on function public.record_accountant_delivery_download(uuid)
from public, anon, authenticated;

grant execute on function public.record_accountant_delivery_download(uuid)
to service_role;

commit;
