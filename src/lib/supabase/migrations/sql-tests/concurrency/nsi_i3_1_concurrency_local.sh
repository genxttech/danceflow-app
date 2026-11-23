#!/usr/bin/env bash
# NSI I3-1 (M12) concurrency harness. LOCAL DISPOSABLE CONTAINERS ONLY (name must start with nsi-i2- or supabase_db_nsi).
# Commits synthetic fixtures (including one synthetic staff user) and temporarily replaces public.intake_platform_policy() to open
# Gate A; the original definition is restored at the end. Committed fixtures cannot be removed by application roles: DISCARD THE
# CONTAINER AFTERWARDS.
#   C1  N parallel staff issues for ONE request (all expecting generation 1): exactly one wins, the others are refused with a generation mismatch
#   C2  N+4 parallel exchanges of ONE valid token: no deadlock, no error, at most 10 live sessions
#   C3  rounds of one resend racing one exchange of the old token: afterwards no live session belongs to a revoked invitation
#   C4  N*4 parallel rate-limit hits on one bucket with limit 10: exactly 10 allowed
#   C5  deterministic lock order: while a session holds the CLIENT lock, an exchange and a bulk key revoke must WAIT without holding the
#       invitation row lock (a third session takes FOR UPDATE NOWAIT on it immediately), then complete when the client lock is released
set -u
DB="${1:?container}"; N="${2:-8}"
case "$DB" in nsi-i2-*|supabase_db_nsi*) ;; *) echo "refused: container must be a disposable local stack"; exit 2;; esac
export MSYS_NO_PATHCONV=1
q() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
trap '[ -n "${ORIG:-}" ] && printf "%s\n" "$ORIG" | docker exec -i "$DB" psql -U postgres -d postgres -X -q >/dev/null 2>&1' EXIT
S=a5600000-0000-0000-0000-00000000000a; U=a5600000-0000-0000-0000-000000000101; T=a5600000-0000-0000-0000-000000000701; V=a5600000-0000-0000-0000-000000000702
OPEN="create or replace function public.intake_platform_policy() returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int, post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int, audit_security_days int, hold_record_days_after_release int, approved_basis_ref text) language sql stable set search_path = pg_catalog, pg_temp as \$\$ select 999, 90, 180, 90, 365, 3650, 365, 730, 1825, 365, 'TEST ONLY'::text \$\$"
ORIG=$(q "select pg_get_functiondef('public.intake_platform_policy()'::regprocedure);")
q "$OPEN" >/dev/null
q "insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values ('$U', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'conc-owner@nsi-i3.invalid', now(), now()) on conflict do nothing;
   insert into public.profiles (id) values ('$U') on conflict do nothing;
   insert into public.studios (id, name, slug) values ('$S', 'NSI I3-1 concurrency', 'nsi-i3-1-conc') on conflict do nothing;
   insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$U', '$S', 'studio_owner', true) on conflict do nothing;
   insert into public.intake_templates (id, studio_id, name) values ('$T', '$S', 'C') on conflict do nothing;
   insert into public.intake_template_versions (id, studio_id, template_id, version_number, status, schema, schema_sha256, max_answer_bytes, published_at)
     values ('$V', '$S', '$T', 1, 'published', '{\"sections\":[]}'::jsonb, 'x', 10, now()) on conflict do nothing;
   insert into public.intake_settings (studio_id, enabled, enabled_at, default_template_id) values ('$S', true, now() - interval '1 day', '$T')
     on conflict (studio_id) do update set enabled = true, enabled_at = now() - interval '1 day', default_template_id = '$T';
   insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at) values ('$S', 'live_collection', 'concurrency harness', '$U', now() + interval '30 days');
   insert into public.intake_service_assignments (studio_id, appointment_type, template_id) values ('$S', 'private_lesson', null) on conflict do nothing;" >/dev/null
mkreq() { # $1 index -> request id
  local C A; C=$(printf 'a5600000-0000-0000-0001-%012d' "$1"); A=$(printf 'a5600000-0000-0000-0002-%012d' "$1")
  q "insert into public.clients (id, studio_id, first_name, last_name) values ('$C', '$S', 'C', '$1') on conflict do nothing;
     insert into public.appointments (id, studio_id, client_id, appointment_type, status, starts_at, ends_at, created_at)
     values ('$A', '$S', '$C', 'private_lesson', 'scheduled', now() + interval '5 days', now() + interval '5 days 1 hour', now() - interval '1 hour') on conflict do nothing;" >/dev/null
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_ensure_request('$S', '$C', '$A');" 2>&1 | grep -E '^[0-9a-f-]{36}$' | head -1
}
hexhash() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
issue() { # request invitation-id hashseed [kid] [expected-generation] -> psql output
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role authenticated; set request.jwt.claims = '{\"sub\":\"$U\",\"role\":\"authenticated\"}'; select public.intake_issue_invitation('$S', '$1', '$2', ${5:-1}, '${4:-kid00001}', decode('$(printf 'ab%.0s' $(seq 1 16))', 'hex'), decode('$(hexhash "$3")', 'hex'), now() + interval '7 days');" 2>&1
}
exch() { # hash-seed session-seed -> psql output
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select session_id from public.intake_exchange_invitation(decode('$(hexhash "$1")', 'hex'), decode('$(hexhash "$2")', 'hex'), 1800, 14400);" 2>&1
}
tmp=$(mktemp -d); fail=0; dead=0

# ---- C1
R1=$(mkreq 1)
for i in $(seq 1 "$N"); do
  ( issue "$R1" "$(printf 'a5600000-0000-0000-0003-%012d' "$i")" "c1-$i" > "$tmp/c1_$i" 2>&1 ) &
done
wait
ok=0; mism=0; for i in $(seq 1 "$N"); do grep -q 40P01 "$tmp/c1_$i" && dead=$((dead+1)); grep -qE '^[0-9a-f-]{36}$' "$tmp/c1_$i" && ok=$((ok+1)); grep -q 'generation mismatch' "$tmp/c1_$i" && mism=$((mism+1)); done
live=$(q "select count(*) from public.intake_invitations where request_id = '$R1' and revoked_at is null;")
maxg=$(q "select max(generation) from public.intake_invitations where request_id = '$R1';")
cnt=$(q "select count(*) from public.intake_invitations where request_id = '$R1';")
st=$(q "select status from public.intake_requests where id = '$R1';")
[ "$ok" = "1" ] && [ "$mism" = "$((N - 1))" ] && [ "$live" = "1" ] && [ "$maxg" = "1" ] && [ "$cnt" = "1" ] && [ "$st" = "invited" ] && [ "$dead" = "0" ] || { fail=$((fail+1)); echo "C1 ok=$ok live=$live maxgen=$maxg count=$cnt status=$st deadlocks=$dead"; sed -n 1,3p "$tmp/c1_1"; }
echo "C1 parallel staff issues for one request (all expect generation 1): attempts=$N succeeded=$ok refused_mismatch=$mism live_invitations=$live max_generation=$maxg status=$st deadlocks=$dead"

# ---- C2
R2=$(mkreq 2); INV2=a5600000-0000-0000-0004-000000000002
issue "$R2" "$INV2" "c2-token" >/dev/null
M=$((N + 4))
for i in $(seq 1 "$M"); do ( exch "c2-token" "c2-sess-$i" > "$tmp/c2_$i" 2>&1 ) & done
wait
served=0; errs=0; for i in $(seq 1 "$M"); do grep -qE '^[0-9a-f-]{36}$' "$tmp/c2_$i" && served=$((served+1)); grep -qiE 'ERROR|40P01' "$tmp/c2_$i" && errs=$((errs+1)); done
sess=$(q "select count(*) from public.intake_sessions where invitation_id = '$INV2';")
[ "$errs" = "0" ] && [ "$sess" -le 10 ] && [ "$served" = "$sess" ] || { fail=$((fail+1)); echo "C2 served=$served sessions=$sess errors=$errs"; }
echo "C2 parallel exchanges of one token: attempts=$M served=$served live_sessions=$sess (cap 10) errors=$errs"

# ---- C3
c3=0
for r in $(seq 1 "$N"); do
  RQ=$(mkreq $((100 + r))); I1=$(printf 'a5600000-0000-0000-0005-%012d' "$r"); I2=$(printf 'a5600000-0000-0000-0006-%012d' "$r")
  issue "$RQ" "$I1" "c3-old-$r" >/dev/null
  ( issue "$RQ" "$I2" "c3-new-$r" kid00001 2 > "$tmp/c3a_$r" 2>&1 ) &
  ( exch "c3-old-$r" "c3-sess-$r" > "$tmp/c3b_$r" 2>&1 ) &
  wait
  bad=$(q "select count(*) from public.intake_sessions s join public.intake_invitations i on i.id = s.invitation_id where s.request_id = '$RQ' and s.revoked_at is null and i.revoked_at is not null;")
  bad=${bad//[^0-9]/}; bad=${bad:-1}
  grep -qE 'ERROR|40P01' "$tmp/c3a_$r" "$tmp/c3b_$r" && bad=$((bad+1))
  [ "$bad" = "0" ] || { c3=$((c3+1)); echo "C3 round $r: live sessions of revoked invitations or errors: $bad"; }
done
fail=$((fail+c3))
echo "C3 resend racing an exchange: rounds=$N failures=$c3"

# ---- C4
BUCKET=$(hexhash "c4-bucket"); K=$((N * 4))
for i in $(seq 1 "$K"); do
  ( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_rate_limit_hit(decode('$BUCKET', 'hex'), 10, 600);" > "$tmp/c4_$i" 2>&1 ) &
done
wait
allowed=0; for i in $(seq 1 "$K"); do grep -qx t "$tmp/c4_$i" && allowed=$((allowed+1)); done
[ "$allowed" = "10" ] || { fail=$((fail+1)); echo "C4 allowed=$allowed (expected 10)"; }
echo "C4 parallel rate-limit hits: attempts=$K allowed=$allowed (limit 10)"


# ---- C5 (deterministic: held locks, no timing luck)
RB=$(mkreq 300); IB=a5600000-0000-0000-0007-000000000300
issue "$RB" "$IB" "c5-token" >/dev/null
CB=$(printf 'a5600000-0000-0000-0001-%012d' 300)
hold() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select intake_private.lock_client('$S', '$CB'); select pg_sleep($1); commit;" >/dev/null 2>&1; }
# exchange waits for the client lock without touching the invitation row
hold 9 &
sleep 2
t0=$(date +%s)
( exch "c5-token" "c5-sess" > "$tmp/c5_exch" 2>&1 ) &
sleep 3
nowait=$(docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select id from public.intake_invitations where id = '$IB' for update nowait; commit;" 2>&1 | tr '\n' ' ')
wait
t1=$(date +%s)
okx=0; grep -qE '^[0-9a-f-]{36}$' "$tmp/c5_exch" && okx=1
case "$nowait" in *"$IB"*) nw=1;; *) nw=0;; esac
if [ "$okx" = "1" ] && [ "$nw" = "1" ] && [ $((t1 - t0)) -ge 4 ]; then echo "C5a exchange waited for the client lock ($((t1 - t0)) s) without holding the invitation lock, then succeeded"; else fail=$((fail+1)); echo "C5a exchange_ok=$okx invitation_lockable_while_waiting=$nw waited=$((t1 - t0))s nowait=[$nowait]"; fi
# bulk revoke waits for the client lock without touching the invitation row
RC=$(mkreq 301); IC=a5600000-0000-0000-0007-000000000301
issue "$RC" "$IC" "c5b-token" kidlock1 >/dev/null
CC=$(printf 'a5600000-0000-0000-0001-%012d' 301)
holdc() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select intake_private.lock_client('$S', '$CC'); select pg_sleep($1); commit;" >/dev/null 2>&1; }
holdc 9 &
sleep 2
t0=$(date +%s)
( docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "set role service_role; select public.intake_revoke_all_invitations_for_key('kidlock1', 100);" > "$tmp/c5_bulk" 2>&1 ) &
sleep 3
nowait=$(docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "begin; select id from public.intake_invitations where id = '$IC' for update nowait; commit;" 2>&1 | tr '\n' ' ')
wait
t1=$(date +%s)
revoked=$(q "select count(*) from public.intake_invitations where id = '$IC' and revoked_at is not null;")
case "$nowait" in *"$IC"*) nw=1;; *) nw=0;; esac
if [ "$revoked" = "1" ] && [ "$nw" = "1" ] && [ $((t1 - t0)) -ge 4 ] && grep -qx 1 "$tmp/c5_bulk"; then echo "C5b bulk key revoke waited for the client lock ($((t1 - t0)) s) without holding the invitation lock, then revoked 1"; else fail=$((fail+1)); echo "C5b revoked=$revoked lockable=$nw waited=$((t1 - t0))s out=[$(tr '\n' ' ' < "$tmp/c5_bulk")]"; fi

printf '%s\n' "$ORIG" | docker exec -i "$DB" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 >/dev/null 2>&1; ORIG=""
gate=$(q "select intake_private.retention_gate_open();"); cat=$(q "select intake_private.assert_catalog();")
echo "after restore: gate_open=$gate catalog=[${cat:-ok}]"
rm -rf "$tmp"
echo "SUMMARY concurrency M12: failures=$fail deadlocks=$dead"
[ "$fail" = "0" ] && [ "$dead" = "0" ] && [ "$gate" = "f" ] && [ -z "$cat" ]
