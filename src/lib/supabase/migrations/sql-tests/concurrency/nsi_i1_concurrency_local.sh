#!/usr/bin/env bash
# NSI I1 -- concurrency harness (P1-5 / F3). LOCAL DISPOSABLE STACKS ONLY (container name supabase_db_nsi*).
# Commits synthetic fixtures and temporarily replaces public.intake_platform_policy() with test values to open Gate A;
# re-applies M1 at the end to restore the shipped (dark) policy. Never run against shared DEV or PROD.
#   C1  N rounds of two simultaneous intake_ensure_request calls for the same client -> exactly one open request
#   C2  N rounds of simultaneous student and guardian submits on the same request -> exactly one completion, no deadlock
set -u
DB="${1:?container}"; M="${2:?migrations dir}"; N="${3:-10}"
case "$DB" in supabase_db_nsi*) ;; *) echo "refused: container must be a disposable local stack named supabase_db_nsi*"; exit 2;; esac
export MSYS_NO_PATHCONV=1
q() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
S=a5400000-0000-0000-0000-00000000000a; T=a5400000-0000-0000-0000-000000000701; V=a5400000-0000-0000-0000-000000000702
G=a5400000-0000-0000-0000-000000000301   # synthetic guardian account (local stack only), linked to every round's client
q "create or replace function public.intake_platform_policy()
returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int,
  post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int,
  audit_security_days int, hold_record_days_after_release int, approved_basis_ref text)
language sql stable set search_path = pg_catalog, pg_temp
as \$\$ select 999, 90, 180, 90, 365, 3650, 365, 730, 1825, 365, 'TEST ONLY'::text \$\$;" >/dev/null
SCHEMA='{"sections":[{"key":"s","title":"S","audience":"student","fields":[{"key":"a","type":"short_text","label":"A","required":true,"visibility":"staff_only","subject_scope":"about_student"}]},{"key":"g","title":"G","audience":"guardian","fields":[{"key":"b","type":"acknowledgment","label":"B","required":true,"visibility":"staff_only","subject_scope":"consent"}]}]}'
q "insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
     values ('$G', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nsi-conc-guardian@nsi-test.invalid', now(), now()) on conflict do nothing;
   insert into public.studios (id, name, slug) values ('$S', 'NSI concurrency', 'nsi-concurrency-a54') on conflict do nothing;
   insert into public.intake_templates (id, studio_id, name) values ('$T', '$S', 'C') on conflict do nothing;
   insert into public.intake_template_versions (id, studio_id, template_id, version_number, status, schema, schema_sha256, max_answer_bytes, published_at)
     values ('$V', '$S', '$T', 1, 'published', '$SCHEMA'::jsonb, 'x', intake_private.schema_max_answer_bytes('$SCHEMA'::jsonb), now()) on conflict do nothing;
   insert into public.intake_settings (studio_id, enabled, default_template_id) values ('$S', true, '$T') on conflict (studio_id) do update set enabled = true, default_template_id = '$T';" >/dev/null
fail=0; dead=0
# C1
for i in $(seq 1 "$N"); do
  C=$(printf 'a5400000-0000-0000-0001-%012d' "$i"); A=$(printf 'a5400000-0000-0000-0002-%012d' "$i")
  q "insert into public.clients (id, studio_id, first_name, last_name) values ('$C', '$S', 'C', '$i');
     insert into public.appointments (id, studio_id, client_id, appointment_type, status, starts_at, ends_at)
     values ('$A', '$S', '$C', 'private_lesson', 'scheduled', now() + interval '5 days', now() + interval '5 days 1 hour');" >/dev/null
  o1=$(mktemp); o2=$(mktemp)
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_ensure_request('$S', '$C', '$A');" > "$o1" 2>&1 &
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_ensure_request('$S', '$C', '$A');" > "$o2" 2>&1 &
  wait
  grep -q 40P01 "$o1" "$o2" && dead=$((dead+1))
  n=$(q "select count(*) from public.intake_requests where client_id = '$C' and status in ('pending','invited','in_progress','suspended');")
  r1=$(grep -E '^[0-9a-f-]{36}$' "$o1"); r2=$(grep -E '^[0-9a-f-]{36}$' "$o2")
  if [ "$n" != "1" ] || [ -z "$r1" ] || [ "$r1" != "$r2" ]; then fail=$((fail+1)); echo "C1 round $i: open=$n r1=$r1 r2=$r2 :: $(cat "$o1" "$o2" | tr '\n' ' ')"; fi
  rm -f "$o1" "$o2"
done
echo "C1 concurrent ensure_request: $N rounds, failures=$fail, deadlocks=$dead"
c1fail=$fail; fail=0; dead=0
# C2
for i in $(seq 1 "$N"); do
  C=$(printf 'a5400000-0000-0000-0001-%012d' "$i"); L=$(printf 'a5400000-0000-0000-0003-%012d' "$i")
  R=$(q "select id from public.intake_requests where client_id = '$C';")
  q "update public.intake_requests set pinned_version_id = '$V', status = 'invited', issued_at = now() where id = '$R';
     insert into public.intake_minor_determinations (studio_id, request_id, is_minor, source, evaluated_on, threshold) values ('$S', '$R', true, 'declared', current_date, 18);
     insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, initiated_by)
     values ('$L', '$S', '$C', '$G', 'linked', 'guardian', 'studio');" >/dev/null
  q "set role service_role; select public.intake_save_draft('$S', '$R', 'student', '{\"display_name\":\"S\"}'::jsonb, '{\"a\":\"x\"}'::jsonb, 0);" >/dev/null
  q "set role service_role; select public.intake_save_draft('$S', '$R', 'guardian', '{\"display_name\":\"G\",\"declared_relationship\":\"parent\",\"source_link_id\":\"$L\"}'::jsonb, '{\"b\":true}'::jsonb, 0);" >/dev/null
  o1=$(mktemp); o2=$(mktemp)
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_submit_response('$S', '$R', 'student', 1);" > "$o1" 2>&1 &
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_submit_response('$S', '$R', 'guardian', 1, '{\"consent_text\":\"synthetic\"}'::jsonb);" > "$o2" 2>&1 &
  wait
  grep -q 40P01 "$o1" "$o2" && dead=$((dead+1))
  n=$(q "select count(*) from public.intake_completions where request_id = '$R';")
  st=$(q "select status from public.intake_requests where id = '$R';")
  if [ "$n" != "1" ] || [ "$st" != "submitted" ] || grep -q ERROR "$o1" "$o2"; then fail=$((fail+1)); echo "C2 round $i: completions=$n status=$st :: $(cat "$o1" "$o2" | tr '\n' ' ')"; fi
  rm -f "$o1" "$o2"
done
echo "C2 concurrent student/guardian submit: $N rounds, failures=$fail, deadlocks=$dead"
c2fail=$fail
# restore the shipped (dark) policy
docker exec -i "$DB" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f - < "$M/20261118090000_nsi_i1_m1_config_helpers.sql" >/dev/null 2>&1
gate=$(q "select intake_private.retention_gate_open();")
cat=$(q "select intake_private.assert_catalog();")
svc=$(q "select has_function_privilege('service_role', 'public.intake_submit_response(uuid,uuid,text,int,jsonb)', 'EXECUTE');")
echo "after M1 re-apply: gate_open=$gate catalog=[${cat:-ok}] service_role_submit=$svc"
echo "SUMMARY concurrency: C1 failures=$c1fail, C2 failures=$c2fail"
[ "$c1fail" = "0" ] && [ "$c2fail" = "0" ] && [ "$gate" = "f" ] && [ -z "$cat" ] && [ "$svc" = "t" ]
