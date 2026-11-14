-- Parity cases for public._tw4us_segments (migration 20270217090000); the same cases, in the same order, as
-- src/lib/sms/__tests__/fixtures/ucs2SegmentCases.json run by segments.test.ts against src/lib/sms/segments.ts.
-- Run on a disposable database only (it creates nothing, but it is a QA script): psql -v ON_ERROR_STOP=1 -f <this file>
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
    ('more than ten parts reports eleven', repeat(chr(128512),400), 11)
  ) v(name, body, expected) loop
    if public._tw4us_segments(r.body) is distinct from r.expected then
      raise exception 'segments mismatch (%): expected %, got %', r.name, r.expected, public._tw4us_segments(r.body);
    end if;
  end loop;
  raise notice 'ucs2 segment parity: all cases passed';
end $$;
