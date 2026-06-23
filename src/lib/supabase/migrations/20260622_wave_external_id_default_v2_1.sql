begin;

alter table public.studio_wave_sync_lines
  alter column wave_external_id
  set default ('danceflow-wave-' || gen_random_uuid()::text);

commit;
