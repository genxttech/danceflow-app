-- D4-2: SINGLE-OWNER HIGH-ASSURANCE price authorization (WebAuthn transaction approval verified INSIDE Postgres), with TEAM MODE kept. NOT APPLIED anywhere; Git only.
-- Depends on 20270204090000 (D4-1). Design, trust boundary and threat model: docs/twilio/TW-4F_Price_Authorization_Threat_Model.md.
--
-- Single-owner mode (the initial mode): the owner proposes in an aal2 session with a fresh TOTP; a MANDATORY 24 h cooling-off starts (a row CHECK, stored config, never auto-publishes);
-- after it ends the owner authorizes from a SEPARATE session (different session_id) with a hardware-backed WebAuthn assertion over the canonical hash of the exact proposal
-- (kind, old and new values, scope, version, expiry, request id) plus a database-generated single-use nonce. The assertion is verified IN POSTGRES (ECDSA P-256 in plpgsql) against a
-- credential registry that has no grants: neither GoTrue, a JWT, nor service_role can publish a price without the hardware key. Enrolling or revoking a credential needs an assertion
-- from an existing credential (a new one also proves possession). Revising a proposal invalidates it and restarts the cooling-off. A freeze can only suspend; lifting it needs the
-- ceremony. Mode, cooling-off, windows and the relying party are protected configuration: owner-level migration only. The 8 limit rows stay UNAPPROVED (nothing enforced).
-- ROLLBACK: rollback/20270204100000_twilio_price_owner_authorization_rollback.sql is valid only while no owner-mode request, credential, challenge or audit row exists (refuses 55000
-- afterwards: forward-fix, or freeze); it returns the schema to exactly 20270204090000.
begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.tw4_price_propose(text,integer,integer,text,text)') is null or to_regprocedure('public._tw4price_do_approve(uuid,uuid,text)') is null then
    raise exception 'price owner authorization precondition failed: 20270204090000 is not applied';
  end if;
  if to_regclass('public.studio_sms_price_auth_config') is not null then
    raise exception 'price owner authorization precondition failed: already applied';
  end if;
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public._tw4price_do_approve(uuid,uuid,text)'::regprocedure) is distinct from '4030438f5d7d89ceead9226c09a8719f' then
    raise exception 'price owner authorization precondition failed: _tw4price_do_approve differs from 20270204090000';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- protected configuration (single row). Mode, cooling-off, relying party and window values change ONLY by owner-level migration / DDL (visible), never through a function
-- or an API role. Only the freeze flag moves, and only through the freeze / thaw functions below.
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_price_auth_config (
  singleton boolean primary key default true check (singleton),
  mode text not null default 'single_owner' check (mode in ('single_owner', 'team')),
  cooling_off_hours int not null default 24 check (cooling_off_hours between 24 and 96),
  authz_window_hours int not null default 24 check (authz_window_hours between 1 and 72),
  challenge_ttl_seconds int not null default 300 check (challenge_ttl_seconds between 60 and 900),
  rp_id text null check (rp_id is null or char_length(rp_id) between 3 and 253),
  rp_origins text[] null,
  credential_delay_hours int not null default 24 check (credential_delay_hours between 24 and 168),
  allow_backup_eligible boolean not null default false,   -- a synced / backup-eligible passkey (flag BE) is refused unless the owner's migration says otherwise
  monitoring_expected boolean not null default false,     -- once true, a missing monitoring events table makes every emit FAIL LOUDLY
  monitor_seq_lifted bigint not null default 0,           -- monitoring suspensions up to this event sequence have been lifted by a hardware-key thaw
  frozen boolean not null default false,
  frozen_at timestamptz null,
  freeze_reason text null,
  constraint studio_sms_price_auth_config_freeze check (frozen = (frozen_at is not null))
);
insert into public.studio_sms_price_auth_config (singleton) values (true);
revoke all on public.studio_sms_price_auth_config from public, anon, authenticated, service_role;
alter table public.studio_sms_price_auth_config enable row level security;

create table public.studio_sms_price_credentials (
  id uuid primary key default gen_random_uuid(),
  credential_id bytea not null unique check (octet_length(credential_id) between 16 and 1023),
  pub_x bytea not null check (octet_length(pub_x) = 32),
  pub_y bytea not null check (octet_length(pub_y) = 32),
  role text not null check (role in ('primary', 'spare')),
  label text not null check (char_length(btrim(label)) between 3 and 60),
  sign_count bigint not null default 0 check (sign_count >= 0),
  status text not null default 'active' check (status in ('active', 'revoked')),
  enrolled_at timestamptz not null default clock_timestamp(),
  enrolled_via text not null check (enrolled_via in ('bootstrap', 'assertion')),
  revoked_at timestamptz null,
  revoked_note text null,
  constraint studio_sms_price_credentials_revoked check ((status = 'revoked') = (revoked_at is not null))
);
create unique index studio_sms_price_credentials_key on public.studio_sms_price_credentials (pub_x, pub_y);   -- one record per key: no aliasing under a second credential id
create unique index studio_sms_price_credentials_one_primary on public.studio_sms_price_credentials (role) where status = 'active' and role = 'primary';
revoke all on public.studio_sms_price_credentials from public, anon, authenticated, service_role;
alter table public.studio_sms_price_credentials enable row level security;

create table public.studio_sms_price_auth_challenges (
  nonce bytea primary key check (octet_length(nonce) = 32),
  purpose text not null check (purpose in ('authorize', 'enroll', 'revoke', 'thaw')),
  bound_hash bytea not null check (octet_length(bound_hash) = 32),
  request_id uuid null references public.studio_sms_price_change_requests(id) on delete restrict,
  issued_to uuid not null,
  session_id text null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  used_at timestamptz null,
  constraint studio_sms_price_auth_challenges_window check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);
revoke all on public.studio_sms_price_auth_challenges from public, anon, authenticated, service_role;
alter table public.studio_sms_price_auth_challenges enable row level security;

-- a credential change is only ever PENDING when it is authorized: it applies after a mandatory delay, is visible, alerting and cancellable, and never while prices are suspended
create table public.studio_sms_price_credential_changes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('enroll', 'revoke')),
  target_credential_id bytea not null check (octet_length(target_credential_id) between 16 and 1023),
  pub_x bytea null check (pub_x is null or octet_length(pub_x) = 32),
  pub_y bytea null check (pub_y is null or octet_length(pub_y) = 32),
  role text null check (role is null or role in ('primary', 'spare')),
  label text null,
  authorized_by_credential_id bytea not null,
  requested_by uuid not null,
  requested_at timestamptz not null default clock_timestamp(),
  effective_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'applied', 'cancelled')),
  applied_at timestamptz null,
  cancelled_at timestamptz null,
  cancelled_by uuid null,
  constraint studio_sms_price_credential_changes_delay check (effective_at >= requested_at + interval '24 hours'),
  constraint studio_sms_price_credential_changes_shape check ((kind = 'enroll') = (pub_x is not null and pub_y is not null and role is not null and label is not null)
    and (status = 'applied') = (applied_at is not null) and (status = 'cancelled') = (cancelled_at is not null and cancelled_by is not null))
);
revoke all on public.studio_sms_price_credential_changes from public, anon, authenticated, service_role;
alter table public.studio_sms_price_credential_changes enable row level security;

create table public.studio_sms_price_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  event text not null check (event in ('proposed', 'revised', 'challenge_issued', 'assertion_rejected', 'authorized', 'published', 'team_approved', 'rejected', 'invalidated',
    'credential_bootstrapped', 'credential_enrolled', 'credential_revoked', 'credential_change_pending', 'credential_change_applied', 'credential_change_cancelled', 'gate_refused',
    'freeze_set', 'freeze_lifted', 'integrity_failure')),
  actor uuid null,
  session_id text null,
  request_id uuid null,
  credential_id bytea null,
  detail jsonb not null default '{}'::jsonb
);
revoke all on public.studio_sms_price_audit from public, anon, authenticated, service_role;
alter table public.studio_sms_price_audit enable row level security;

create or replace function public._tw4priceauth_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare w boolean := coalesce(current_setting('tw4.priceauth_write', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    raise exception '%: rows are never deleted', tg_table_name using errcode = '42501';
  end if;
  if tg_table_name = 'studio_sms_price_auth_config' then
    if tg_op = 'INSERT' then
      raise exception 'the price authorization configuration is a single protected row' using errcode = '42501';
    end if;
    -- mode, cooling-off, windows: never through a function. rp_id / rp_origins: set once, by the bootstrap. frozen: only by the freeze functions.
    if new.singleton is distinct from old.singleton or new.mode is distinct from old.mode or new.cooling_off_hours is distinct from old.cooling_off_hours
       or new.authz_window_hours is distinct from old.authz_window_hours or new.challenge_ttl_seconds is distinct from old.challenge_ttl_seconds
       or new.credential_delay_hours is distinct from old.credential_delay_hours or new.allow_backup_eligible is distinct from old.allow_backup_eligible
       or new.monitoring_expected is distinct from old.monitoring_expected
       or ((new.rp_id is distinct from old.rp_id or new.rp_origins is distinct from old.rp_origins) and (old.rp_id is not null or not w)) then
      raise exception 'the price authorization configuration changes only by an owner-level migration' using errcode = '42501';
    end if;
    if (new.frozen is distinct from old.frozen or new.frozen_at is distinct from old.frozen_at or new.freeze_reason is distinct from old.freeze_reason or new.monitor_seq_lifted is distinct from old.monitor_seq_lifted) and not w then
      raise exception 'the freeze flag moves only through the freeze functions' using errcode = '42501';
    end if;
    if new.monitor_seq_lifted < old.monitor_seq_lifted then
      raise exception 'a lifted suspension is never un-lifted' using errcode = '42501';
    end if;
    return new;
  end if;
  if not w then
    raise exception '%: written only by the price authorization functions', tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if tg_table_name = 'studio_sms_price_credentials' then
      if new.id is distinct from old.id or new.credential_id is distinct from old.credential_id or new.pub_x is distinct from old.pub_x or new.pub_y is distinct from old.pub_y
         or new.role is distinct from old.role or new.label is distinct from old.label or new.enrolled_at is distinct from old.enrolled_at or new.enrolled_via is distinct from old.enrolled_via
         or new.sign_count < old.sign_count or (old.status = 'revoked' and new.status is distinct from old.status) or old.status = 'revoked' and new is distinct from old then
        raise exception 'a credential record only gains a higher sign counter or is revoked, once' using errcode = '42501';
      end if;
    elsif tg_table_name = 'studio_sms_price_credential_changes' then
      if new.id is distinct from old.id or new.kind is distinct from old.kind or new.target_credential_id is distinct from old.target_credential_id or new.pub_x is distinct from old.pub_x
         or new.pub_y is distinct from old.pub_y or new.role is distinct from old.role or new.label is distinct from old.label or new.authorized_by_credential_id is distinct from old.authorized_by_credential_id
         or new.requested_by is distinct from old.requested_by or new.requested_at is distinct from old.requested_at or new.effective_at is distinct from old.effective_at
         or old.status <> 'pending' or new.status = 'pending' then
        raise exception 'a credential change is applied or cancelled once and never changes otherwise' using errcode = '42501';
      end if;
    elsif tg_table_name = 'studio_sms_price_auth_challenges' then
      if new.nonce is distinct from old.nonce or new.purpose is distinct from old.purpose or new.bound_hash is distinct from old.bound_hash or new.request_id is distinct from old.request_id
         or new.issued_to is distinct from old.issued_to or new.session_id is distinct from old.session_id or new.created_at is distinct from old.created_at
         or new.expires_at is distinct from old.expires_at or old.used_at is not null or new.used_at is null then
        raise exception 'a challenge is used once and never changes otherwise' using errcode = '42501';
      end if;
    else
      raise exception '%: rows are append-only', tg_table_name using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger studio_sms_price_auth_config_guard before insert or update or delete on public.studio_sms_price_auth_config for each row execute function public._tw4priceauth_guard();
create trigger studio_sms_price_credentials_guard before insert or update or delete on public.studio_sms_price_credentials for each row execute function public._tw4priceauth_guard();
create trigger studio_sms_price_auth_challenges_guard before insert or update or delete on public.studio_sms_price_auth_challenges for each row execute function public._tw4priceauth_guard();
create trigger studio_sms_price_credential_changes_guard before insert or update or delete on public.studio_sms_price_credential_changes for each row execute function public._tw4priceauth_guard();
create trigger studio_sms_price_credential_changes_truncate before truncate on public.studio_sms_price_credential_changes for each statement execute function public._tw4c_truncate_guard();
alter table public.studio_sms_price_credential_changes enable always trigger studio_sms_price_credential_changes_guard;
alter table public.studio_sms_price_credential_changes enable always trigger studio_sms_price_credential_changes_truncate;
create trigger studio_sms_price_audit_guard before insert or update or delete on public.studio_sms_price_audit for each row execute function public._tw4priceauth_guard();
create trigger studio_sms_price_auth_config_truncate before truncate on public.studio_sms_price_auth_config for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_price_credentials_truncate before truncate on public.studio_sms_price_credentials for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_price_auth_challenges_truncate before truncate on public.studio_sms_price_auth_challenges for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_price_audit_truncate before truncate on public.studio_sms_price_audit for each statement execute function public._tw4c_truncate_guard();
alter table public.studio_sms_price_auth_config enable always trigger studio_sms_price_auth_config_guard;
alter table public.studio_sms_price_credentials enable always trigger studio_sms_price_credentials_guard;
alter table public.studio_sms_price_auth_challenges enable always trigger studio_sms_price_auth_challenges_guard;
alter table public.studio_sms_price_audit enable always trigger studio_sms_price_audit_guard;
alter table public.studio_sms_price_auth_config enable always trigger studio_sms_price_auth_config_truncate;
alter table public.studio_sms_price_credentials enable always trigger studio_sms_price_credentials_truncate;
alter table public.studio_sms_price_auth_challenges enable always trigger studio_sms_price_auth_challenges_truncate;
alter table public.studio_sms_price_audit enable always trigger studio_sms_price_audit_truncate;

-- the single audit writer: immutable evidence, also the monitoring interface (tw4_price_audit_feed)
create or replace function public._tw4price_audit(p_event text, p_actor uuid, p_session text, p_request uuid, p_credential bytea, p_detail jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform set_config('tw4.priceauth_write', 'on', true);
  insert into public.studio_sms_price_audit (event, actor, session_id, request_id, credential_id, detail) values (p_event, p_actor, p_session, p_request, p_credential, coalesce(p_detail, '{}'::jsonb));
  perform set_config('tw4.priceauth_write', 'off', true);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- request table: the single-owner columns and the constraints that make the cooling-off and the hardware-key evidence structural
-- ---------------------------------------------------------------------------------------------------------------
alter table public.studio_sms_price_change_requests
  add column approval_mode text not null default 'team' check (approval_mode in ('team', 'owner')),
  add column cooling_until timestamptz null,
  add column proposer_session text null,
  add column proposal_version int not null default 1 check (proposal_version >= 1),
  add column replaces_request_id uuid null references public.studio_sms_price_change_requests(id) on delete restrict,
  add column auth_credential_id bytea null,
  add column auth_nonce bytea null;
alter table public.studio_sms_price_change_requests drop constraint studio_sms_price_change_requests_window;
alter table public.studio_sms_price_change_requests add constraint studio_sms_price_change_requests_window check (expires_at > requested_at and expires_at <= requested_at + interval '8 days');
alter table public.studio_sms_price_change_requests drop constraint studio_sms_price_change_requests_distinct;
-- team mode: two DISTINCT administrators. owner mode: the approval carries the hardware-key evidence instead (a single human, a separate session, a signed transaction)
alter table public.studio_sms_price_change_requests add constraint studio_sms_price_change_requests_distinct check (
  decided_by is null or decided_by <> requested_by or status = 'rejected' or (approval_mode = 'owner' and auth_credential_id is not null));
-- the mandatory cooling-off is a ROW constraint: an owner-mode request always waits at least 24 hours before it can be authorized, whatever a function does
alter table public.studio_sms_price_change_requests add constraint studio_sms_price_change_requests_owner_shape check (
  (approval_mode = 'owner') = (cooling_until is not null and proposer_session is not null)
  and (cooling_until is null or (cooling_until >= requested_at + interval '24 hours' and expires_at > cooling_until)));
alter table public.studio_sms_price_change_requests add constraint studio_sms_price_change_requests_owner_evidence check (
  (auth_credential_id is not null) = (approval_mode = 'owner' and status in ('approved', 'applied')) and (auth_nonce is not null) = (auth_credential_id is not null)
  and (status <> 'applied' or approval_mode = 'team' or decided_at >= cooling_until));

-- ---------------------------------------------------------------------------------------------------------------
-- WebAuthn assertion verification INSIDE the database (trust boundary option A). ECDSA P-256 / SHA-256 in plpgsql over numeric: no extension, no external service, no GoTrue,
-- no JWT, no service_role. The credential registry and the challenges have no grants and are written only by the functions below.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4price_bytes2num(p_b bytea)
returns numeric language plpgsql immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare v numeric := 0; i int;
begin
  for i in 0..octet_length(p_b) - 1 loop
    v := v * 256 + get_byte(p_b, i);
  end loop;
  return v;
end $$;

create or replace function public._tw4price_powmod(p_b numeric, p_e numeric, p_m numeric)
returns numeric language plpgsql immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare r numeric := 1; x numeric := mod(p_b, p_m); k numeric := p_e;
begin
  while k > 0 loop
    if mod(k, 2) = 1 then r := mod(r * x, p_m); end if;
    x := mod(x * x, p_m);
    k := div(k, 2);
  end loop;
  return r;
end $$;

create or replace function public._tw4price_num2bits(p_v numeric)
returns bit varying language plpgsql immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare h text := ''; k int;
begin
  for k in reverse 7..0 loop
    h := h || lpad(to_hex(mod(div(p_v, 2::numeric ^ (32 * k)), 4294967296::numeric)::bigint), 8, '0');
  end loop;
  return ('x' || h)::bit(256);
end $$;

-- Jacobian doubling on y^2 = x^3 - 3x + b (mod p). Infinity is z = 0.
create or replace function public._tw4price_jdbl(x numeric, y numeric, z numeric)
returns numeric[] language plpgsql immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  p constant numeric := 115792089210356248762697446949407573530086143415290314195533631308867097853951;
  delta numeric; gamma numeric; beta numeric; alpha numeric; x3 numeric; y3 numeric; z3 numeric;
begin
  if z = 0 or y = 0 then return array[0, 1, 0]::numeric[]; end if;
  delta := mod(z * z, p);
  gamma := mod(y * y, p);
  beta := mod(x * gamma, p);
  alpha := mod(mod(3 * (x - delta) * (x + delta), p) + p, p);
  x3 := mod(mod(alpha * alpha - 8 * beta, p) + p, p);
  z3 := mod(mod((y + z) * (y + z) - gamma - delta, p) + p, p);
  y3 := mod(mod(alpha * (4 * beta - x3) - 8 * gamma * gamma, p) + p, p);
  return array[x3, y3, z3]::numeric[];
end $$;

-- Jacobian addition (general, handles infinity, doubling and the inverse point)
create or replace function public._tw4price_jadd(x1 numeric, y1 numeric, z1 numeric, x2 numeric, y2 numeric, z2 numeric)
returns numeric[] language plpgsql immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  p constant numeric := 115792089210356248762697446949407573530086143415290314195533631308867097853951;
  z1z1 numeric; z2z2 numeric; u1 numeric; u2 numeric; s1 numeric; s2 numeric; h numeric; rr numeric; i numeric; j numeric; v numeric; x3 numeric; y3 numeric; z3 numeric;
begin
  if z1 = 0 then return array[x2, y2, z2]::numeric[]; end if;
  if z2 = 0 then return array[x1, y1, z1]::numeric[]; end if;
  z1z1 := mod(z1 * z1, p);
  z2z2 := mod(z2 * z2, p);
  u1 := mod(x1 * z2z2, p);
  u2 := mod(x2 * z1z1, p);
  s1 := mod(mod(y1 * z2, p) * z2z2, p);
  s2 := mod(mod(y2 * z1, p) * z1z1, p);
  h := mod(mod(u2 - u1, p) + p, p);
  rr := mod(mod(2 * (s2 - s1), p) + p, p);
  if h = 0 then
    if rr = 0 then return public._tw4price_jdbl(x1, y1, z1); end if;
    return array[0, 1, 0]::numeric[];
  end if;
  i := mod(4 * h * h, p);
  j := mod(h * i, p);
  v := mod(u1 * i, p);
  x3 := mod(mod(rr * rr - j - 2 * v, p) + p, p);
  y3 := mod(mod(rr * (v - x3) - 2 * s1 * j, p) + p, p);
  z3 := mod(mod(((z1 + z2) * (z1 + z2) - z1z1 - z2z2) * h, p) + p, p);
  return array[x3, y3, z3]::numeric[];
end $$;

create or replace function public._tw4price_p256_oncurve(p_x numeric, p_y numeric)
returns boolean language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select p_x > 0 and p_x < 115792089210356248762697446949407573530086143415290314195533631308867097853951
     and p_y > 0 and p_y < 115792089210356248762697446949407573530086143415290314195533631308867097853951
     and mod(mod(p_y * p_y - (p_x * p_x * p_x - 3 * p_x + 41058363725152142129326129780047268409114441015993725554835256314039467401291), 115792089210356248762697446949407573530086143415290314195533631308867097853951)
             + 115792089210356248762697446949407573530086143415290314195533631308867097853951, 115792089210356248762697446949407573530086143415290314195533631308867097853951) = 0;
$$;

-- ECDSA verify: e is the hash as a number, (r, s) the signature, (qx, qy) the public key
create or replace function public._tw4price_p256_verify(p_e numeric, p_r numeric, p_s numeric, p_qx numeric, p_qy numeric)
returns boolean language plpgsql immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  p constant numeric := 115792089210356248762697446949407573530086143415290314195533631308867097853951;
  n constant numeric := 115792089210356248762697446949407573529996955224135760342422259061068512044369;
  gx constant numeric := 48439561293906451759052585252797914202762949526041747995844080717082404635286;
  gy constant numeric := 36134250956749795798585127919587881956611106672985015071877198253568414405109;
  w numeric; u1 numeric; u2 numeric; b1 bit varying; b2 bit varying; r numeric[]; gq numeric[]; i int; c1 int; c2 int; zinv numeric; xa numeric;
begin
  if p_r < 1 or p_r >= n or p_s < 1 or p_s >= n or not public._tw4price_p256_oncurve(p_qx, p_qy) then return false; end if;
  w := public._tw4price_powmod(p_s, n - 2, n);
  u1 := mod(p_e * w, n);
  u2 := mod(p_r * w, n);
  b1 := public._tw4price_num2bits(u1);
  b2 := public._tw4price_num2bits(u2);
  gq := public._tw4price_jadd(gx, gy, 1, p_qx, p_qy, 1);
  r := array[0, 1, 0]::numeric[];
  for i in 0..255 loop
    r := public._tw4price_jdbl(r[1], r[2], r[3]);
    c1 := get_bit(b1, i);
    c2 := get_bit(b2, i);
    if c1 = 1 and c2 = 1 then r := public._tw4price_jadd(r[1], r[2], r[3], gq[1], gq[2], gq[3]);
    elsif c1 = 1 then r := public._tw4price_jadd(r[1], r[2], r[3], gx, gy, 1);
    elsif c2 = 1 then r := public._tw4price_jadd(r[1], r[2], r[3], p_qx, p_qy, 1);
    end if;
  end loop;
  if r[3] = 0 then return false; end if;
  zinv := public._tw4price_powmod(r[3], p - 2, p);
  xa := mod(r[1] * mod(zinv * zinv, p), p);
  return mod(xa, n) = p_r;
end $$;

-- DER ECDSA signature -> (r, s); null when malformed
create or replace function public._tw4price_der_rs(p_sig bytea, out r numeric, out s numeric)
language plpgsql immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare rl int; sl int; idx int;
begin
  r := null; s := null;
  if p_sig is null or octet_length(p_sig) < 8 or octet_length(p_sig) > 72 or get_byte(p_sig, 0) <> 48 or get_byte(p_sig, 1) <> octet_length(p_sig) - 2 or get_byte(p_sig, 2) <> 2 then return; end if;
  rl := get_byte(p_sig, 3);
  idx := 4 + rl;
  if rl < 1 or idx + 2 > octet_length(p_sig) or get_byte(p_sig, idx) <> 2 then return; end if;
  sl := get_byte(p_sig, idx + 1);
  if sl < 1 or idx + 2 + sl <> octet_length(p_sig) then return; end if;
  r := public._tw4price_bytes2num(substring(p_sig from 5 for rl));
  s := public._tw4price_bytes2num(substring(p_sig from idx + 3 for sl));
end $$;

create or replace function public._tw4price_b64u(p_b bytea)
returns text language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$ select translate(replace(encode(p_b, 'base64'), E'\n', ''), '+/=', '-_'); $$;

create or replace function public._tw4price_unb64u(p_t text)
returns bytea language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$ select decode(translate(p_t, '-_', '+/') || repeat('=', (4 - char_length(p_t) % 4) % 4), 'base64'); $$;

-- canonical hash of a proposal: this is what the hardware key signs (inside the WebAuthn challenge). Every field a decision depends on is in it.
create or replace function public._tw4price_request_hash(q public.studio_sms_price_change_requests)
returns bytea language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select sha256(convert_to(concat_ws('|', 'tw4price/v1', 'authorize', 'studio_sms_price_list', q.kind, coalesce(q.base_customer_price_cents::text, 'none'), coalesce(q.base_provider_cost_cents::text, 'none'),
    q.customer_price_cents::text, q.provider_cost_cents::text, q.description, coalesce(q.base_price_id::text, 'none'), q.proposal_version::text, q.id::text, q.approval_mode,
    (extract(epoch from q.cooling_until) * 1000000)::bigint::text, (extract(epoch from q.expires_at) * 1000000)::bigint::text), 'UTF8'));
$$;

-- one assertion check. Returns NULL when valid, otherwise the reason (never raises for a bad assertion, so the caller can record the rejection and commit it).
-- Consumes the challenge and bumps the sign counter ONLY on success.
create or replace function public._tw4price_check_assertion(p_purpose text, p_nonce bytea, p_expected_hash bytea, p_cred_id bytea, p_auth bytea, p_client bytea, p_sig bytea, p_consume boolean)
returns text language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  ch public.studio_sms_price_auth_challenges;
  cr public.studio_sms_price_credentials;
  cfg public.studio_sms_price_auth_config;
  cd jsonb;
  v_challenge bytea;
  v_count bigint;
  v_rs record;
begin
  select * into cfg from public.studio_sms_price_auth_config;
  if cfg.rp_id is null or cfg.rp_origins is null then return 'the relying party is not configured'; end if;
  select * into ch from public.studio_sms_price_auth_challenges c where c.nonce = p_nonce for update;
  if ch.nonce is null then return 'unknown challenge'; end if;
  if ch.purpose <> p_purpose then return 'challenge for another purpose'; end if;
  if ch.used_at is not null then return 'challenge already used'; end if;
  if ch.expires_at <= clock_timestamp() then return 'challenge expired'; end if;
  if ch.bound_hash is distinct from p_expected_hash then return 'the transaction changed after the challenge was issued'; end if;
  select * into cr from public.studio_sms_price_credentials c where c.credential_id = p_cred_id and c.status = 'active';
  if cr.id is null then return 'unknown or revoked credential'; end if;
  begin
    cd := convert_from(p_client, 'UTF8')::jsonb;
  exception when others then
    return 'client data is not JSON';
  end;
  v_challenge := sha256(p_expected_hash || p_nonce);
  if cd ->> 'type' is distinct from 'webauthn.get' or cd ->> 'challenge' is distinct from public._tw4price_b64u(v_challenge) then return 'client data does not carry this challenge'; end if;
  if cd ->> 'origin' is null or not (cd ->> 'origin' = any (cfg.rp_origins)) or coalesce(cd ->> 'crossOrigin', 'false') <> 'false' then return 'origin not allowed'; end if;
  if p_auth is null or octet_length(p_auth) < 37 or substring(p_auth from 1 for 32) <> sha256(convert_to(cfg.rp_id, 'UTF8')) then return 'relying party hash mismatch'; end if;
  if (get_byte(p_auth, 32) & 1) = 0 or (get_byte(p_auth, 32) & 4) = 0 then return 'user presence and user verification are required'; end if;
  -- backup-eligible / backed-up (synced passkey) credentials are not device-bound: refused unless the owner's migration allows them. (There is no attestation, so this flag is the strongest evidence an assertion carries.)
  if (get_byte(p_auth, 32) & 24) <> 0 and not cfg.allow_backup_eligible then return 'a backup-eligible (synced) credential is not accepted'; end if;
  v_count := get_byte(p_auth, 33)::bigint * 16777216 + get_byte(p_auth, 34) * 65536 + get_byte(p_auth, 35) * 256 + get_byte(p_auth, 36);
  if v_count <= cr.sign_count and not (v_count = 0 and cr.sign_count = 0) then return 'sign counter did not increase (cloned authenticator?)'; end if;
  select * into v_rs from public._tw4price_der_rs(p_sig);
  if v_rs.r is null then return 'malformed signature'; end if;
  if not public._tw4price_p256_verify(public._tw4price_bytes2num(sha256(p_auth || sha256(p_client))), v_rs.r, v_rs.s, public._tw4price_bytes2num(cr.pub_x), public._tw4price_bytes2num(cr.pub_y)) then
    return 'signature does not verify';
  end if;
  perform set_config('tw4.priceauth_write', 'on', true);
  if p_consume then
    update public.studio_sms_price_auth_challenges set used_at = clock_timestamp() where nonce = p_nonce;
  end if;
  update public.studio_sms_price_credentials set sign_count = greatest(sign_count, v_count) where id = cr.id;
  perform set_config('tw4.priceauth_write', 'off', true);
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- challenge issue and transaction authorization (single-owner mode): cooling-off, a SEPARATE session, and a hardware-key signature over the exact proposal
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4price_new_nonce()
returns bytea language sql volatile
set search_path = pg_catalog, public, pg_temp
as $$ select decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'); $$;

create or replace function public._tw4price_session_id()
returns text language sql stable
set search_path = pg_catalog, public, pg_temp
as $$ select nullif(auth.jwt() ->> 'session_id', ''); $$;

-- shared state checks for begin / finish: returns the locked request. Raises on any business-rule failure.
create or replace function public._tw4price_owner_gate(p_request_id uuid, p_actor uuid, p_sid text)
returns public.studio_sms_price_change_requests language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  q public.studio_sms_price_change_requests;
  cfg public.studio_sms_price_auth_config;
  v_cur uuid;
begin
  if p_sid is null then
    raise exception 'the session has no session id: sign in again' using errcode = '42501';
  end if;
  if not public._tw4price_admin_active(p_actor) then
    raise exception 'actor must be an active registered platform admin' using errcode = '42501';
  end if;
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id;
  if q.id is null then
    raise exception 'unknown price proposal' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || q.kind));
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id for update;
  if q.approval_mode <> 'owner' then
    raise exception 'this proposal is a team-mode proposal: it is approved by a second administrator' using errcode = 'TW042';
  end if;
  if q.requested_by <> p_actor then
    raise exception 'only the owner who made the proposal can authorize it' using errcode = '42501';
  end if;
  if q.status <> 'pending' then
    raise exception 'this price proposal is already % and cannot be authorized', q.status using errcode = 'TW041';
  end if;
  if q.proposer_session is not distinct from p_sid then
    raise exception 'authorize from a SEPARATE session: sign in again (the proposing session cannot authorize)' using errcode = '42501';
  end if;
  if q.expires_at <= clock_timestamp() then
    raise exception 'the authorization window of this proposal has ended: make a new proposal' using errcode = 'TW041';
  end if;
  if q.cooling_until > clock_timestamp() then
    raise exception 'the cooling-off period has not ended (until %)', q.cooling_until using errcode = 'TW045';
  end if;
  if public._tw4price_suspended() then
    raise exception 'price publication is suspended (freeze or a monitoring suspension): lifting it needs the hardware-key ceremony' using errcode = '42501';
  end if;
  select x.id into v_cur from public.studio_sms_price_list x where x.kind = q.kind and x.active for update;
  if v_cur is distinct from q.base_price_id then
    raise exception 'the active price changed after the proposal was made: make a new proposal' using errcode = 'TW041';
  end if;
  return q;
end $$;

-- approved limits (data) re-checked at EVERY decision: an older proposal can never publish outside limits the owner approved later
create or replace function public._tw4price_limits_check(p_kind text, p_customer int, p_provider int, p_base_customer int)
returns void language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare lim public.studio_sms_price_limits;
begin
  select * into lim from public.studio_sms_price_limits l where l.kind = p_kind and l.approved;
  if lim.kind is not null and (p_customer > lim.max_customer_cents or p_provider > lim.max_provider_cents
       or (lim.max_provider_pct_of_customer is not null and p_provider::bigint * 100 > p_customer::bigint * lim.max_provider_pct_of_customer)
       or (lim.max_step_pct is not null and p_base_customer is not null and abs(p_customer::bigint - p_base_customer) * 100 > p_base_customer::bigint * lim.max_step_pct)) then
    raise exception 'the proposed prices exceed the owner-approved limits for this kind' using errcode = '22023';
  end if;
end $$;

-- does this challenge belong to this user and this session? (every purpose, not only authorize)
create or replace function public._tw4price_challenge_ok(p_nonce bytea, p_actor uuid, p_sid text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select exists (select 1 from public.studio_sms_price_auth_challenges c where c.nonce = p_nonce and c.issued_to = p_actor and c.session_id is not distinct from p_sid); $$;

create or replace function public.tw4_price_authz_begin(p_request_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := public._tw4price_session_actor('aal2');
  v_sid text := public._tw4price_session_id();
  q public.studio_sms_price_change_requests;
  cfg public.studio_sms_price_auth_config;
  v_hash bytea;
  v_nonce bytea;
  v_creds jsonb;
begin
  -- a refusal by a registered administrator's session is RECORDED (committed) and returned, not raised: the audit is the detector, independent of any other table
  begin
    q := public._tw4price_owner_gate(p_request_id, v_actor, v_sid);
    perform public._tw4price_limits_check(q.kind, q.customer_price_cents, q.provider_cost_cents, q.base_customer_price_cents);
  exception when others then
    perform public._tw4price_audit('gate_refused', v_actor, v_sid, p_request_id, null, jsonb_build_object('step', 'begin', 'code', sqlstate, 'reason', left(sqlerrm, 200)));
    return jsonb_build_object('status', 'refused', 'code', sqlstate, 'reason', sqlerrm);
  end;
  select * into cfg from public.studio_sms_price_auth_config;
  v_hash := public._tw4price_request_hash(q);
  v_nonce := public._tw4price_new_nonce();
  perform set_config('tw4.priceauth_write', 'on', true);
  insert into public.studio_sms_price_auth_challenges (nonce, purpose, bound_hash, request_id, issued_to, session_id, expires_at)
  values (v_nonce, 'authorize', v_hash, q.id, v_actor, v_sid, clock_timestamp() + make_interval(secs => cfg.challenge_ttl_seconds));
  perform set_config('tw4.priceauth_write', 'off', true);
  select coalesce(jsonb_agg(public._tw4price_b64u(c.credential_id)), '[]'::jsonb) into v_creds from public.studio_sms_price_credentials c where c.status = 'active';
  perform public._tw4price_audit('challenge_issued', v_actor, v_sid, q.id, null, jsonb_build_object('purpose', 'authorize', 'kind', q.kind, 'new_customer_cents', q.customer_price_cents,
    'new_provider_cents', q.provider_cost_cents, 'fingerprint', left(encode(v_hash, 'hex'), 16)));
  -- the SECOND CHANNEL: the monitoring feed carries the same fingerprint and values, so an alert can show them to the owner on a path that does not run through the page that signs
  perform public._tw4price_emit('price_authorization_started', v_actor, jsonb_build_object('request_id', q.id, 'kind', q.kind, 'new_customer_cents', q.customer_price_cents,
    'new_provider_cents', q.provider_cost_cents, 'fingerprint', left(encode(v_hash, 'hex'), 16)));
  return jsonb_build_object('nonce', public._tw4price_b64u(v_nonce), 'challenge', public._tw4price_b64u(sha256(v_hash || v_nonce)), 'rp_id', cfg.rp_id, 'allow_credentials', v_creds,
    'expires_in_seconds', cfg.challenge_ttl_seconds, 'summary', jsonb_build_object('scope', 'studio_sms_price_list', 'kind', q.kind, 'old_customer_cents', q.base_customer_price_cents,
      'old_provider_cents', q.base_provider_cost_cents, 'new_customer_cents', q.customer_price_cents, 'new_provider_cents', q.provider_cost_cents, 'description', q.description,
      'proposal_version', q.proposal_version, 'request_id', q.id, 'hash', encode(v_hash, 'hex'), 'expires_at', q.expires_at));
end $$;

create or replace function public.tw4_price_authz_finish(p_request_id uuid, p_nonce text, p_credential_id text, p_auth_data text, p_client_data text, p_signature text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := public._tw4price_session_actor('aal2');
  v_sid text := public._tw4price_session_id();
  q public.studio_sms_price_change_requests;
  v_nonce bytea;
  v_cred bytea;
  v_reason text;
  v_new uuid;
begin
  begin
    q := public._tw4price_owner_gate(p_request_id, v_actor, v_sid);
    perform public._tw4price_limits_check(q.kind, q.customer_price_cents, q.provider_cost_cents, q.base_customer_price_cents);
  exception when others then
    perform public._tw4price_audit('gate_refused', v_actor, v_sid, p_request_id, null, jsonb_build_object('step', 'finish', 'code', sqlstate, 'reason', left(sqlerrm, 200)));
    return jsonb_build_object('status', 'refused', 'code', sqlstate, 'reason', sqlerrm);
  end;
  begin
    v_nonce := public._tw4price_unb64u(p_nonce);
    v_cred := public._tw4price_unb64u(p_credential_id);
    if not public._tw4price_challenge_ok(v_nonce, v_actor, v_sid) or not exists (select 1 from public.studio_sms_price_auth_challenges c where c.nonce = v_nonce and c.request_id = q.id) then
      v_reason := 'the challenge was issued to another session or request';
    else
      v_reason := public._tw4price_check_assertion('authorize', v_nonce, public._tw4price_request_hash(q), v_cred, public._tw4price_unb64u(p_auth_data), public._tw4price_unb64u(p_client_data),
        public._tw4price_unb64u(p_signature), true);
    end if;
  exception when others then
    v_reason := 'malformed input';
  end;
  if v_reason is not null then
    -- recorded and committed: nothing else changes. A sign counter that did not increase is an integrity failure (a cloned authenticator?), recorded as such.
    perform public._tw4price_audit(case when v_reason like 'sign counter%' then 'integrity_failure' else 'assertion_rejected' end, v_actor, v_sid, q.id, v_cred, jsonb_build_object('reason', v_reason, 'step', 'finish'));
    if v_reason like 'sign counter%' then
      perform public._tw4price_emit('price_integrity_failure', v_actor, jsonb_build_object('reason', 'sign counter did not increase', 'request_id', q.id));
    end if;
    return jsonb_build_object('status', 'rejected', 'reason', v_reason);
  end if;
  perform set_config('tw4.pricedual_write', 'on', true);
  update public.studio_sms_price_change_requests set status = 'approved', decided_by = v_actor, decided_at = clock_timestamp(),
    decision_note = 'authorized with a hardware-backed transaction approval after the cooling-off', auth_credential_id = v_cred, auth_nonce = v_nonce where id = q.id;
  update public.studio_sms_price_list set active = false where kind = q.kind and active;
  insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, description, created_by)
  values (q.kind, q.customer_price_cents, q.provider_cost_cents, q.description, v_actor) returning id into v_new;
  update public.studio_sms_price_change_requests set status = 'applied', applied_price_id = v_new, applied_at = clock_timestamp() where id = q.id;
  perform set_config('tw4.pricedual_write', 'off', true);
  perform public._tw4price_audit('authorized', v_actor, v_sid, q.id, v_cred, jsonb_build_object('hash', encode(public._tw4price_request_hash(q), 'hex')));
  perform public._tw4price_audit('published', v_actor, v_sid, q.id, v_cred, jsonb_build_object('price_id', v_new, 'kind', q.kind, 'customer_cents', q.customer_price_cents, 'provider_cents', q.provider_cost_cents));
  return jsonb_build_object('status', 'applied', 'price_id', v_new);
end $$;

-- revising a proposal invalidates the old one (and with it every challenge issued for it) and starts a NEW proposal version with a fresh cooling-off
create or replace function public.tw4_price_revise(p_request_id uuid, p_customer_cents int, p_provider_cents int, p_description text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := public._tw4price_session_actor('recent');
  q public.studio_sms_price_change_requests;
begin
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id;
  if q.id is null then
    raise exception 'unknown price proposal' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || q.kind));
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id for update;
  if q.requested_by <> v_actor or not public._tw4price_admin_active(v_actor) then
    raise exception 'only the administrator who made the proposal can revise it' using errcode = '42501';
  end if;
  if q.status <> 'pending' then
    raise exception 'this price proposal is already % and cannot be revised', q.status using errcode = 'TW041';
  end if;
  perform set_config('tw4.pricedual_write', 'on', true);
  update public.studio_sms_price_change_requests set status = 'invalidated', decided_at = clock_timestamp(), decision_note = 'invalidated: revised by the proposer, a new version restarts the cooling-off' where id = q.id;
  perform set_config('tw4.pricedual_write', 'off', true);
  perform public._tw4price_audit('revised', v_actor, public._tw4price_session_id(), q.id, null, jsonb_build_object('from_version', q.proposal_version));
  return public._tw4price_do_propose_mode(q.kind, p_customer_cents, p_provider_cents, p_description, p_reason, v_actor, q.approval_mode, public._tw4price_session_id(), q.id);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- credentials: bootstrap (owner-level only), enrol / revoke (each needs an assertion from an EXISTING credential and is only PENDING for a mandatory delay)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4price_bootstrap(p_rp_id text, p_origins text[], p_cred_id bytea, p_x bytea, p_y bytea, p_label text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if exists (select 1 from public.studio_sms_price_credentials) or (select rp_id from public.studio_sms_price_auth_config) is not null then
    raise exception 'the price authorization is already bootstrapped' using errcode = '42501';
  end if;
  if p_origins is null or cardinality(p_origins) < 1 or not public._tw4price_p256_oncurve(public._tw4price_bytes2num(p_x), public._tw4price_bytes2num(p_y)) then
    raise exception 'bootstrap needs the relying party origins and a valid P-256 public key' using errcode = '22023';
  end if;
  perform set_config('tw4.priceauth_write', 'on', true);
  update public.studio_sms_price_auth_config set rp_id = p_rp_id, rp_origins = p_origins;
  insert into public.studio_sms_price_credentials (credential_id, pub_x, pub_y, role, label, enrolled_via) values (p_cred_id, p_x, p_y, 'primary', p_label, 'bootstrap');
  perform set_config('tw4.priceauth_write', 'off', true);
  perform public._tw4price_audit('credential_bootstrapped', null, null, null, p_cred_id, jsonb_build_object('rp_id', p_rp_id, 'label', p_label));
end $$;

create or replace function public._tw4price_cred_hash(p_purpose text, p_cred_id bytea, p_x bytea, p_y bytea, p_role text, p_label text)
returns bytea language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$ select sha256(convert_to(concat_ws('|', 'tw4price/v1', p_purpose, public._tw4price_b64u(p_cred_id), coalesce(public._tw4price_b64u(p_x), '-'), coalesce(public._tw4price_b64u(p_y), '-'), coalesce(p_role, '-'), coalesce(p_label, '-')), 'UTF8')); $$;

-- the freeze can be lifted only by a credential that PREDATES it; the hash binds the exact suspension being lifted (the local freeze and/or the unlifted monitoring suspension)
create or replace function public._tw4price_thaw_hash()
returns bytea language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return (select sha256(convert_to('tw4price/v1|thaw|' || coalesce((extract(epoch from c.frozen_at) * 1000000)::bigint::text, 'none') || '|' || public._tw4price_monitor_suspend_seq()::text, 'UTF8')) from public.studio_sms_price_auth_config c);
end $$;

-- begin a credential ceremony. purpose: enroll (new credential public key, role, label), revoke (target credential id), thaw (lift the suspension)
create or replace function public.tw4_price_cred_begin(p_purpose text, p_cred_id text, p_x text, p_y text, p_role text, p_label text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := public._tw4price_session_actor('aal2');
  v_sid text := public._tw4price_session_id();
  cfg public.studio_sms_price_auth_config;
  v_hash bytea;
  v_nonce bytea;
  v_target bytea := case when p_cred_id is null then null else public._tw4price_unb64u(p_cred_id) end;
  v_creds jsonb;
begin
  if not public._tw4price_admin_active(v_actor) then
    raise exception 'actor must be an active registered platform admin' using errcode = '42501';
  end if;
  select * into cfg from public.studio_sms_price_auth_config;
  if p_purpose = 'enroll' then
    if p_role not in ('primary', 'spare') or p_label is null or char_length(btrim(p_label)) not between 3 and 60 or v_target is null or octet_length(v_target) < 16
       or not public._tw4price_p256_oncurve(public._tw4price_bytes2num(public._tw4price_unb64u(p_x)), public._tw4price_bytes2num(public._tw4price_unb64u(p_y)))
       or (select count(*) from public.studio_sms_price_credentials c where c.status = 'active') >= 3 then
      raise exception 'an enrolment needs a valid P-256 public key, a role, a label, and at most 3 credentials may be active' using errcode = '22023';
    end if;
    v_hash := public._tw4price_cred_hash('enroll', v_target, public._tw4price_unb64u(p_x), public._tw4price_unb64u(p_y), p_role, btrim(p_label));
  elsif p_purpose = 'revoke' then
    if not exists (select 1 from public.studio_sms_price_credentials c where c.credential_id = v_target and c.status = 'active') or (select count(*) from public.studio_sms_price_credentials c where c.status = 'active') < 2 then
      raise exception 'revoke needs an active target credential and at least one other active credential' using errcode = '22023';
    end if;
    v_hash := public._tw4price_cred_hash('revoke', v_target, null, null, null, null);
  elsif p_purpose = 'thaw' then
    if not public._tw4price_suspended() then
      raise exception 'prices are not suspended' using errcode = 'TW041';
    end if;
    v_hash := public._tw4price_thaw_hash();
  else
    raise exception 'unknown ceremony' using errcode = '22023';
  end if;
  v_nonce := public._tw4price_new_nonce();
  perform set_config('tw4.priceauth_write', 'on', true);
  insert into public.studio_sms_price_auth_challenges (nonce, purpose, bound_hash, issued_to, session_id, expires_at) values (v_nonce, p_purpose, v_hash, v_actor, v_sid, clock_timestamp() + make_interval(secs => cfg.challenge_ttl_seconds));
  perform set_config('tw4.priceauth_write', 'off', true);
  select coalesce(jsonb_agg(public._tw4price_b64u(c.credential_id)), '[]'::jsonb) into v_creds from public.studio_sms_price_credentials c
   where c.status = 'active' and (p_purpose <> 'revoke' or c.credential_id <> v_target)
     and (p_purpose <> 'thaw' or c.enrolled_at < coalesce(cfg.frozen_at, 'infinity'::timestamptz));
  perform public._tw4price_audit('challenge_issued', v_actor, v_sid, null, v_target, jsonb_build_object('purpose', p_purpose));
  return jsonb_build_object('nonce', public._tw4price_b64u(v_nonce), 'challenge', public._tw4price_b64u(sha256(v_hash || v_nonce)), 'rp_id', cfg.rp_id, 'allow_credentials', v_creds, 'hash', encode(v_hash, 'hex'));
end $$;

-- REQUEST a credential enrolment. It does NOT take effect: it becomes a visible, alerting, cancellable PENDING change that applies only after the mandatory delay
create or replace function public.tw4_price_cred_enroll(p_nonce text, p_new_cred_id text, p_x text, p_y text, p_role text, p_label text,
  p_by_cred text, p_by_auth text, p_by_client text, p_by_sig text, p_new_auth text, p_new_client text, p_new_sig text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := public._tw4price_session_actor('aal2');
  v_sid text := public._tw4price_session_id();
  cfg public.studio_sms_price_auth_config;
  v_nonce bytea;
  v_new bytea;
  v_x bytea;
  v_y bytea;
  v_hash bytea;
  v_reason text;
  v_by bytea;
  v_change uuid;
begin
  if not public._tw4price_admin_active(v_actor) then
    raise exception 'actor must be an active registered platform admin' using errcode = '42501';
  end if;
  select * into cfg from public.studio_sms_price_auth_config;
  perform pg_advisory_xact_lock(hashtext('tw4price:cred'));
  begin
    v_nonce := public._tw4price_unb64u(p_nonce); v_new := public._tw4price_unb64u(p_new_cred_id); v_x := public._tw4price_unb64u(p_x); v_y := public._tw4price_unb64u(p_y);
    v_by := public._tw4price_unb64u(p_by_cred);
    v_hash := public._tw4price_cred_hash('enroll', v_new, v_x, v_y, p_role, btrim(p_label));
    if not public._tw4price_challenge_ok(v_nonce, v_actor, v_sid) then
      v_reason := 'the challenge was issued to another session';
    else
      -- 1. an EXISTING credential signs this exact enrolment (the new key, role and label are in the hash)
      v_reason := public._tw4price_check_assertion('enroll', v_nonce, v_hash, v_by, public._tw4price_unb64u(p_by_auth), public._tw4price_unb64u(p_by_client), public._tw4price_unb64u(p_by_sig), false);
    end if;
    if v_reason is null and v_by = v_new then v_reason := 'the new credential cannot authorize its own enrolment'; end if;
    if v_reason is null and (select count(*) from public.studio_sms_price_credentials c where c.status = 'active') >= 3 then v_reason := 'too many active credentials'; end if;
    if v_reason is null then
      -- 2. the NEW credential proves possession of its private key over the same challenge. The tentative row is always rolled back (the change is only PENDING); a duplicate key or id fails here
      begin
        perform set_config('tw4.priceauth_write', 'on', true);
        insert into public.studio_sms_price_credentials (credential_id, pub_x, pub_y, role, label, enrolled_via) values (v_new, v_x, v_y, p_role, btrim(p_label), 'assertion');
        v_reason := public._tw4price_check_assertion('enroll', v_nonce, v_hash, v_new, public._tw4price_unb64u(p_new_auth), public._tw4price_unb64u(p_new_client), public._tw4price_unb64u(p_new_sig), false);
        raise exception 'ROLLBACK_TENTATIVE_CREDENTIAL';
      exception when others then
        if sqlerrm <> 'ROLLBACK_TENTATIVE_CREDENTIAL' then v_reason := coalesce(v_reason, 'the new credential could not be enrolled (duplicate key or id?)'); end if;
      end;
      perform set_config('tw4.priceauth_write', 'off', true);
    end if;
  exception when others then
    v_reason := coalesce(v_reason, 'malformed input');
  end;
  if v_reason is not null then
    perform public._tw4price_audit('assertion_rejected', v_actor, v_sid, null, v_by, jsonb_build_object('purpose', 'enroll', 'reason', v_reason));
    return jsonb_build_object('status', 'rejected', 'reason', v_reason);
  end if;
  perform set_config('tw4.priceauth_write', 'on', true);
  update public.studio_sms_price_auth_challenges set used_at = clock_timestamp() where nonce = v_nonce;
  insert into public.studio_sms_price_credential_changes (kind, target_credential_id, pub_x, pub_y, role, label, authorized_by_credential_id, requested_by, effective_at)
  values ('enroll', v_new, v_x, v_y, p_role, btrim(p_label), v_by, v_actor, clock_timestamp() + make_interval(hours => cfg.credential_delay_hours)) returning id into v_change;
  perform set_config('tw4.priceauth_write', 'off', true);
  perform public._tw4price_audit('credential_change_pending', v_actor, v_sid, null, v_new, jsonb_build_object('change', 'enroll', 'change_id', v_change, 'role', p_role, 'label', btrim(p_label), 'authorized_by', encode(v_by, 'hex')));
  perform public._tw4price_emit('credential_change_pending', v_actor, jsonb_build_object('change', 'enroll', 'change_id', v_change, 'role', p_role, 'effective_in_hours', cfg.credential_delay_hours));
  return jsonb_build_object('status', 'pending', 'change_id', v_change, 'effective_in_hours', cfg.credential_delay_hours);
end $$;

-- REQUEST a revocation: pending, visible, alerting, cancellable, applied only after the delay
create or replace function public.tw4_price_cred_revoke(p_nonce text, p_target text, p_by_cred text, p_by_auth text, p_by_client text, p_by_sig text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := public._tw4price_session_actor('aal2');
  v_sid text := public._tw4price_session_id();
  cfg public.studio_sms_price_auth_config;
  v_nonce bytea;
  v_target bytea;
  v_by bytea;
  v_reason text;
  v_change uuid;
begin
  if not public._tw4price_admin_active(v_actor) then
    raise exception 'actor must be an active registered platform admin' using errcode = '42501';
  end if;
  select * into cfg from public.studio_sms_price_auth_config;
  perform pg_advisory_xact_lock(hashtext('tw4price:cred'));
  begin
    v_nonce := public._tw4price_unb64u(p_nonce); v_target := public._tw4price_unb64u(p_target); v_by := public._tw4price_unb64u(p_by_cred);
    if not public._tw4price_challenge_ok(v_nonce, v_actor, v_sid) then v_reason := 'the challenge was issued to another session';
    elsif v_by = v_target then v_reason := 'a credential cannot authorize its own revocation';
    elsif (select count(*) from public.studio_sms_price_credentials c where c.status = 'active') < 2 or not exists (select 1 from public.studio_sms_price_credentials c where c.credential_id = v_target and c.status = 'active') then
      v_reason := 'the last active credential cannot be revoked';
    else
      v_reason := public._tw4price_check_assertion('revoke', v_nonce, public._tw4price_cred_hash('revoke', v_target, null, null, null, null), v_by, public._tw4price_unb64u(p_by_auth),
        public._tw4price_unb64u(p_by_client), public._tw4price_unb64u(p_by_sig), true);
    end if;
  exception when others then
    v_reason := coalesce(v_reason, 'malformed input');
  end;
  if v_reason is not null then
    perform public._tw4price_audit('assertion_rejected', v_actor, v_sid, null, v_by, jsonb_build_object('purpose', 'revoke', 'reason', v_reason));
    return jsonb_build_object('status', 'rejected', 'reason', v_reason);
  end if;
  perform set_config('tw4.priceauth_write', 'on', true);
  insert into public.studio_sms_price_credential_changes (kind, target_credential_id, authorized_by_credential_id, requested_by, effective_at)
  values ('revoke', v_target, v_by, v_actor, clock_timestamp() + make_interval(hours => cfg.credential_delay_hours)) returning id into v_change;
  perform set_config('tw4.priceauth_write', 'off', true);
  perform public._tw4price_audit('credential_change_pending', v_actor, v_sid, null, v_target, jsonb_build_object('change', 'revoke', 'change_id', v_change, 'authorized_by', encode(v_by, 'hex')));
  perform public._tw4price_emit('credential_change_pending', v_actor, jsonb_build_object('change', 'revoke', 'change_id', v_change, 'effective_in_hours', cfg.credential_delay_hours));
  return jsonb_build_object('status', 'pending', 'change_id', v_change, 'effective_in_hours', cfg.credential_delay_hours);
end $$;

-- apply a pending change once its delay has passed. Nothing new is authorized here (the change was signed when it was requested); it is refused while publication is suspended
create or replace function public.tw4_price_cred_apply(p_change_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := public._tw4price_session_actor('aal2');
  v_sid text := public._tw4price_session_id();
  ch public.studio_sms_price_credential_changes;
begin
  if not public._tw4price_admin_active(v_actor) then
    raise exception 'actor must be an active registered platform admin' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4price:cred'));
  select * into ch from public.studio_sms_price_credential_changes c where c.id = p_change_id for update;
  if ch.id is null then raise exception 'unknown credential change' using errcode = '22023'; end if;
  if ch.status <> 'pending' then raise exception 'this credential change is already %', ch.status using errcode = 'TW041'; end if;
  if ch.effective_at > clock_timestamp() then raise exception 'the mandatory delay of this credential change has not ended (until %)', ch.effective_at using errcode = 'TW045'; end if;
  if public._tw4price_suspended() then raise exception 'credential changes are not applied while prices are suspended' using errcode = '42501'; end if;
  perform set_config('tw4.priceauth_write', 'on', true);
  if ch.kind = 'enroll' then
    if (select count(*) from public.studio_sms_price_credentials c where c.status = 'active') >= 3 then raise exception 'too many active credentials' using errcode = '22023'; end if;
    insert into public.studio_sms_price_credentials (credential_id, pub_x, pub_y, role, label, enrolled_via) values (ch.target_credential_id, ch.pub_x, ch.pub_y, ch.role, ch.label, 'assertion');
  else
    update public.studio_sms_price_credentials set status = 'revoked', revoked_at = clock_timestamp(), revoked_note = 'revoked with a hardware-backed approval after the delay' where credential_id = ch.target_credential_id and status = 'active';
    -- re-checked AFTER the update, under the credential lock: the registry never drops to zero active credentials
    if (select count(*) from public.studio_sms_price_credentials c where c.status = 'active') < 1 then
      raise exception 'the last active credential cannot be revoked' using errcode = '42501';
    end if;
  end if;
  update public.studio_sms_price_credential_changes set status = 'applied', applied_at = clock_timestamp() where id = ch.id;
  perform set_config('tw4.priceauth_write', 'off', true);
  perform public._tw4price_audit('credential_change_applied', v_actor, v_sid, null, ch.target_credential_id, jsonb_build_object('change', ch.kind, 'change_id', ch.id));
  perform public._tw4price_emit('credential_replaced', v_actor, jsonb_build_object('change', ch.kind, 'role', ch.role));
  return jsonb_build_object('status', 'applied', 'change', ch.kind);
end $$;

-- cancel a pending change: the SAFE direction, so a registered administrator session is enough (the owner's second session can always interrupt a hostile change; a hostile session can only delay a legitimate one)
create or replace function public.tw4_price_cred_cancel(p_change_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := public._tw4price_session_actor('aal2');
  ch public.studio_sms_price_credential_changes;
begin
  if not public._tw4price_admin_active(v_actor) then
    raise exception 'actor must be an active registered platform admin' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4price:cred'));
  select * into ch from public.studio_sms_price_credential_changes c where c.id = p_change_id for update;
  if ch.id is null then raise exception 'unknown credential change' using errcode = '22023'; end if;
  if ch.status <> 'pending' then raise exception 'this credential change is already %', ch.status using errcode = 'TW041'; end if;
  perform set_config('tw4.priceauth_write', 'on', true);
  update public.studio_sms_price_credential_changes set status = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by = v_actor where id = ch.id;
  perform set_config('tw4.priceauth_write', 'off', true);
  perform public._tw4price_audit('credential_change_cancelled', v_actor, public._tw4price_session_id(), null, ch.target_credential_id, jsonb_build_object('change', ch.kind, 'change_id', ch.id));
  perform public._tw4price_emit('credential_change_pending', v_actor, jsonb_build_object('change', ch.kind, 'change_id', ch.id, 'status', 'cancelled'));
  return jsonb_build_object('status', 'cancelled');
end $$;

create or replace function public.tw4_price_cred_pending()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_actor uuid := public._tw4price_session_actor('aal2');
begin
  if not public._tw4price_admin_active(v_actor) then
    raise exception 'actor must be an active registered platform admin' using errcode = '42501';
  end if;
  return jsonb_build_object('pending', coalesce((select jsonb_agg(jsonb_build_object('change_id', c.id, 'kind', c.kind, 'role', c.role, 'label', c.label, 'requested_at', c.requested_at, 'effective_at', c.effective_at) order by c.requested_at)
            from public.studio_sms_price_credential_changes c where c.status = 'pending'), '[]'::jsonb),
    'credentials', coalesce((select jsonb_agg(jsonb_build_object('role', k.role, 'label', k.label, 'enrolled_at', k.enrolled_at, 'id', public._tw4price_b64u(k.credential_id)) order by k.enrolled_at)
            from public.studio_sms_price_credentials k where k.status = 'active'), '[]'::jsonb));
end $$;

create or replace function public.tw4_price_thaw(p_nonce text, p_cred text, p_auth text, p_client text, p_sig text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := public._tw4price_session_actor('aal2');
  v_sid text := public._tw4price_session_id();
  cfg public.studio_sms_price_auth_config;
  v_reason text;
  v_cred bytea;
  v_nonce bytea;
  v_ref timestamptz;
  v_mon timestamptz;
  v_maxseq bigint := 0;
begin
  if not public._tw4price_admin_active(v_actor) then
    raise exception 'actor must be an active registered platform admin' using errcode = '42501';
  end if;
  select * into cfg from public.studio_sms_price_auth_config;
  if not public._tw4price_suspended() then
    return jsonb_build_object('status', 'not_frozen');
  end if;
  v_ref := cfg.frozen_at;
  if public._tw4price_monitor_suspend_seq() > 0 then
    execute 'select min(recorded_at), max(seq) from public.studio_sms_price_security_events where kind = ''pricing_suspended'' and seq > $1' into v_mon, v_maxseq using cfg.monitor_seq_lifted;
    v_ref := least(coalesce(v_ref, v_mon), coalesce(v_mon, v_ref));
  end if;
  begin
    v_nonce := public._tw4price_unb64u(p_nonce);
    v_cred := public._tw4price_unb64u(p_cred);
    if not public._tw4price_challenge_ok(v_nonce, v_actor, v_sid) then v_reason := 'the challenge was issued to another session';
    elsif not exists (select 1 from public.studio_sms_price_credentials k where k.credential_id = v_cred and k.status = 'active' and k.enrolled_at < v_ref) then
      v_reason := 'only a credential enrolled BEFORE the suspension can lift it';
    else
      v_reason := public._tw4price_check_assertion('thaw', v_nonce, public._tw4price_thaw_hash(), v_cred, public._tw4price_unb64u(p_auth), public._tw4price_unb64u(p_client), public._tw4price_unb64u(p_sig), true);
    end if;
  exception when others then
    v_reason := coalesce(v_reason, 'malformed input');
  end;
  if v_reason is not null then
    perform public._tw4price_audit('assertion_rejected', v_actor, v_sid, null, v_cred, jsonb_build_object('purpose', 'thaw', 'reason', v_reason));
    return jsonb_build_object('status', 'rejected', 'reason', v_reason);
  end if;
  perform set_config('tw4.priceauth_write', 'on', true);
  update public.studio_sms_price_auth_config set frozen = false, frozen_at = null, freeze_reason = null, monitor_seq_lifted = greatest(monitor_seq_lifted, coalesce(v_maxseq, 0));
  perform set_config('tw4.priceauth_write', 'off', true);
  perform public._tw4price_audit('freeze_lifted', v_actor, v_sid, null, v_cred, jsonb_build_object('lifted_monitor_seq', v_maxseq));
  perform public._tw4price_emit('pricing_resumed', v_actor, jsonb_build_object('lifted_by', 'hardware_key_thaw'));
  return jsonb_build_object('status', 'thawed');
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- emergency freeze: can only SUSPEND publication. Lifting it needs the hardware-key ceremony.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_price_freeze(p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_actor uuid := public._tw4price_session_actor('aal2');
begin
  if not public._tw4price_admin_active(v_actor) then
    raise exception 'actor must be an active registered platform admin' using errcode = '42501';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 10 and 300 then
    raise exception 'a freeze needs a written reason of 10 to 300 characters' using errcode = '22023';
  end if;
  if (select frozen from public.studio_sms_price_auth_config) then
    return jsonb_build_object('status', 'frozen', 'replayed', true);
  end if;
  perform set_config('tw4.priceauth_write', 'on', true);
  update public.studio_sms_price_auth_config set frozen = true, frozen_at = clock_timestamp(), freeze_reason = btrim(p_reason);
  perform set_config('tw4.priceauth_write', 'off', true);
  perform public._tw4price_audit('freeze_set', v_actor, public._tw4price_session_id(), null, null, jsonb_build_object('reason', btrim(p_reason)));
  perform public._tw4price_emit('pricing_suspended', v_actor, jsonb_build_object('reason', btrim(p_reason)));
  return jsonb_build_object('status', 'frozen', 'replayed', false);
end $$;

-- monitoring interface (stable): audit events after an id, oldest first. Read only; service_role and owner.
create or replace function public.tw4_price_audit_feed(p_after bigint default 0, p_limit int default 200)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'at', a.at, 'event', a.event, 'actor', a.actor, 'session_id', a.session_id, 'request_id', a.request_id,
    'credential_id', case when a.credential_id is null then null else public._tw4price_b64u(a.credential_id) end, 'detail', a.detail) order by a.id), '[]'::jsonb)
  from (select * from public.studio_sms_price_audit x where x.id > coalesce(p_after, 0) order by x.id limit least(greatest(coalesce(p_limit, 200), 1), 1000)) a;
$$;
-- ---------------------------------------------------------------------------------------------------------------
-- monitoring interface (workstream #391): security events are emitted into studio_sms_price_security_events WHEN that table exists (migration 20270205090000 creates it; the order on
-- the chain is 20270204090000, 20270204100000, then 20270205090000, so every emit is conditional and a missing table is simply a no-op). The same events are always in the
-- local immutable audit (studio_sms_price_audit). No secrets in any detail: roles, labels, reasons, counts, never keys, challenges, tokens or credential ids.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4price_emit(p_kind text, p_subject uuid, p_detail jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if to_regclass('public.studio_sms_price_security_events') is not null then
    execute 'insert into public.studio_sms_price_security_events (kind, subject_user_id, detail) values ($1, $2, $3)' using p_kind, p_subject, coalesce(p_detail, '{}'::jsonb);
  elsif (select monitoring_expected from public.studio_sms_price_auth_config) then
    -- once the owner declares monitoring expected, a missing events table is a LOUD failure, not a silent no-op
    raise exception 'the monitoring events table is expected but missing: security event % was not delivered', p_kind using errcode = 'TW046';
  end if;
end $$;

-- the unlifted MONITORING suspension: the highest pricing_suspended event of the monitoring feed above the sequence a hardware-key thaw has lifted (0 when none). pricing_resumed rows in
-- that table are IGNORED: only this schema's own hardware-key thaw lifts a suspension, so the monitoring table cannot lift one (and cannot wedge pricing beyond what a thaw undoes).
create or replace function public._tw4price_monitor_suspend_seq()
returns bigint language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v bigint := 0;
begin
  if to_regclass('public.studio_sms_price_security_events') is not null then
    execute 'select coalesce(max(seq), 0) from public.studio_sms_price_security_events where kind = ''pricing_suspended'' and seq > $1' into v using (select monitor_seq_lifted from public.studio_sms_price_auth_config);
  end if;
  return coalesce(v, 0);
end $$;

-- is price publication suspended? The local freeze flag, or an unlifted monitoring suspension (lifted ONLY by the hardware-key thaw)
create or replace function public._tw4price_suspended()
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  return (select frozen from public.studio_sms_price_auth_config) or public._tw4price_monitor_suspend_seq() > 0;
end $$;

-- the approver registry is written by the owner only; every registration or revocation is an event
create or replace function public._tw4price_registry_emit()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform public._tw4price_emit('approver_added', new.user_id, jsonb_build_object('note_length', char_length(new.added_note)));
    perform public._tw4price_emit('approver_registry_changed', new.user_id, jsonb_build_object('change', 'added'));
  elsif new.revoked_at is not null and old.revoked_at is null then
    perform public._tw4price_emit('approver_removed', new.user_id, '{}'::jsonb);
    perform public._tw4price_emit('approver_registry_changed', new.user_id, jsonb_build_object('change', 'revoked'));
  end if;
  return null;
end $$;
drop trigger if exists studio_sms_price_approvers_emit on public.studio_sms_price_approvers;
create trigger studio_sms_price_approvers_emit after insert or update on public.studio_sms_price_approvers for each row execute function public._tw4price_registry_emit();
alter table public.studio_sms_price_approvers enable always trigger studio_sms_price_approvers_emit;

-- a registered administrator reports a suspected credential compromise: this SUSPENDS publication (never publishes anything) and raises the event
create or replace function public.tw4_price_report_compromise(p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_actor uuid := public._tw4price_session_actor('aal2');
begin
  if not public._tw4price_admin_active(v_actor) then
    raise exception 'actor must be an active registered platform admin' using errcode = '42501';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 10 and 300 then
    raise exception 'a compromise report needs a written note of 10 to 300 characters' using errcode = '22023';
  end if;
  if not (select frozen from public.studio_sms_price_auth_config) then
    perform set_config('tw4.priceauth_write', 'on', true);
    update public.studio_sms_price_auth_config set frozen = true, frozen_at = clock_timestamp(), freeze_reason = 'compromise reported: ' || left(btrim(p_note), 240);
    perform set_config('tw4.priceauth_write', 'off', true);
    perform public._tw4price_audit('freeze_set', v_actor, public._tw4price_session_id(), null, null, jsonb_build_object('reason', 'compromise reported'));
    perform public._tw4price_emit('pricing_suspended', v_actor, jsonb_build_object('reason', 'compromise reported'));
  end if;
  perform public._tw4price_emit('credential_compromise_reported', v_actor, jsonb_build_object('note_length', char_length(btrim(p_note))));
  return jsonb_build_object('status', 'frozen');
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- replaced functions (20270204090000 bodies are restored byte for byte by the rollback)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4pricedual_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare p public.studio_sms_price_list;
begin
  if tg_op = 'DELETE' then
    raise exception 'studio_sms_price_change_requests: rows are never deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    -- a request is always BORN pending and undecided, whatever an owner-level insert supplies, and only the dual-control function creates one
    if coalesce(current_setting('tw4.pricedual_write', true), '') <> 'on' then
      raise exception 'studio_sms_price_change_requests: a request is created only by tw4_price_propose' using errcode = '42501';
    end if;
    new.status := 'pending';
    new.decided_by := null;
    new.decided_at := null;
    new.decision_note := null;
    new.applied_price_id := null;
    new.applied_at := null;
    new.auth_credential_id := null;
    new.auth_nonce := null;
    return new;
  end if;
  if new.id is distinct from old.id or new.kind is distinct from old.kind or new.customer_price_cents is distinct from old.customer_price_cents
     or new.provider_cost_cents is distinct from old.provider_cost_cents or new.description is distinct from old.description or new.reason is distinct from old.reason
     or new.base_price_id is distinct from old.base_price_id or new.base_customer_price_cents is distinct from old.base_customer_price_cents
     or new.base_provider_cost_cents is distinct from old.base_provider_cost_cents or new.requested_by is distinct from old.requested_by
     or new.requested_at is distinct from old.requested_at or new.expires_at is distinct from old.expires_at
     or new.approval_mode is distinct from old.approval_mode or new.cooling_until is distinct from old.cooling_until or new.proposer_session is distinct from old.proposer_session
     or new.proposal_version is distinct from old.proposal_version or new.replaces_request_id is distinct from old.replaces_request_id then
    raise exception 'studio_sms_price_change_requests: the binding of a proposal is fixed' using errcode = '42501';
  end if;
  if coalesce(current_setting('tw4.pricedual_write', true), '') <> 'on' then
    raise exception 'studio_sms_price_change_requests: status moves only through the dual-control functions' using errcode = '42501';
  end if;
  if not ((old.status = 'pending' and new.status in ('approved', 'rejected', 'expired', 'invalidated')) or (old.status = 'approved' and new.status = 'applied')) then
    raise exception 'studio_sms_price_change_requests: % -> % is not a legal transition (a decided proposal is final)', old.status, new.status using errcode = '42501';
  end if;
  if (new.auth_credential_id is distinct from old.auth_credential_id or new.auth_nonce is distinct from old.auth_nonce) and not (old.status = 'pending' and new.status = 'approved') then
    raise exception 'studio_sms_price_change_requests: the hardware-key evidence is written once, with the approval' using errcode = '42501';
  end if;
  if new.status = 'applied' then
    -- the evidence names a published price with exactly the approved amounts
    select * into p from public.studio_sms_price_list x where x.id = new.applied_price_id;
    if p.id is null or p.kind <> new.kind or p.customer_price_cents <> new.customer_price_cents or p.provider_cost_cents <> new.provider_cost_cents or p.description <> new.description
       or p.created_by is distinct from new.decided_by then
      raise exception 'studio_sms_price_change_requests: the applied price is not the approved price' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create or replace function public._tw4price_activation_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare q public.studio_sms_price_change_requests;
begin
  if tg_op = 'INSERT' then
    select * into q from public.studio_sms_price_change_requests x
     where x.status = 'approved' and x.kind = new.kind and x.customer_price_cents = new.customer_price_cents and x.provider_cost_cents = new.provider_cost_cents
       and x.description = new.description and x.decided_by = new.created_by and x.applied_price_id is null;
    if q.id is null or not new.active or not public._tw4price_admin_active(q.decided_by) or not public._tw4price_admin_active(q.requested_by)
       or public._tw4price_suspended()
       or not ((q.approval_mode = 'team' and q.decided_by <> q.requested_by)
               or (q.approval_mode = 'owner' and q.auth_credential_id is not null and q.auth_nonce is not null and q.cooling_until <= clock_timestamp())) then
      raise exception 'a price is published only by an approved price change (team: two different registered administrators; owner: after the cooling-off, with the hardware-key approval of the exact proposal): none is being applied for these amounts' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'a published price is never deleted (a retired price stays as history)' using errcode = '42501';
  end if;
  -- UPDATE: a published price is immutable, whatever the session mode; the only change that remains is retiring it (active -> false)
  if new.id is distinct from old.id or new.kind is distinct from old.kind or new.customer_price_cents is distinct from old.customer_price_cents
     or new.provider_cost_cents is distinct from old.provider_cost_cents or new.description is distinct from old.description or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'a published price is never edited: retire it and publish a new one through a price change request' using errcode = '42501';
  end if;
  if old.active = false and new.active = true then
    raise exception 'a published price is never edited: a retired price is never re-activated; publish a new price through a price change request' using errcode = '42501';
  end if;
  return new;
end $$;
create or replace function public._tw4price_do_propose_mode(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_reason text, p_actor uuid, p_mode text, p_session text, p_replaces uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  q public.studio_sms_price_change_requests;
  b public.studio_sms_price_list;
  lim public.studio_sms_price_limits;
  v_id uuid;
  cfg public.studio_sms_price_auth_config;
  v_now timestamptz := clock_timestamp();
  v_cool timestamptz;
  v_exp timestamptz;
  v_ver int := 1;
begin
  perform 1 from public.profiles pr where pr.id = p_actor for share;
  perform public._tw4c_admin(p_actor);
  if not public._tw4price_admin_active(p_actor) then
    raise exception 'actor must be an active platform admin' using errcode = '42501';
  end if;
  if p_kind is null or p_customer_cents is null or p_customer_cents <= 0 or p_customer_cents > 10000000 or p_provider_cents is null or p_provider_cents < 0 or p_provider_cents > 10000000
     or p_description is null or char_length(btrim(p_description)) not between 3 and 200 or p_reason is null or char_length(btrim(p_reason)) not between 10 and 500 then
    raise exception 'a price proposal needs a known kind, a positive customer price and a non-negative provider cost (each at most 10,000,000 cents), a description (3 to 200) and a written reason (10 to 500)' using errcode = '22023';
  end if;
  if not (p_kind = any (public._tw4price_kinds())) then
    raise exception 'unknown price kind' using errcode = '22023';
  end if;
  if p_mode not in ('owner', 'team') then
    raise exception 'unknown approval mode' using errcode = '22023';
  end if;
  select * into cfg from public.studio_sms_price_auth_config;
  if public._tw4price_suspended() then
    raise exception 'price changes are suspended (freeze or a monitoring suspension)' using errcode = '42501';
  end if;
  if p_mode = 'owner' and (p_session is null or p_session = '') then
    raise exception 'an owner-mode proposal needs the session id of the proposing session' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || p_kind));
  select * into b from public.studio_sms_price_list x where x.kind = p_kind and x.active;
  -- OWNER-APPROVED limits only (data; unapproved proposals in the limits table are not enforced)
  select * into lim from public.studio_sms_price_limits l where l.kind = p_kind and l.approved;
  if lim.kind is not null then
    if p_customer_cents > lim.max_customer_cents or p_provider_cents > lim.max_provider_cents
       or (lim.max_provider_pct_of_customer is not null and p_provider_cents::bigint * 100 > p_customer_cents::bigint * lim.max_provider_pct_of_customer)
       or (lim.max_step_pct is not null and b.id is not null and abs(p_customer_cents::bigint - b.customer_price_cents) * 100 > b.customer_price_cents::bigint * lim.max_step_pct) then
      raise exception 'the proposed prices exceed the owner-approved limits for this kind' using errcode = '22023';
    end if;
  end if;
  if b.id is not null and b.customer_price_cents = p_customer_cents and b.provider_cost_cents = p_provider_cents then
    raise exception 'the proposed prices equal the active prices: nothing to change' using errcode = '22023';
  end if;
  select * into q from public.studio_sms_price_change_requests x where x.kind = p_kind and x.status in ('pending', 'approved') for update;
  if q.id is not null then
    if q.expires_at <= clock_timestamp() then
      perform set_config('tw4.pricedual_write', 'on', true);
      update public.studio_sms_price_change_requests set status = 'expired', decided_at = clock_timestamp(), decision_note = 'expired: not approved within the allowed time' where id = q.id;
      perform set_config('tw4.pricedual_write', 'off', true);
    elsif p_replaces is null and q.approval_mode = (case when p_mode = 'owner' then 'owner' else 'team' end) and q.requested_by = p_actor and q.customer_price_cents = p_customer_cents and q.provider_cost_cents = p_provider_cents and q.description = btrim(p_description)
          and q.reason = btrim(p_reason) and q.base_price_id is not distinct from b.id then
      return jsonb_build_object('request_id', q.id, 'status', q.status, 'expires_at', q.expires_at, 'replayed', true);
    else
      raise exception 'an open price proposal already exists for this kind: it must be approved, rejected or withdrawn, or expire, first' using errcode = 'TW041';
    end if;
  end if;
  if p_mode = 'owner' then
    v_cool := v_now + make_interval(hours => cfg.cooling_off_hours);
    v_exp := v_cool + make_interval(hours => cfg.authz_window_hours);
  else
    v_exp := v_now + interval '24 hours';
  end if;
  if p_replaces is not null then
    select proposal_version + 1 into v_ver from public.studio_sms_price_change_requests where id = p_replaces;
  end if;
  perform set_config('tw4.pricedual_write', 'on', true);
  insert into public.studio_sms_price_change_requests (kind, customer_price_cents, provider_cost_cents, description, reason, base_price_id, base_customer_price_cents, base_provider_cost_cents, requested_by, requested_at, expires_at,
    approval_mode, cooling_until, proposer_session, proposal_version, replaces_request_id)
  values (p_kind, p_customer_cents, p_provider_cents, btrim(p_description), btrim(p_reason), b.id, b.customer_price_cents, b.provider_cost_cents, p_actor, v_now, v_exp,
    p_mode, v_cool, case when p_mode = 'owner' then p_session else null end, v_ver, p_replaces)
  returning id into v_id;
  perform set_config('tw4.pricedual_write', 'off', true);
  perform public._tw4price_audit('proposed', p_actor, p_session, v_id, null, jsonb_build_object('kind', p_kind, 'mode', p_mode, 'customer_cents', p_customer_cents, 'provider_cents', p_provider_cents, 'version', v_ver));
  return jsonb_build_object('request_id', v_id, 'status', 'pending', 'replayed', false, 'mode', p_mode, 'cooling_until', v_cool, 'expires_at', v_exp, 'version', v_ver);
end $$;
create or replace function public._tw4price_do_propose(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_reason text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  -- the team-mode path (two distinct registered administrators); used by the local QA fixtures and by team mode
  return public._tw4price_do_propose_mode(p_kind, p_customer_cents, p_provider_cents, p_description, p_reason, p_actor, 'team', null, null);
end $$;
create or replace function public._tw4price_do_approve(p_request_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  q public.studio_sms_price_change_requests;
  v_cur uuid;
  v_new uuid;
begin
  -- an unlocked read learns the parties; their profile rows are share-locked FIRST (in id order) and the standing of both is checked after the lock, so a demotion either
  -- committed before (this refuses or invalidates) or waits until this transaction ends
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id;
  perform 1 from public.profiles pr where pr.id in (coalesce(q.requested_by, p_actor), p_actor) order by pr.id for share;
  perform public._tw4c_admin(p_actor);
  if not public._tw4price_admin_active(p_actor) then
    raise exception 'actor must be an active platform admin' using errcode = '42501';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'an approval needs a written note of 10 to 500 characters' using errcode = '22023';
  end if;
  if q.id is null then
    raise exception 'unknown price proposal' using errcode = '22023';
  end if;
  if q.requested_by = p_actor then
    raise exception 'the requester cannot approve their own price proposal: a second platform administrator must' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || q.kind));
  select * into q from public.studio_sms_price_change_requests x where x.id = p_request_id for update;
  if q.approval_mode <> 'team' then
    raise exception 'this proposal can only be authorized with the hardware-key transaction approval (single-owner mode)' using errcode = 'TW042';
  end if;
  if q.status = 'applied' and q.decided_by = p_actor then
    return jsonb_build_object('status', 'applied', 'replayed', true, 'price_id', q.applied_price_id);
  end if;
  if q.status in ('expired', 'invalidated') then
    return jsonb_build_object('status', q.status, 'replayed', true);
  end if;
  if q.status <> 'pending' then
    raise exception 'this price proposal is already % and cannot be approved', q.status using errcode = 'TW041';
  end if;
  if q.expires_at <= clock_timestamp() then
    perform set_config('tw4.pricedual_write', 'on', true);
    update public.studio_sms_price_change_requests set status = 'expired', decided_at = clock_timestamp(), decision_note = 'expired: not approved within the allowed time' where id = q.id;
    perform set_config('tw4.pricedual_write', 'off', true);
    return jsonb_build_object('status', 'expired', 'replayed', false);
  end if;
  select x.id into v_cur from public.studio_sms_price_list x where x.kind = q.kind and x.active for update;
  if v_cur is distinct from q.base_price_id then
    perform set_config('tw4.pricedual_write', 'on', true);
    update public.studio_sms_price_change_requests set status = 'invalidated', decided_at = clock_timestamp(), decision_note = 'invalidated: the active price changed after the proposal was made' where id = q.id;
    perform set_config('tw4.pricedual_write', 'off', true);
    return jsonb_build_object('status', 'invalidated', 'replayed', false);
  end if;
  if not public._tw4price_admin_active(q.requested_by) then
    perform set_config('tw4.pricedual_write', 'on', true);
    update public.studio_sms_price_change_requests set status = 'invalidated', decided_at = clock_timestamp(), decision_note = 'invalidated: the requester is no longer an active platform administrator' where id = q.id;
    perform set_config('tw4.pricedual_write', 'off', true);
    return jsonb_build_object('status', 'invalidated', 'replayed', false);
  end if;
  if public._tw4price_suspended() then
    raise exception 'price publication is suspended' using errcode = '42501';
  end if;
  perform public._tw4price_limits_check(q.kind, q.customer_price_cents, q.provider_cost_cents, q.base_customer_price_cents);
  perform set_config('tw4.pricedual_write', 'on', true);
  update public.studio_sms_price_change_requests set status = 'approved', decided_by = p_actor, decided_at = clock_timestamp(), decision_note = btrim(p_note) where id = q.id;
  update public.studio_sms_price_list set active = false where kind = q.kind and active;
  insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, description, created_by)
  values (q.kind, q.customer_price_cents, q.provider_cost_cents, q.description, p_actor) returning id into v_new;
  update public.studio_sms_price_change_requests set status = 'applied', applied_price_id = v_new, applied_at = clock_timestamp() where id = q.id;
  perform set_config('tw4.pricedual_write', 'off', true);
  perform public._tw4price_audit('team_approved', p_actor, null, q.id, null, jsonb_build_object('price_id', v_new, 'kind', q.kind));
  return jsonb_build_object('status', 'applied', 'replayed', false, 'price_id', v_new);
end $$;
create or replace function public.tw4_price_propose(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare cfg public.studio_sms_price_auth_config;
begin
  select * into cfg from public.studio_sms_price_auth_config;
  return public._tw4price_do_propose_mode(p_kind, p_customer_cents, p_provider_cents, p_description, p_reason, public._tw4price_session_actor('recent'),
    case when cfg.mode = 'single_owner' then 'owner' else 'team' end, public._tw4price_session_id(), null);
end $$;
create or replace function public._tw4price_do_list(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_active jsonb;
  v_requests jsonb;
begin
  if not public._tw4price_admin_active(p_actor) then
    raise exception 'actor must be an active platform admin' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('price_id', x.id, 'kind', x.kind, 'customer_price_cents', x.customer_price_cents, 'provider_cost_cents', x.provider_cost_cents,
           'description', x.description, 'created_at', x.created_at) order by x.kind), '[]'::jsonb) into v_active from public.studio_sms_price_list x where x.active;
  select coalesce(jsonb_agg(t order by t.requested_at desc, t.request_id), '[]'::jsonb) into v_requests from (
    select r.id as request_id, r.kind, r.customer_price_cents, r.provider_cost_cents, r.description, r.reason, r.base_price_id, r.base_customer_price_cents, r.base_provider_cost_cents,
           case when r.status = 'pending' and r.expires_at <= clock_timestamp() then 'expired' else r.status end as status,
           r.requested_by, r.requested_at, r.expires_at, r.approval_mode, r.cooling_until, r.proposal_version, r.decided_by, r.decided_at, r.decision_note, r.applied_price_id,
           ((select a.id from public.studio_sms_price_list a where a.kind = r.kind and a.active) is distinct from r.base_price_id) as base_changed
      from public.studio_sms_price_change_requests r order by r.requested_at desc, r.id limit 100) t;
  return jsonb_build_object('active', v_active, 'requests', v_requests, 'mode', (select mode from public.studio_sms_price_auth_config), 'frozen', (select frozen from public.studio_sms_price_auth_config));
end $$;
create or replace function public.tw4_price_verify(p_since timestamptz default null)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v jsonb := '[]'::jsonb;
  r record;
begin
  -- a published price with no attesting applied request (prices published before this migration are listed too: pass p_since to look only at newer ones)
  for r in select p.id, p.kind, p.created_at from public.studio_sms_price_list p
            where (p_since is null or p.created_at >= p_since)
              and not exists (select 1 from public.studio_sms_price_change_requests q
                               where q.status = 'applied' and q.applied_price_id = p.id and q.kind = p.kind and q.customer_price_cents = p.customer_price_cents
                                 and q.provider_cost_cents = p.provider_cost_cents and q.description = p.description and q.decided_by = p.created_by
                                 and ((q.approval_mode = 'team' and q.decided_by <> q.requested_by)
                                      or (q.approval_mode = 'owner' and q.auth_credential_id is not null and q.decided_at >= q.cooling_until
                                          and exists (select 1 from public.studio_sms_price_auth_challenges c where c.nonce = q.auth_nonce and c.used_at is not null and c.request_id = q.id)
                                          and exists (select 1 from public.studio_sms_price_credentials k where k.credential_id = q.auth_credential_id)))
                                 and public._tw4price_registered_at(q.requested_by, q.requested_at)
                                 and public._tw4price_registered_at(q.decided_by, q.decided_at)) loop
    v := v || jsonb_build_object('code', 'price_unattested', 'price_id', r.id, 'kind', r.kind, 'created_at', r.created_at);
  end loop;
  for r in select q.id, q.status, q.kind from public.studio_sms_price_change_requests q
            where (q.status in ('approved', 'applied') and (q.decided_by is null or (q.decided_by = q.requested_by and q.approval_mode = 'team')))
               or (q.status = 'applied' and not exists (select 1 from public.studio_sms_price_list p where p.id = q.applied_price_id))
               or (q.status = 'approved' and q.decided_at < clock_timestamp() - interval '1 minute')
               or (q.status = 'pending' and q.expires_at < clock_timestamp() - interval '48 hours')
               or (q.status in ('approved', 'applied') and not (public._tw4price_registered_at(q.requested_by, q.requested_at) and public._tw4price_registered_at(q.decided_by, q.decided_at))) loop
    v := v || jsonb_build_object('code', 'request_anomaly', 'request_id', r.id, 'status', r.status, 'kind', r.kind);
  end loop;
  for r in select x.kind, count(*) as n from public.studio_sms_price_list x where x.active group by x.kind having count(*) > 1 loop
    v := v || jsonb_build_object('code', 'several_active_prices', 'kind', r.kind, 'count', r.n);
  end loop;
  return jsonb_build_object('ok', jsonb_array_length(v) = 0, 'anomalies', v, 'checked_at', clock_timestamp());
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4price_bytes2num(bytea), public._tw4price_powmod(numeric, numeric, numeric), public._tw4price_num2bits(numeric), public._tw4price_jdbl(numeric, numeric, numeric),
  public._tw4price_jadd(numeric, numeric, numeric, numeric, numeric, numeric), public._tw4price_p256_oncurve(numeric, numeric), public._tw4price_p256_verify(numeric, numeric, numeric, numeric, numeric),
  public._tw4price_der_rs(bytea), public._tw4price_b64u(bytea), public._tw4price_unb64u(text), public._tw4price_request_hash(public.studio_sms_price_change_requests),
  public._tw4price_check_assertion(text, bytea, bytea, bytea, bytea, bytea, bytea, boolean), public._tw4priceauth_guard(), public._tw4price_audit(text, uuid, text, uuid, bytea, jsonb),
  public._tw4price_new_nonce(), public._tw4price_session_id(), public._tw4price_limits_check(text, int, int, int), public._tw4price_challenge_ok(bytea, uuid, text), public._tw4price_monitor_suspend_seq(), public._tw4price_emit(text, uuid, jsonb), public._tw4price_suspended(), public._tw4price_registry_emit(), public._tw4price_owner_gate(uuid, uuid, text), public._tw4price_bootstrap(text, text[], bytea, bytea, bytea, text),
  public._tw4price_cred_hash(text, bytea, bytea, bytea, text, text), public._tw4price_thaw_hash(),
  public._tw4price_do_propose_mode(text, int, int, text, text, uuid, text, text, uuid), public._tw4price_do_propose(text, int, int, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.tw4_price_authz_begin(uuid), public.tw4_price_authz_finish(uuid, text, text, text, text, text), public.tw4_price_revise(uuid, int, int, text, text),
  public.tw4_price_cred_begin(text, text, text, text, text, text), public.tw4_price_cred_enroll(text, text, text, text, text, text, text, text, text, text, text, text, text),
  public.tw4_price_cred_revoke(text, text, text, text, text, text), public.tw4_price_freeze(text), public.tw4_price_thaw(text, text, text, text, text), public.tw4_price_report_compromise(text), public.tw4_price_cred_apply(uuid), public.tw4_price_cred_cancel(uuid), public.tw4_price_cred_pending(),
  public.tw4_price_audit_feed(bigint, int) from public, anon, authenticated, service_role;
revoke all on function public.tw4_price_propose(text, int, int, text, text) from public, anon, authenticated, service_role;
grant execute on function public.tw4_price_propose(text, int, int, text, text), public.tw4_price_authz_begin(uuid), public.tw4_price_authz_finish(uuid, text, text, text, text, text), public.tw4_price_revise(uuid, int, int, text, text),
  public.tw4_price_cred_begin(text, text, text, text, text, text), public.tw4_price_cred_enroll(text, text, text, text, text, text, text, text, text, text, text, text, text),
  public.tw4_price_cred_revoke(text, text, text, text, text, text), public.tw4_price_freeze(text), public.tw4_price_thaw(text, text, text, text, text), public.tw4_price_report_compromise(text), public.tw4_price_cred_apply(uuid), public.tw4_price_cred_cancel(uuid), public.tw4_price_cred_pending() to authenticated;
grant execute on function public.tw4_price_audit_feed(bigint, int) to service_role;

do $$
begin
  if has_function_privilege('service_role', 'public.tw4_price_authz_finish(uuid,text,text,text,text,text)', 'execute') or has_function_privilege('anon', 'public.tw4_price_authz_finish(uuid,text,text,text,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.tw4_price_authz_finish(uuid,text,text,text,text,text)', 'execute')
     or has_function_privilege('service_role', 'public._tw4price_check_assertion(text,bytea,bytea,bytea,bytea,bytea,bytea,boolean)', 'execute')
     or has_function_privilege('authenticated', 'public._tw4price_bootstrap(text,text[],bytea,bytea,bytea,text)', 'execute')
     or has_function_privilege('authenticated', 'public.tw4_price_audit_feed(bigint,integer)', 'execute') or not has_function_privilege('service_role', 'public.tw4_price_audit_feed(bigint,integer)', 'execute') then
    raise exception 'price owner authorization postcondition failed: unexpected function privileges';
  end if;
  if (select count(*) from pg_trigger where tgname like 'studio_sms_price_%' and tgrelid in ('public.studio_sms_price_auth_config'::regclass, 'public.studio_sms_price_credentials'::regclass,
       'public.studio_sms_price_auth_challenges'::regclass, 'public.studio_sms_price_audit'::regclass, 'public.studio_sms_price_credential_changes'::regclass) and not tgisinternal and tgenabled = 'A') <> 10 then
    raise exception 'price owner authorization postcondition failed: an always-on trigger is missing';
  end if;
end $$;

commit;
