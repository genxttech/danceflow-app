-- Phase 8A -- Documents signing integrity (P0).
--
-- Removes two client-writable RLS policies that let a signed-in user create signing evidence or complete a document
-- without going through an authoritative signing workflow:
--
--   1. document_signatures  "Portal users can create document signatures" (INSERT)
--      WITH CHECK: (signer_user_id = auth.uid()) OR (<portal access to client_id>)
--      The first branch alone admitted a row for ANY studio / client / assignment / body, as long as the caller put
--      their own id in signer_user_id -- a forged "signature" that staff surfaces then display as evidence.
--
--   2. document_assignments "Portal users can mark own document assignments signed" (UPDATE)
--      Let a linked portal user update ANY column of their client's assignments as long as the new status is
--      pending/signed -- i.e. mark a document signed without signing, or rewrite envelope / version / timestamp
--      columns.
--
-- Neither policy is needed: every legitimate write is server-mediated. The legacy typed-signature portal action now
-- validates the relationship, assignment lifecycle and envelope state on the server and writes with the service role;
-- envelope signing (public token, portal hand-off, student app) already writes with the service role. Read policies
-- are unchanged, so portal display keeps working. No columns, data or other policies change.
--
-- Preflight fails closed if either policy's predicate drifted from the reviewed text (md5 of USING || '|' || CHECK,
-- identical on DEV and PROD at review time) or if RLS is not enabled on either table.

begin;

do $$
declare
  v_fp text;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'document_signatures' and c.relrowsecurity
  ) or not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'document_assignments' and c.relrowsecurity
  ) then
    raise exception 'Phase 8A preflight: RLS must be enabled on document_signatures and document_assignments';
  end if;

  select md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) into v_fp
  from pg_policies
  where schemaname = 'public' and tablename = 'document_signatures'
    and policyname = 'Portal users can create document signatures' and cmd = 'INSERT';
  if v_fp is distinct from '808bbda0c4a3f6a07ddd036055f3dd8c' then
    raise exception 'Phase 8A preflight: document_signatures portal INSERT policy drifted or missing (fp=%)', v_fp;
  end if;

  select md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) into v_fp
  from pg_policies
  where schemaname = 'public' and tablename = 'document_assignments'
    and policyname = 'Portal users can mark own document assignments signed' and cmd = 'UPDATE';
  if v_fp is distinct from '3ec5d3c8f739010592cbd8fe51f6893e' then
    raise exception 'Phase 8A preflight: document_assignments portal UPDATE policy drifted or missing (fp=%)', v_fp;
  end if;
end;
$$;

drop policy "Portal users can create document signatures" on public.document_signatures;
drop policy "Portal users can mark own document assignments signed" on public.document_assignments;

-- Postflight: no client-facing INSERT/UPDATE/DELETE path remains on document_signatures, and portal users keep only
-- SELECT on document_assignments (staff management policies are untouched).
do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'document_signatures' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) then
    raise exception 'Phase 8A postflight: a write policy still exists on document_signatures';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'document_assignments'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and policyname <> 'Studio admins can manage document assignments'
  ) then
    raise exception 'Phase 8A postflight: unexpected write policy remains on document_assignments';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'document_assignments'
      and policyname = 'Portal users can view own document assignments' and cmd = 'SELECT'
  ) or not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'document_signatures'
      and policyname = 'Portal users can view own document signatures' and cmd = 'SELECT'
  ) then
    raise exception 'Phase 8A postflight: portal read policies must be preserved';
  end if;
end;
$$;

commit;
