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

create function pg_temp.reserve(p_ws text, p_id uuid, p_qty integer, p_allowance integer, p_key text)
returns jsonb language sql as $$
  select public.reserve_usage_allowance(
    p_ws,
    case when p_ws = 'studio' then p_id else null end,
    case when p_ws = 'organizer' then p_id else null end,
    'email_campaign_recipient', p_qty, p_allowance,
    date_trunc('month', now())::date, (date_trunc('month', now()) + interval '1 month')::date,
    p_key, 't-ent1', 'marketing_campaigns', null, null
  )
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
  if has_function_privilege('authenticated', 'public.reserve_usage_allowance(text, uuid, uuid, text, integer, integer, date, date, text, text, text, uuid, uuid, integer)', 'execute')
     or has_function_privilege('anon', 'public.reserve_usage_allowance(text, uuid, uuid, text, integer, integer, date, date, text, text, text, uuid, uuid, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.finalize_usage_reservation(uuid, integer, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.release_usage_reservation(uuid)', 'execute') then
    raise exception 'FAIL T-ent1-S3 tenant roles must not execute reservation functions';
  end if;
  if not has_function_privilege('service_role', 'public.reserve_usage_allowance(text, uuid, uuid, text, integer, integer, date, date, text, text, text, uuid, uuid, integer)', 'execute')
     or not has_function_privilege('service_role', 'public.finalize_usage_reservation(uuid, integer, jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.release_usage_reservation(uuid)', 'execute') then
    raise exception 'FAIL T-ent1-S4 service_role must execute reservation functions';
  end if;
  if (select count(*) from pg_proc where proname in ('reserve_usage_allowance', 'finalize_usage_reservation', 'release_usage_reservation') and not prosecdef) <> 0 then
    raise exception 'FAIL T-ent1-S5 reservation functions must be SECURITY DEFINER';
  end if;
  raise notice 'PASS T-ent1-shape';
end $$;

-- ============================================================================
-- R. Reserve: limits, exactness, fail closed
-- ============================================================================
do $$
declare r jsonb; A uuid := '00000000-0000-0000-0000-000000e10001';
begin
  -- R1 zero allowance is refused, never unlimited.
  r := pg_temp.reserve('studio', A, 1, 0, 'r1');
  if (r->>'ok')::boolean or r->>'reason' <> 'no_allowance' then raise exception 'FAIL T-ent1-R1 %', r; end if;

  -- R2 within allowance succeeds and reports the remainder.
  r := pg_temp.reserve('studio', A, 6, 10, 'r2');
  if not (r->>'ok')::boolean or (r->>'remaining')::int <> 4 or (r->>'used')::int <> 0 then raise exception 'FAIL T-ent1-R2 %', r; end if;

  -- R3 one over the remainder blocks (no partial reservation).
  r := pg_temp.reserve('studio', A, 5, 10, 'r3');
  if (r->>'ok')::boolean or r->>'reason' <> 'limit_reached' or (r->>'remaining')::int <> 4 or (r->>'reserved')::int <> 6 then
    raise exception 'FAIL T-ent1-R3 %', r;
  end if;
  if exists (select 1 from public.usage_reservations where studio_id = A and idempotency_key = 'r3') then
    raise exception 'FAIL T-ent1-R3b a blocked request must not leave a reservation';
  end if;

  -- R4 exactly the remainder is allowed.
  r := pg_temp.reserve('studio', A, 4, 10, 'r4');
  if not (r->>'ok')::boolean or (r->>'remaining')::int <> 0 then raise exception 'FAIL T-ent1-R4 %', r; end if;

  -- R5 nothing remains.
  r := pg_temp.reserve('studio', A, 1, 10, 'r5');
  if (r->>'ok')::boolean or r->>'reason' <> 'limit_reached' or (r->>'remaining')::int <> 0 then raise exception 'FAIL T-ent1-R5 %', r; end if;

  raise notice 'PASS T-ent1-reserve-limits';
end $$;

-- ============================================================================
-- I. Idempotency
-- ============================================================================
do $$
declare r1 jsonb; r2 jsonb; B uuid := '00000000-0000-0000-0000-000000e10002';
begin
  r1 := pg_temp.reserve('studio', B, 5, 10, 'idem');
  r2 := pg_temp.reserve('studio', B, 5, 10, 'idem');
  if r1->>'reservation_id' <> r2->>'reservation_id' or not (r2->>'idempotent')::boolean then raise exception 'FAIL T-ent1-I1 %, %', r1, r2; end if;
  if (select sum(quantity_reserved) from public.usage_reservations where studio_id = B) <> 5 then
    raise exception 'FAIL T-ent1-I2 repeat must not reserve twice';
  end if;
  raise notice 'PASS T-ent1-idempotency';
end $$;

-- ============================================================================
-- F. Finalize: success-only usage, release of the unused part, no double counting
-- ============================================================================
do $$
declare r jsonb; f jsonb; v_id uuid; v_used int;
  C uuid := '00000000-0000-0000-0000-000000e10001';
  B uuid := '00000000-0000-0000-0000-000000e10002';
begin
  -- B has an active reservation of 5 (from I). Allowance 10: used 0, reserved 5.
  select id into v_id from public.usage_reservations where studio_id = B and idempotency_key = 'idem';

  -- F1 finalize consumes only the successes (3 of 5).
  f := public.finalize_usage_reservation(v_id, 3, '{"campaign":"t"}'::jsonb);
  if not (f->>'ok')::boolean or (f->>'quantity_consumed')::int <> 3 or (f->>'quantity_released')::int <> 2 then raise exception 'FAIL T-ent1-F1 %', f; end if;
  select quantity_used into v_used from public.usage_monthly_summaries
   where studio_id = B and feature_key = 'email_campaign_recipient' and period_start = date_trunc('month', now())::date;
  if v_used <> 3 then raise exception 'FAIL T-ent1-F2 summary must show 3 successful recipients, got %', v_used; end if;

  -- F3 no double counting: used 3, reserved 0, so 7 remain.
  r := pg_temp.reserve('studio', B, 7, 10, 'after-finalize');
  if not (r->>'ok')::boolean or (r->>'used')::int <> 3 or (r->>'remaining')::int <> 0 then raise exception 'FAIL T-ent1-F3 %', r; end if;
  r := pg_temp.reserve('studio', B, 1, 10, 'after-finalize-2');
  if (r->>'ok')::boolean then raise exception 'FAIL T-ent1-F3b over the limit after finalize %', r; end if;

  -- F4 finalize is idempotent and does not add usage again.
  f := public.finalize_usage_reservation(v_id, 3);
  if not (f->>'ok')::boolean or not (f->>'idempotent')::boolean then raise exception 'FAIL T-ent1-F4 %', f; end if;
  select quantity_used into v_used from public.usage_monthly_summaries
   where studio_id = B and feature_key = 'email_campaign_recipient' and period_start = date_trunc('month', now())::date;
  if v_used <> 3 then raise exception 'FAIL T-ent1-F4b repeat finalize double counted: %', v_used; end if;

  -- F5 a finalized key cannot be re-reserved.
  r := pg_temp.reserve('studio', B, 5, 10, 'idem');
  if (r->>'ok')::boolean or r->>'reason' <> 'already_finalized' then raise exception 'FAIL T-ent1-F5 %', r; end if;

  -- F6 consumed beyond reserved is refused.
  select id into v_id from public.usage_reservations where studio_id = B and idempotency_key = 'after-finalize';
  begin
    perform public.finalize_usage_reservation(v_id, 8);
    raise exception 'FAIL T-ent1-F6 over-consumption accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  -- F7 zero successes: nothing is recorded, everything is released.
  f := public.finalize_usage_reservation(v_id, 0);
  if not (f->>'ok')::boolean or (f->>'quantity_released')::int <> 7 then raise exception 'FAIL T-ent1-F7 %', f; end if;
  select quantity_used into v_used from public.usage_monthly_summaries
   where studio_id = B and feature_key = 'email_campaign_recipient' and period_start = date_trunc('month', now())::date;
  if v_used <> 3 then raise exception 'FAIL T-ent1-F7b failed recipients consumed allowance: %', v_used; end if;
  r := pg_temp.reserve('studio', B, 7, 10, 'after-zero');
  if not (r->>'ok')::boolean then raise exception 'FAIL T-ent1-F7c released allowance must be reusable %', r; end if;

  raise notice 'PASS T-ent1-finalize';
end $$;

-- ============================================================================
-- L. Release, expiry
-- ============================================================================
do $$
declare r jsonb; v_id uuid; f jsonb;
  O uuid := '00000000-0000-0000-0000-000000e10101';
begin
  -- L1 release frees the allowance and is idempotent.
  r := pg_temp.reserve('organizer', O, 8, 10, 'org-1');
  if not (r->>'ok')::boolean then raise exception 'FAIL T-ent1-L1 %', r; end if;
  v_id := (r->>'reservation_id')::uuid;
  r := pg_temp.reserve('organizer', O, 3, 10, 'org-2');
  if (r->>'ok')::boolean then raise exception 'FAIL T-ent1-L1b organizer limit %', r; end if;
  f := public.release_usage_reservation(v_id);
  f := public.release_usage_reservation(v_id);
  if not (f->>'ok')::boolean then raise exception 'FAIL T-ent1-L1c repeat release %', f; end if;
  r := pg_temp.reserve('organizer', O, 3, 10, 'org-3');
  if not (r->>'ok')::boolean then raise exception 'FAIL T-ent1-L1d %', r; end if;

  -- L2 a released reservation cannot be finalized into usage.
  f := public.finalize_usage_reservation(v_id, 1);
  if (f->>'ok')::boolean or f->>'reason' <> 'released' then raise exception 'FAIL T-ent1-L2 %', f; end if;

  -- L3 an expired reservation stops counting, but its real deliveries can still be recorded.
  select id into v_id from public.usage_reservations where organizer_id = O and idempotency_key = 'org-3';
  update public.usage_reservations set expires_at = now() - interval '1 minute' where id = v_id;
  r := pg_temp.reserve('organizer', O, 10, 10, 'org-4');
  if not (r->>'ok')::boolean then raise exception 'FAIL T-ent1-L3 expired reservation still counted %', r; end if;
  if (select status from public.usage_reservations where id = v_id) <> 'expired' then raise exception 'FAIL T-ent1-L3b expired status'; end if;
  f := public.finalize_usage_reservation(v_id, 2);
  if not (f->>'ok')::boolean then raise exception 'FAIL T-ent1-L3c late finalize %', f; end if;
  if (select quantity_used from public.usage_monthly_summaries
       where organizer_id = O and feature_key = 'email_campaign_recipient' and period_start = date_trunc('month', now())::date) <> 2 then
    raise exception 'FAIL T-ent1-L3d late finalize must record the 2 real deliveries';
  end if;

  raise notice 'PASS T-ent1-release-expiry';
end $$;

-- ============================================================================
-- T. Tenant scoping and validation
-- ============================================================================
do $$
declare r jsonb; A uuid := '00000000-0000-0000-0000-000000e10001'; B uuid := '00000000-0000-0000-0000-000000e10002';
begin
  -- T1 the same key in another workspace is independent; usage never crosses workspaces.
  r := pg_temp.reserve('studio', B, 1, 100, 'r2');
  if not (r->>'ok')::boolean or (r->>'idempotent')::boolean then raise exception 'FAIL T-ent1-T1 %', r; end if;

  -- T2 the studio A allowance is untouched by studio B / organizer activity.
  r := pg_temp.reserve('studio', A, 1, 10, 'a-extra');
  if (r->>'ok')::boolean or (r->>'used')::int <> 0 or (r->>'reserved')::int <> 10 then raise exception 'FAIL T-ent1-T2 %', r; end if;

  -- T3 invalid workspace shapes and quantities raise.
  begin perform public.reserve_usage_allowance('studio', null, null, 'email_campaign_recipient', 1, 10, current_date, current_date + 1, 'k', 's');
        raise exception 'FAIL T-ent1-T3a'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform public.reserve_usage_allowance('studio', A, A, 'email_campaign_recipient', 1, 10, current_date, current_date + 1, 'k', 's');
        raise exception 'FAIL T-ent1-T3b'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform pg_temp.reserve('studio', A, 0, 10, 'zero');
        raise exception 'FAIL T-ent1-T3c'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform pg_temp.reserve('studio', A, 1, -1, 'neg');
        raise exception 'FAIL T-ent1-T3d'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;

  raise notice 'PASS T-ent1-tenant-validation';
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
  raise notice 'PASS T-ent1-tenant-roles-blocked';
end $$;

do $$
begin
  raise notice 'ALL T-ent1 TESTS PASSED';
end $$;

rollback;

select 'ALL T-ent1 TESTS PASSED' as result;
