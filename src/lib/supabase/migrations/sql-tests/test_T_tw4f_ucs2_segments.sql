-- Parity cases (UCS-2 clusters and GSM-7) for public._tw4us_segments (migration 20270217090000): the same cases, in the same order, as
-- src/lib/sms/__tests__/fixtures/ucs2SegmentCases.json, which segments.test.ts runs against src/lib/sms/segments.ts and against a Twilio-calculator reference;
-- segments.test.ts also fails if this list drifts from the fixture. Run on a disposable database only (it creates nothing): psql -v ON_ERROR_STOP=1 -f <this file>
do $$
declare r record;
begin
  for r in select * from (values
    ('66 a + emoji + 66 a: the pair cannot split, three parts', repeat('a',66) || repeat(chr(128512),1) || repeat('a',66), 3),
    ('emoji + 131 a (133 units) still fits two parts', repeat(chr(128512),1) || repeat('a',131), 2),
    ('emoji at the start: 71 units', repeat(chr(128512),1) || repeat('a',69), 2),
    ('emoji in the middle: 66 a + emoji + 65 a', repeat('a',66) || repeat(chr(128512),1) || repeat('a',65), 2),
    ('emoji at the end: 69 a + emoji', repeat('a',69) || repeat(chr(128512),1), 2),
    ('emoji at the end, still one part: 68 a + emoji = 70 units', repeat('a',68) || repeat(chr(128512),1), 1),
    ('35 emoji = 70 units, one part', repeat(chr(128512),35), 1),
    ('36 emoji = 72 units, two parts', repeat(chr(128512),36), 2),
    ('66 emoji = 132 units, 33 per part, two parts', repeat(chr(128512),66), 2),
    ('67 emoji = 134 units, three parts', repeat(chr(128512),67), 3),
    ('BMP non-GSM, exactly 70 units', repeat('a',69) || repeat(chr(10003),1), 1),
    ('BMP non-GSM, 71 units', repeat('a',70) || repeat(chr(10003),1), 2),
    ('BMP non-GSM, 134 units = 2 x 67', repeat('a',133) || repeat(chr(10003),1), 2),
    ('BMP non-GSM, 135 units', repeat('a',134) || repeat(chr(10003),1), 3),
    ('BMP non-GSM then emoji, 66 a + check + 66 a + emoji', repeat('a',66) || repeat(chr(10003),1) || repeat('a',66) || repeat(chr(128512),1), 3),
    ('ZWJ family (8 units) + 62 a = 70 units, one part', repeat(chr(128104),1) || repeat(chr(8205),1) || repeat(chr(128105),1) || repeat(chr(8205),1) || repeat(chr(128103),1) || repeat('a',62), 1),
    ('ZWJ family after 63 a = 71 units: the cluster moves whole to part two', repeat('a',63) || repeat(chr(128104),1) || repeat(chr(8205),1) || repeat(chr(128105),1) || repeat(chr(8205),1) || repeat(chr(128103),1), 2),
    ('60 a + family + 60 a: 128 units but the cluster costs a part, three parts', repeat('a',60) || repeat(chr(128104),1) || repeat(chr(8205),1) || repeat(chr(128105),1) || repeat(chr(8205),1) || repeat(chr(128103),1) || repeat('a',60), 3),
    ('flag (two regional indicators, 4 units) after 66 a + b', repeat('a',66) || repeat(chr(127482),1) || repeat(chr(127480),1) || repeat('b',1), 2),
    ('keycap 1 + VS16 + keycap (3 units) after 68 a', repeat('a',68) || repeat(chr(49),1) || repeat(chr(65039),1) || repeat(chr(8419),1), 2),
    ('skin-tone thumbs up (4 units) after 67 a', repeat('a',67) || repeat(chr(128077),1) || repeat(chr(127997),1), 2),
    ('400 emoji: 33 per part (66 units), exact count 13 (callers refuse more than 10)', repeat(chr(128512),400), 13),
    ('GSM-7 with a backslash stays GSM-7: 100 a + backslash is one part', repeat('a',100) || repeat(chr(92),1), 1),
    ('GSM-7 with a backslash: 160 a + backslash = 162 septets, two parts', repeat('a',160) || repeat(chr(92),1), 2),
    ('GSM-7 extension characters count two septets: 151 a + 5 braces = 161 septets, two parts', repeat('a',151) || repeat(chr(123),5), 2),
    ('combining acute (e + U+0301, 2 units) after 66 a, then 66 a: the cluster cannot split, three parts', repeat('a',66) || repeat('e',1) || repeat(chr(769),1) || repeat('a',66), 3),
    ('red heart + VS16 (2 BMP units) after 66 a, then 66 a: three parts', repeat('a',66) || repeat(chr(10084),1) || repeat(chr(65039),1) || repeat('a',66), 3),
    ('Scotland tag flag (14 units) after 60 a: 74 units, two parts', repeat('a',60) || repeat(chr(127988),1) || repeat(chr(917607),1) || repeat(chr(917602),1) || repeat(chr(917619),1) || repeat(chr(917603),1) || repeat(chr(917620),1) || repeat(chr(917631),1), 2),
    ('three regional indicators after 64 a: the flag pair stays whole, the third starts its own cluster', repeat('a',64) || repeat(chr(127482),1) || repeat(chr(127480),1) || repeat(chr(127482),1) || repeat('a',1), 2),
    ('Hangul syllables are whole characters: 80 units, two parts', repeat(chr(50504),40) || repeat(chr(45397),40), 2),
    ('Devanagari letters are whole characters: 100 x U+0915 = 100 units, two parts', repeat(chr(2325),100), 2),
    ('unspaced complex-script run (100 x U+0995 Bengali) is one coarse cluster, sized at 34 per part: three parts (Twilio sends two; never fewer)', repeat(chr(2453),100), 3),
    ('GSM-7: 303 a + euro = 305 septets, two parts (an extension character only ends a part early where it would split)', repeat('a',303) || repeat(chr(8364),1), 2),
    ('GSM-7: 152 a + euro + 152 a = 306 septets: the euro cannot split at 152, three parts', repeat('a',152) || repeat(chr(8364),1) || repeat('a',152), 3),
    ('GSM-7: 153 a + euro + 151 a = 306 septets, two parts', repeat('a',153) || repeat(chr(8364),1) || repeat('a',151), 2),
    ('GSM-7: CR LF stay GSM-7, 159 a + CR LF = 161 septets, two parts', repeat('a',159) || repeat(chr(13),1) || repeat(chr(10),1), 2)
  ) v(name, body, expected) loop
    if public._tw4us_segments(r.body) is distinct from r.expected then
      raise exception 'segments mismatch (%): expected %, got %', r.name, r.expected, public._tw4us_segments(r.body);
    end if;
  end loop;
  raise notice 'ucs2 segment parity: all cases passed';
end $$;
