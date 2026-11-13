-- Behavior check against the fictional fixtures that leaves NOTHING behind: it runs in a transaction that always ends in ROLLBACK, and it
-- raises (non-zero exit) on the first unexpected result. Needs the migration and fixtures.sql applied.
-- sb.sh dev-apply scripts/qa/embeds/dev/verify-settings.sql <sha256>
begin;
do $$
declare
  a constant uuid := 'e3b00000-0000-4000-8000-000000000001';
  s record;
  x record;
  ids uuid[] := array['e3b00000-0000-4000-8000-0000000000a2']::uuid[];
  cnt int;
begin
  -- defaults for a studio with no row
  select * into s from public.public_studio_embed_settings('embed-qa-fictional-a');
  if s is null or s.embeds_enabled is not true or s.show_events is not true or s.show_class_description is not false or s.show_class_price is not false then
    raise exception 'FAIL default settings: %', row_to_json(s); end if;
  select count(*) into cnt from public.public_group_class_extras('embed-qa-fictional-a', ids) where description is not null or price_amount is not null;
  if cnt <> 0 then raise exception 'FAIL extras must be empty by default (got %)', cnt; end if;

  -- opt in: description and price appear
  insert into public.studio_embed_settings (studio_id, show_class_description, show_class_price) values (a, true, true);
  select * into x from public.public_group_class_extras('embed-qa-fictional-a', ids);
  if x is null or x.description is distinct from 'Fictional weekly partner work for embed testing.' or x.price_amount is distinct from 20 then
    raise exception 'FAIL opted-in extras: %', row_to_json(x); end if;
  -- a different studio's slug never returns this studio's class
  select count(*) into cnt from public.public_group_class_extras('embed-qa-fictional-b', ids);
  if cnt <> 0 then raise exception 'FAIL studio isolation on extras (got %)', cnt; end if;

  -- kill switch: everything disappears
  update public.studio_embed_settings set embeds_enabled = false where studio_id = a;
  select * into s from public.public_studio_embed_settings('embed-qa-fictional-a');
  if s.embeds_enabled is not false then raise exception 'FAIL kill switch not reflected: %', row_to_json(s); end if;
  select count(*) into cnt from public.public_group_class_extras('embed-qa-fictional-a', ids);
  if cnt <> 0 then raise exception 'FAIL extras must be empty when embeds are off (got %)', cnt; end if;
  -- the other fictional studio is unaffected
  select * into s from public.public_studio_embed_settings('embed-qa-fictional-b');
  if s.embeds_enabled is not true then raise exception 'FAIL studio B affected by studio A switch'; end if;

  -- a non-public studio is invisible
  update public.studios set public_directory_enabled = false where id = a;
  select count(*) into cnt from public.public_studio_embed_settings('embed-qa-fictional-a');
  if cnt <> 0 then raise exception 'FAIL non-public studio must not be returned'; end if;

  raise notice 'DEV EMBED SETTINGS VERIFY PASS';
end
$$;
rollback;
