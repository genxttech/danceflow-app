#!/usr/bin/env bash
# NSI M16b race and lock-order proofs. LOCAL DISPOSABLE CONTAINERS ONLY (name must start with nsi-i2- or supabase_db_nsi).
#   A1 request and A2 issue / A3 verify take the client lock before writing
#   B1 revoke-all vs finalize (finalize waits, then refuses); B2 erase vs verify, both orders
#   C1 concurrent wrong verifies never lose an attempt and never pass five; C2 two requests leave one open row;
#   C3 two issues leave one open challenge; P1 purge skips a client whose lock a writer holds; E1 isolation guards
# usage: nsi_m16b_race_local.sh <container> [run-offset] [scenario]   (MUST run on an M16b database; committed fixtures: discard the container)
set -u
DB="${1:?container}"; OFF="${2:-0}"
case "$DB" in nsi-i2-*|supabase_db_nsi*) ;; *) echo "refused: container must be a disposable local stack"; exit 2;; esac
export MSYS_NO_PATHCONV=1
TD="${TMPDIR:-/tmp}"
q() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
trap '[ -n "${ORIG:-}" ] && printf "%s\n" "$ORIG" | docker exec -i "$DB" psql -U postgres -d postgres -X -q >/dev/null 2>&1' EXIT
S=a5900000-0000-0000-0000-00000000000a; U=a5900000-0000-0000-0000-000000000101; PA=a5900000-0000-0000-0000-000000000401
T=a5900000-0000-0000-0000-000000000701; V=a5900000-0000-0000-0000-000000000702
OPEN="create or replace function public.intake_platform_policy() returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int, post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int, audit_security_days int, hold_record_days_after_release int, approved_basis_ref text) language sql stable set search_path = pg_catalog, pg_temp as \$\$ select 999, 90, 180, 90, 365, 3650, 365, 730, 1825, 365, 'TEST ONLY'::text \$\$"
ORIG=$(q "select pg_get_functiondef('public.intake_platform_policy()'::regprocedure);")
q "$OPEN" >/dev/null
q "insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values ('$U', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm16b-owner@nsi.invalid', now(), now()), ('$PA', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm16b-padmin@nsi.invalid', now(), now()) on conflict do nothing;
   insert into public.profiles (id) values ('$U') on conflict do nothing;
   insert into public.profiles (id, platform_role) values ('$PA', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';
   insert into public.studios (id, name, slug) values ('$S', 'NSI M16b races', 'nsi-m16b-races') on conflict do nothing;
   insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$U', '$S', 'studio_owner', true) on conflict do nothing;
   insert into public.intake_templates (id, studio_id, name) values ('$T', '$S', 'C') on conflict do nothing;
   insert into public.intake_template_versions (id, studio_id, template_id, version_number, status, schema, schema_sha256, max_answer_bytes, published_at)
     values ('$V', '$S', '$T', 1, 'published', '{\"sections\":[]}'::jsonb, 'x', 10, now()) on conflict do nothing;
   insert into public.intake_settings (studio_id, enabled, enabled_at, default_template_id) values ('$S', true, now() - interval '1 day', '$T')
     on conflict (studio_id) do update set enabled = true, enabled_at = now() - interval '1 day', default_template_id = '$T';" >/dev/null
q "insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at) select '$S', 'live_collection', 'm16b race harness', '$U', now() + interval '30 days' where not exists (select 1 from public.intake_feature_grants where studio_id = '$S' and capability = 'live_collection' and revoked_at is null);
   insert into public.intake_service_assignments (studio_id, appointment_type, template_id) values ('$S', 'private_lesson', null) on conflict do nothing;" >/dev/null
hexhash() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
SALT=$(printf 'cd%.0s' $(seq 1 16))
as_staff() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role authenticated; set request.jwt.claims = '{\"sub\":\"$1\",\"role\":\"authenticated\"}'; $2" 2>&1; }
svc() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; $1" 2>&1; }
last() { tail -1 "$1" | tr -d '\r'; }
lastv() { tail -1 | tr -d '\r'; }
lockkey() { echo "hashtextextended('intake:client:$S:$1', 0)"; }
# Ordering never depends on timing (a docker exec can take seconds on a loaded host). A GATE is a session lock (7160, n) held by its
# own backend; a transaction ending in gate_wait n keeps all its locks until gate_open n ends that backend. Client locks are the
# one-key advisory locks (objsubid 1), gates the two-key ones (objsubid 2).
seen() { local i; for i in $(seq 1 120); do [ "$(q "$1" | tr -d '\r')" -ge 1 ] 2>/dev/null && return 0; sleep 0.5; done; return 1; }
gatesql() { echo "select count(*) from pg_locks where locktype = 'advisory' and objsubid = 2 and classid = 7160 and objid = $1 and $2;"; }
gate_close() { ( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "select pg_advisory_lock(7160, $1); select pg_sleep(600);" > /dev/null 2>&1 ) & seen "$(gatesql "$1" granted)" || echo "gate $1 never closed"; }
gate_wait() { echo "reset role; select pg_advisory_xact_lock(7160, $1);"; }
at_gate() { seen "$(gatesql "$1" "not granted")" || echo "the first transaction never reached gate $1"; }
gate_open() { q "select count(pg_terminate_backend(pid)) from pg_locks where locktype = 'advisory' and objsubid = 2 and classid = 7160 and objid = $1 and granted;" > /dev/null; }
CLIENTWAIT="select count(*) from pg_locks where locktype = 'advisory' and objsubid = 1 and not granted"
# blocked <pid>: 1 once a caller waits on a client lock; 0 when the background caller ended without ever waiting
blocked() { local i; for i in $(seq 1 60); do [ "$(q "$CLIENTWAIT;" | tr -d '\r')" -ge 1 ] 2>/dev/null && { echo 1; return; }; kill -0 "$1" 2>/dev/null || break; sleep 0.5; done; echo 0; }
allblocked() { seen "select (($CLIENTWAIT) >= $1)::int;" || echo "fewer than $1 callers waited on the client lock"; }
# holder <client> <gate>: another writer holds the client lock until gate_open <gate>
holder() { gate_close "$2"; ( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select pg_advisory_xact_lock($(lockkey "$1")); $(gate_wait "$2") commit;" > /dev/null 2>&1 ) & at_gate "$2"; }
# ONLY=<scenario> (third argument) runs one scenario group, for the mutation probes
ONLY="${3:-}"; ran=0
want() { local t; [ -z "$ONLY" ] && return 0; for t in "$@"; do [ "$t" = "$ONLY" ] && return 0; done; return 1; }
G0=$((OFF + 1))
reqsql() { echo "select public.intake_guardian_request_invitation('$S', '$1', '$2', 1::smallint);"; }
finsql() { echo "select public.intake_guardian_finalize_invitation('$1', '$2', $3, 'kid00001', decode('$SALT', 'hex'), decode('$(hexhash "$4")', 'hex'), now() + interval '7 days');"; }
isssql() { echo "select public.intake_issue_email_challenge(decode('$(hexhash "$1")', 'hex'), '$2', decode('$(hexhash "$3")', 'hex'), decode('$(hexhash "ip-$2")', 'hex'), decode('$(hexhash "em-$2")', 'hex'), '$4', 1::smallint);"; }
versql() { echo "select public.intake_verify_email_challenge(decode('$(hexhash "$1")', 'hex'), '$2', decode('$(hexhash "$3")', 'hex'));"; }
uid() { printf 'a5900000-0000-0000-%04d-%012d' "$1" "$(($2 + OFF))"; }
# seed <index> [stage: pending|full]  ->  "client|request|session-token|pending|hash|respondent"
seed() {
  local n=$1 stage=${2:-full} C A R I tok P G H gi gtok res
  C=$(uid 1 $n); A=$(uid 2 $n); I=$(uid 3 $n); gi=$(uid 4 $n); G=$(uid 5 $n); tok="st-$((n + OFF))"; gtok="gt-$((n + OFF))"; H="hmac-$((n + OFF))"
  q "insert into public.clients (id, studio_id, first_name, last_name) values ('$C', '$S', 'C', '$n') on conflict do nothing;
     insert into public.appointments (id, studio_id, client_id, appointment_type, status, starts_at, ends_at, created_at)
     values ('$A', '$S', '$C', 'private_lesson', 'scheduled', now() + interval '5 days', now() + interval '5 days 1 hour', now() - interval '1 hour') on conflict do nothing;" >/dev/null
  R=$(svc "select public.intake_ensure_request('$S', '$C', '$A');" | grep -E '^[0-9a-f-]{36}$' | head -1)
  as_staff "$U" "select public.intake_issue_invitation('$S', '$R', '$I', 1, 'kid00001', decode('$SALT', 'hex'), decode('$(hexhash "$tok")', 'hex'), now() + interval '7 days');" >/dev/null
  q "insert into public.intake_minor_determinations (studio_id, request_id, is_minor, source, evaluated_on, threshold) values ('$S', '$R', true, 'birthday', current_date, 18);" >/dev/null
  res=$(as_staff "$U" "$(reqsql "$R" "$H")" | lastv); P=$(echo "$res" | cut -d: -f2)
  if [ "$stage" = "full" ]; then
    svc "$(finsql "$P" "$gi" 1 "$gtok")" >/dev/null
    svc "select session_id from public.intake_exchange_invitation(decode('$(hexhash "$gtok")', 'hex'), decode('$(hexhash "gs-$gtok")', 'hex'), 1800, 14400);" >/dev/null
    q "insert into public.intake_respondents (id, studio_id, request_id, client_id, role, display_name, email, email_hmac, email_hmac_kid, declared_relationship, assurance) select '$G', studio_id, id, client_id, 'guardian', 'Synthetic G', 'g@nsi-m16b.invalid', '$H', 1, 'parent', 'declared_unverified' from public.intake_requests where id = '$R' on conflict do nothing;" >/dev/null
  fi
  echo "$C|$R|gs-$gtok|$P|$H|$G"
}
f() { echo "$1" | cut -d'|' -f"$2"; }
fail=0
note() { echo "$*"; }
must() { ran=$((ran+1)); if [ "$2" = "1" ]; then note "$1: ok"; else fail=$((fail+1)); note "$1: FAIL"; fi; }
col() { q "select $2 from public.intake_email_challenges where id = '$1';"; }

# ---- A1 request takes the client lock before it writes
if want A1; then
X=$(seed 11 pending); C=$(f "$X" 1); R=$(f "$X" 2)
holder "$C" $G0
gen() { q "select count(*) || '/' || max(id::text) from public.intake_guardian_invitation_requests where request_id = '$R';"; }
b=$(gen)
( as_staff "$U" "$(reqsql "$R" again)" > $TD/m16b_a1.out 2>&1 ) & p=$!
w=$(blocked $p); m=$(gen); gate_open $G0; wait
ok=0; [ "$w" = "1" ] && [ "$m" = "$b" ] && last $TD/m16b_a1.out | grep -q '^requested:' && ok=1
note "A1 request: waiting=$w unchanged-while-held=$([ "$m" = "$b" ] && echo yes || echo no) result=$(last $TD/m16b_a1.out | cut -c1-20)"
must "A1 the staff request takes the client lock before it writes" "$ok"
fi

# ---- A2 issue and A3 verify take the client lock
if want A2 A3; then
X=$(seed 12); C=$(f "$X" 1); SS=$(f "$X" 3); H=$(f "$X" 5); CH=$(uid 6 12)
holder "$C" $((G0 + 1))
( svc "$(isssql "$SS" "$CH" right "$H")" > $TD/m16b_a2.out 2>&1 ) & p=$!
w=$(blocked $p); n0=$(q "select count(*) from public.intake_email_challenges where id = '$CH';"); gate_open $((G0 + 1)); wait
ok=0; [ "$w" = "1" ] && [ "$n0" = "0" ] && [ "$(last $TD/m16b_a2.out)" = "ok" ] && ok=1
note "A2 issue: waiting=$w rows-while-held=$n0 result=$(last $TD/m16b_a2.out)"
must "A2 issue takes the client lock before it writes" "$ok"
holder "$C" $((G0 + 2))
( svc "$(versql "$SS" "$CH" wrong)" > $TD/m16b_a3.out 2>&1 ) & p=$!
w=$(blocked $p); n0=$(col "$CH" attempts); gate_open $((G0 + 2)); wait
ok=0; [ "$w" = "1" ] && [ "$n0" = "0" ] && [ "$(last $TD/m16b_a3.out)" = "invalid" ] && [ "$(col "$CH" attempts)" = "1" ] && ok=1
note "A3 verify: waiting=$w attempts-while-held=$n0 result=$(last $TD/m16b_a3.out) attempts=$(col "$CH" attempts)"
must "A3 verify takes the client lock before it counts" "$ok"
fi

# ---- B1 revoke-all holds the lock; finalize waits and then refuses
if want B1; then
X=$(seed 13 pending); R=$(f "$X" 2); P=$(f "$X" 4); GI=$(uid 4 13)
gate_close $((G0 + 3))
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$U\",\"role\":\"authenticated\"}'; select public.intake_revoke_invitations('$S', '$R'); $(gate_wait $((G0 + 3))) commit;" > $TD/m16b_b1_rev.out 2>&1 ) &
at_gate $((G0 + 3))
( svc "$(finsql "$P" "$GI" 1 "gt-b1-$OFF")" > $TD/m16b_b1.out 2>&1 ) & p=$!
w=$(blocked $p); gate_open $((G0 + 3)); wait
n=$(q "select count(*) from public.intake_invitations where id = '$GI';")
ok=0; [ "$w" = "1" ] && [ "$(last $TD/m16b_b1.out)" = "superseded" ] && [ "$n" = "0" ] && ok=1
note "B1 revoke first: waiting=$w result=$(last $TD/m16b_b1.out) invitations=$n"
must "B1 finalize waits for revoke-all and then refuses without issuing" "$ok"
fi

# ---- B2a erase first, verify waits; B2b verify first, erase waits
if want B2a B2b; then
X=$(seed 14); C=$(f "$X" 1); R=$(f "$X" 2); SS=$(f "$X" 3); H=$(f "$X" 5); CH=$(uid 6 14)
svc "$(isssql "$SS" "$CH" right "$H")" >/dev/null
gate_close $((G0 + 4))
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$PA\",\"role\":\"authenticated\"}'; select public.intake_erase_client('$S', '$C', 'data_subject_request')::text; $(gate_wait $((G0 + 4))) commit;" > $TD/m16b_b2e.out 2>&1 ) &
at_gate $((G0 + 4))
( svc "$(versql "$SS" "$CH" right)" > $TD/m16b_b2.out 2>&1 ) & p=$!
w=$(blocked $p); gate_open $((G0 + 4)); wait
left=$(q "select (select count(*) from public.intake_email_challenges where request_id = '$R') + (select count(*) from public.intake_requests where id = '$R');")
ok=0; [ "$w" = "1" ] && [ "$(last $TD/m16b_b2.out)" = "invalid" ] && [ "$left" = "0" ] && ok=1
note "B2a erase first: waiting=$w result=$(last $TD/m16b_b2.out) left=$left"
must "B2a verify waits for the erase and answers invalid" "$ok"
X=$(seed 15); C=$(f "$X" 1); R=$(f "$X" 2); SS=$(f "$X" 3); H=$(f "$X" 5); CH=$(uid 6 15)
svc "$(isssql "$SS" "$CH" right "$H")" >/dev/null
gate_close $((G0 + 5))
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; set local role service_role; $(versql "$SS" "$CH" right) $(gate_wait $((G0 + 5))) commit;" > $TD/m16b_b3v.out 2>&1 ) &
at_gate $((G0 + 5))
( as_staff "$PA" "select public.intake_erase_client('$S', '$C', 'data_subject_request')::text;" > $TD/m16b_b3.out 2>&1 ) & p=$!
w=$(blocked $p); gate_open $((G0 + 5)); wait
left=$(q "select (select count(*) from public.intake_email_challenges where request_id = '$R') + (select count(*) from public.intake_requests where id = '$R');")
ok=0; [ "$w" = "1" ] && grep -q '^ok' $TD/m16b_b3v.out && grep -q '"erased"' $TD/m16b_b3.out && [ "$left" = "0" ] && ok=1
note "B2b verify first: waiting=$w left=$left"
must "B2b erase waits for the verify and then removes everything" "$ok"
fi

# ---- B4 finalize holds the lock first; revoke-all waits and then ends the new invitation
if want B4; then
X=$(seed 21 pending); R=$(f "$X" 2); P=$(f "$X" 4); GI=$(uid 4 21)
gate_close $((G0 + 6))
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; set local role service_role; $(finsql "$P" "$GI" 1 "gt-b4-$OFF") $(gate_wait $((G0 + 6))) commit;" > $TD/m16b_b4_fin.out 2>&1 ) &
at_gate $((G0 + 6))
( as_staff "$U" "select public.intake_revoke_invitations('$S', '$R');" > $TD/m16b_b4.out 2>&1 ) & p=$!
w=$(blocked $p); gate_open $((G0 + 6)); wait
st=$(q "select coalesce(revoked_reason, 'live') from public.intake_invitations where id = '$GI';")
ok=0; [ "$w" = "1" ] && grep -q '^issued:1' $TD/m16b_b4_fin.out && [ "$st" = "staff_revoked" ] && ok=1
note "B4 finalize first: waiting=$w invitation=$st"
must "B4 revoke-all waits for the finalize and then revokes the new guardian invitation" "$ok"
fi

# ---- B5 a re-request holds the lock first; an issue on the old link waits and is refused
if want B5; then
X=$(seed 22); R=$(f "$X" 2); SS=$(f "$X" 3); H=$(f "$X" 5); CH=$(uid 6 22)
gate_close $((G0 + 7))
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$U\",\"role\":\"authenticated\"}'; $(reqsql "$R" b5) $(gate_wait $((G0 + 7))) commit;" > $TD/m16b_b5_req.out 2>&1 ) &
at_gate $((G0 + 7))
( svc "$(isssql "$SS" "$CH" right "$H")" > $TD/m16b_b5.out 2>&1 ) & p=$!
w=$(blocked $p); gate_open $((G0 + 7)); wait
n=$(q "select count(*) from public.intake_email_challenges where request_id = '$R';")
ok=0; [ "$w" = "1" ] && grep -q '^requested:' $TD/m16b_b5_req.out && [ "$(last $TD/m16b_b5.out)" = "invalid" ] && [ "$n" = "0" ] && ok=1
note "B5 re-request first: waiting=$w issue=$(last $TD/m16b_b5.out) challenges=$n"
must "B5 an issue on the old link waits for the re-request and writes nothing" "$ok"
fi

# ---- C1 eight concurrent wrong verifies: exactly five counted
if want C1; then
X=$(seed 16); C=$(f "$X" 1); SS=$(f "$X" 3); H=$(f "$X" 5); CH=$(uid 6 16)
svc "$(isssql "$SS" "$CH" right "$H")" >/dev/null
holder "$C" $((G0 + 8))
for k in 1 2 3 4 5 6 7 8; do ( svc "$(versql "$SS" "$CH" wrong)" > $TD/m16b_c1_$k.out 2>&1 ) & done
allblocked 8; gate_open $((G0 + 8)); wait
inv=0; lk=0; for k in 1 2 3 4 5 6 7 8; do case "$(last $TD/m16b_c1_$k.out)" in invalid) inv=$((inv+1));; locked) lk=$((lk+1));; esac; done
ok=0; [ "$inv" = "5" ] && [ "$lk" = "3" ] && [ "$(col "$CH" attempts)" = "5" ] && ok=1
note "C1 eight wrong codes: invalid=$inv locked=$lk attempts=$(col "$CH" attempts)"
must "C1 concurrent verifies never lose an attempt and never pass five" "$ok"
fi

# ---- C2 two concurrent requests leave one open row
if want C2; then
X=$(seed 17 pending); C=$(f "$X" 1); R=$(f "$X" 2)
holder "$C" $((G0 + 9))
( as_staff "$U" "$(reqsql "$R" c2a)" > $TD/m16b_c2a.out 2>&1 ) &
( as_staff "$U" "$(reqsql "$R" c2b)" > $TD/m16b_c2b.out 2>&1 ) &
allblocked 2; gate_open $((G0 + 9)); wait
n=$(q "select count(*) from public.intake_guardian_invitation_requests where request_id = '$R' and finalized_at is null and superseded_at is null;")
ok=0; last $TD/m16b_c2a.out | grep -q '^requested:' && last $TD/m16b_c2b.out | grep -q '^requested:' && [ "$n" = "1" ] && ok=1
note "C2 two requests: open=$n"
must "C2 two concurrent requests both succeed and leave one open row" "$ok"
fi

# ---- C3 two concurrent issues leave one open challenge
if want C3; then
X=$(seed 18); C=$(f "$X" 1); R=$(f "$X" 2); SS=$(f "$X" 3); H=$(f "$X" 5)
holder "$C" $((G0 + 10))
( svc "$(isssql "$SS" "$(uid 6 181)" a "$H")" > $TD/m16b_c3a.out 2>&1 ) &
( svc "$(isssql "$SS" "$(uid 6 182)" b "$H")" > $TD/m16b_c3b.out 2>&1 ) &
allblocked 2; gate_open $((G0 + 10)); wait
n=$(q "select count(*) filter (where consumed_at is null and superseded_at is null) || '/' || count(*) from public.intake_email_challenges where request_id = '$R';")
ok=0; [ "$(last $TD/m16b_c3a.out)" = "ok" ] && [ "$(last $TD/m16b_c3b.out)" = "ok" ] && [ "$n" = "1/2" ] && ok=1
note "C3 two issues: $(last $TD/m16b_c3a.out) / $(last $TD/m16b_c3b.out) open/all=$n"
must "C3 two concurrent issues both succeed and leave one open challenge" "$ok"
fi

# ---- P1 the purge skips a client whose lock a writer holds, without failing
if want P1; then
X=$(seed 19); C=$(f "$X" 1); R=$(f "$X" 2); SS=$(f "$X" 3); H=$(f "$X" 5); CH=$(uid 6 19)
svc "$(isssql "$SS" "$CH" right "$H")" >/dev/null
docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; set local session_replication_role = replica;
  update public.intake_invitations set expires_at = now() - interval '100 days' where request_id = '$R' and audience = 'guardian';
  update public.intake_email_challenges set expires_at = now() - interval '100 days' where request_id = '$R';
  update public.intake_sessions set created_at = now() - interval '200 days', absolute_expires_at = now() - interval '150 days', idle_expires_at = now() - interval '150 days' where request_id = '$R'; commit;" >/dev/null 2>&1
rows() { q "select (select count(*) from public.intake_email_challenges where request_id = '$R') || '/' || (select count(*) from public.intake_guardian_invitation_requests where request_id = '$R');"; }
holder "$C" $((G0 + 11))
p1=$(svc "select public.intake_purge_expired(500)::text;" | lastv); mid=$(rows); gate_open $((G0 + 11)); wait
p2=$(svc "select public.intake_purge_expired(500)::text;" | lastv); end=$(rows)
ok=0; echo "$p1" | grep -q '"challenges"' && [ "$mid" = "1/1" ] && echo "$p2" | grep -q '"challenges"' && [ "$end" = "0/0" ] && ok=1
note "P1 purge under a held lock: rows=$mid then=$end first=$(echo "$p1" | cut -c1-120)"
must "P1 the purge skips a locked client without failing and removes it on the next run" "$ok"
fi

# ---- E1 isolation guards (entry checks, so they hold on the early-return paths too)
if want E1; then
X=$(seed 20); SS=$(f "$X" 3); R=$(f "$X" 2)
rr() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin isolation level $1; select 1; set local role $2; set local request.jwt.claims = '{\"sub\":\"$U\",\"role\":\"authenticated\"}'; $3 rollback;" 2>&1 | tr '\n' ' '; }
r1=$(rr "repeatable read" authenticated "$(reqsql "$(uid 7 1)" x)")
r2=$(rr "repeatable read" service_role "$(finsql "$(uid 7 2)" "$(uid 7 3)" 1 e1)")
r3=$(rr "repeatable read" service_role "$(isssql unknown-session "$(uid 7 4)" c x)")
r4=$(rr "repeatable read" service_role "$(versql unknown-session "$(uid 7 5)" c)")
r5=$(rr "read uncommitted" service_role "$(versql "$SS" "$(uid 7 6)" c)")
ok=1; i=0; for r in "$r1" "$r2" "$r3" "$r4" "$r5"; do i=$((i+1)); echo "$r" | grep -q "READ COMMITTED" || { ok=0; note "E1 call $i not refused: $(echo "$r" | cut -c1-150)"; }; done
must "E1 every writer refuses REPEATABLE READ / READ UNCOMMITTED (55000), including on unknown ids" "$ok"
fi

printf '%s\n' "$ORIG" | docker exec -i "$DB" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 >/dev/null 2>&1; ORIG=""
[ "$ran" -gt 0 ] || { echo "no scenario matched '$ONLY'"; exit 2; }
echo "SUMMARY m16b races: failures=$fail"
[ "$fail" = "0" ]
