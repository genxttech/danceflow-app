#!/usr/bin/env bash
# NSI M14 race proofs. LOCAL DISPOSABLE CONTAINERS ONLY (name must start with nsi-i2- or supabase_db_nsi).
# Test code only. Plan: docs/student-intake/NSI_M14_Test_Plan.md; spec: NSI_M14_Hold_Semantics_Spec.md (revision 2).
#   R1   erase transaction started before a hold committed: the held client's rows must survive            (P2-A, erase)
#   R2-P2A a PURGE transaction that began before a hold committed (same root cause as R1)
#   R2a  the purge holds L1 (blocked on a row lock): the RPC hold creator WAITS on the advisory lock, the purge deletes, the hold exists afterwards (correct in both modes)
#   R2b  a hold inserted DIRECTLY bypassing the lock, committed while the purge DELETE waited: the guard refuses, the row remains (correct in both modes)
#   R2c  the delete guard locks before it checks; R2d every direct hold insert takes the client lock
#   R3   isolation level: lock_client, hold creation, erase and purge under REPEATABLE READ raise 55000
#   R4/R5/R6 live in the M14 suite (starvation T07), the concurrency harness (C7 strengthened) and the M13 suite (P04 pair)
# usage: nsi_m14_race_local.sh <container> <bug|fixed> [run-offset]
#   bug    run on an M13 database: R1, R2, R2b, R3 must REPRODUCE the defect (proves the tests discriminate); R2a must pass (L1 existed in M13)
#   fixed  run on an M14 database: every scenario must show the defect gone
# Committed fixtures cannot be removed by application roles: DISCARD THE CONTAINER AFTERWARDS. Use a different run-offset per run on one container.
set -u
DB="${1:?container}"; EXPECT="${2:?bug|fixed}"; OFF="${3:-0}"
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

# ---- R1: erase vs a hold committed after the erase transaction began
P=$(seed_client 1); C1=${P%%|*}
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select now(); select pg_sleep(7); set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$PA\",\"role\":\"authenticated\"}'; select public.intake_erase_client('$S', '$C1', 'data_subject_request')::text; commit;" > $TD/m14_r1_erase.out 2>&1 ) &
sleep 2
as_staff "$PA" "select public.intake_create_legal_hold('$S', 'client', '$C1', 'm14 race', 'm14 race', now() + interval '30 days');" > $TD/m14_r1_hold.out 2>&1
wait
left=$(q "select count(*) from public.intake_requests where client_id = '$C1';")
erased=0; [ "$left" = "0" ] && erased=1
note "R1 held client rows left=$left"
verdict "R1 erase vs a hold committed after the erase transaction began" "$erased"

# ---- R2-P2A: a PURGE transaction that began before a hold committed (same root cause as R1: the hold is wrongly "not yet effective")
P=$(seed_client 2); C2=${P%%|*}; REST=${P#*|}; R2=${REST%%|*}
backdate "$R2"
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select now(); select pg_sleep(7); set local role service_role; select public.intake_purge_expired(500)::text; commit;" > $TD/m14_r2p_purge.out 2>&1 ) &
sleep 2
as_staff "$PA" "select public.intake_create_legal_hold('$S', 'client', '$C2', 'm14 r2p', 'm14 r2p', now() + interval '30 days');" > $TD/m14_r2p_hold.out 2>&1
wait
gone=$(q "select count(*) from public.intake_sessions where request_id = '$R2';")
deleted=0; [ "$gone" = "0" ] && deleted=1
note "R2-P2A purge output: $(tail -1 $TD/m14_r2p_purge.out | cut -c1-120); sessions left=$gone"
verdict "R2-P2A purge transaction began before the hold committed" "$deleted"

# ---- R2a: purge DELETE blocked on a row lock; the hold creator (RPC) must WAIT on the client lock until the purge commits (the CORRECT outcome in BOTH modes)
P=$(seed_client 3); C3=${P%%|*}; REST=${P#*|}; R3=${REST%%|*}
backdate "$R3"
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select id from public.intake_sessions where request_id = '$R3' for update; select pg_sleep(18); commit;" > /dev/null 2>&1 ) &
sleep 2
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_purge_expired(500)::text; select clock_timestamp();" > $TD/m14_r2a_purge.out 2>&1 ) &
sleep 2
( as_staff "$PA" "select public.intake_create_legal_hold('$S', 'client', '$C3', 'm14 r2a', 'm14 r2a', now() + interval '30 days');" > $TD/m14_r2a_hold.out 2>&1 ) &
# deterministic: sample until the creator is seen waiting WHILE the purge is still blocked; the hold must not exist at that moment
waiting=0; early=unseen
for k in $(seq 1 24); do
  waiting=$(q "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory';")
  if [ "$waiting" -ge 1 ]; then early=$(q "select count(*) from public.intake_legal_holds where client_ref = '$C3';"); break; fi
  sleep 0.5
done
wait
gone=$(q "select count(*) from public.intake_sessions where request_id = '$R3';")
holds=$(q "select count(*) from public.intake_legal_holds where client_ref = '$C3';")
ok=0; [ "$waiting" -ge 1 ] && [ "$early" = "0" ] && [ "$gone" = "0" ] && [ "$holds" = "1" ] && ok=1
note "R2a hold creator waiting on the advisory lock=$waiting (hold rows while blocked=$early); purge deleted (sessions left=$gone); hold exists afterwards=$holds"
must "R2a RPC hold creation waits on the client lock while the purge runs, the purge deletes (the hold did not exist yet), the hold exists afterwards" "$ok"

# ---- R2b: the backstop: a hold inserted DIRECTLY bypassing the lock (replica role disables the insert trigger), in a transaction that began BEFORE the purge,
#           committed while the purge DELETE waited on a row lock: the guard must refuse and the row must remain (the CORRECT outcome in BOTH modes)
P=$(seed_client 4); C4=${P%%|*}; REST=${P#*|}; R4=${REST%%|*}
backdate "$R4"
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; set local session_replication_role = replica; select now(); select pg_sleep(5); insert into public.intake_legal_holds (studio_id, scope_type, scope_ref, client_ref, reason, retention_basis, review_due_at, created_by) values ('$S', 'client', '$C4', '$C4', 'm14 r2b', 'm14 r2b', now() + interval '30 days', '$PA'); commit;" > $TD/m14_r2b_hold.out 2>&1 ) &
sleep 1
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select id from public.intake_sessions where request_id = '$R4' for update; select pg_sleep(8); commit;" > /dev/null 2>&1 ) &
sleep 1
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_purge_expired(500)::text;" > $TD/m14_r2b_purge.out 2>&1 ) &
wait
gone=$(q "select count(*) from public.intake_sessions where request_id = '$R4';")
holds=$(q "select count(*) from public.intake_legal_holds where client_ref = '$C4';")
ok=0; [ "$gone" = "1" ] && [ "$holds" = "1" ] && ok=1
note "R2b purge output: $(tail -1 $TD/m14_r2b_purge.out | cut -c1-140); rows left=$gone; hold committed=$holds"
must "R2b a direct hold that bypassed the lock: the guard refuses (42501) and the row remains" "$ok"

# ---- R2c: the delete guard locks before it checks: a direct delete while another writer holds the client lock is refused (M13: it deletes)
P=$(seed_client 6); C6=${P%%|*}; REST=${P#*|}; R6=${REST%%|*}
backdate "$R6"
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select intake_private.lock_client('$S', '$C6'); select pg_sleep(7); commit;" > /dev/null 2>&1 ) &
sleep 2
docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; set local role intake_destructive; delete from public.intake_sessions where request_id = '$R6'; commit;" > $TD/m14_r2c_del.out 2>&1
wait
gone=$(q "select count(*) from public.intake_sessions where request_id = '$R6';")
deleted=0; [ "$gone" = "0" ] && deleted=1
note "R2c direct delete while another writer holds the client: $(tr '
' ' ' < $TD/m14_r2c_del.out | cut -c1-110); rows left=$gone"
verdict "R2c delete guard lock-then-check" "$deleted"

# ---- R2d: every direct hold insert takes the client lock first (M13: the insert does not wait)
P=$(seed_client 7); C7=${P%%|*}
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select intake_private.lock_client('$S', '$C7'); select pg_sleep(8); commit;" > /dev/null 2>&1 ) &
sleep 2
t0=$(date +%s)
q "insert into public.intake_legal_holds (studio_id, scope_type, scope_ref, client_ref, reason, retention_basis, review_due_at, created_by) values ('$S', 'client', '$C7', '$C7', 'm14 r2d', 'm14 r2d', now() + interval '30 days', '$PA');" > /dev/null 2>&1
t1=$(date +%s)
wait
notwaited=0; [ $((t1 - t0)) -lt 4 ] && notwaited=1
note "R2d a direct hold insert waited $((t1 - t0)) s for the lock holder"
verdict "R2d hold-insert trigger takes the client lock" "$notwaited"

# ---- R3: isolation level
P=$(seed_client 5); C5=${P%%|*}
rr() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin isolation level repeatable read; select 1; $1 rollback;" 2>&1 | tr '\n' ' '; }
r3a=$(rr "select intake_private.lock_client('$S', '$C5');")
r3b=$(rr "set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$PA\",\"role\":\"authenticated\"}'; select public.intake_create_legal_hold('$S', 'client', '$C5', 'm14 r3', 'm14 r3', now() + interval '30 days');")
r3c=$(rr "set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$PA\",\"role\":\"authenticated\"}'; select public.intake_erase_client('$S', '$C5', 'data_subject_request')::text;")
r3d=$(rr "set local role service_role; select public.intake_purge_expired(500)::text;")
refused=1; for r in "$r3a" "$r3b" "$r3c" "$r3d"; do echo "$r" | grep -q "read committed\|READ COMMITTED" || refused=0; done
note "R3 lock_client: $(echo "$r3a" | cut -c1-90)"
note "R3 hold creation: $(echo "$r3b" | cut -c1-90)"
note "R3 erase: $(echo "$r3c" | cut -c1-90)"
note "R3 purge: $(echo "$r3d" | cut -c1-90)"
# the defect is the ABSENCE of the refusal
verdict "R3 isolation guard under REPEATABLE READ" "$((1 - refused))"

note "R4 starvation: the M14 suite (T07). R5 strengthened C7: the concurrency harness (C7). R6 P04 pair: the M13 suite (P04)."
printf '%s\n' "$ORIG" | docker exec -i "$DB" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 >/dev/null 2>&1; ORIG=""
echo "SUMMARY m14 races ($EXPECT): failures=$fail"
[ "$fail" = "0" ]
