-- Restores _tw4us_segments to its 20261201090000 definition (67 units per UCS-2 part, astral characters or not).
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
  select v_len + count(*) into v_units from regexp_split_to_table(p_body, '') c where ascii(c) > 65535;   -- astral characters are two UTF-16 units
  if v_units <= 70 then return 1; end if;
  return ceil(v_units::numeric / 67)::int;
end $$;

notify pgrst, 'reload schema';
commit;
