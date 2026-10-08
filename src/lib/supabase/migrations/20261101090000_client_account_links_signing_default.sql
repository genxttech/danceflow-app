-- Phase 8D -- fail-safe default for document-signing permission on client account links.
--
-- Product rule: a client's OWN account (relationship_type = 'self') can sign documents; any other relationship
-- (guardian, parent, billing_contact, dependent_manager, dependent) may sign only when authorized staff explicitly
-- grant it. Relationship type alone never grants signing authority; the stored can_sign_documents value is the
-- authority.
--
-- Before: can_sign_documents defaulted to TRUE, so any insert that omitted the column silently granted signing to
-- a non-self relationship (fail-open).
-- After:
--   * the column default is FALSE (an unreviewed creation path can no longer grant signing by omission);
--   * a BEFORE INSERT trigger keeps 'self' links signing-enabled, so existing database paths that create self links
--     without naming the column (public class purchase, legacy portal-user repair) keep working unchanged.
--
-- Existing rows are NOT changed: no UPDATE, no backfill. Stored TRUE / FALSE values keep their meaning -- staff
-- decisions and established guardian access are never reinterpreted. The trigger acts on INSERT only.
--
-- Fail-closed preflight: the column must exist, be NOT NULL and still default to TRUE; RLS must be enabled; the
-- new trigger / function must not already exist.

begin;

set local search_path to pg_catalog, public;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'client_account_links'
      and column_name = 'can_sign_documents' and is_nullable = 'NO' and column_default = 'true'
  ) then
    raise exception 'Phase 8D preflight: client_account_links.can_sign_documents is not the reviewed NOT NULL DEFAULT true column';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.client_account_links'::regclass) then
    raise exception 'Phase 8D preflight: RLS must be enabled on client_account_links';
  end if;

  if exists (
    select 1 from pg_trigger
    where tgrelid = 'public.client_account_links'::regclass and tgname = 'client_account_links_self_signing_default'
  ) or to_regprocedure('public.client_account_links_self_signing_default()') is not null then
    raise exception 'Phase 8D preflight: the self-signing default trigger already exists';
  end if;
end;
$$;

alter table public.client_account_links
  alter column can_sign_documents set default false;

create function public.client_account_links_self_signing_default()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $fn$
begin
  -- A client's own account always signs for itself; every other relationship keeps the explicit / default value.
  if new.relationship_type = 'self' then
    new.can_sign_documents := true;
  end if;
  return new;
end;
$fn$;

create trigger client_account_links_self_signing_default
  before insert on public.client_account_links
  for each row execute function public.client_account_links_self_signing_default();

-- Postflight
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'client_account_links'
      and column_name = 'can_sign_documents' and is_nullable = 'NO' and column_default = 'false'
  ) then
    raise exception 'Phase 8D postflight: can_sign_documents default is not false';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.client_account_links'::regclass
      and tgname = 'client_account_links_self_signing_default'
      and not tgisinternal
      and tgenabled = 'O'
  ) then
    raise exception 'Phase 8D postflight: self-signing default trigger missing or disabled';
  end if;
end;
$$;

commit;
