#!/usr/bin/env bash
# NSI M15 race and lock-order proofs. LOCAL DISPOSABLE CONTAINERS ONLY (name must start with nsi-i2- or supabase_db_nsi).
#   A1/A2 determine and declare take the client lock before writing; A3 the two reads never wait for it
#   B1/B2 erase vs determine, both interleavings (the request is re-read after the lock; erasure_barrier or 22023)
#   C1 two concurrent determinations write one row; D1 declare vs revoke re-checks the session after the locks; E1 isolation guards
# usage: nsi_m15_race_local.sh <container> [run-offset]   (MUST run on an M15 database; committed fixtures: discard the container afterwards)
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

# ---- helpers for the M15 scenarios
BDAY_ADULT="(current_date - interval '30 years')::date"
setbd() { q "update public.clients set birthday = $2 where id = '$1';" >/dev/null; }
detsql() { echo "set role service_role; select public.intake_determine_minor_from_birthday('$S', '$1');"; }
declsql() { echo "set role service_role; select public.intake_declare_minor_status(decode('$(hexhash "sess-$1")', 'hex'), '$2');"; }
lockkey() { echo "hashtextextended('intake:client:$S:$1', 0)"; }
holder() { # client seconds : hold the client lock in a background session
  ( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select pg_advisory_xact_lock($(lockkey "$1")); select pg_sleep($2); commit;" > /dev/null 2>&1 ) &
}
nrows() { q "select count(*) from public.intake_minor_determinations where request_id = '$1';"; }
last() { tail -1 "$1" | tr -d '\r'; }
advwait() { q "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory';"; }

# ---- A1: determine waits on the client lock, then proceeds
P=$(seed_client 11); C=${P%%|*}; REST=${P#*|}; R=${REST%%|*}; setbd "$C" "$BDAY_ADULT"
holder "$C" 7; sleep 1; t0=$(date +%s)
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "$(detsql "$R")" > $TD/m15_a1.out 2>&1 ) &
sleep 2; w=$(advwait); wait; t1=$(date +%s)
ok=0; [ "$w" -ge 1 ] && [ "$(last $TD/m15_a1.out)" = "determined_adult" ] && [ "$(nrows "$R")" = "1" ] && [ $((t1 - t0)) -ge 4 ] && ok=1
note "A1 determine: waiting=$w result=$(last $TD/m15_a1.out) rows=$(nrows "$R") elapsed=$((t1 - t0))s"
must "A1 determine takes the client lock before it writes (waits for the holder, then determines)" "$ok"

# ---- A2: declare waits on the client lock, then proceeds
P=$(seed_client 12); C=${P%%|*}; REST=${P#*|}; R=${REST%%|*}; TK=${P##*|}
holder "$C" 7; sleep 1; t0=$(date +%s)
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "$(declsql "$TK" adult)" > $TD/m15_a2.out 2>&1 ) &
sleep 2; w=$(advwait); wait; t1=$(date +%s)
ok=0; [ "$w" -ge 1 ] && [ "$(last $TD/m15_a2.out)" = "declared_adult" ] && [ "$(nrows "$R")" = "1" ] && [ $((t1 - t0)) -ge 4 ] && ok=1
note "A2 declare: waiting=$w result=$(last $TD/m15_a2.out) rows=$(nrows "$R") elapsed=$((t1 - t0))s"
must "A2 declare takes the client lock before it writes (waits for the holder, then declares)" "$ok"

# ---- A3: the two reads never take the client lock
P=$(seed_client 13); C=${P%%|*}; REST=${P#*|}; R=${REST%%|*}; TK=${P##*|}
holder "$C" 9; sleep 1
t0=$(date +%s%N)
st=$(docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_session_minor_state(decode('$(hexhash "sess-$TK")', 'hex'));" 2>&1 | tail -1)
t1=$(date +%s%N)
bs=$(as_staff "$U" "select count(*) from public.intake_minor_basis('$S', '$R');" | tail -1)
t2=$(date +%s%N); wait
d1=$(( (t1 - t0) / 1000000 )); d2=$(( (t2 - t1) / 1000000 ))
ok=0; [ "$st" = "unknown" ] && [ "$bs" = "0" ] && [ $d1 -lt 4000 ] && [ $d2 -lt 4000 ] && ok=1
note "A3 reads while the client lock is held: state=$st (${d1} ms) basis_rows=$bs (${d2} ms)"
must "A3 session_minor_state and intake_minor_basis do not wait for the client lock (each under 4 s while the holder keeps it for 9 s)" "$ok"

# ---- A2b: declare takes the client lock BEFORE it locks the session row (client lock first, then the session row, like the revoke-all path)
P=$(seed_client 19); C=${P%%|*}; REST=${P#*|}; R=${REST%%|*}; TK=${P##*|}
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select 1 from public.intake_sessions where request_id = '$R' for update; select pg_sleep(8); commit;" > /dev/null 2>&1 ) &
sleep 1
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "$(declsql "$TK" adult)" > $TD/m15_a2b.out 2>&1 ) &
sleep 3
held=$(q "begin; select pg_try_advisory_xact_lock($(lockkey "$C")); rollback;" | grep -E '^(t|f)$' | head -1)
wait
ok=0; [ "$held" = "f" ] && [ "$(last $TD/m15_a2b.out)" = "declared_adult" ] && ok=1
note "A2b declare while another session holds the session row: client lock held by declare=$([ "$held" = f ] && echo yes || echo no) result=$(last $TD/m15_a2b.out)"
must "A2b declare holds the client lock while it waits for the session row (client lock first, then the session row)" "$ok"

# ---- B1: erase holds the client lock; determine started meanwhile waits, then finds the request gone and the barrier active
P=$(seed_client 14); C=${P%%|*}; REST=${P#*|}; R=${REST%%|*}; setbd "$C" "$BDAY_ADULT"
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$PA\",\"role\":\"authenticated\"}'; select public.intake_erase_client('$S', '$C', 'data_subject_request')::text; reset role; select pg_sleep(7); commit;" > $TD/m15_b1_erase.out 2>&1 ) &
sleep 2
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "$(detsql "$R")" > $TD/m15_b1.out 2>&1 ) &
sleep 2; w=$(advwait); wait
left=$(q "select count(*) from public.intake_requests where id = '$R';")
ok=0; [ "$w" -ge 1 ] && [ "$(last $TD/m15_b1.out)" = "erasure_barrier" ] && [ "$left" = "0" ] && [ "$(nrows "$R")" = "0" ] && ok=1
note "B1 erase-first (determine already past its unlocked read): waiting=$w result=$(last $TD/m15_b1.out) requests left=$left rows=$(nrows "$R")"
must "B1 determine waits for the erase, then re-reads, sees the request gone and returns erasure_barrier without writing" "$ok"

# ---- B2: erase committed before determine's first read: unknown request (22023)
P=$(seed_client 15); C=${P%%|*}; REST=${P#*|}; R=${REST%%|*}; setbd "$C" "$BDAY_ADULT"
as_staff "$PA" "select public.intake_erase_client('$S', '$C', 'data_subject_request')::text;" > $TD/m15_b2_erase.out 2>&1
docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "$(detsql "$R")" > $TD/m15_b2.out 2>&1
ok=0; grep -q "unknown request" $TD/m15_b2.out && ok=1
note "B2 erase committed first: $(last $TD/m15_b2.out | cut -c1-90)"
must "B2 determine after a committed erase raises unknown request (22023), no exception from the gate or a foreign key" "$ok"

# ---- C1: two concurrent determinations write exactly one row
P=$(seed_client 16); C=${P%%|*}; REST=${P#*|}; R=${REST%%|*}; setbd "$C" "$BDAY_ADULT"
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "$(detsql "$R")" > $TD/m15_c1a.out 2>&1 ) &
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "$(detsql "$R")" > $TD/m15_c1b.out 2>&1 ) &
wait
ra=$(last $TD/m15_c1a.out); rb=$(last $TD/m15_c1b.out)
ok=0; if [ "$(nrows "$R")" = "1" ]; then if { [ "$ra" = "determined_adult" ] && [ "$rb" = "already_current" ]; } || { [ "$rb" = "determined_adult" ] && [ "$ra" = "already_current" ]; }; then ok=1; fi; fi
note "C1 two concurrent determinations: $ra / $rb rows=$(nrows "$R")"
must "C1 two concurrent determinations leave exactly one row (one determined, one already_current)" "$ok"

# ---- D1: declare racing a revoke: the revoke holds the session row; declare takes the client lock, then waits for the row and sees it revoked
P=$(seed_client 17); C=${P%%|*}; REST=${P#*|}; R=${REST%%|*}; TK=${P##*|}
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; set local role service_role; select public.intake_revoke_session(decode('$(hexhash "sess-$TK")', 'hex')); reset role; select pg_sleep(6); commit;" > $TD/m15_d1_rev.out 2>&1 ) &
sleep 2; t0=$(date +%s)
docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "$(declsql "$TK" adult)" > $TD/m15_d1.out 2>&1; t1=$(date +%s); wait
ok=0; [ "$(last $TD/m15_d1.out)" = "invalid" ] && [ "$(nrows "$R")" = "0" ] && [ $((t1 - t0)) -ge 2 ] && ok=1
note "D1 declare vs revoke: result=$(last $TD/m15_d1.out) rows=$(nrows "$R") waited $((t1 - t0))s"
must "D1 a declaration that waited on a concurrent revoke re-checks the session and writes nothing (invalid)" "$ok"

# ---- E1: isolation guard on both writers (entry check, so it holds on every path)
P=$(seed_client 18); C=${P%%|*}; REST=${P#*|}; R=${REST%%|*}; TK=${P##*|}
rr() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin isolation level repeatable read; select 1; set local role service_role; $1 rollback;" 2>&1 | tr '\n' ' '; }
e1=$(rr "select public.intake_determine_minor_from_birthday('$S', '$R');")
e2=$(rr "select public.intake_declare_minor_status(decode('$(hexhash "sess-$TK")', 'hex'), 'adult');")
e3=$(docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin isolation level read uncommitted; select 1; set local role service_role; select public.intake_determine_minor_from_birthday('$S', '$R'); rollback;" 2>&1 | tr '\n' ' ')
e4=$(rr "select public.intake_determine_minor_from_birthday('$S', gen_random_uuid());")
note "E1 determine (unknown request) under RR: $(echo "$e4" | cut -c1-80)"
ok=0; echo "$e4" | grep -q "READ COMMITTED" && echo "$e1" | grep -q "READ COMMITTED" && echo "$e2" | grep -q "READ COMMITTED" && echo "$e3" | grep -q "READ COMMITTED" && ok=1
note "E1 determine under RR: $(echo "$e1" | cut -c1-80)"
note "E1 declare under RR: $(echo "$e2" | cut -c1-80)"
note "E1 determine under READ UNCOMMITTED: $(echo "$e3" | cut -c1-80)"
must "E1 both writers refuse REPEATABLE READ and READ UNCOMMITTED (55000)" "$ok"

printf '%s\n' "$ORIG" | docker exec -i "$DB" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 >/dev/null 2>&1; ORIG=""
echo "SUMMARY m15 races: failures=$fail"
[ "$fail" = "0" ]
