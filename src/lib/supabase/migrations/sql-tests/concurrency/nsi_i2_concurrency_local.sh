#!/usr/bin/env bash
# NSI I2 -- concurrency harness for M6 (preview) and the unchanged intake_ensure_request. LOCAL DISPOSABLE CONTAINERS ONLY
# (name must start with nsi-i2- or supabase_db_nsi). Commits synthetic fixtures and temporarily replaces
# public.intake_platform_policy() to open Gate A for section K3; the original definition is restored at the end.
# Committed fixtures cannot be removed by the application roles (delete guards): DISCARD THE CONTAINER AFTERWARDS.
#   K1  N parallel previews of one studio return identical results, no errors, no deadlocks
#   K2  [gate closed] N parallel ensure_request calls are all refused and create zero rows
#   K3  [gate opened in test] rounds of two simultaneous ensure_request calls (+ a preview) -> exactly one open request,
#       same id returned, and the preview afterwards predicts already_attached
set -u
trap '[ -n "${ORIG:-}" ] && printf "%s
" "$ORIG" | docker exec -i "$DB" psql -U postgres -d postgres -X -q >/dev/null 2>&1' EXIT
DB="${1:?container}"; N="${2:-8}"
case "$DB" in nsi-i2-*|supabase_db_nsi*) ;; *) echo "refused: container must be a disposable local stack"; exit 2;; esac
export MSYS_NO_PATHCONV=1
q() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
S=a5500000-0000-0000-0000-00000000000a; T=a5500000-0000-0000-0000-000000000701; V=a5500000-0000-0000-0000-000000000702
q "insert into public.studios (id, name, slug) values ('$S', 'NSI I2 concurrency', 'nsi-i2-conc') on conflict do nothing;
   insert into public.intake_templates (id, studio_id, name) values ('$T', '$S', 'C') on conflict do nothing;
   insert into public.intake_template_versions (id, studio_id, template_id, version_number, status, schema, schema_sha256, max_answer_bytes, published_at)
     values ('$V', '$S', '$T', 1, 'published', '{\"sections\":[]}'::jsonb, 'x', 10, now()) on conflict do nothing;
   insert into public.intake_settings (studio_id, enabled, enabled_at, default_template_id) values ('$S', true, now() - interval '1 day', '$T')
     on conflict (studio_id) do update set enabled = true, enabled_at = now() - interval '1 day', default_template_id = '$T';" >/dev/null
q "insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at) values ('$S', 'live_collection', 'concurrency harness', gen_random_uuid(), now() + interval '30 days') on conflict do nothing;
   insert into public.intake_service_assignments (studio_id, appointment_type, template_id) values ('$S', 'private_lesson', null) on conflict do nothing;" >/dev/null
for i in $(seq 1 "$N"); do
  C=$(printf 'a5500000-0000-0000-0001-%012d' "$i"); A=$(printf 'a5500000-0000-0000-0002-%012d' "$i")
  q "insert into public.clients (id, studio_id, first_name, last_name) values ('$C', '$S', 'C', '$i') on conflict do nothing;
     insert into public.appointments (id, studio_id, client_id, appointment_type, status, starts_at, ends_at, created_at)
     values ('$A', '$S', '$C', 'private_lesson', 'scheduled', now() + interval '5 days', now() + interval '5 days 1 hour', now() - interval '1 hour') on conflict do nothing;" >/dev/null
done
fail=0; dead=0
# K1
tmp=$(mktemp -d)
for i in $(seq 1 "$N"); do
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select appointment_id || ':' || outcome from public.intake_reconcile_preview('$S', 200) order by 1;" > "$tmp/k1_$i" 2>&1 &
done
wait
ref=$(cat "$tmp/k1_1"); rows=$(grep -c ':' "$tmp/k1_1")
for i in $(seq 1 "$N"); do
  grep -q 40P01 "$tmp/k1_$i" && dead=$((dead+1))
  [ "$(cat "$tmp/k1_$i")" = "$ref" ] || { fail=$((fail+1)); echo "K1 session $i differs"; }
done
[ "$rows" -ge "$N" ] || { fail=$((fail+1)); echo "K1 expected >= $N rows, got $rows"; }
echo "K1 parallel previews: sessions=$N rows=$rows failures=$fail deadlocks=$dead"; k1=$fail; fail=0; dead=0
# K2
before=$(q "select (select count(*) from public.intake_requests) + (select count(*) from public.intake_request_appointments) + (select count(*) from public.intake_audit_events);")
for i in $(seq 1 "$N"); do
  C=$(printf 'a5500000-0000-0000-0001-%012d' "$i"); A=$(printf 'a5500000-0000-0000-0002-%012d' "$i")
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_ensure_request('$S', '$C', '$A');" > "$tmp/k2_$i" 2>&1 &
done
wait
for i in $(seq 1 "$N"); do grep -q "retention_policy_incomplete" "$tmp/k2_$i" || { fail=$((fail+1)); echo "K2 session $i not refused: $(cat "$tmp/k2_$i" | tr '\n' ' ')"; }; done
after=$(q "select (select count(*) from public.intake_requests) + (select count(*) from public.intake_request_appointments) + (select count(*) from public.intake_audit_events);")
[ "$before" = "$after" ] || { fail=$((fail+1)); echo "K2 rows changed: $before -> $after"; }
echo "K2 gate-closed parallel ensure_request: sessions=$N failures=$fail rows_before=$before rows_after=$after"; k2=$fail; fail=0
# K3
ORIG=$(q "select pg_get_functiondef('public.intake_platform_policy()'::regprocedure);")
q "create or replace function public.intake_platform_policy()
returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int,
  post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int,
  audit_security_days int, hold_record_days_after_release int, approved_basis_ref text)
language sql stable set search_path = pg_catalog, pg_temp
as \$\$ select 999, 90, 180, 90, 365, 3650, 365, 730, 1825, 365, 'TEST ONLY'::text \$\$;" >/dev/null
for i in $(seq 1 "$N"); do
  C=$(printf 'a5500000-0000-0000-0001-%012d' "$i"); A=$(printf 'a5500000-0000-0000-0002-%012d' "$i")
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_ensure_request('$S', '$C', '$A');" > "$tmp/k3a_$i" 2>&1 &
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_ensure_request('$S', '$C', '$A');" > "$tmp/k3b_$i" 2>&1 &
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select count(*) from public.intake_reconcile_preview('$S', 200);" > "$tmp/k3p_$i" 2>&1 &
  wait
  grep -q 40P01 "$tmp/k3a_$i" "$tmp/k3b_$i" "$tmp/k3p_$i" && dead=$((dead+1))
  n=$(q "select count(*) from public.intake_requests where client_id = '$C' and status in ('pending','invited','in_progress','suspended');")
  r1=$(grep -E '^[0-9a-f-]{36}$' "$tmp/k3a_$i"); r2=$(grep -E '^[0-9a-f-]{36}$' "$tmp/k3b_$i")
  o=$(q "select o_outcome from intake_private.evaluate_appointment_eligibility('$S', '$C', '$A', now());")
  if [ "$n" != "1" ] || [ -z "$r1" ] || [ "$r1" != "$r2" ] || [ "$o" != "already_attached" ] || grep -q ERROR "$tmp/k3p_$i"; then
    fail=$((fail+1)); echo "K3 round $i: open=$n r1=$r1 r2=$r2 eval=$o"; fi
done
# restore the shipped (dark) policy from the captured definition
printf '%s\n' "$ORIG" | docker exec -i "$DB" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 >/dev/null 2>&1
gate=$(q "select intake_private.retention_gate_open();"); cat=$(q "select intake_private.assert_catalog();")
echo "K3 gate-open parallel ensure_request + preview: rounds=$N failures=$fail deadlocks=$dead"
echo "after restore: gate_open=$gate catalog=[${cat:-ok}]"
rm -rf "$tmp"
echo "SUMMARY concurrency: K1 failures=$k1, K2 failures=$k2, K3 failures=$fail"
[ "$k1" = "0" ] && [ "$k2" = "0" ] && [ "$fail" = "0" ] && [ "$dead" = "0" ] && [ "$gate" = "f" ] && [ -z "$cat" ]
