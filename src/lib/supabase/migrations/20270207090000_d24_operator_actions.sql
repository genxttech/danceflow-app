-- 20270207090000_d24_operator_actions.sql
-- D24 M2-B: verified-authorization operator workflow for hosted-invoice reconciliation. NOT APPLIED to any shared environment by this file.
--   * The acting user is ALWAYS auth.uid() read inside the database; no function here accepts an actor argument.
--   * Every operator function requires an authenticated end-user JWT with aal = 'aal2' (the claim PostgREST verified), checked in SQL (_d24_op_caller).
--   * Authority is checked in SQL against profiles.platform_role (platform_admin) and user_studio_roles (active studio_owner / studio_admin of the invoice's studio).
--   * Evidence is never deleted or edited: acknowledgements go to hosted_invoice_recon_audit, dismissals to hosted_invoice_dismissals (+ an audit row),
--     requeues (owned by M2-C: hosted_invoice_deferred_requeues + d24_requeue_deferred_event) are reached only through the authorization wrapper below.
--   * Platform admin only: dismiss an unmatched invoice, requeue a rejected deferred event, list/inspect deferred events, acknowledge any code.
--     Studio owner/admin: review and acknowledge ONLY the unverified-origin codes on their own studio's registered invoices.
--   * Old d24_acknowledge_anomalies(uuid, text[], uuid, text) (trusts p_actor) is closed to every API role, service_role included.
-- Requires 20270203110000_d24_hosted_invoice_facts.sql, profiles(platform_role) and user_studio_roles. Rollback: rollback/20270207090000_d24_operator_actions_rollback.sql
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.d24_acknowledge_anomalies(uuid,text[],uuid,text)') is null or to_regprocedure('public.d24_requeue_deferred_event(text,uuid,text)') is null then
    raise exception 'd24 m2b precondition failed: 20270203110000 (M1) and 20270206090000 (M2-C drain recovery) must be applied first';
  end if;
  if to_regclass('public.profiles') is null or to_regclass('public.user_studio_roles') is null then
    raise exception 'd24 m2b precondition failed: profiles and user_studio_roles are required';
  end if;
  if to_regprocedure('auth.uid()') is null or to_regprocedure('auth.jwt()') is null then
    raise exception 'd24 m2b precondition failed: auth.uid() and auth.jwt() are required';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Evidence tables
-- ---------------------------------------------------------------------------------------------------------------------

create table public.hosted_invoice_dismissals (
  id bigint generated always as identity primary key,
  invoice_row_id uuid not null references public.hosted_invoices(id) on delete restrict,
  actor_user_id uuid not null,
  reason text not null,
  events_seen integer not null,                 -- source events on the invoice at dismissal; a later event makes the dismissal stale (the invoice resurfaces)
  dismissed_at timestamptz not null default now(),
  constraint hosted_invoice_dismissals_reason_chk check (length(btrim(reason)) between 10 and 1000),
  constraint hosted_invoice_dismissals_events_chk check (events_seen >= 0),
  constraint hosted_invoice_dismissals_once unique (invoice_row_id, events_seen)
);

do $$
declare t text;
begin
  foreach t in array array['hosted_invoice_dismissals'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to service_role', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public._d24_require_writer()', t || '_writer_trg', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public._d24_append_only()', t || '_append_trg', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public._d24_append_only()', t || '_trunc_trg', t);
  end loop;
end $$;
revoke all on sequence public.hosted_invoice_dismissals_id_seq from public, anon, authenticated, service_role;

-- The audit log learns one more trigger kind (a dismissal changes no state, it records a decision); every manual kind needs an actor and a reason.
alter table public.hosted_invoice_recon_audit drop constraint hosted_invoice_recon_audit_trigger_chk;
alter table public.hosted_invoice_recon_audit drop constraint hosted_invoice_recon_audit_ack_chk;
alter table public.hosted_invoice_recon_audit add constraint hosted_invoice_recon_audit_trigger_chk
  check (trigger_kind in ('event', 'registration', 'acknowledgement', 'dismissal'));
alter table public.hosted_invoice_recon_audit add constraint hosted_invoice_recon_audit_ack_chk
  check (trigger_kind not in ('acknowledgement', 'dismissal') or (actor_user_id is not null and reason is not null and length(btrim(reason)) > 0));

-- ---------------------------------------------------------------------------------------------------------------------
-- Caller verification (internal; no API role may call these)
-- ---------------------------------------------------------------------------------------------------------------------

-- The verified end user, or an error. Service-role / anon calls have no auth.uid() and are refused; an aal1 session is refused.
create or replace function public._d24_op_caller()
returns uuid language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    raise exception 'd24_op_authentication_required' using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'd24_op_aal2_required' using errcode = '42501';
  end if;
  return v_uid;
end $$;

create or replace function public._d24_op_is_platform_admin(p_uid uuid)
returns boolean language sql stable
set search_path = pg_catalog, public, pg_temp
as $$ select exists (select 1 from public.profiles p where p.id = p_uid and p.platform_role::text = 'platform_admin') $$;

create or replace function public._d24_op_is_studio_operator(p_uid uuid, p_studio_id uuid)
returns boolean language sql stable
set search_path = pg_catalog, public, pg_temp
as $$
  select p_studio_id is not null and exists (
    select 1 from public.user_studio_roles r
    where r.user_id = p_uid and r.studio_id = p_studio_id and r.active = true and r.role::text in ('studio_owner', 'studio_admin'))
$$;

create or replace function public._d24_op_reason(p_reason text)
returns text language plpgsql immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare v text := btrim(coalesce(p_reason, ''));
begin
  if length(v) < 10 or length(v) > 1000 then
    raise exception 'd24_op_reason_required: a reason of 10 to 1000 characters is mandatory' using errcode = '22023';
  end if;
  return v;
end $$;

-- Anomaly codes a studio owner/admin may acknowledge on their own invoices. Everything else (cross-tenant, replay, conflict, payment-vs-void signals)
-- needs a platform admin. Open policy decision D-2 in docs/billing/D24-M2B-OPERATOR.md.
create or replace function public._d24_op_studio_ackable(p_code text)
returns boolean language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$ select p_code in ('unverified_void_origin', 'unverified_uncollectible_origin') $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Operator functions (authenticated only; the actor is auth.uid())
-- ---------------------------------------------------------------------------------------------------------------------

-- Acknowledge (review) anomalies on an attributed invoice. Never attributes, never erases a code. Idempotent: re-acknowledging acknowledged codes writes nothing.
create or replace function public.d24_op_acknowledge_anomalies(p_invoice_row_id uuid, p_codes text[], p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := public._d24_op_caller();
  v_reason text := public._d24_op_reason(p_reason);
  v public.hosted_invoices%rowtype;
  v_codes text[];
  v_new text[];
  v_all_ack text[];
  v_state text;
  v_platform boolean := public._d24_op_is_platform_admin(v_uid);
begin
  if p_invoice_row_id is null or p_codes is null or coalesce(array_length(p_codes, 1), 0) = 0 or array_position(p_codes, null) is not null then
    raise exception 'd24_op_acknowledge_anomalies: invoice and codes are required' using errcode = '22023';
  end if;
  select array_agg(distinct c order by c) into v_codes from unnest(p_codes) c;
  perform set_config('d24.writer', 'on', true);
  -- authorize BEFORE taking the row lock (an unauthorized caller must neither block on nor stall the webhook path), then lock and re-check
  select * into v from public.hosted_invoices where id = p_invoice_row_id;
  -- not found and not authorized look the same to a studio operator: no existence oracle across tenants
  if not found or not (v_platform or public._d24_op_is_studio_operator(v_uid, v.studio_id)) then
    raise exception 'd24_invoice_not_found' using errcode = 'P0002';
  end if;
  select * into v from public.hosted_invoices where id = p_invoice_row_id for update;
  if v.studio_id is null then
    raise exception 'd24_unmatched_invoice_cannot_be_acknowledged: attribute it through the registry first' using errcode = '55000';
  end if;
  if not (v_codes <@ v.anomaly_codes) then
    raise exception 'd24_unknown_anomaly_code' using errcode = '22023';
  end if;
  if not v_platform and exists (select 1 from unnest(v_codes) c where not public._d24_op_studio_ackable(c)) then
    raise exception 'd24_op_code_requires_platform_admin' using errcode = '42501';
  end if;
  select coalesce(array_agg(c order by c), '{}') into v_new from unnest(v_codes) c where c <> all (v.acknowledged_codes);
  if coalesce(array_length(v_new, 1), 0) = 0 then
    return jsonb_build_object('outcome', 'already_acknowledged', 'reconciliation_state', v.reconciliation_state);
  end if;
  select array_agg(distinct c order by c) into v_all_ack from unnest(v.acknowledged_codes || v_new) c;
  v_state := public._d24_derive_state(v.studio_id, v.classification, v.anomaly_codes, v_all_ack);
  update public.hosted_invoices set acknowledged_codes = v_all_ack, reconciliation_state = v_state, updated_at = now() where id = p_invoice_row_id;
  insert into public.hosted_invoice_recon_audit (invoice_row_id, studio_id, trigger_kind, from_state, to_state, anomaly_codes, actor_user_id, reason)
  values (p_invoice_row_id, v.studio_id, 'acknowledgement', v.reconciliation_state, v_state, v_new, v_uid, v_reason);
  return jsonb_build_object('outcome', 'acknowledged', 'reconciliation_state', v_state, 'codes', to_jsonb(v_new));
end $$;

-- Dismiss an unmatched invoice from the review queue. Platform admin only (an unmatched invoice has no studio). The invoice and all its facts stay; the state stays
-- 'unmatched'; a new event on the invoice (or a registry match) makes the dismissal stale and the invoice resurfaces. Idempotent per (invoice, events seen).
create or replace function public.d24_op_dismiss_unmatched(p_invoice_row_id uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := public._d24_op_caller();
  v_reason text := public._d24_op_reason(p_reason);
  v public.hosted_invoices%rowtype;
  v_seen integer;
  v_inserted integer;
begin
  if not public._d24_op_is_platform_admin(v_uid) then
    raise exception 'd24_op_platform_admin_required' using errcode = '42501';
  end if;
  if p_invoice_row_id is null then
    raise exception 'd24_op_dismiss_unmatched: invoice is required' using errcode = '22023';
  end if;
  perform set_config('d24.writer', 'on', true);
  select * into v from public.hosted_invoices where id = p_invoice_row_id for update;  -- platform admin already verified above
  if not found then raise exception 'd24_invoice_not_found' using errcode = 'P0002'; end if;
  if v.studio_id is not null or v.reconciliation_state <> 'unmatched' then
    raise exception 'd24_op_not_dismissable: only an unmatched, unattributed invoice can be dismissed' using errcode = '55000';
  end if;
  select count(*) into v_seen from public.hosted_invoice_source_events where invoice_row_id = p_invoice_row_id;
  insert into public.hosted_invoice_dismissals (invoice_row_id, actor_user_id, reason, events_seen)
  values (p_invoice_row_id, v_uid, v_reason, v_seen) on conflict (invoice_row_id, events_seen) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('outcome', 'already_dismissed');
  end if;
  insert into public.hosted_invoice_recon_audit (invoice_row_id, studio_id, trigger_kind, from_state, to_state, anomaly_codes, actor_user_id, reason)
  values (p_invoice_row_id, null, 'dismissal', v.reconciliation_state, v.reconciliation_state, v.anomaly_codes, v_uid, v_reason);
  return jsonb_build_object('outcome', 'dismissed', 'events_seen', v_seen);
end $$;

-- Put a REJECTED deferred event back to pending so the next drain re-applies it. Platform admin only. The snapshot is immutable evidence, so this helps only events
-- that were rejected for a reason outside the event (transient failure, ordering, a since-fixed defect); a malformed event is simply rejected again. Capped (5) by M2-C's mechanics
-- per event. Idempotent: an already pending event is reported, not re-audited.
create or replace function public.d24_op_requeue_deferred(p_provider_event_id text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := public._d24_op_caller();
  v_reason text := public._d24_op_reason(p_reason);
  r public.hosted_invoice_deferred_events%rowtype;
  v_res jsonb;
begin
  if not public._d24_op_is_platform_admin(v_uid) then
    raise exception 'd24_op_platform_admin_required' using errcode = '42501';
  end if;
  if p_provider_event_id is null or length(btrim(p_provider_event_id)) = 0 then
    raise exception 'd24_op_requeue_deferred: event id is required' using errcode = '22023';
  end if;
  perform set_config('d24.writer', 'on', true);
  select * into r from public.hosted_invoice_deferred_events where provider_event_id = p_provider_event_id for update;
  if not found then raise exception 'd24_deferred_event_not_found' using errcode = 'P0002'; end if;
  if r.state = 'pending' then
    return jsonb_build_object('outcome', 'already_pending');
  end if;
  if r.state <> 'rejected' then
    raise exception 'd24_op_not_recoverable: only a rejected deferred event can be requeued (state %)', r.state using errcode = '55000';
  end if;
  if length(v_reason) > 500 then raise exception 'd24_op_reason_required: a requeue reason is at most 500 characters' using errcode = '22023'; end if;
  -- M2-C owns the requeue mechanics (evidence row, attempt budget, cap, guard flag); this wrapper supplies the VERIFIED actor. The event row lock is held across the call.
  v_res := public.d24_requeue_deferred_event(r.provider_event_id, v_uid, v_reason);
  return v_res;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Review reads (definer; each call is scoped to what the caller may see)
-- ---------------------------------------------------------------------------------------------------------------------

create or replace function public.d24_op_list_invoices(
  p_state text default null, p_studio_id uuid default null, p_include_dismissed boolean default false, p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql security definer stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := public._d24_op_caller();
  v_platform boolean := public._d24_op_is_platform_admin(v_uid);
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
begin
  if p_state is not null and p_state not in ('unmatched', 'anomalous', 'resolved', 'clear', 'out_of_scope') then
    raise exception 'd24_op_list_invoices: unknown state' using errcode = '22023';
  end if;
  if not v_platform and not exists (select 1 from public.user_studio_roles r where r.user_id = v_uid and r.active = true and r.role::text in ('studio_owner', 'studio_admin')) then
    raise exception 'd24_op_forbidden' using errcode = '42501';
  end if;
  with scoped as (
    select i.*, (select count(*) from public.hosted_invoice_source_events e where e.invoice_row_id = i.id) as events_seen
    from public.hosted_invoices i
    where (p_state is null or i.reconciliation_state = p_state)
      and (p_studio_id is null or i.studio_id = p_studio_id)
      and (v_platform or (i.studio_id is not null and public._d24_op_is_studio_operator(v_uid, i.studio_id)))
  ), flagged as (
    select s.*, exists (select 1 from public.hosted_invoice_dismissals d where d.invoice_row_id = s.id and d.events_seen = s.events_seen) as dismissed from scoped s
  ), shown as (
    select * from flagged where p_include_dismissed or not dismissed
  )
  select (select count(*) from shown),
         coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at desc, x.id) from (
           select id, stripe_account_id, stripe_invoice_id, livemode, studio_id, classification, status, total, amount_due, amount_paid, amount_remaining, currency,
                  anomaly_codes, acknowledged_codes, array(select c from unnest(anomaly_codes) c where c <> all (acknowledged_codes)) as unacknowledged_codes,
                  reconciliation_state, last_event_created, updated_at, dismissed
           from shown order by updated_at desc, id limit v_limit offset v_offset) x), '[]'::jsonb)
  into v_total, v_rows;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;

-- One invoice with its facts and history. Platform admins also see the sanitized source-event snapshots; studio operators do not.
create or replace function public.d24_op_get_invoice(p_invoice_row_id uuid)
returns jsonb language plpgsql security definer stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := public._d24_op_caller();
  v_platform boolean := public._d24_op_is_platform_admin(v_uid);
  v public.hosted_invoices%rowtype;
begin
  select * into v from public.hosted_invoices where id = p_invoice_row_id;
  if not found or not (v_platform or public._d24_op_is_studio_operator(v_uid, v.studio_id)) then
    raise exception 'd24_invoice_not_found' using errcode = 'P0002';
  end if;
  -- explicit column lists (a column added later is not exposed by accident); studio operators get no actor ids, reasons or internal refs
  return jsonb_build_object(
    'invoice', jsonb_build_object('id', v.id, 'stripe_invoice_id', v.stripe_invoice_id, 'livemode', v.livemode, 'studio_id', v.studio_id, 'classification', v.classification,
      'status', v.status, 'total', v.total, 'amount_due', v.amount_due, 'amount_paid', v.amount_paid, 'amount_remaining', v.amount_remaining, 'currency', v.currency,
      'anomaly_codes', v.anomaly_codes, 'acknowledged_codes', v.acknowledged_codes, 'reconciliation_state', v.reconciliation_state,
      'last_event_created', v.last_event_created, 'created_at', v.created_at, 'updated_at', v.updated_at)
      || case when v_platform then jsonb_build_object('stripe_account_id', v.stripe_account_id, 'registry_id', v.registry_id, 'seen_statuses', v.seen_statuses,
                                                       'subscription_evidence', v.subscription_evidence, 'metadata_ref', v.metadata_ref, 'metadata_studio', v.metadata_studio) else '{}'::jsonb end,
    'payments', coalesce((select jsonb_agg(jsonb_build_object('stripe_invoice_payment_id', p.stripe_invoice_payment_id, 'status', p.status, 'amount_requested', p.amount_requested,
        'amount_paid', p.amount_paid, 'currency', p.currency, 'conflict', p.conflict, 'created_at', p.created_at, 'updated_at', p.updated_at) order by p.created_at, p.id)
      from public.hosted_invoice_payments p where p.invoice_row_id = v.id), '[]'::jsonb),
    'credit_notes', coalesce((select jsonb_agg(jsonb_build_object('stripe_credit_note_id', c.stripe_credit_note_id, 'status', c.status, 'credit_note_type', c.credit_note_type,
        'amount', c.amount, 'currency', c.currency, 'conflict', c.conflict, 'created_at', c.created_at, 'updated_at', c.updated_at) order by c.created_at, c.id)
      from public.hosted_credit_notes c where c.invoice_row_id = v.id), '[]'::jsonb),
    'transitions', coalesce((select jsonb_agg(jsonb_build_object('status', t.status, 'event_created', t.event_created, 'origin_state', t.origin_state, 'created_at', t.created_at) order by t.event_created, t.id)
      from public.hosted_invoice_status_transitions t where t.invoice_row_id = v.id), '[]'::jsonb),
    'audit', coalesce((select jsonb_agg(
        case when v_platform then to_jsonb(a) - 'studio_id'
             else jsonb_build_object('id', a.id, 'occurred_at', a.occurred_at, 'trigger_kind', a.trigger_kind, 'from_state', a.from_state, 'to_state', a.to_state, 'anomaly_codes', a.anomaly_codes) end
        order by a.id) from public.hosted_invoice_recon_audit a where a.invoice_row_id = v.id), '[]'::jsonb),
    'dismissals', case when v_platform then coalesce((select jsonb_agg(to_jsonb(d) order by d.id) from public.hosted_invoice_dismissals d where d.invoice_row_id = v.id), '[]'::jsonb) else '[]'::jsonb end,
    'source_events', coalesce((select jsonb_agg(
        case when v_platform then to_jsonb(e) - 'invoice_row_id' else jsonb_build_object('provider_event_id', e.provider_event_id, 'event_type', e.event_type, 'event_created', e.event_created, 'object_kind', e.object_kind) end
        order by e.event_created, e.provider_event_id) from public.hosted_invoice_source_events e where e.invoice_row_id = v.id), '[]'::jsonb));
end $$;

-- Deferred-event review (platform admin only): counts per state plus a page of events with their requeue history.
create or replace function public.d24_op_list_deferred(p_state text default 'rejected', p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql security definer stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_uid uuid := public._d24_op_caller();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not public._d24_op_is_platform_admin(v_uid) then
    raise exception 'd24_op_platform_admin_required' using errcode = '42501';
  end if;
  if p_state is not null and p_state not in ('pending', 'applied', 'rejected') then
    raise exception 'd24_op_list_deferred: unknown state' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'counts', jsonb_build_object(
      'pending', (select count(*) from public.hosted_invoice_deferred_events where state = 'pending'),
      'applied', (select count(*) from public.hosted_invoice_deferred_events where state = 'applied'),
      'rejected', (select count(*) from public.hosted_invoice_deferred_events where state = 'rejected')),
    'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.received_at desc, x.provider_event_id) from (
      select e.provider_event_id, e.event_type, e.stripe_account_id, e.livemode, e.event_created, e.object_kind, e.state, e.attempts, e.last_error,
             e.payload_mismatch, e.received_at, e.settled_at, e.object_snapshot, e.last_error_code, e.attempt_base,
             e.requeue_count
      from public.hosted_invoice_deferred_events e where p_state is null or e.state = p_state
      order by e.received_at desc, e.provider_event_id limit v_limit offset v_offset) x), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------------------------

revoke all on function public._d24_op_caller() from public, anon, authenticated, service_role;
revoke all on function public._d24_op_is_platform_admin(uuid) from public, anon, authenticated, service_role;
revoke all on function public._d24_op_is_studio_operator(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._d24_op_reason(text) from public, anon, authenticated, service_role;
revoke all on function public._d24_op_studio_ackable(text) from public, anon, authenticated, service_role;
revoke all on function public.d24_op_acknowledge_anomalies(uuid, text[], text) from public, anon, authenticated, service_role;
revoke all on function public.d24_op_dismiss_unmatched(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.d24_op_requeue_deferred(text, text) from public, anon, authenticated, service_role;
revoke all on function public.d24_op_list_invoices(text, uuid, boolean, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.d24_op_get_invoice(uuid) from public, anon, authenticated, service_role;
revoke all on function public.d24_op_list_deferred(text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.d24_op_acknowledge_anomalies(uuid, text[], text) to authenticated;
grant execute on function public.d24_op_dismiss_unmatched(uuid, text) to authenticated;
grant execute on function public.d24_op_requeue_deferred(text, text) to authenticated;
grant execute on function public.d24_op_list_invoices(text, uuid, boolean, integer, integer) to authenticated;
grant execute on function public.d24_op_get_invoice(uuid) to authenticated;
grant execute on function public.d24_op_list_deferred(text, integer, integer) to authenticated;

-- The M1 function trusts its p_actor argument: nobody may call it directly any more (no application code ever did).
revoke all on function public.d24_requeue_deferred_event(text, uuid, text) from public, anon, authenticated, service_role;  -- M2-C's p_actor function: only the verified wrapper above may reach it
revoke all on function public.d24_acknowledge_anomalies(uuid, text[], uuid, text) from public, anon, authenticated, service_role;

commit;
