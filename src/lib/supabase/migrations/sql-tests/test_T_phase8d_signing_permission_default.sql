-- Phase 8D -- document-signing permission default on client_account_links: live-Postgres regression suite.
--
-- After 20261101090000_client_account_links_signing_default.sql:
--   A. a new NON-SELF link that does not name can_sign_documents gets FALSE (guardian, parent, billing_contact,
--      dependent_manager, dependent) -- relationship type alone never grants signing;
--   B. a new SELF link gets TRUE, even when the column is omitted (existing database paths) or written FALSE;
--   C. an explicit staff grant at creation (non-self, TRUE) is kept;
--   D. existing rows are never rewritten: updating an existing non-self link keeps its stored TRUE / FALSE;
--   E. catalog: column default is false and the INSERT-only trigger exists;
--   F. a signed-in studio owner cannot change can_sign_documents directly (no client write policy) -- grants go
--      only through the authorized server action.
--
-- One transaction, rolled back. Run against DEV: supabase db query --linked --file <this file>
-- Before the migration, check A fails (that is the regression this suite pins).
-- Deterministic UUID block: 00000000-0000-0000-0000-00008d0XXXXX

begin;

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00008d000001', 'Phase 8D Harness Studio', 't-phase8d-studio');

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-00008d000101', 't-phase8d-owner@example.test', now());
insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-00008d000101', 't-phase8d-owner@example.test')
on conflict (id) do nothing;
insert into public.user_studio_roles (studio_id, user_id, role, active) values
  ('00000000-0000-0000-0000-00008d000001', '00000000-0000-0000-0000-00008d000101', 'studio_owner', true);

insert into public.clients (id, studio_id, first_name, last_name, email) values
  ('00000000-0000-0000-0000-00008d000201', '00000000-0000-0000-0000-00008d000001', 'Child', 'Client', null);

create or replace function pg_temp.as_user(p_sub uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end;
$$;

do $$
declare
  v_type text;
  v_value boolean;
  v_id uuid;
  v_rows int;
begin
  -- A. non-self links default to no signing permission
  foreach v_type in array array['guardian', 'parent', 'billing_contact', 'dependent_manager', 'dependent'] loop
    insert into public.client_account_links (studio_id, client_id, status, relationship_type, invited_email)
    values ('00000000-0000-0000-0000-00008d000001', '00000000-0000-0000-0000-00008d000201', 'unclaimed', v_type, v_type || '@example.test')
    returning can_sign_documents into v_value;
    if v_value is distinct from false then
      raise exception 'FAIL A % link defaulted to can_sign_documents=%', v_type, v_value;
    end if;
  end loop;

  -- B. self links always sign for themselves
  insert into public.client_account_links (studio_id, client_id, status, relationship_type, invited_email)
  values ('00000000-0000-0000-0000-00008d000001', '00000000-0000-0000-0000-00008d000201', 'unclaimed', 'self', 'self-a@example.test')
  returning can_sign_documents into v_value;
  if v_value is distinct from true then raise exception 'FAIL B1 self (column omitted) got %', v_value; end if;
  insert into public.client_account_links (studio_id, client_id, status, relationship_type, invited_email, can_sign_documents)
  values ('00000000-0000-0000-0000-00008d000001', '00000000-0000-0000-0000-00008d000201', 'unclaimed', 'self', 'self-b@example.test', false)
  returning can_sign_documents into v_value;
  if v_value is distinct from true then raise exception 'FAIL B2 self (written false) got %', v_value; end if;

  -- C. explicit staff grant at creation is kept
  insert into public.client_account_links (studio_id, client_id, status, relationship_type, invited_email, can_sign_documents)
  values ('00000000-0000-0000-0000-00008d000001', '00000000-0000-0000-0000-00008d000201', 'unclaimed', 'guardian', 'granted@example.test', true)
  returning id, can_sign_documents into v_id, v_value;
  if v_value is distinct from true then raise exception 'FAIL C explicit grant dropped'; end if;

  -- D. updates never rewrite the stored permission (trigger is INSERT-only)
  update public.client_account_links set status = 'invited', invite_sent_at = now() where id = v_id
  returning can_sign_documents into v_value;
  if v_value is distinct from true then raise exception 'FAIL D update rewrote a stored grant'; end if;

  -- E. catalog
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'client_account_links'
      and column_name = 'can_sign_documents' and column_default = 'false'
  ) then raise exception 'FAIL E default is not false'; end if;
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.client_account_links'::regclass and t.tgname = 'client_account_links_self_signing_default'
      and (t.tgtype & 4) = 4 and (t.tgtype & 16) = 0 and (t.tgtype & 2) = 2
  ) then raise exception 'FAIL E trigger missing or not BEFORE INSERT only'; end if;

  -- F. no direct client write path for the permission
  perform pg_temp.as_user('00000000-0000-0000-0000-00008d000101');
  set local role authenticated;
  update public.client_account_links set can_sign_documents = false where id = v_id;
  get diagnostics v_rows = row_count;
  reset role;
  if v_rows <> 0 then raise exception 'FAIL F a signed-in owner changed can_sign_documents directly'; end if;
  select can_sign_documents into v_value from public.client_account_links where id = v_id;
  if v_value is distinct from true then raise exception 'FAIL F permission changed'; end if;
end;
$$;

select 'PASS T-phase8d signing permission default (A B C D E F)' as result;

rollback;
