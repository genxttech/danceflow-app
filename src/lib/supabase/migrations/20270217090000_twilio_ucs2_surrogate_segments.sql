-- TW-4F: a UCS-2 text containing an emoji (or other non-splittable character cluster) can need more parts than ceil(units / 67).
-- A surrogate pair or ZWJ/flag/keycap sequence is never split across parts, so a part that would end inside one stops short and the cluster starts the next part:
--   66 x 'a' + one emoji + 66 more = 134 units: ceil(134 / 67) sizes 2 parts, the carrier sends 3.
-- A blanket "66 per part" rule would over-reserve other bodies (one emoji + 131 'a' = 133 units fits 2 parts), so this packs greedily at 67 with clusters kept whole,
-- the way the carrier and Twilio's open-source segment calculator do. GSM-7 and a UCS-2 body of 70 units or less are unchanged (identical to 20261201090000).
-- Pure function: no table, grant or data change. Mirrors src/lib/sms/segments.ts. Settlement still charges the provider's num_segments (never this estimate);
-- a count more than 2 above the estimate goes to review uncharged, so an estimate error can never over-charge a studio.
-- Known limit: US/Canada toll-free carries 66 units per UCS-2 part (Twilio docs); toll-free is not a provisioned sender type here and the difference is at most one segment on a
-- 10-segment text, inside the settlement tolerance. A toll-free sender needs its own review before activation.
begin;

create or replace function public._tw4us_segments(p_body text)
returns int language plpgsql immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_basic text := '@£$¥èéùìòÇ' || chr(10) || 'Øø' || chr(13) || 'ÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&''()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  v_ext text := '^{}[~]|€' || chr(12);
  v_len int := char_length(coalesce(p_body, ''));
  v_ext_count int;
  v_units int;
  v_astral int;
  i int;
  cp int;
  v_join boolean;
  v_after_zwj boolean := false;
  v_ri_open boolean := false;
  v_cluster int := 0;
  v_used int := 0;
  v_parts int := 1;
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
  -- UCS-2, concatenated: 67 UTF-16 units per part, packed greedily. A character cluster (an emoji with its modifiers, a ZWJ sequence, a flag, a keycap,
  -- a base with combining marks) is never split across parts: if it does not fit what is left of a part it starts the next one.
  -- Same rule, same order as src/lib/sms/segments.ts; more than 10 parts returns 11 (the caller refuses 1..10 only) without scanning the rest.
  for i in 1 .. v_len loop
    cp := ascii(substr(p_body, i, 1));
    v_join := i > 1 and (v_after_zwj or cp = 8205 or cp in (65038, 65039, 8419) or cp between 127995 and 127999 or cp between 917536 and 917631
                         or cp between 768 and 879 or (cp between 127462 and 127487 and v_ri_open));
    v_ri_open := (cp between 127462 and 127487) and not (v_ri_open and v_join);
    v_after_zwj := cp = 8205;
    if v_join then
      v_cluster := v_cluster + case when cp > 65535 then 2 else 1 end;
    else
      if v_cluster > 0 then
        if v_used + v_cluster > 67 then v_parts := v_parts + 1; v_used := v_cluster; else v_used := v_used + v_cluster; end if;
        if v_parts > 10 then return 11; end if;
      end if;
      v_cluster := case when cp > 65535 then 2 else 1 end;
    end if;
  end loop;
  if v_used + v_cluster > 67 then v_parts := v_parts + 1; end if;
  return least(v_parts, 11);
end $$;

notify pgrst, 'reload schema';
commit;
