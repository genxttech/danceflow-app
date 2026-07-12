-- DanceFlow Sign V1.6 production hardening
-- Run in development and production before deploying V1.6 code.

begin;

create table if not exists public.document_sign_rate_limits (
  scope text not null,
  key_hash text not null,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (scope, key_hash)
);

alter table public.document_sign_rate_limits enable row level security;

revoke all on table public.document_sign_rate_limits from anon, authenticated;

create or replace function public.consume_document_sign_rate_limit(
  p_scope text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns table (
  allowed boolean,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.document_sign_rate_limits%rowtype;
  v_window interval;
begin
  if p_scope is null or length(p_scope) < 1 or length(p_scope) > 80 then
    raise exception 'invalid rate limit scope';
  end if;
  if p_key_hash is null or length(p_key_hash) <> 64 then
    raise exception 'invalid rate limit key';
  end if;
  if p_limit < 1 or p_limit > 10000 then
    raise exception 'invalid rate limit';
  end if;
  if p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit window';
  end if;

  v_window := make_interval(secs => p_window_seconds);

  insert into public.document_sign_rate_limits (
    scope,
    key_hash,
    window_started_at,
    request_count,
    updated_at
  )
  values (p_scope, p_key_hash, v_now, 1, v_now)
  on conflict (scope, key_hash)
  do update set
    window_started_at = case
      when public.document_sign_rate_limits.window_started_at + v_window <= v_now
        then v_now
      else public.document_sign_rate_limits.window_started_at
    end,
    request_count = case
      when public.document_sign_rate_limits.window_started_at + v_window <= v_now
        then 1
      else public.document_sign_rate_limits.request_count + 1
    end,
    updated_at = v_now
  returning * into v_row;

  allowed := v_row.request_count <= p_limit;
  retry_after_seconds := greatest(
    1,
    ceil(extract(epoch from ((v_row.window_started_at + v_window) - v_now)))::integer
  );
  return next;
end;
$$;

revoke all on function public.consume_document_sign_rate_limit(text, text, integer, integer) from public;
grant execute on function public.consume_document_sign_rate_limit(text, text, integer, integer) to service_role;

create index if not exists document_sign_rate_limits_updated_at_idx
  on public.document_sign_rate_limits (updated_at);

-- Keep the table bounded without requiring a separate cron job.
create or replace function public.prune_document_sign_rate_limits()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.document_sign_rate_limits
  where updated_at < now() - interval '2 days';
$$;

revoke all on function public.prune_document_sign_rate_limits() from public;
grant execute on function public.prune_document_sign_rate_limits() to service_role;

commit;
