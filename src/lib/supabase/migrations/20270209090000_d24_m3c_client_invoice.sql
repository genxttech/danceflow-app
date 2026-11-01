-- 20270209090000_d24_m3c_client_invoice.sql
-- D24 M3-C: the studio-owned ONE-OFF CLIENT INVOICE business object (draft creation/editing only). NOT APPLIED to any shared environment by this file. Dark.
--   * Decision D1: a studio-issued one-time invoice to one of the studio's own clients (later created on the studio's connected Stripe account). Not a DanceFlow platform
--     subscription invoice, not a Checkout payment, not a membership invoice, not a DanceFlow payment record. Nothing here writes payments / settlement rows.
--   * Decision D2: tables studio_client_invoices (+ _lines, _audit, _limits). Client and optional charge reference are same-studio enforced in the database.
--     The Stripe customer/account/invoice registration is written ONLY by studio_client_invoice_link_registration (service_role) from a REGISTERED M3-A intent.
--   * Decision D3: only studio_owner and studio_admin (active user_studio_roles) may draft/edit. One SQL helper (studio_billing_permission) is the only place that maps
--     (role, permission); every function and RLS policy asks it, so granular billing permissions later change one function, not its callers.
--     The actor is ALWAYS auth.uid() read inside the database; no function accepts an actor argument. Platform admins get NO implicit access.
--   * Decision D4: statuses 'draft' and 'provider_draft_created' only. Finalize / send / pay link / collection / void are designed (docs) but have no column value,
--     no function and no grant here. A draft has no payment URL (there is no such column).
--   * Decision D5: USD, integer cents, positive amounts, quantity bounds, bounded line count, stored total = sum of lines (constraint trigger), and FAIL-CLOSED limits:
--     studio_client_invoice_limits ships with NULL min/max, which refuses every draft until the owner supplies the numbers (migration/owner only; no API role can write).
--   * Registers the ownership function for business object type 'studio_client_invoice' with the M3-A registry (public.d24_owns_studio_client_invoice).
-- Requires: 20270208090000 (M3-A), public.studios / clients / user_studio_roles, auth.uid()/auth.jwt().
-- Rollback: rollback/20270209090000_d24_m3c_client_invoice_rollback.sql (export-gated). Contract: docs/billing/D24-M3C-CLIENT-INVOICE.md
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.d24_register_business_object_type(text,regprocedure)') is null or to_regclass('public.hosted_invoice_creation_intents') is null then
    raise exception 'd24 m3c precondition failed: 20270208090000 (M3-A) must be applied first';
  end if;
  if to_regclass('public.studios') is null or to_regclass('public.clients') is null or to_regclass('public.user_studio_roles') is null then
    raise exception 'd24 m3c precondition failed: studios, clients and user_studio_roles are required';
  end if;
  if to_regprocedure('auth.uid()') is null or to_regprocedure('auth.jwt()') is null then
    raise exception 'd24 m3c precondition failed: auth.uid() and auth.jwt() are required';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------------

-- Fail-closed limits. Singleton. NULL min/max = no draft can be saved. No API role can write; only the migration owner (owner decision, documented procedure).
create table public.studio_client_invoice_limits (
  singleton boolean primary key default true check (singleton),
  min_total_cents bigint,
  max_total_cents bigint,
  max_lines integer not null default 25,
  max_quantity integer not null default 1000,
  updated_at timestamptz not null default now(),
  constraint sci_limits_range_chk check (
    (min_total_cents is null) = (max_total_cents is null)
    and (min_total_cents is null or (min_total_cents >= 50 and max_total_cents >= min_total_cents and max_total_cents <= 99999999))),   -- Stripe USD minimum 50c; hard ceiling below Stripe's maximum
  constraint sci_limits_lines_chk check (max_lines between 1 and 100),
  constraint sci_limits_qty_chk check (max_quantity between 1 and 100000)
);
insert into public.studio_client_invoice_limits (singleton) values (true);

create table public.studio_client_invoices (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,          -- same-studio enforced by trigger
  request_key uuid not null,                                                          -- double-submit guard (one per studio)
  status text not null default 'draft',
  currency text not null default 'usd',
  total_cents bigint not null,
  line_count integer not null,
  version integer not null default 1,                                                 -- optimistic concurrency token
  reference_type text,                                                                -- optional originating record; never a settlement
  reference_id uuid,
  reference_note text,
  created_by uuid not null,
  last_edited_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- trusted provider registration (written only by studio_client_invoice_link_registration)
  intent_id uuid,
  registry_id uuid references public.hosted_invoice_registry(id) on delete restrict,
  stripe_account_id text,
  stripe_customer_id text,
  stripe_invoice_id text,
  livemode boolean,
  provider_draft_created_at timestamptz,
  constraint sci_status_chk check (status in ('draft', 'provider_draft_created')),
  constraint sci_currency_chk check (currency = 'usd'),
  constraint sci_total_chk check (total_cents between 1 and 99999999),
  constraint sci_lines_chk check (line_count between 1 and 100),
  constraint sci_version_chk check (version >= 1),
  constraint sci_ref_chk check (
    (reference_type is null and reference_id is null and reference_note is null)
    or (reference_type in ('appointment', 'event', 'payment') and reference_id is not null and reference_note is null)
    or (reference_type = 'other' and reference_id is null and reference_note is not null and length(btrim(reference_note)) between 1 and 200)),
  constraint sci_registration_chk check (
    (status = 'draft' and intent_id is null and registry_id is null and stripe_account_id is null and stripe_customer_id is null
       and stripe_invoice_id is null and livemode is null and provider_draft_created_at is null)
    or (status = 'provider_draft_created' and intent_id is not null and registry_id is not null and stripe_account_id ~ '^acct_[A-Za-z0-9]+$'
       and stripe_invoice_id ~ '^in_[A-Za-z0-9]+$' and livemode is not null and provider_draft_created_at is not null
       and (stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9]+$')))
);
create unique index sci_request_key_uq on public.studio_client_invoices (studio_id, request_key);
create unique index sci_fk_uq on public.studio_client_invoices (id, studio_id);
create unique index sci_intent_uq on public.studio_client_invoices (intent_id) where intent_id is not null;
create unique index sci_stripe_invoice_uq on public.studio_client_invoices (stripe_account_id, stripe_invoice_id) where stripe_invoice_id is not null;
create index sci_studio_idx on public.studio_client_invoices (studio_id, created_at desc);
create index sci_client_idx on public.studio_client_invoices (client_id);

create table public.studio_client_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null,
  studio_id uuid not null,
  position integer not null,
  description text not null,
  quantity integer not null,
  unit_price_cents bigint not null,
  line_total_cents bigint not null,
  constraint sci_lines_invoice_fk foreign key (invoice_id, studio_id) references public.studio_client_invoices (id, studio_id) on delete restrict,
  constraint sci_line_pos_chk check (position between 1 and 100),
  constraint sci_line_desc_chk check (length(btrim(description)) between 1 and 200 and description !~ '[[:cntrl:]]'),
  constraint sci_line_qty_chk check (quantity between 1 and 100000),
  constraint sci_line_unit_chk check (unit_price_cents between 1 and 99999999),
  constraint sci_line_total_chk check (line_total_cents = quantity::bigint * unit_price_cents and line_total_cents between 1 and 99999999)
);
create unique index sci_lines_pos_uq on public.studio_client_invoice_lines (invoice_id, position);

create table public.studio_client_invoice_audit (
  id bigint generated always as identity primary key,
  invoice_id uuid not null,
  studio_id uuid not null,
  action text not null,
  actor_user_id uuid,
  actor_role text,
  actor_aal text,
  version integer not null,
  client_id uuid not null,
  total_cents bigint not null,
  line_count integer not null,
  content_sha256 text not null,
  intent_id uuid,
  created_at timestamptz not null default now(),
  constraint sci_audit_invoice_fk foreign key (invoice_id, studio_id) references public.studio_client_invoices (id, studio_id) on delete restrict,
  constraint sci_audit_action_chk check (action in ('create', 'edit', 'link_registration')),
  constraint sci_audit_actor_chk check ((action = 'link_registration') or (actor_user_id is not null and actor_role in ('studio_owner', 'studio_admin') and actor_aal in ('aal1', 'aal2', 'unknown'))),
  constraint sci_audit_link_chk check (action <> 'link_registration' or (actor_user_id is null and intent_id is not null))
);
create index sci_audit_invoice_idx on public.studio_client_invoice_audit (invoice_id, id);

do $$
declare t text;
begin
  foreach t in array array['studio_client_invoice_limits', 'studio_client_invoices', 'studio_client_invoice_lines', 'studio_client_invoice_audit'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to service_role', t);
  end loop;
  -- staff read through RLS (the permission helper); NO write grant to any API role
  foreach t in array array['studio_client_invoices', 'studio_client_invoice_lines', 'studio_client_invoice_audit'] loop
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
revoke all on sequence public.studio_client_invoice_audit_id_seq from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- Authorization: ONE helper. Callers never test roles themselves.
-- ---------------------------------------------------------------------------------------------------------------------

-- True when auth.uid() holds `p_permission` in `p_studio_id`. Today both permissions map to active studio_owner / studio_admin only. Unknown permission = false.
-- Future granular billing permissions replace the body (e.g. a role/permission table); no caller changes.
create or replace function public.studio_billing_permission(p_studio_id uuid, p_permission text)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or p_studio_id is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return false;
  end if;
  if p_permission not in ('client_invoice.draft', 'client_invoice.view') then
    return false;
  end if;
  return exists (select 1 from public.user_studio_roles r
                 where r.user_id = v_uid and r.studio_id = p_studio_id and r.active is true and r.role in ('studio_owner', 'studio_admin'));
end $$;

-- The acting user's role for the audit record (same predicate as the helper; owner outranks admin if both rows exist).
create or replace function public._sci_actor_role(p_studio_id uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select r.role from public.user_studio_roles r
  where r.user_id = auth.uid() and r.studio_id = p_studio_id and r.active is true and r.role in ('studio_owner', 'studio_admin')
  order by (r.role = 'studio_owner') desc limit 1
$$;

-- Verified end user + permission, or an error. Not-a-member and unknown-studio are indistinguishable. AAL is recorded, not required.
create or replace function public._sci_authorize(p_studio_id uuid, p_permission text)
returns uuid language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    raise exception 'client_invoice_authentication_required' using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'exp', '') !~ '^[0-9]{1,12}$' or (auth.jwt() ->> 'exp')::bigint <= extract(epoch from now())::bigint then
    raise exception 'client_invoice_session_expired' using errcode = '42501';
  end if;
  if not public.studio_billing_permission(p_studio_id, p_permission) then
    raise exception 'client_invoice_forbidden' using errcode = '42501';
  end if;
  return v_uid;
end $$;

create or replace function public._sci_aal()
returns text language sql stable
set search_path = pg_catalog, public, pg_temp
as $$ select case when auth.jwt() ->> 'aal' in ('aal1', 'aal2') then auth.jwt() ->> 'aal' else 'unknown' end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Write guards (the same posture as the D24 tables: trigger-enforced, writer flag set only inside the functions below)
-- ---------------------------------------------------------------------------------------------------------------------

create or replace function public._sci_require_writer()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if coalesce(current_setting('df.sci_writer', true), '') <> 'on' then
    raise exception 'client invoices: % on % is only allowed through the client invoice functions', tg_op, tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create or replace function public._sci_refuse()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'client invoices: % on % is not allowed (evidence is permanent)', tg_op, tg_table_name using errcode = '42501';
end $$;

-- Same-studio enforcement for the client and the optional charge reference; immutability once registered.
create or replace function public._sci_invoice_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare v_ok boolean;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.version <> 1 then
      raise exception 'client invoices: a new invoice must be a version-1 draft' using errcode = '23514';
    end if;
  else
    if old.status <> 'draft' then
      raise exception 'client_invoice_not_editable' using errcode = '55000';       -- registered invoices never change
    end if;
    if new.id <> old.id or new.studio_id <> old.studio_id or new.created_by <> old.created_by or new.created_at <> old.created_at
       or new.request_key <> old.request_key or new.currency <> old.currency then
      raise exception 'client invoices: immutable column changed' using errcode = '42501';
    end if;
    if new.status = 'provider_draft_created' then
      if new.client_id <> old.client_id or new.total_cents <> old.total_cents or new.line_count <> old.line_count
         or new.reference_type is distinct from old.reference_type or new.reference_id is distinct from old.reference_id
         or new.reference_note is distinct from old.reference_note or new.version <> old.version + 1 then
        raise exception 'client invoices: registration may not change invoice content' using errcode = '42501';
      end if;
    elsif new.version <> old.version + 1 then
      raise exception 'client invoices: version must advance by one' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'INSERT' or new.client_id <> old.client_id then
    perform 1 from public.clients c where c.id = new.client_id and c.studio_id = new.studio_id for share;
    if not found then
      raise exception 'client_invoice_client_not_in_studio' using errcode = '42501';
    end if;
  end if;
  if new.reference_type in ('appointment', 'event', 'payment')
     and (tg_op = 'INSERT' or new.reference_type is distinct from old.reference_type or new.reference_id is distinct from old.reference_id) then
    if new.reference_type = 'appointment' then
      select exists (select 1 from public.appointments a where a.id = new.reference_id and a.studio_id = new.studio_id) into v_ok;
    elsif new.reference_type = 'event' then
      select exists (select 1 from public.events e where e.id = new.reference_id and e.studio_id = new.studio_id) into v_ok;
    else
      select exists (select 1 from public.payments p where p.id = new.reference_id and p.studio_id = new.studio_id) into v_ok;
    end if;
    if not v_ok then
      raise exception 'client_invoice_reference_not_in_studio' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- Lines change only while the parent is a draft, and are never updated in place (replace = delete + insert inside one function call).
create or replace function public._sci_line_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare v_status text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'client invoices: lines are replaced, never updated' using errcode = '42501';
  end if;
  select i.status into v_status from public.studio_client_invoices i
    where i.id = case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end for share;
  if v_status is distinct from 'draft' then
    raise exception 'client_invoice_not_editable' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- Stored total and line count must equal the lines at COMMIT (deferred): the database, not the caller, owns the arithmetic.
create or replace function public._sci_check_totals()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_id uuid;
  v_total bigint; v_count integer; v_sum bigint; v_n integer;
begin
  if tg_table_name = 'studio_client_invoices' then v_id := new.id;
  elsif tg_op = 'DELETE' then v_id := old.invoice_id;
  else v_id := new.invoice_id; end if;
  select total_cents, line_count into v_total, v_count from public.studio_client_invoices where id = v_id;
  if not found then return null; end if;
  select coalesce(sum(line_total_cents), 0), count(*) into v_sum, v_n from public.studio_client_invoice_lines where invoice_id = v_id;
  if v_sum <> v_total or v_n <> v_count then
    raise exception 'client_invoice_total_mismatch: stored total/line count disagree with the lines' using errcode = '23514';
  end if;
  return null;
end $$;

create trigger sci_invoices_writer_trg before insert or update or delete on public.studio_client_invoices for each row execute function public._sci_require_writer();
create trigger sci_invoices_guard_trg before insert or update on public.studio_client_invoices for each row execute function public._sci_invoice_guard();
create trigger sci_invoices_nodelete_trg before delete on public.studio_client_invoices for each row execute function public._sci_refuse();
create trigger sci_invoices_trunc_trg before truncate on public.studio_client_invoices for each statement execute function public._sci_refuse();
create constraint trigger sci_invoices_totals_trg after insert or update on public.studio_client_invoices deferrable initially deferred for each row execute function public._sci_check_totals();

create trigger sci_lines_writer_trg before insert or update or delete on public.studio_client_invoice_lines for each row execute function public._sci_require_writer();
create trigger sci_lines_guard_trg before insert or update or delete on public.studio_client_invoice_lines for each row execute function public._sci_line_guard();
create trigger sci_lines_trunc_trg before truncate on public.studio_client_invoice_lines for each statement execute function public._sci_refuse();
create constraint trigger sci_lines_totals_trg after insert or update or delete on public.studio_client_invoice_lines deferrable initially deferred for each row execute function public._sci_check_totals();

create trigger sci_audit_writer_trg before insert on public.studio_client_invoice_audit for each row execute function public._sci_require_writer();
create trigger sci_audit_append_trg before update or delete on public.studio_client_invoice_audit for each row execute function public._sci_refuse();
create trigger sci_audit_trunc_trg before truncate on public.studio_client_invoice_audit for each statement execute function public._sci_refuse();

create or replace function public._sci_limits_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'client invoice limits cannot be deleted' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger sci_limits_guard_trg before update or delete on public.studio_client_invoice_limits for each row execute function public._sci_limits_guard();
create trigger sci_limits_trunc_trg before truncate on public.studio_client_invoice_limits for each statement execute function public._sci_limits_guard();

-- RLS: studio staff with the view permission read; nobody writes through the API.
create policy sci_invoices_select on public.studio_client_invoices for select to authenticated using (public.studio_billing_permission(studio_id, 'client_invoice.view'));
create policy sci_lines_select on public.studio_client_invoice_lines for select to authenticated using (public.studio_billing_permission(studio_id, 'client_invoice.view'));
create policy sci_audit_select on public.studio_client_invoice_audit for select to authenticated using (public.studio_billing_permission(studio_id, 'client_invoice.view'));

-- ---------------------------------------------------------------------------------------------------------------------
-- Line validation (shared): returns the normalized lines. Fail-closed on limits.
-- ---------------------------------------------------------------------------------------------------------------------

create or replace function public._sci_parse_lines(p_lines jsonb)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_lim public.studio_client_invoice_limits;
  v_n integer;
  v_total numeric := 0;
  v_out jsonb := '[]'::jsonb;
  e jsonb; k text; i integer := 0;
  v_desc text; v_qty numeric; v_unit numeric;
begin
  select * into v_lim from public.studio_client_invoice_limits where singleton;
  if v_lim.min_total_cents is null or v_lim.max_total_cents is null then
    raise exception 'client_invoice_limits_not_configured' using errcode = '55000';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'client_invoice_lines_invalid' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_lines);
  if v_n < 1 or v_n > v_lim.max_lines then
    raise exception 'client_invoice_line_count_invalid' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(p_lines) loop
    i := i + 1;
    if jsonb_typeof(e) <> 'object' then raise exception 'client_invoice_lines_invalid' using errcode = '22023'; end if;
    for k in select jsonb_object_keys(e) loop
      if k not in ('description', 'quantity', 'unit_price_cents') then raise exception 'client_invoice_lines_invalid' using errcode = '22023'; end if;
    end loop;
    if jsonb_typeof(e -> 'description') <> 'string' or jsonb_typeof(e -> 'quantity') <> 'number' or jsonb_typeof(e -> 'unit_price_cents') <> 'number' then
      raise exception 'client_invoice_lines_invalid' using errcode = '22023';
    end if;
    v_desc := btrim(e ->> 'description');
    v_qty := (e ->> 'quantity')::numeric;
    v_unit := (e ->> 'unit_price_cents')::numeric;
    if length(v_desc) < 1 or length(v_desc) > 200 or v_desc ~ '[[:cntrl:]]' then raise exception 'client_invoice_description_invalid' using errcode = '22023'; end if;
    if v_qty <> trunc(v_qty) or v_qty < 1 or v_qty > v_lim.max_quantity then raise exception 'client_invoice_quantity_invalid' using errcode = '22023'; end if;
    if v_unit <> trunc(v_unit) or v_unit < 1 or v_unit > v_lim.max_total_cents then raise exception 'client_invoice_amount_invalid' using errcode = '22023'; end if;
    if v_qty * v_unit > v_lim.max_total_cents then raise exception 'client_invoice_amount_invalid' using errcode = '22023'; end if;
    v_total := v_total + v_qty * v_unit;
    if v_total > v_lim.max_total_cents then raise exception 'client_invoice_total_out_of_range' using errcode = '22023'; end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('pos', i, 'description', v_desc, 'quantity', v_qty::integer,
      'unit_price_cents', v_unit::bigint, 'line_total_cents', (v_qty * v_unit)::bigint));
  end loop;
  if v_total < v_lim.min_total_cents then raise exception 'client_invoice_total_out_of_range' using errcode = '22023'; end if;
  return v_out;
end $$;

create or replace function public._sci_content_hash(p_client uuid, p_ref_type text, p_ref_id uuid, p_ref_note text, p_invoice uuid)
returns text language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select encode(sha256(convert_to(
    coalesce(p_client::text, '') || '|' || coalesce(p_ref_type, '') || '|' || coalesce(p_ref_id::text, '') || '|' || coalesce(p_ref_note, '') || '|' ||
    coalesce((select string_agg(l.position || ':' || l.quantity || ':' || l.unit_price_cents || ':' || l.description, E'\n' order by l.position)
              from public.studio_client_invoice_lines l where l.invoice_id = p_invoice), ''), 'UTF8')), 'hex')
$$;

create or replace function public._sci_json(i public.studio_client_invoices, p_outcome text)
returns jsonb language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object('outcome', p_outcome, 'invoice_id', i.id, 'studio_id', i.studio_id, 'client_id', i.client_id, 'status', i.status,
    'version', i.version, 'total_cents', i.total_cents, 'line_count', i.line_count, 'currency', i.currency)
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Draft create / edit (authenticated staff; the ONLY write path for content)
-- ---------------------------------------------------------------------------------------------------------------------

create or replace function public.studio_client_invoice_save_draft(
  p_studio_id uuid, p_request_key uuid, p_invoice_id uuid, p_expected_version integer, p_client_id uuid,
  p_reference_type text, p_reference_id uuid, p_reference_note text, p_lines jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid;
  v_role text;
  v_inv public.studio_client_invoices;
  v_total bigint; v_count integer; v_lines jsonb;
  v_note text := nullif(btrim(p_reference_note), '');
begin
  v_uid := public._sci_authorize(p_studio_id, 'client_invoice.draft');
  v_role := public._sci_actor_role(p_studio_id);
  if p_client_id is null or p_request_key is null then
    raise exception 'client_invoice_input_invalid' using errcode = '22023';
  end if;
  if v_note is not null and (length(v_note) > 200 or v_note ~ '[[:cntrl:]]') then
    raise exception 'client_invoice_input_invalid' using errcode = '22023';
  end if;
  if p_reference_type is not null and p_reference_type not in ('appointment', 'event', 'payment', 'other') then
    raise exception 'client_invoice_input_invalid' using errcode = '22023';
  end if;
  if (p_reference_type is null and (p_reference_id is not null or v_note is not null))
     or (p_reference_type in ('appointment', 'event', 'payment') and (p_reference_id is null or v_note is not null))
     or (p_reference_type = 'other' and (p_reference_id is not null or v_note is null)) then
    raise exception 'client_invoice_input_invalid' using errcode = '22023';
  end if;
  perform set_config('df.sci_writer', 'on', true);

  -- validate before locking anything (also the fail-closed limits gate)
  v_lines := public._sci_parse_lines(p_lines);
  select sum((x ->> 'line_total_cents')::bigint), count(*) into v_total, v_count from jsonb_array_elements(v_lines) x;

  perform pg_advisory_xact_lock(hashtextextended('sci:' || p_studio_id::text || ':' || p_request_key::text, 0));

  if p_invoice_id is null then
    select * into v_inv from public.studio_client_invoices where studio_id = p_studio_id and request_key = p_request_key;
    if found then
      return public._sci_json(v_inv, 'existing');                          -- double submit: same request key, no second invoice, no second audit row
    end if;
    insert into public.studio_client_invoices (studio_id, client_id, request_key, total_cents, line_count, reference_type, reference_id, reference_note, created_by, last_edited_by)
      values (p_studio_id, p_client_id, p_request_key, v_total, v_count, p_reference_type, case when p_reference_type = 'other' then null else p_reference_id end,
              case when p_reference_type = 'other' then v_note else null end, v_uid, v_uid)
      returning * into v_inv;
  else
    select * into v_inv from public.studio_client_invoices where id = p_invoice_id and studio_id = p_studio_id for update;
    if not found then
      raise exception 'client_invoice_not_found' using errcode = '42501';   -- another studio's invoice looks exactly like a missing one
    end if;
    if v_inv.status <> 'draft' then
      raise exception 'client_invoice_not_editable' using errcode = '55000';
    end if;
    if p_expected_version is distinct from v_inv.version then
      raise exception 'client_invoice_version_conflict' using errcode = '40001';
    end if;
    delete from public.studio_client_invoice_lines where invoice_id = v_inv.id;
    update public.studio_client_invoices set client_id = p_client_id, total_cents = v_total, line_count = v_count,
        reference_type = p_reference_type, reference_id = case when p_reference_type = 'other' then null else p_reference_id end,
        reference_note = case when p_reference_type = 'other' then v_note else null end,
        version = version + 1, last_edited_by = v_uid, updated_at = now()
      where id = v_inv.id returning * into v_inv;
  end if;

  insert into public.studio_client_invoice_lines (invoice_id, studio_id, position, description, quantity, unit_price_cents, line_total_cents)
    select v_inv.id, v_inv.studio_id, (x ->> 'pos')::integer, x ->> 'description', (x ->> 'quantity')::integer, (x ->> 'unit_price_cents')::bigint,
           (x ->> 'line_total_cents')::bigint from jsonb_array_elements(v_lines) x;

  insert into public.studio_client_invoice_audit (invoice_id, studio_id, action, actor_user_id, actor_role, actor_aal, version, client_id, total_cents, line_count, content_sha256)
    values (v_inv.id, v_inv.studio_id, case when v_inv.version = 1 then 'create' else 'edit' end, v_uid, v_role, public._sci_aal(), v_inv.version, v_inv.client_id,
            v_inv.total_cents, v_inv.line_count,
            public._sci_content_hash(v_inv.client_id, v_inv.reference_type, v_inv.reference_id, v_inv.reference_note, v_inv.id));
  return public._sci_json(v_inv, case when v_inv.version = 1 then 'created' else 'updated' end);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- M3-A integration: ownership function, creation spec (trusted content for the orchestrator), registration link
-- ---------------------------------------------------------------------------------------------------------------------

-- Contract (D24-M3A-FOUNDATION.md §2): public.<fn>(uuid, text) returns boolean, STABLE; true only when the object exists and belongs to that studio.
-- Both draft and provider_draft_created invoices are owned (a replayed register must still pass). Malformed ids are false, never an error.
create or replace function public.d24_owns_studio_client_invoice(p_studio_id uuid, p_object_id text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select p_studio_id is not null and p_object_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and exists (select 1 from public.studio_client_invoices i where i.id = p_object_id::uuid and i.studio_id = p_studio_id)
$$;

-- Trusted content for the creation orchestrator. A draft that is complete, consistent and inside the limits, else NULL ("not creatable").
create or replace function public.studio_client_invoice_creation_spec(p_invoice_id uuid, p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  i public.studio_client_invoices;
  v_lim public.studio_client_invoice_limits;
  v_sum bigint; v_n integer;
begin
  select * into v_lim from public.studio_client_invoice_limits where singleton;
  if v_lim.min_total_cents is null or v_lim.max_total_cents is null then return null; end if;
  select * into i from public.studio_client_invoices where id = p_invoice_id and studio_id = p_studio_id;
  if not found or i.status <> 'draft' then return null; end if;
  select coalesce(sum(line_total_cents), 0), count(*) into v_sum, v_n from public.studio_client_invoice_lines where invoice_id = i.id;
  if v_sum <> i.total_cents or v_n <> i.line_count or i.total_cents < v_lim.min_total_cents or i.total_cents > v_lim.max_total_cents or v_n > v_lim.max_lines then return null; end if;
  perform 1 from public.clients c where c.id = i.client_id and c.studio_id = i.studio_id;
  if not found then return null; end if;
  return jsonb_build_object('invoice_id', i.id, 'studio_id', i.studio_id, 'client_id', i.client_id, 'currency', i.currency, 'total_cents', i.total_cents,
    'version', i.version, 'content_sha256', public._sci_content_hash(i.client_id, i.reference_type, i.reference_id, i.reference_note, i.id),
    'lines', (select jsonb_agg(jsonb_build_object('description', l.description, 'quantity', l.quantity, 'unit_price_cents', l.unit_price_cents,
                'line_total_cents', l.line_total_cents) order by l.position) from public.studio_client_invoice_lines l where l.invoice_id = i.id));
end $$;

-- Records the provider registration on the invoice. Trusts ONLY the M3-A ledger: the intent must be 'registered', for this studio, for this exact object,
-- its registry row must match. Nothing client- or caller-supplied except the Stripe customer id (format-checked, set once).
create or replace function public.studio_client_invoice_link_registration(p_invoice_id uuid, p_studio_id uuid, p_intent_id uuid, p_stripe_customer_id text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  i public.studio_client_invoices;
  t public.hosted_invoice_creation_intents;
  r public.hosted_invoice_registry;
  v_hash text;
begin
  if p_invoice_id is null or p_studio_id is null or p_intent_id is null then
    raise exception 'client_invoice_input_invalid' using errcode = '22023';
  end if;
  if p_stripe_customer_id is not null and p_stripe_customer_id !~ '^cus_[A-Za-z0-9]+$' then
    raise exception 'client_invoice_input_invalid' using errcode = '22023';
  end if;
  perform set_config('df.sci_writer', 'on', true);
  select * into i from public.studio_client_invoices where id = p_invoice_id and studio_id = p_studio_id for update;
  if not found then raise exception 'client_invoice_not_found' using errcode = '42501'; end if;
  select * into t from public.hosted_invoice_creation_intents where id = p_intent_id and studio_id = p_studio_id;
  if not found or t.business_object_type <> 'studio_client_invoice' or t.business_object_id <> i.id::text then
    raise exception 'client_invoice_intent_mismatch' using errcode = '42501';
  end if;
  if i.status = 'provider_draft_created' then
    if i.intent_id = t.id and (p_stripe_customer_id is null or i.stripe_customer_id is not distinct from p_stripe_customer_id) then
      return public._sci_json(i, 'already_linked');
    end if;
    raise exception 'client_invoice_already_linked' using errcode = '55000';
  end if;
  if t.status <> 'registered' or t.registry_id is null or t.stripe_invoice_id is null or t.livemode is null then
    raise exception 'client_invoice_intent_not_registered' using errcode = '55000';
  end if;
  select * into r from public.hosted_invoice_registry where id = t.registry_id;
  if not found or r.studio_id <> p_studio_id or r.stripe_account_id is distinct from t.stripe_account_id or r.stripe_invoice_id <> t.stripe_invoice_id
     or r.business_object_type <> 'studio_client_invoice' or r.business_object_id <> i.id::text then
    raise exception 'client_invoice_intent_mismatch' using errcode = '42501';
  end if;
  update public.studio_client_invoices set status = 'provider_draft_created', intent_id = t.id, registry_id = r.id, stripe_account_id = t.stripe_account_id,
      stripe_customer_id = p_stripe_customer_id, stripe_invoice_id = t.stripe_invoice_id, livemode = t.livemode, provider_draft_created_at = now(),
      version = version + 1, updated_at = now()
    where id = i.id returning * into i;
  v_hash := public._sci_content_hash(i.client_id, i.reference_type, i.reference_id, i.reference_note, i.id);
  insert into public.studio_client_invoice_audit (invoice_id, studio_id, action, version, client_id, total_cents, line_count, content_sha256, intent_id)
    values (i.id, i.studio_id, 'link_registration', i.version, i.client_id, i.total_cents, i.line_count, v_hash, t.id);
  return public._sci_json(i, 'linked');
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------------------------

revoke all on function public.studio_billing_permission(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public._sci_actor_role(uuid) from public, anon, authenticated, service_role;
revoke all on function public._sci_authorize(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public._sci_aal() from public, anon, authenticated, service_role;
revoke all on function public._sci_require_writer() from public, anon, authenticated, service_role;
revoke all on function public._sci_refuse() from public, anon, authenticated, service_role;
revoke all on function public._sci_invoice_guard() from public, anon, authenticated, service_role;
revoke all on function public._sci_line_guard() from public, anon, authenticated, service_role;
revoke all on function public._sci_check_totals() from public, anon, authenticated, service_role;
revoke all on function public._sci_limits_guard() from public, anon, authenticated, service_role;
revoke all on function public._sci_parse_lines(jsonb) from public, anon, authenticated, service_role;
revoke all on function public._sci_content_hash(uuid, text, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public._sci_json(public.studio_client_invoices, text) from public, anon, authenticated, service_role;
revoke all on function public.studio_client_invoice_save_draft(uuid, uuid, uuid, integer, uuid, text, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.d24_owns_studio_client_invoice(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.studio_client_invoice_creation_spec(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.studio_client_invoice_link_registration(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
-- the RLS policies call the helper as the querying role: authenticated needs EXECUTE (it returns false for anyone else's identity; it takes no user id)
grant execute on function public.studio_billing_permission(uuid, text) to authenticated;
grant execute on function public.studio_client_invoice_save_draft(uuid, uuid, uuid, integer, uuid, text, uuid, text, jsonb) to authenticated;
grant execute on function public.studio_client_invoice_creation_spec(uuid, uuid) to service_role;
grant execute on function public.studio_client_invoice_link_registration(uuid, uuid, uuid, text) to service_role;

-- Register the ownership function with the M3-A registry (owner-only registrar; the type name contains no 'subscription').
select public.d24_register_business_object_type('studio_client_invoice', 'public.d24_owns_studio_client_invoice(uuid,text)'::regprocedure);

commit;
