create temp table if not exists c as select (x->>'b') b, (x->>'e')::int e from jsonb_array_elements(pg_read_file('/w/corpus_all.json')::jsonb) x;
select count(*) n_total, count(*) filter (where public._tw4us_segments(b) <> e) n_mismatch, count(*) filter (where public._tw4us_segments(b) < e) n_under, count(*) filter (where public._tw4us_segments(b) > e) n_over from c;
