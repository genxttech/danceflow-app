-- 20261008090000_launchsec1ca_verified_email_proof.sql
--
-- LAUNCH-SEC-1C-A: durable verified-email proof + credential binding.
--
-- PLUMBING ONLY. No existing claim RPC, policy or route is changed here; 1C-B
-- will make sensitive email-based claims require public.my_verified_email().
-- Nothing from LAUNCH-SEC-1C-0 / 1C-0-R is touched.
--
-- Basis (LAUNCH-SEC-1C-A0, DEV GoTrue v2.197.0, synthetic users only):
--   * every mailbox flow (email code, magic link, recovery, signup confirmation,
--     email-change confirmation) yields auth.mfa_amr_claims.authentication_method
--     = 'otp'; password login yields 'password';
--   * the amr row's updated_at equals the JWT amr timestamp and is NOT changed by
--     token refresh or setSession (iat is);
--   * auth.users.encrypted_password is non-empty for every account type, so
--     "did this user choose a password" cannot be determined; every FIRST proof
--     therefore requires credential binding (binding_required -> bound);
--   * revoked access tokens are still accepted by PostgREST until they expire,
--     so every check here re-verifies the session row in auth.sessions;
--   * an email change can complete through a single confirmation link whose
--     session carries a fresh 'otp' for the NEW address, so a proof is only
--     accepted when the mailbox authentication happened after the last email
--     change (tracked by an AFTER UPDATE OF email trigger on auth.users).
--
-- Accepted mailbox method set: exactly {'otp'}. Any other non-password method
-- on the session fails closed (PKCE method not yet captured; do not guess).

begin;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.verified_email_identities (
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  first_verified_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now(),
  method text not null,
  source text not null,
  credential_status text not null,
  binding_session_id uuid null,
  binding_started_at timestamptz null,
  bound_at timestamptz null,
  primary key (user_id, email),
  constraint verified_email_identities_email_normalized
    check (email = lower(btrim(email)) and length(email) between 3 and 320 and position('@' in email) > 1),
  constraint verified_email_identities_method check (method in ('otp')),
  constraint verified_email_identities_source check (source in ('web_callback', 'mobile_app')),
  constraint verified_email_identities_credential_status
    check (credential_status in ('binding_required', 'bound')),
  constraint verified_email_identities_binding_shape check (
    (credential_status = 'binding_required' and binding_session_id is not null
       and binding_started_at is not null and bound_at is null)
    or (credential_status = 'bound' and bound_at is not null)
  )
);

comment on table public.verified_email_identities is
  'LAUNCH-SEC-1C-A: durable proof that a user controlled a mailbox, plus credential binding state. Written only by trusted SECURITY DEFINER functions. Only the row for the CURRENT auth.users email can authorize.';

create table public.auth_email_change_markers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_email_change_at timestamptz not null
);

comment on table public.auth_email_change_markers is
  'LAUNCH-SEC-1C-A: last time auth.users.email changed (maintained by trigger). Mailbox authentication older than this cannot create proof.';

alter table public.verified_email_identities enable row level security;
alter table public.auth_email_change_markers enable row level security;

revoke all on table public.verified_email_identities from public, anon, authenticated;
revoke all on table public.auth_email_change_markers from public, anon, authenticated;
grant select on table public.verified_email_identities to service_role;
grant select on table public.auth_email_change_markers to service_role;

-- ---------------------------------------------------------------------------
-- Email change tracking
-- ---------------------------------------------------------------------------

create function public.track_auth_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    insert into public.auth_email_change_markers (user_id, last_email_change_at)
    values (new.id, now())
    on conflict (user_id) do update set last_email_change_at = excluded.last_email_change_at;
  end if;
  return new;
end;
$$;

create trigger launchsec1ca_track_email_change
  after update of email on auth.users
  for each row execute function public.track_auth_email_change();

-- ---------------------------------------------------------------------------
-- Session helpers (private)
-- ---------------------------------------------------------------------------

-- The caller's live session id, or null. Never trusts the JWT email.
create function public._launchsec1ca_live_session_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_raw text := auth.jwt() ->> 'session_id';
  v_sid uuid;
begin
  if v_uid is null or v_raw is null
     or v_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_sid := v_raw::uuid;

  if not exists (
    select 1 from auth.sessions s
    where s.id = v_sid
      and s.user_id = v_uid
      and (s.not_after is null or s.not_after > now())
  ) then
    return null;
  end if;

  return v_sid;
end;
$$;

-- Most recent accepted mailbox authentication for a session, or null when the
-- session carries none, carries an unvalidated method (fail closed), or the
-- mailbox authentication predates the user's last email change (+30s, which
-- excludes the email-change confirmation session itself).
create function public._launchsec1ca_mailbox_auth_at(p_user_id uuid, p_session_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
  v_changed timestamptz;
begin
  if exists (
    select 1 from auth.mfa_amr_claims m
    where m.session_id = p_session_id
      and m.authentication_method not in ('otp', 'password')
  ) then
    return null;
  end if;

  select max(m.updated_at) into v_at
  from auth.mfa_amr_claims m
  where m.session_id = p_session_id
    and m.authentication_method = 'otp';

  if v_at is null or v_at > now() + interval '1 minute' then
    return null;
  end if;

  select c.last_email_change_at into v_changed
  from public.auth_email_change_markers c
  where c.user_id = p_user_id;

  if v_changed is not null and v_at < v_changed + interval '30 seconds' then
    return null;
  end if;

  return v_at;
end;
$$;

create function public._launchsec1ca_current_email(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(lower(btrim(u.email)), '')
  from auth.users u
  where u.id = p_user_id and u.deleted_at is null;
$$;

-- ---------------------------------------------------------------------------
-- Proof recording
-- ---------------------------------------------------------------------------

create function public._record_email_proof(p_source text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_sid uuid;
  v_email text;
  v_auth_at timestamptz;
  v_changed timestamptz;
  v_row public.verified_email_identities%rowtype;
begin
  if p_source not in ('web_callback', 'mobile_app') then
    raise exception 'invalid proof source';
  end if;

  v_sid := public._launchsec1ca_live_session_id();
  if v_sid is null then
    return 'no_live_session';
  end if;

  v_email := public._launchsec1ca_current_email(v_uid);
  if v_email is null or position('@' in v_email) <= 1 then
    return 'no_email';
  end if;

  v_auth_at := public._launchsec1ca_mailbox_auth_at(v_uid, v_sid);
  if v_auth_at is null or v_auth_at < now() - interval '10 minutes' then
    return 'no_fresh_mailbox_auth';
  end if;

  select c.last_email_change_at into v_changed
  from public.auth_email_change_markers c where c.user_id = v_uid;

  insert into public.verified_email_identities (
    user_id, email, first_verified_at, last_verified_at, method, source,
    credential_status, binding_session_id, binding_started_at, bound_at
  ) values (
    v_uid, v_email, now(), now(), 'otp', p_source,
    'binding_required', v_sid, now(), null
  )
  on conflict (user_id, email) do nothing;

  select * into v_row
  from public.verified_email_identities
  where user_id = v_uid and email = v_email
  for update;

  if v_row.credential_status = 'bound'
     and (v_changed is null or v_row.bound_at > v_changed) then
    update public.verified_email_identities
       set last_verified_at = now(), method = 'otp', source = p_source
     where user_id = v_uid and email = v_email;
    return 'bound';
  end if;

  -- binding_required (new or retry), or a bound row made stale by a later
  -- email change: (re)start binding on this fresh mailbox session.
  update public.verified_email_identities
     set last_verified_at = now(), method = 'otp', source = p_source,
         credential_status = 'binding_required', binding_session_id = v_sid,
         binding_started_at = now(), bound_at = null
   where user_id = v_uid and email = v_email;
  return 'binding_required';
end;
$$;

create function public.record_email_proof_web()
returns text
language sql
volatile
security definer
set search_path = ''
as $$ select public._record_email_proof('web_callback'); $$;

create function public.record_email_proof_mobile()
returns text
language sql
volatile
security definer
set search_path = ''
as $$ select public._record_email_proof('mobile_app'); $$;

-- ---------------------------------------------------------------------------
-- Status / eligibility
-- ---------------------------------------------------------------------------

-- Claim-eligible verified email for the CURRENT caller and session, else null.
create function public.my_verified_email()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_sid uuid := public._launchsec1ca_live_session_id();
  v_email text;
begin
  if v_sid is null then
    return null;
  end if;

  v_email := public._launchsec1ca_current_email(v_uid);
  if v_email is null then
    return null;
  end if;

  if exists (
    select 1
    from public.verified_email_identities v
    join auth.sessions s on s.id = v_sid and s.user_id = v_uid
    left join public.auth_email_change_markers c on c.user_id = v_uid
    where v.user_id = v_uid
      and v.email = v_email
      and v.credential_status = 'bound'
      and v.bound_at is not null
      and s.created_at >= v.bound_at
      and (c.last_email_change_at is null or v.bound_at > c.last_email_change_at)
  ) then
    return v_email;
  end if;

  return null;
end;
$$;

-- UX routing for the caller: no_session | unproven | binding_required |
-- binding_ready (this exact proof session may bind now) | bound
-- (bound = current email bound; claims still need my_verified_email()).
create function public.email_binding_status()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_sid uuid := public._launchsec1ca_live_session_id();
  v_email text;
  v_changed timestamptz;
  v_row public.verified_email_identities%rowtype;
  v_auth_at timestamptz;
begin
  if v_sid is null then
    return 'no_session';
  end if;

  v_email := public._launchsec1ca_current_email(v_uid);
  if v_email is null then
    return 'unproven';
  end if;

  select * into v_row from public.verified_email_identities
  where user_id = v_uid and email = v_email;
  if not found then
    return 'unproven';
  end if;

  select c.last_email_change_at into v_changed
  from public.auth_email_change_markers c where c.user_id = v_uid;

  if v_row.credential_status = 'bound' then
    if v_changed is null or v_row.bound_at > v_changed then
      return 'bound';
    end if;
    return 'unproven';
  end if;

  if v_row.binding_session_id = v_sid then
    v_auth_at := public._launchsec1ca_mailbox_auth_at(v_uid, v_sid);
    if v_auth_at is not null and v_auth_at >= now() - interval '30 minutes'
       and v_row.binding_started_at >= now() - interval '30 minutes' then
      return 'binding_ready';
    end if;
  end if;

  return 'binding_required';
end;
$$;

-- Service-role only. Called by the server ONLY after it observed
-- email_binding_status() = 'binding_ready' for this exact session and a
-- successful admin password replacement (which revokes every session).
create function public.complete_email_binding(p_user_id uuid, p_session_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_count integer;
begin
  if p_user_id is null or p_session_id is null then
    return false;
  end if;

  v_email := public._launchsec1ca_current_email(p_user_id);
  if v_email is null then
    return false;
  end if;

  update public.verified_email_identities
     set credential_status = 'bound', bound_at = now(),
         binding_session_id = null, binding_started_at = null
   where user_id = p_user_id
     and email = v_email
     and credential_status = 'binding_required'
     and binding_session_id = p_session_id
     and binding_started_at >= now() - interval '35 minutes';

  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership and privileges
-- ---------------------------------------------------------------------------

alter function public.track_auth_email_change() owner to postgres;
alter function public._launchsec1ca_live_session_id() owner to postgres;
alter function public._launchsec1ca_mailbox_auth_at(uuid, uuid) owner to postgres;
alter function public._launchsec1ca_current_email(uuid) owner to postgres;
alter function public._record_email_proof(text) owner to postgres;
alter function public.record_email_proof_web() owner to postgres;
alter function public.record_email_proof_mobile() owner to postgres;
alter function public.my_verified_email() owner to postgres;
alter function public.email_binding_status() owner to postgres;
alter function public.complete_email_binding(uuid, uuid) owner to postgres;

revoke all on function public.track_auth_email_change() from public, anon, authenticated, service_role;
revoke all on function public._launchsec1ca_live_session_id() from public, anon, authenticated, service_role;
revoke all on function public._launchsec1ca_mailbox_auth_at(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._launchsec1ca_current_email(uuid) from public, anon, authenticated, service_role;
revoke all on function public._record_email_proof(text) from public, anon, authenticated, service_role;
revoke all on function public.record_email_proof_web() from public, anon, authenticated, service_role;
revoke all on function public.record_email_proof_mobile() from public, anon, authenticated, service_role;
revoke all on function public.my_verified_email() from public, anon, authenticated, service_role;
revoke all on function public.email_binding_status() from public, anon, authenticated, service_role;
revoke all on function public.complete_email_binding(uuid, uuid) from public, anon, authenticated, service_role;

grant execute on function public.record_email_proof_web() to authenticated;
grant execute on function public.record_email_proof_mobile() to authenticated;
grant execute on function public.my_verified_email() to authenticated;
grant execute on function public.email_binding_status() to authenticated;
grant execute on function public.complete_email_binding(uuid, uuid) to service_role;

commit;
