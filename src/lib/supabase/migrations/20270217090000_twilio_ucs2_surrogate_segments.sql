-- TW-4F: a UCS-2 text with astral characters (emoji) can need more parts than ceil(units / 67).
-- A surrogate pair is never split across parts, so a part that would end mid-pair carries 66 units, not 67:
--   66 x 'a' + one emoji + 66 more units = 134 units, which ceil(134 / 67) sizes as 2 parts but the carrier sends as 3.
-- The reservation must cover what the provider counts, so when any astral character is present the per-part capacity is the conservative 66.
-- Only the UCS-2 branch changes; GSM-7 sizing and every other path are identical to 20261201090000. Pure function: no table, grant or data change.
-- Mirrors src/lib/sms/segments.ts. Provider evidence (num_segments) is still what is finally charged; this only sizes the reservation.
begin;

create or replace function public._tw4us_segments(p_body text)
returns int language plpgsql immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_basic text := '@£$¥èéùìòÇ' || chr(10) || 'Øø' || chr(13) || 'ÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&''()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  v_ext text := '^{}\[~]|€' || chr(12);
  v_len int := char_length(coalesce(p_body, ''));
  v_ext_count int;
  v_units int;
  v_astral int;
begin
  if v_len = 0 then
    return 0;
  end if;
  if translate(p_body, v_basic || v_ext, '') = '' then
    v_ext_count := v_len - char_length(translate(p_body, v_ext, ''));
    v_units := v_len + v_ext_count;
    if v_units <= 160 then return 1; end if;
    return ceil(v_units::numeric / (case when v_ext_count > 0 then 152 else 153 end))::int;
  end if;
  select count(*) into v_astral from regexp_split_to_table(p_body, '') c where ascii(c) > 65535;   -- astral characters are two UTF-16 units
  v_units := v_len + v_astral;
  if v_units <= 70 then return 1; end if;
  return ceil(v_units::numeric / (case when v_astral > 0 then 66 else 67 end))::int;   -- a pair is never split across parts
end $$;

notify pgrst, 'reload schema';
commit;
