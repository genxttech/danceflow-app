-- TW-4F 20270217090000 smoke (read-only; calls only the pure function public._tw4us_segments). Run through sb.sh dev-read | prod-read.
-- Before 20270217: ucs2_emoji = 2 (undercount), gsm_extension = 3 (overcount). After: 3 and 2. plain_160 = 1 and ucs2_70 = 1 either way.
select public._tw4us_segments(repeat('a', 66) || U&'\+01F600' || repeat('a', 66)) as ucs2_emoji,
       public._tw4us_segments(repeat('a', 303) || U&'\20AC') as gsm_extension,
       public._tw4us_segments(repeat('a', 160)) as plain_160,
       public._tw4us_segments(repeat(U&'\00E9\4E2D', 35)) as ucs2_70;
