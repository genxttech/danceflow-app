-- FC-1B5D Phase A: search_bookable_clients_for_instructor
--
-- The second of two controlled instructor interfaces designed in the
-- FC-1B5D containment audit/design. Distinct from and structurally
-- independent of get_teaching_clients_for_instructor (companion migration
-- 20260905160000): this function grants no appointment-relationship
-- requirement at all, and by itself never creates teaching-client access --
-- it exists purely so an instructor can still discover an existing studio
-- client (including one they have never taught) in order to create a first
-- appointment, without falling back to a raw, broad-RLS clients query.
--
-- Identity resolution mirrors the teaching RPC: derived from auth.uid() via
-- instructors.user_id, scoped to the target studio, with no instructor-id
-- parameter accepted.
--
-- Hardened against roster-extraction abuse -- a result cap alone would not
-- be sufficient:
--   - a null/blank (post-trim) search returns nothing (no full-roster dump
--     via an empty query);
--   - fewer than 2 characters after trimming returns nothing (blocks
--     single-character wildcard sweeps);
--   - '%', '_' and the escape character itself are escaped before use in
--     ILIKE, so embedded wildcard characters in the input are matched
--     literally rather than expanding the match;
--   - the result count is server-clamped to a hard maximum of 20 regardless
--     of the caller-supplied limit_count;
--   - results are deterministically ordered (last_name, first_name, id) so
--     they cannot be repeatedly resampled into a reconstructed roster;
--   - only id, first_name, and last_name are returned -- no email, phone,
--     notes, dance_goals, address, referral/lead, payment, package/
--     membership, QR token, or import metadata.
--
-- "archived" clients are excluded from results, matching the existing,
-- unchanged CRM-tier booking behavior in
-- src/app/app/schedule/new/page.tsx (`status !== "archived"`) -- no new
-- filtering policy is invented here, this mirrors current product behavior.
create or replace function public.search_bookable_clients_for_instructor(
  target_studio_id uuid,
  search_text text,
  limit_count int default 20
)
returns table (
  id uuid,
  first_name text,
  last_name text
)
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  normalized_search text;
  escaped_search text;
  capped_limit int;
begin
  if not exists (
    select 1
    from public.instructors i
    where i.user_id = auth.uid()
      and i.studio_id = target_studio_id
      and i.active = true
  ) then
    return;
  end if;

  normalized_search := trim(coalesce(search_text, ''));

  if length(normalized_search) < 2 then
    return;
  end if;

  escaped_search := replace(
    replace(
      replace(normalized_search, '\', '\\'),
      '%', '\%'
    ),
    '_', '\_'
  );

  capped_limit := least(coalesce(limit_count, 20), 20);
  if capped_limit < 1 then
    capped_limit := 20;
  end if;

  return query
    select c.id, c.first_name, c.last_name
    from public.clients c
    where c.studio_id = target_studio_id
      and c.status <> 'archived'
      and (c.first_name || ' ' || c.last_name) ilike ('%' || escaped_search || '%') escape '\'
    order by c.last_name, c.first_name, c.id
    limit capped_limit;
end;
$$;

-- Supabase creates functions with an explicit per-role EXECUTE grant for
-- `anon`, not merely an inherited PUBLIC grant -- revoking from PUBLIC alone
-- does not remove it (matches the established convention in
-- 20260831090000_user_has_client_portal_access_helper.sql). This function
-- has no reason to ever be invoked by an unauthenticated caller.
revoke all on function public.search_bookable_clients_for_instructor(uuid, text, int) from public;
revoke all on function public.search_bookable_clients_for_instructor(uuid, text, int) from anon;
grant execute on function public.search_bookable_clients_for_instructor(uuid, text, int) to authenticated;
grant execute on function public.search_bookable_clients_for_instructor(uuid, text, int) to service_role;
