-- TW-4F: exact SMS part counts for reservations, matching Twilio's segment calculator (TwilioDevEd/message-segment-calculator): a part is 140 octets, a concatenated
-- part carries a 6-octet header (67 UTF-16 units or 153 septets left), and a character never splits across parts.
--   UCS-2: 66 x 'a' + one emoji + 66 more = 134 units. ceil(134 / 67) sizes 2 parts; the emoji cannot split, so Twilio sends 3 (undercount fixed).
--   GSM-7: one extension character no longer drops every part to 152 septets; a part ends early only where an extension character would split
--          (303 x 'a' + '€' = 305 septets is 2 parts, the old rule said 3: overcount fixed).
-- UCS-2 packs greedily by character cluster: a cluster breaks only before a character that always starts a new grapheme (Latin, Greek, Cyrillic, Hebrew, Arabic,
-- Devanagari and Thai letters, CJK, kana, Hangul syllables, punctuation, symbols, emoji bases), never after a ZWJ, a prepended mark, a Devanagari virama or a
-- leading Hangul jamo; regional indicators pair into flags; every other character joins the cluster before it. For English, emoji and GSM-7 text this is exactly
-- Twilio's grapheme split (CR and LF stay separate, as in Twilio's calculator). Elsewhere a cluster can be coarser than a grapheme (up to a word in other scripts),
-- which can only add parts, never remove them. A cluster longer than 67 units (unspaced complex-script text) is sized at 34 units per part, which holds while no
-- single grapheme exceeds 34 units.
-- The count is exact, not capped (callers refuse more than 10). A body of 160 septets / 70 units or less is still one part. Same rule, ranges and order as
-- src/lib/sms/segments.ts. Pure function: no table, grant or data change (create or replace keeps the 20261201090000 privileges). Settlement still charges the
-- provider's num_segments (never this estimate); a count more than 2 above the estimate goes to review uncharged, so an estimate error can never over-charge a studio.
-- Known limit: US/Canada toll-free carries 66 units per UCS-2 part (Twilio docs); toll-free is not a provisioned sender type here. A toll-free sender needs its own
-- review before activation.
begin;

do $$
begin
  if to_regprocedure('public._tw4us_segments(text)') is null then
    raise exception '20270217090000 requires 20261201090000 (public._tw4us_segments)';
  end if;
end $$;

create or replace function public._tw4us_segments(p_body text)
returns int language plpgsql immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_basic text := '@£$¥èéùìòÇ' || chr(10) || 'Øø' || chr(13) || 'ÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&''()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  v_ext text := '^{}\[~]|€' || chr(12);
  -- code points that always start a new grapheme, as [low, high] pairs (STARTERS in src/lib/sms/segments.ts)
  v_starters int[] := array[0, 767, 880, 1154, 1162, 1327,
                            1470, 1470, 1472, 1472, 1475, 1475, 1478, 1478, 1488, 1524,                                                     -- Hebrew
                            1542, 1551, 1563, 1610, 1632, 1647, 1649, 1749, 1758, 1758, 1765, 1766, 1769, 1769, 1774, 1791,                 -- Arabic
                            2308, 2361, 2365, 2365, 2384, 2384, 2392, 2401, 2404, 2431,                                                     -- Devanagari
                            3585, 3632, 3634, 3634, 3647, 3654, 3663, 3675,                                                                 -- Thai
                            7680, 7935, 8192, 8203, 8206, 8399, 8448, 11263,
                            12288, 12329, 12336, 12438, 12448, 12543, 13312, 19903, 19968, 40959, 44032, 55203, 63744, 64255, 65281, 65437,
                            126976, 127461, 127488, 127994, 128000, 129791];
  -- code points the next character always joins: ZWJ, Prepend marks, the Devanagari virama, leading Hangul jamo (JOINS_NEXT in src/lib/sms/segments.ts)
  v_joins_next int[] := array[1536, 1541, 1757, 1757, 1807, 1807, 2192, 2193, 2274, 2274, 2381, 2381, 3406, 3406, 4352, 4447, 8205, 8205, 43360, 43388,
                              69821, 69821, 69837, 69837, 70082, 70083, 71999, 71999, 72001, 72001, 72250, 72250, 72324, 72329, 73030, 73030, 73474, 73474];
  v_chars text[];
  c text;
  cp int;
  j int;
  v_w int;
  v_units int;
  v_used int := 0;
  v_parts int := 1;
  v_cluster int := 0;
  v_ri boolean;
  v_starter boolean;
  v_join boolean;
  v_join_next boolean := false;
  v_ri_open boolean := false;
begin
  if p_body is null or p_body = '' then
    return 0;
  end if;
  v_chars := string_to_array(p_body, null);   -- one element per character
  if translate(p_body, v_basic || v_ext, '') = '' then
    v_units := cardinality(v_chars) + (cardinality(v_chars) - char_length(translate(p_body, v_ext, '')));
    if v_units <= 160 then return 1; end if;
    -- GSM-7, concatenated: 153 septets per part, an extension character (two septets) never split
    foreach c in array v_chars loop
      v_w := case when strpos(v_ext, c) > 0 then 2 else 1 end;
      if v_used + v_w > 153 then v_parts := v_parts + 1; v_used := v_w; else v_used := v_used + v_w; end if;
    end loop;
    return v_parts;
  end if;
  select cardinality(v_chars) + count(*) into v_units from unnest(v_chars) u(ch) where ascii(u.ch) > 65535;   -- astral characters are two UTF-16 units
  if v_units <= 70 then return 1; end if;
  -- UCS-2, concatenated: 67 UTF-16 units per part, packed greedily by character cluster
  foreach c in array v_chars loop
    cp := ascii(c);
    v_ri := cp between 127462 and 127487;
    v_starter := cp <= 767;   -- fast path for the first table range (ASCII and Latin)
    if not v_starter then
      for j in 3 .. cardinality(v_starters) by 2 loop
        if cp between v_starters[j] and v_starters[j + 1] then v_starter := true; exit; end if;
      end loop;
    end if;
    v_join := v_cluster > 0 and (v_join_next or case when v_ri then v_ri_open else not v_starter end);
    v_ri_open := v_ri and not (v_ri_open and v_join);
    v_join_next := false;
    if cp >= 1536 then   -- nothing below the first table range joins the next character
      for j in 1 .. cardinality(v_joins_next) by 2 loop
        if cp between v_joins_next[j] and v_joins_next[j + 1] then v_join_next := true; exit; end if;
      end loop;
    end if;
    if not v_join and v_cluster > 0 then
      if v_cluster > 67 then
        if v_used > 0 then v_parts := v_parts + 1; end if;
        v_parts := v_parts + ceil(v_cluster::numeric / 34)::int - 1;
        v_used := 67;
      elsif v_used + v_cluster > 67 then
        v_parts := v_parts + 1; v_used := v_cluster;
      else
        v_used := v_used + v_cluster;
      end if;
      v_cluster := 0;
    end if;
    v_cluster := v_cluster + case when cp > 65535 then 2 else 1 end;
  end loop;
  if v_cluster > 67 then
    if v_used > 0 then v_parts := v_parts + 1; end if;
    v_parts := v_parts + ceil(v_cluster::numeric / 34)::int - 1;
  elsif v_used + v_cluster > 67 then
    v_parts := v_parts + 1;
  end if;
  return v_parts;
end $$;

notify pgrst, 'reload schema';
commit;
