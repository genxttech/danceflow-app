-- READ-ONLY evidence for the Gate 2 prerequisites ("web readers live" and "a view-reading Student build is live and seen").
-- Run with: bash C:/Users/mcurt/danceflow-ops/sb.sh prod-read <this file>   (one jsonb row). Writes nothing, takes no locks beyond catalog reads.
-- pg_stat_statements is cumulative since stats_reset; record this output BEFORE the web deploy (baseline) and compare after. PostgREST statements
-- quote identifiers ("public"."my_event_registrations"), so the filters below match application reads and not hand-run SQL with unquoted names.
select jsonb_build_object(
  'stats_reset', (select stats_reset from pg_stat_statements_info),
  'view_reads', (select jsonb_build_object('statements', count(*), 'calls', coalesce(sum(calls), 0), 'rows', coalesce(sum(rows), 0))
                 from pg_stat_statements where query like '%"public"."my_event_registrations"%' or query like '%"public"."my_event_registration_attendees"%'),
  'base_reads', (select jsonb_build_object('statements', count(*), 'calls', coalesce(sum(calls), 0))
                 from pg_stat_statements where query like '%"public"."event_registrations"%' or query like '%"public"."event_registration_attendees"%'),
  'function_calls_tracked', current_setting('track_functions', true),  -- 'none' on PROD: per-call counts of the claim RPC are not available
  'dancer_self_policies', (select coalesce(jsonb_agg(tablename || '.' || policyname order by tablename, policyname), '[]'::jsonb) from pg_policies
                           where schemaname = 'public' and policyname in ('event_registrations_self_select', 'event_registration_attendees_self_select', 'event_registration_attendees_self_insert')),
  'claim_function_authenticated_exec', (select has_function_privilege('authenticated', to_regprocedure('public.claim_my_event_registrations()'), 'execute'))
) as gate2_prereq_evidence;
