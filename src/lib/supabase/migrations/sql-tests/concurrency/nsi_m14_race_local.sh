#!/usr/bin/env bash
# NSI M14 race proofs (SKELETON). LOCAL DISPOSABLE CONTAINERS ONLY (name must start with nsi-i2- or supabase_db_nsi).
# Test code only: contains no migration SQL. Plan: docs/student-intake/NSI_M14_Test_Plan.md.
#   R1  erase vs a hold committed after the erase transaction began (P2-A)
#   R2  purge DELETE racing a hold commit (calling-statement snapshot)
#   R3..R6  stubs until the M14 migration exists (isolation level, starvation, strengthened C7, discriminating P04 pair)
# usage: nsi_m14_race_local.sh <container> <bug|fixed>
#   bug    run on an M13 database: each scenario must REPRODUCE the defect (proves the test discriminates)
#   fixed  run on an M14 database: each scenario must show the defect is gone
# Committed fixtures cannot be removed by application roles: DISCARD THE CONTAINER AFTERWARDS.
set -u
DB="${1:?container}"; EXPECT="${2:?bug|fixed}"
case "$DB" in nsi-i2-*|supabase_db_nsi*) ;; *) echo "refused: container must be a disposable local stack"; exit 2;; esac
case "$EXPECT" in bug|fixed) ;; *) echo "EXPECT must be bug or fixed"; exit 2;; esac
export MSYS_NO_PATHCONV=1
q() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
trap '[ -n "${ORIG:-}" ] && printf "%s\n" "$ORIG" | docker exec -i "$DB" psql -U postgres -d postgres -X -q >/dev/null 2>&1' EXIT
S=a5700000-0000-0000-0000-00000000000a; U=a5700000-0000-0000-0000-000000000101; PA=a5700000-0000-0000-0000-000000000401
T=a5700000-0000-0000-0000-000000000701; V=a5700000-0000-0000-0000-000000000702
OPEN="create or replace function public.intake_platform_policy() returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int, post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int, audit_security_days int, hold_record_days_after_release int, approved_basis_ref text) language sql stable set search_path = pg_catalog, pg_temp as \$\$ select 999, 90, 180, 90, 365, 3650, 365, 730, 1825, 365, 'TEST ONLY'::text \$\$"
ORIG=$(q "select pg_get_functiondef('public.intake_platform_policy()'::regprocedure);")
q "$OPEN" >/dev/null
q "insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values ('$U', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm14-owner@nsi.invalid', now(), now()), ('$PA', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm14-padmin@nsi.invalid', now(), now()) on conflict do nothing;
   insert into public.profiles (id) values ('$U') on conflict do nothing;
   insert into public.profiles (id, platform_role) values ('$PA', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';
   insert into public.studios (id, name, slug) values ('$S', 'NSI M14 races', 'nsi-m14-races') on conflict do nothing;
   insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$U', '$S', 'studio_owner', true) on conflict do nothing;
   insert into public.intake_templates (id, studio_id, name) values ('$T', '$S', 'C') on conflict do nothing;
   insert into public.intake_template_versions (id, studio_id, template_id, version_number, status, schema, schema_sha256, max_answer_bytes, published_at)
     values ('$V', '$S', '$T', 1, 'published', '{\"sections\":[]}'::jsonb, 'x', 10, now()) on conflict do nothing;
   insert into public.intake_settings (studio_id, enabled, enabled_at, default_template_id) values ('$S', true, now() - interval '1 day', '$T')
     on conflict (studio_id) do update set enabled = true, enabled_at = now() - interval '1 day', default_template_id = '$T';
   insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at) values ('$S', 'live_collection', 'm14 race harness', '$U', now() + interval '30 days');
   insert into public.intake_service_assignments (studio_id, appointment_type, template_id) values ('$S', 'private_lesson', null) on conflict do nothing;" >/dev/null
hexhash() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
as_staff() { # user sql
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role authenticated; set request.jwt.claims = '{\"sub\":\"$1\",\"role\":\"authenticated\"}'; $2" 2>&1; }
# fresh client with one appointment, a request, an issued invitation and one session; returns "client|request|invitation|sessiontoken"
seed_client() { # index
  local C A R I tok
  C=$(printf 'a5700000-0000-0000-0001-%012d' "$1"); A=$(printf 'a5700000-0000-0000-0002-%012d' "$1"); I=$(printf 'a5700000-0000-0000-0003-%012d' "$1"); tok="m14-$1"
  q "insert into public.clients (id, studio_id, first_name, last_name) values ('$C', '$S', 'C', '$1') on conflict do nothing;
     insert into public.appointments (id, studio_id, client_id, appointment_type, status, starts_at, ends_at, created_at)
     values ('$A', '$S', '$C', 'private_lesson', 'scheduled', now() + interval '5 days', now() + interval '5 days 1 hour', now() - interval '1 hour') on conflict do nothing;" >/dev/null
  R=$(docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_ensure_request('$S', '$C', '$A');" 2>&1 | grep -E '^[0-9a-f-]{36}$' | head -1)
  as_staff "$U" "select public.intake_issue_invitation('$S', '$R', '$I', 1, 'kid00001', decode('$(printf 'ab%.0s' $(seq 1 16))', 'hex'), decode('$(hexhash "$tok")', 'hex'), now() + interval '7 days');" >/dev/null
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select session_id from public.intake_exchange_invitation(decode('$(hexhash "$tok")', 'hex'), decode('$(hexhash "sess-$tok")', 'hex'), 1800, 14400);" >/dev/null 2>&1
  echo "$C|$R|$I|$tok"
}
fail=0
note() { echo "$*"; }
verdict() { # label bug_condition(0/1 = defect reproduced)
  local label="$1" defect="$2"
  if [ "$EXPECT" = "bug" ]; then
    if [ "$defect" = "1" ]; then note "$label: defect reproduced on this database (expected for EXPECT=bug)"; else fail=$((fail+1)); note "$label: FAIL the defect did NOT reproduce (the test does not discriminate, or this is not an M13 database)"; fi
  else
    if [ "$defect" = "0" ]; then note "$label: defect absent (expected for EXPECT=fixed)"; else fail=$((fail+1)); note "$label: FAIL the defect is still present"; fi
  fi
}

# ---- R1: erase vs a hold committed after the erase transaction began
P=$(seed_client 1); C1=${P%%|*}; REST=${P#*|}; R1=${REST%%|*}
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select now(); select pg_sleep(7); set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$PA\",\"role\":\"authenticated\"}'; select public.intake_erase_client('$S', '$C1', 'data_subject_request')::text; commit;" > /tmp/m14_r1_erase.out 2>&1 ) &
sleep 2
as_staff "$PA" "select public.intake_create_legal_hold('$S', 'client', '$C1', 'm14 race', 'm14 race', now() + interval '30 days');" > /tmp/m14_r1_hold.out 2>&1
wait
left=$(q "select count(*) from public.intake_requests where client_id = '$C1';")
erased=0; [ "$left" = "0" ] && erased=1
note "R1 held client rows left=$left (hold: $(tail -1 /tmp/m14_r1_hold.out | cut -c1-40))"
verdict "R1 erase vs just-committed hold" "$erased"

# ---- R2: purge DELETE racing a hold commit
P=$(seed_client 2); C2=${P%%|*}; REST=${P#*|}; R2=${REST%%|*}
docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; set local session_replication_role = replica; update public.intake_sessions set absolute_expires_at = now() - interval '2 days', idle_expires_at = now() - interval '2 days', created_at = now() - interval '3 days' where request_id = '$R2'; commit;" >/dev/null 2>&1
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select id from public.intake_sessions where request_id = '$R2' for update; select pg_sleep(8); commit;" > /tmp/m14_r2_block.out 2>&1 ) &
sleep 2
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_purge_expired(500)::text;" > /tmp/m14_r2_purge.out 2>&1 ) &
sleep 2
as_staff "$PA" "select public.intake_create_legal_hold('$S', 'client', '$C2', 'm14 race 2', 'm14 race 2', now() + interval '30 days');" > /tmp/m14_r2_hold.out 2>&1
wait
gone=$(q "select count(*) from public.intake_sessions where request_id = '$R2';")
deleted=0; [ "$gone" = "0" ] && deleted=1
note "R2 purge output: $(tail -1 /tmp/m14_r2_purge.out | cut -c1-120); sessions left=$gone"
verdict "R2 purge DELETE vs a hold committed during the statement" "$deleted"

# ---- R3..R6: stubs until the M14 migration exists
note "R3 isolation level: STUB (needs the M14 guard)"
note "R4 starvation by held clients: STUB (needs the M14 candidate pre-filter)"
note "R5 strengthened C7 (call succeeded, clients_locked < clients_candidate): STUB"
note "R6 P04 discriminating pair (different non-null actors): STUB"

printf '%s\n' "$ORIG" | docker exec -i "$DB" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 >/dev/null 2>&1; ORIG=""
echo "SUMMARY m14 races ($EXPECT): failures=$fail"
[ "$fail" = "0" ]
