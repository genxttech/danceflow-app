-- ENT-1 -- atomic usage allowance reservations (email-campaign recipients).
--
-- Covers 20261013090000_ent1_usage_allowance_reservations.sql. One transaction,
-- synthetic fixtures only (UUID block ...00000e1....), rolled back at the end --
-- nothing persists. Assumes the forward migration has been applied. Real
-- concurrency (parallel sessions) is covered separately by
-- concurrency/ent1_race_harness.mjs.

begin;

-- ============================================================================
-- Fixtures: studio A, studio B, organizer A
-- ============================================================================
insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000e10001', 'ENT-1 Studio A', 't-ent1-a'),
  ('00000000-0000-0000-0000-000000e10002', 'ENT-1 Studio B', 't-ent1-b');

insert into public.organizers (id, name, slug) values
  ('00000000-0000-0000-0000-000000e10101', 'ENT-1 Organizer A', 't-ent1-org-a');

-- recipient ids for a batch: n synthetic uuids
create function pg_temp.ids(p_n integer, p_tag integer) returns uuid[] language sql as $$
  select coalesce(array_agg(('00000000-0000-0000-0000-' || lpad(to_hex(p_tag * 100000 + g), 12, '0'))::uuid), '{}')
  from generate_series(1, p_n) g
$$;

-- reserve for the whole logical campaign `p_key`; `p_pending` = all pending now; batch = first min(500, pending) ids
create function pg_temp.reserve(p_ws text, p_id uuid, p_pending integer, p_allowance integer, p_key text, p_batch integer default null)
returns jsonb language sql as $$
  select public.reserve_usage_allowance(
    p_ws,
    case when p_ws = 'studio' then p_id else null end,
    case when p_ws = 'organizer' then p_id else null end,
    'email_campaign_recipient', p_pending, p_allowance,
    date_trunc('month', now())::date, (date_trunc('month', now()) + interval '1 month')::date,
    p_key, 't-ent1', 'marketing_campaigns', null, null,
    pg_temp.ids(coalesce(p_batch, least(p_pending, 500)), 7)
  )
$$;

create function pg_temp.used(p_ws text, p_id uuid) returns integer language sql as $$
  select coalesce((select quantity_used from public.usage_monthly_summaries
    where case when p_ws = 'studio' then studio_id = p_id else organizer_id = p_id end
      and feature_key = 'email_campaign_recipient' and period_start = date_trunc('month', now())::date), 0)
$$;

-- ============================================================================
-- S. Shape and privileges
-- ============================================================================
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.usage_reservations'::regclass)
     or exists (select 1 from pg_policy where polrelid = 'public.usage_reservations'::regclass) then
    raise exception 'FAIL T-ent1-S1 usage_reservations must have RLS enabled and zero policies';
  end if;
  if has_table_privilege('authenticated', 'public.usage_reservations', 'select')
     or has_table_privilege('anon', 'public.usage_reservations', 'select')
     or has_table_privilege('authenticated', 'public.usage_reservations', 'insert') then
    raise exception 'FAIL T-ent1-S2 tenant roles must have no table privileges';
  end if;
  if has_function_privilege('authenticated', 'public.reserve_usage_allowance(text, uuid, uuid, text, integer, integer, date, date, text, text, text, uuid, uuid, uuid[], integer)', 'execute')
     or has_function_privilege('anon', 'public.reserve_usage_allowance(text, uuid, uuid, text, integer, integer, date, date, text, text, text, uuid, uuid, uuid[], integer)', 'execute')
     or has_function_privilege('authenticated', 'public.settle_usage_reservation(uuid, integer, integer, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.settle_usage_reservation(uuid, integer, integer, jsonb)', 'execute') then
    raise exception 'FAIL T-ent1-S3 tenant roles must not execute reservation functions';
  end if;
  if not has_function_privilege('service_role', 'public.reserve_usage_allowance(text, uuid, uuid, text, integer, integer, date, date, text, text, text, uuid, uuid, uuid[], integer)', 'execute')
     or not has_function_privilege('service_role', 'public.settle_usage_reservation(uuid, integer, integer, jsonb)', 'execute') then
    raise exception 'FAIL T-ent1-S4 service_role must execute reservation functions';
  end if;
  if (select count(*) from pg_proc where proname in ('reserve_usage_allowance', 'settle_usage_reservation') and not prosecdef) <> 0 then
    raise exception 'FAIL T-ent1-S5 reservation functions must be SECURITY DEFINER';
  end if;
  if exists (select 1 from pg_proc where proname in ('finalize_usage_reservation', 'release_usage_reservation')) then
    raise exception 'FAIL T-ent1-S6 the superseded candidate functions must not exist';
  end if;
  raise notice 'PASS T-ent1-shape';
end $$;

-- ============================================================================
-- A. Admission: the whole logical campaign fits, or nothing is committed
-- ============================================================================
do $$
declare r jsonb; A uuid := '00000000-0000-0000-0000-000000e10001';
begin
  -- A1 zero allowance is refused, never unlimited.
  r := pg_temp.reserve('studio', A, 1, 0, 'a1');
  if (r->>'ok')::boolean or r->>'reason' <> 'no_allowance' then raise exception 'FAIL T-ent1-A1 %', r; end if;

  -- A2 a 600-recipient campaign is admitted as a whole against 1000 (more than one 500-recipient batch).
  r := pg_temp.reserve('studio', A, 600, 1000, 'camp-1');
  if not (r->>'ok')::boolean or (r->>'remaining')::int <> 400 or (r->>'committed')::int <> 600 then raise exception 'FAIL T-ent1-A2 %', r; end if;
  if (select quantity_reserved from public.usage_reservations where idempotency_key = 'camp-1') <> 600 then
    raise exception 'FAIL T-ent1-A2b the whole logical campaign must be committed, not the 500 batch';
  end if;

  -- A3 one over the uncommitted remainder blocks entirely and commits nothing.
  r := pg_temp.reserve('studio', A, 401, 1000, 'camp-2');
  if (r->>'ok')::boolean or r->>'reason' <> 'limit_reached' or (r->>'remaining')::int <> 400 or (r->>'committed')::int <> 600 then
    raise exception 'FAIL T-ent1-A3 %', r;
  end if;
  if exists (select 1 from public.usage_reservations where idempotency_key = 'camp-2') then
    raise exception 'FAIL T-ent1-A3b a blocked campaign must not leave a reservation';
  end if;

  -- A4 exactly the remainder is admitted.
  r := pg_temp.reserve('studio', A, 400, 1000, 'camp-3');
  if not (r->>'ok')::boolean or (r->>'remaining')::int <> 0 then raise exception 'FAIL T-ent1-A4 %', r; end if;
  r := pg_temp.reserve('studio', A, 1, 1000, 'camp-4');
  if (r->>'ok')::boolean then raise exception 'FAIL T-ent1-A4b nothing remains %', r; end if;

  raise notice 'PASS T-ent1-admission';
end $$;

-- ============================================================================
-- M. Multi-batch: later batches continue under the committed capacity
-- ============================================================================
do $$
declare r jsonb; s jsonb; v_id uuid; A uuid := '00000000-0000-0000-0000-000000e10001';
begin
  -- State from A: camp-1 (600, batch 1 open), camp-3 (400, batch open). used 0.
  select id into v_id from public.usage_reservations where idempotency_key = 'camp-1';

  -- M1 camp-1's first batch (500) settles with 500 sent, 100 still pending: usage 500, commitment shrinks to 100.
  s := public.settle_usage_reservation(v_id, 500, 100);
  if not (s->>'ok')::boolean or s->>'status' <> 'reserved' or (s->>'quantity_still_committed')::int <> 100 then raise exception 'FAIL T-ent1-M1 %', s; end if;
  if pg_temp.used('studio', A) <> 500 then raise exception 'FAIL T-ent1-M1b usage'; end if;

  -- M2 capacity committed to camp-1's remaining 100 cannot be stolen: used 500 + camp-3 400 + camp-1 100 = 1000 -> nothing free.
  r := pg_temp.reserve('studio', A, 1, 1000, 'thief');
  if (r->>'ok')::boolean then raise exception 'FAIL T-ent1-M2 a concurrent campaign took committed capacity %', r; end if;

  -- M3 camp-1's second batch continues under the original commitment (no new allowance check), even though others were admitted meanwhile.
  r := pg_temp.reserve('studio', A, 100, 1000, 'camp-1', 100);
  if not (r->>'ok')::boolean or not (r->>'continued')::boolean or r->>'reservation_id' <> v_id::text then raise exception 'FAIL T-ent1-M3 %', r; end if;

  -- M4 the second batch settles: everything sent, nothing pending -> the campaign is finalized, usage 600.
  s := public.settle_usage_reservation(v_id, 100, 0);
  if s->>'status' <> 'finalized' or pg_temp.used('studio', A) <> 600 then raise exception 'FAIL T-ent1-M4 %', s; end if;

  -- M5 a finalized campaign holds nothing: only camp-3's 400 is still committed (used 600 + 400 = 1000).
  r := pg_temp.reserve('studio', A, 1, 1000, 'after-camp-1');
  if (r->>'ok')::boolean then raise exception 'FAIL T-ent1-M5 used 600 + camp-3 400 leaves nothing %', r; end if;

  raise notice 'PASS T-ent1-multi-batch';
end $$;

-- ============================================================================
-- F. Failures and settle semantics
-- ============================================================================
do $$
declare r jsonb; s jsonb; v_id uuid; B uuid := '00000000-0000-0000-0000-000000e10002';
begin
  -- F1 batch with failures: 700 admitted, batch 1 = 500 of which 450 sent and 50 failed; 200 still pending.
  r := pg_temp.reserve('studio', B, 700, 1000, 'f-camp');
  if not (r->>'ok')::boolean then raise exception 'FAIL T-ent1-F1 %', r; end if;
  select id into v_id from public.usage_reservations where idempotency_key = 'f-camp';
  s := public.settle_usage_reservation(v_id, 450, 200);
  if (s->>'quantity_still_committed')::int <> 200 then raise exception 'FAIL T-ent1-F1b failed recipients must not stay committed %', s; end if;
  if pg_temp.used('studio', B) <> 450 then raise exception 'FAIL T-ent1-F1c only successes are usage'; end if;
  -- the 50 failed recipients' capacity is free: 1000 - 450 used - 200 committed = 350
  r := pg_temp.reserve('studio', B, 350, 1000, 'f-other');
  if not (r->>'ok')::boolean then raise exception 'FAIL T-ent1-F1d freed capacity should be reusable %', r; end if;
  s := public.settle_usage_reservation((r->>'reservation_id')::uuid, 0, 350);
  -- consumed 0 -> a campaign that mailed nobody holds nothing
  if s->>'status' <> 'released' then raise exception 'FAIL T-ent1-F1e %', s; end if;

  -- F2 settle is idempotent: a retry never double counts.
  s := public.settle_usage_reservation(v_id, 450, 200);
  if not (s->>'idempotent')::boolean or pg_temp.used('studio', B) <> 450 then raise exception 'FAIL T-ent1-F2 %', s; end if;

  -- F3 settling more than the committed capacity or the open batch is refused.
  r := pg_temp.reserve('studio', B, 200, 1000, 'f-camp', 200);
  if not (r->>'ok')::boolean then raise exception 'FAIL T-ent1-F3 %', r; end if;
  begin perform public.settle_usage_reservation(v_id, 201, 0); raise exception 'FAIL T-ent1-F3b over-settlement accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  s := public.settle_usage_reservation(v_id, 200, 0);
  if s->>'status' <> 'finalized' or pg_temp.used('studio', B) <> 650 then raise exception 'FAIL T-ent1-F3c %', s; end if;

  raise notice 'PASS T-ent1-failures-settle';
end $$;

-- ============================================================================
-- U. Unsettled batches stay conservative; reconciliation records them; nothing disappears
-- ============================================================================
do $$
declare r jsonb; s jsonb; v_id uuid; O uuid := '00000000-0000-0000-0000-000000e10101';
begin
  r := pg_temp.reserve('organizer', O, 800, 1000, 'u-camp');
  v_id := (r->>'reservation_id')::uuid;

  -- U1 while the batch is open (even if its settle call never succeeds) the capacity stays held.
  r := pg_temp.reserve('organizer', O, 201, 1000, 'u-other');
  if (r->>'ok')::boolean then raise exception 'FAIL T-ent1-U1 unsettled capacity was released %', r; end if;

  -- U2 a second batch on the same campaign while the first is open is refused.
  r := pg_temp.reserve('organizer', O, 800, 1000, 'u-camp');
  if (r->>'ok')::boolean or r->>'reason' <> 'in_progress' then raise exception 'FAIL T-ent1-U2 %', r; end if;

  -- U3 a batch left open past the stale window (crashed request) requires reconciliation first.
  update public.usage_reservations set batch_started_at = now() - interval '1 hour' where id = v_id;
  r := pg_temp.reserve('organizer', O, 800, 1000, 'u-camp');
  if (r->>'ok')::boolean or r->>'reason' <> 'needs_reconcile' then raise exception 'FAIL T-ent1-U3 %', r; end if;
  -- ...and the capacity is STILL held while it is unresolved
  r := pg_temp.reserve('organizer', O, 201, 1000, 'u-other');
  if (r->>'ok')::boolean then raise exception 'FAIL T-ent1-U3b %', r; end if;

  -- U4 reconciliation (the app counts the durable 'sent' records of the batch) records the successes exactly once.
  s := public.settle_usage_reservation(v_id, 300, 500);
  if not (s->>'ok')::boolean or pg_temp.used('organizer', O) <> 300 then raise exception 'FAIL T-ent1-U4 %', s; end if;
  s := public.settle_usage_reservation(v_id, 300, 500);
  if pg_temp.used('organizer', O) <> 300 then raise exception 'FAIL T-ent1-U4b repeated reconciliation double counted'; end if;

  -- U5 the campaign can then continue under its commitment.
  r := pg_temp.reserve('organizer', O, 500, 1000, 'u-camp', 500);
  if not (r->>'ok')::boolean or not (r->>'continued')::boolean then raise exception 'FAIL T-ent1-U5 %', r; end if;
  s := public.settle_usage_reservation(v_id, 500, 0);
  if pg_temp.used('organizer', O) <> 800 or s->>'status' <> 'finalized' then raise exception 'FAIL T-ent1-U5b %', s; end if;

  raise notice 'PASS T-ent1-unsettled-durable';
end $$;

-- ============================================================================
-- G. Growth, entitlement loss, tenants, validation
-- ============================================================================
do $$
declare r jsonb; s jsonb; v_id uuid;
  A uuid := '00000000-0000-0000-0000-000000e10001'; B uuid := '00000000-0000-0000-0000-000000e10002';
begin
  -- B has used 650 (F). Admit a 100-recipient campaign and mail 50 of it: used 700, committed 50.
  r := pg_temp.reserve('studio', B, 100, 1000, 'g-camp');
  select id into v_id from public.usage_reservations where idempotency_key = 'g-camp';
  s := public.settle_usage_reservation(v_id, 50, 50);
  if pg_temp.used('studio', B) <> 700 then raise exception 'FAIL T-ent1-G0 %', s; end if;

  -- G1 if the list grew beyond the committed capacity, only the difference is checked and added, atomically.
  -- 200 pending needs 150 more than the 50 committed; free = 1000 - 700 - 50 = 250 -> fits.
  r := pg_temp.reserve('studio', B, 200, 1000, 'g-camp', 200);
  if not (r->>'ok')::boolean or (r->>'committed')::int <> 200 then raise exception 'FAIL T-ent1-G1 %', r; end if;
  s := public.settle_usage_reservation(v_id, 0, 200);
  -- 400 pending needs 200 more than the 200 committed; free = 1000 - 700 - 200 = 100 -> blocked, commitment untouched.
  r := pg_temp.reserve('studio', B, 400, 1000, 'g-camp', 400);
  if (r->>'ok')::boolean or r->>'reason' <> 'limit_reached' then raise exception 'FAIL T-ent1-G1b growth beyond capacity must block %', r; end if;
  if (select quantity_reserved - quantity_consumed from public.usage_reservations where id = v_id) <> 200 then
    raise exception 'FAIL T-ent1-G1c a blocked growth must leave the commitment unchanged';
  end if;

  -- G2 losing the entitlement mid-campaign blocks continuation (zero is never unlimited).
  r := pg_temp.reserve('studio', B, 100, 0, 'g-camp', 100);
  if (r->>'ok')::boolean or r->>'reason' <> 'no_allowance' then raise exception 'FAIL T-ent1-G2 %', r; end if;

  -- G3 the same key in another workspace is independent; usage never crosses workspaces.
  r := pg_temp.reserve('studio', A, 1, 100000, 'g-camp');
  if not (r->>'ok')::boolean or (r->>'continued')::boolean then raise exception 'FAIL T-ent1-G3 %', r; end if;

  -- G4 invalid workspace shapes and quantities raise.
  begin perform public.reserve_usage_allowance('studio', null, null, 'email_campaign_recipient', 1, 10, current_date, current_date + 1, 'k', 's');
        raise exception 'FAIL T-ent1-G4a'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform public.reserve_usage_allowance('studio', A, A, 'email_campaign_recipient', 1, 10, current_date, current_date + 1, 'k', 's');
        raise exception 'FAIL T-ent1-G4b'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform pg_temp.reserve('studio', A, 0, 10, 'zero');
        raise exception 'FAIL T-ent1-G4c'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform pg_temp.reserve('studio', A, 1, -1, 'neg');
        raise exception 'FAIL T-ent1-G4d'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;

  raise notice 'PASS T-ent1-growth-validation';
end $$;

-- ============================================================================
-- P. Tenant roles cannot reach the table or the functions
-- ============================================================================
do $$
declare v int;
begin
  set local role authenticated;
  begin
    select count(*) into v from public.usage_reservations;
    reset role;
    raise exception 'FAIL T-ent1-P1 authenticated could read usage_reservations';
  exception when insufficient_privilege then
    reset role;
  end;
  set local role authenticated;
  begin
    perform public.reserve_usage_allowance('studio', '00000000-0000-0000-0000-000000e10001', null, 'email_campaign_recipient', 1, 10, current_date, current_date + 1, 'tenant', 't');
    reset role;
    raise exception 'FAIL T-ent1-P2 authenticated reserved allowance';
  exception when insufficient_privilege then
    reset role;
  end;
  set local role authenticated;
  begin
    perform public.settle_usage_reservation(gen_random_uuid(), 1);
    reset role;
    raise exception 'FAIL T-ent1-P3 authenticated settled a reservation';
  exception when insufficient_privilege then
    reset role;
  end;
  raise notice 'PASS T-ent1-tenant-roles-blocked';
end $$;

do $$
begin
  raise notice 'ALL T-ent1 TESTS PASSED';
end $$;

rollback;

select 'ALL T-ent1 TESTS PASSED' as result;
