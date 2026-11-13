-- Removes exactly the fictional embed fixtures (ids from fixtures.sql). Safe to re-run.
-- sb.sh dev-apply scripts/qa/embeds/dev/fixtures-cleanup.sql <sha256>
do $$
declare
  a constant uuid := 'e3b00000-0000-4000-8000-000000000001';
  b constant uuid := 'e3b00000-0000-4000-8000-000000000002';
begin
  delete from public.group_class_enrollment_policies where studio_id in (a, b);
  delete from public.appointments where studio_id in (a, b);
  delete from public.group_class_series where studio_id in (a, b);
  delete from public.events where studio_id in (a, b);
  if to_regclass('public.studio_embed_settings') is not null then
    delete from public.studio_embed_settings where studio_id in (a, b);
  end if;
  delete from public.studios where id in (a, b);
end
$$;
