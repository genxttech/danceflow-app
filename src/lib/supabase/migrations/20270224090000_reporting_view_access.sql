-- Reporting views: reads follow the caller's own access rules, and only the profit-and-loss view stays readable,
-- by signed-in users. Server (service_role) access is unchanged. A view that does not exist is skipped.
-- There is deliberately no rollback: if a legitimate page stops working, correct it forward without widening access.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
declare
  v_name text;
  v_view regclass;
begin
  foreach v_name in array array['client_package_balances', 'active_client_memberships', 'today_appointments', 'v_event_profit_loss']
  loop
    v_view := to_regclass('public.' || v_name);
    continue when v_view is null;

    execute format('alter view %s set (security_invoker = true)', v_view);
    execute format('revoke all on table %s from public, anon, authenticated', v_view);
    if v_name = 'v_event_profit_loss' then
      execute format('grant select on table %s to authenticated', v_view);
    end if;

    -- stop the whole change unless the end state is exactly the intended one
    if has_table_privilege('anon', v_view, 'select, insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege('anon', v_view, 'select, insert, update, references') then
      raise exception 'signed-out access remains on %', v_name;
    end if;
    if has_table_privilege('authenticated', v_view, 'insert, update, delete, truncate, references, trigger')
       or has_any_column_privilege('authenticated', v_view, 'insert, update, references') then
      raise exception 'signed-in write access remains on %', v_name;
    end if;
    if (v_name = 'v_event_profit_loss') is distinct from has_table_privilege('authenticated', v_view, 'select') then
      raise exception 'unexpected signed-in read access on %', v_name;
    end if;
    if not exists (select 1 from pg_catalog.pg_class c where c.oid = v_view and 'security_invoker=true' = any (c.reloptions)) then
      raise exception '% does not follow the caller''s access rules', v_name;
    end if;
  end loop;
end
$$;

commit;
