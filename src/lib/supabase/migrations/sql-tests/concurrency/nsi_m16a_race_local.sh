#!/usr/bin/env bash
# NSI M16a race and lock-order proofs. LOCAL DISPOSABLE CONTAINERS ONLY (name must start with nsi-i2- or supabase_db_nsi).
#   A1 attest takes the client lock before writing; B1 erase vs attest (request re-read after the lock, erasure_barrier)
#   C1 two concurrent attestations write one row; E1 isolation guard (entry check)
# usage: nsi_m16a_race_local.sh <container> [run-offset]   (MUST run on an M16a database; committed fixtures: discard the container afterwards)
set -u
DB="${1:?container}"; EXPECT=fixed; OFF="${2:-0}"
case "$DB" in nsi-i2-*|supabase_db_nsi*) ;; *) echo "refused: container must be a disposable local stack"; exit 2;; esac
case "$EXPECT" in bug|fixed) ;; *) echo "EXPECT must be bug or fixed"; exit 2;; esac
export MSYS_NO_PATHCONV=1
TD="${TMPDIR:-/tmp}"
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
     on conflict (studio_id) do update set enabled = true, enabled_at = now() - interval '1 day', default_template_id = '$T';" >/dev/null
q "insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at) select '$S', 'live_collection', 'm14 race harness', '$U', now() + interval '30 days' where not exists (select 1 from public.intake_feature_grants where studio_id = '$S' and capability = 'live_collection' and revoked_at is null);
   insert into public.intake_service_assignments (studio_id, appointment_type, template_id) values ('$S', 'private_lesson', null) on conflict do nothing;" >/dev/null
hexhash() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
as_staff() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role authenticated; set request.jwt.claims = '{\"sub\":\"$1\",\"role\":\"authenticated\"}'; $2" 2>&1; }
seed_client() { # index -> "client|request|invitation|token"
  local n=$(($1 + OFF)) C A R I tok
  C=$(printf 'a5700000-0000-0000-0001-%012d' "$n"); A=$(printf 'a5700000-0000-0000-0002-%012d' "$n"); I=$(printf 'a5700000-0000-0000-0003-%012d' "$n"); tok="m14-$n"
  q "insert into public.clients (id, studio_id, first_name, last_name) values ('$C', '$S', 'C', '$n') on conflict do nothing;
     insert into public.appointments (id, studio_id, client_id, appointment_type, status, starts_at, ends_at, created_at)
     values ('$A', '$S', '$C', 'private_lesson', 'scheduled', now() + interval '5 days', now() + interval '5 days 1 hour', now() - interval '1 hour') on conflict do nothing;" >/dev/null
  R=$(docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_ensure_request('$S', '$C', '$A');" 2>&1 | grep -E '^[0-9a-f-]{36}$' | head -1)
  as_staff "$U" "select public.intake_issue_invitation('$S', '$R', '$I', 1, 'kid00001', decode('$(printf 'ab%.0s' $(seq 1 16))', 'hex'), decode('$(hexhash "$tok")', 'hex'), now() + interval '7 days');" >/dev/null
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select session_id from public.intake_exchange_invitation(decode('$(hexhash "$tok")', 'hex'), decode('$(hexhash "sess-$tok")', 'hex'), 1800, 14400);" >/dev/null 2>&1
  echo "$C|$R|$I|$tok"
}
backdate() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; set local session_replication_role = replica; update public.intake_sessions set absolute_expires_at = now() - interval '2 days', idle_expires_at = now() - interval '2 days', created_at = now() - interval '3 days' where request_id = '$1'; commit;" >/dev/null 2>&1; }
fail=0
note() { echo "$*"; }
verdict() { # label defect(1 = the defect is visible)
  local label="$1" defect="$2"
  if [ "$EXPECT" = "bug" ]; then
    if [ "$defect" = "1" ]; then note "$label: defect reproduced on this database (expected for EXPECT=bug)"; else fail=$((fail+1)); note "$label: FAIL the defect did NOT reproduce (the test does not discriminate, or this is not an M13 database)"; fi
  else
    if [ "$defect" = "0" ]; then note "$label: defect absent (expected for EXPECT=fixed)"; else fail=$((fail+1)); note "$label: FAIL the defect is still present"; fi
  fi
}
must() { # label ok(1/0): a scenario that must pass in BOTH modes
  if [ "$2" = "1" ]; then note "$1: ok"; else fail=$((fail+1)); note "$1: FAIL"; fi
}

# ---- helpers for the M16a scenarios
lockkey() { echo "hashtextextended('intake:client:$S:$1', 0)"; }
holder() { # client seconds : hold the client lock in a background session
  ( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select pg_advisory_xact_lock($(lockkey "$1")); select pg_sleep($2); commit;" > /dev/null 2>&1 ) &
}
last() { tail -1 "$1" | tr -d '\r'; }
advwait() { q "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory';"; }
mkguardian() { # request id -> guardian respondent id (declared_unverified)
  local G; G=$(printf 'a5700000-0000-0000-0004-%012d' "$(( ${2} + OFF ))")
  q "insert into public.intake_respondents (id, studio_id, request_id, client_id, role, display_name, declared_relationship, assurance) select '$G', studio_id, id, client_id, 'guardian', 'Synthetic G', 'parent', 'declared_unverified' from public.intake_requests where id = '$1' on conflict do nothing;" >/dev/null
  echo "$G"
}
attsql() { echo "select public.intake_attest_guardian('$S', '$1', '$2', 'in_person', 'parent', 'm16a race');"; }
assurance() { q "select assurance from public.intake_respondents where id = '$1';"; }
natt() { q "select count(*) from public.intake_guardian_attestations where respondent_id = '$1';"; }

# ---- A1: attest takes the client lock before it writes
P=$(seed_client 11); C=${P%%|*}; REST=${P#*|}; R=${REST%%|*}; G=$(mkguardian "$R" 11)
holder "$C" 7; sleep 1; t0=$(date +%s)
( as_staff "$U" "$(attsql "$R" "$G")" > $TD/m16a_a1.out 2>&1 ) &
sleep 2; w=$(advwait); wait; t1=$(date +%s)
ok=0; [ "$w" -ge 1 ] && [ "$(last $TD/m16a_a1.out)" = "attested" ] && [ "$(natt "$G")" = "1" ] && [ "$(assurance "$G")" = "staff_attested" ] && [ $((t1 - t0)) -ge 4 ] && ok=1
note "A1 attest: waiting=$w result=$(last $TD/m16a_a1.out) rows=$(natt "$G") assurance=$(assurance "$G") elapsed=$((t1 - t0))s"
must "A1 attest takes the client lock before it writes (waits for the holder, then attests)" "$ok"

# ---- B1: an erase holds the client lock; attest started meanwhile waits, then sees the request gone and the barrier active
P=$(seed_client 12); C=${P%%|*}; REST=${P#*|}; R=${REST%%|*}; G=$(mkguardian "$R" 12)
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$PA\",\"role\":\"authenticated\"}'; select public.intake_erase_client('$S', '$C', 'data_subject_request')::text; reset role; select pg_sleep(7); commit;" > $TD/m16a_b1_erase.out 2>&1 ) &
sleep 2
( as_staff "$U" "$(attsql "$R" "$G")" > $TD/m16a_b1.out 2>&1 ) &
sleep 2; w=$(advwait); wait
left=$(q "select count(*) from public.intake_requests where id = '$R';")
ok=0; [ "$w" -ge 1 ] && [ "$(last $TD/m16a_b1.out)" = "erasure_barrier" ] && [ "$left" = "0" ] && [ "$(natt "$G")" = "0" ] && ok=1
note "B1 erase first: waiting=$w result=$(last $TD/m16a_b1.out) requests left=$left attestations=$(natt "$G")"
must "B1 attest waits for the erase, re-reads, sees the request gone and returns erasure_barrier without writing" "$ok"

# ---- C1: two concurrent attestations of one respondent write exactly one row
P=$(seed_client 13); C=${P%%|*}; REST=${P#*|}; R=${REST%%|*}; G=$(mkguardian "$R" 13)
( as_staff "$U" "$(attsql "$R" "$G")" > $TD/m16a_c1a.out 2>&1 ) &
( as_staff "$U" "$(attsql "$R" "$G")" > $TD/m16a_c1b.out 2>&1 ) &
wait
ra=$(last $TD/m16a_c1a.out); rb=$(last $TD/m16a_c1b.out)
ok=0; if [ "$(natt "$G")" = "1" ]; then if { [ "$ra" = "attested" ] && [ "$rb" = "already_done" ]; } || { [ "$rb" = "attested" ] && [ "$ra" = "already_done" ]; }; then ok=1; fi; fi
note "C1 two concurrent attestations: $ra / $rb rows=$(natt "$G")"
must "C1 two concurrent attestations leave exactly one row (one attested, one already_done)" "$ok"

# ---- E1: isolation guard (entry check, so it also holds on the early-return paths)
P=$(seed_client 14); C=${P%%|*}; REST=${P#*|}; R=${REST%%|*}; G=$(mkguardian "$R" 14)
rr() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin isolation level $1; select 1; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$U\",\"role\":\"authenticated\"}'; $2 rollback;" 2>&1 | tr '\n' ' '; }
e1=$(rr "repeatable read" "$(attsql "$R" "$G")")
e2=$(rr "read uncommitted" "$(attsql "$R" "$G")")
e3=$(rr "repeatable read" "select public.intake_attest_guardian('$S', gen_random_uuid(), gen_random_uuid(), 'in_person', 'parent', 'x');")
ok=0; echo "$e1" | grep -q "READ COMMITTED" && echo "$e2" | grep -q "READ COMMITTED" && echo "$e3" | grep -q "READ COMMITTED" && [ "$(natt "$G")" = "0" ] && ok=1
note "E1 attest under RR: $(echo "$e1" | cut -c1-90)"
note "E1 attest (unknown request) under RR: $(echo "$e3" | cut -c1-90)"
must "E1 attest refuses REPEATABLE READ and READ UNCOMMITTED (55000), including on the unknown-request path" "$ok"

printf '%s\n' "$ORIG" | docker exec -i "$DB" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 >/dev/null 2>&1; ORIG=""
echo "SUMMARY m16a races: failures=$fail"
[ "$fail" = "0" ]
