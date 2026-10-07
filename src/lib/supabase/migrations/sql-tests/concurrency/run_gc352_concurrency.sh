#!/usr/bin/env bash
# GC-3.5-2 -- real two-session checks for public paid Group Class acquisition holds.
# Run against DEV only, from the repo root:
#   bash src/lib/supabase/migrations/sql-tests/concurrency/run_gc352_concurrency.sh
# Creates committed synthetic fixtures (studio ...35c0001, two one-seat public direct-payment classes,
# three verified purchasers produced through the real LAUNCH-SEC-1C-A proof/binding functions), then:
#   SC1 purchaser A takes the final seat (holds the class row FOR UPDATE) vs purchaser B   -> B waits, then GC35_CLASS_FULL
#   SC2 purchaser A holds class 2's final seat (open transaction) vs staff enrollment    -> staff waits, then "no available seats"
#   SC3 purchaser C releases a checked-out hold (holds the hold row) vs finalize          -> finalize waits, then conflict hold_released
# and always cleans up. Concurrent CLI logins collide, so the second session starts 7s after the first.
set -u
case "$(cat supabase/.temp/project-ref 2>/dev/null)" in
  epdrtzcydvnoidwrepqz) ;;
  *) echo "refusing: repo is not linked to DEV epdrtzcydvnoidwrepqz"; exit 1 ;;
esac
T="${TMPDIR:-/tmp}/gc352-conc"; mkdir -p "$T"
S=00000000-0000-0000-0000-0000035c0001
K1=00000000-0000-0000-0000-0000035c6001; K2=00000000-0000-0000-0000-0000035c6002; K3=00000000-0000-0000-0000-0000035c6003
UA=00000000-0000-0000-0000-0000035c1001; UB=00000000-0000-0000-0000-0000035c1002; UC=00000000-0000-0000-0000-0000035c1003
PA=00000000-0000-0000-0000-0000035c2001; PB=00000000-0000-0000-0000-0000035c2002; PC=00000000-0000-0000-0000-0000035c2003
LA=00000000-0000-0000-0000-0000035c3001; LB=00000000-0000-0000-0000-0000035c3002; LC=00000000-0000-0000-0000-0000035c3003
CL=00000000-0000-0000-0000-0000035c4001
run() { supabase db query --linked -f "$1" 2>&1; }

cleanup() { cat > "$T/cleanup.sql" <<SQL
begin;
delete from public.group_class_enrollment_holds where studio_id='$S';
delete from public.payments where studio_id='$S';
delete from public.accounting_entries where studio_id='$S';
delete from public.appointment_attendees where studio_id='$S';
delete from public.group_class_enrollment_policies where studio_id='$S';
delete from public.appointments where studio_id='$S';
delete from public.clients where studio_id='$S';
delete from public.verified_email_identities where user_id in ('$UA','$UB','$UC');
delete from public.auth_email_change_markers where user_id in ('$UA','$UB','$UC');
delete from public.profiles where id in ('$UA','$UB','$UC');
delete from auth.mfa_amr_claims where session_id in (select id from auth.sessions where user_id in ('$UA','$UB','$UC'));
delete from auth.sessions where user_id in ('$UA','$UB','$UC');
delete from auth.users where id in ('$UA','$UB','$UC');
delete from public.studios where id='$S';
commit;
select (select count(*) from public.studios where id='$S') studios_left, (select count(*) from auth.users where id in ('$UA','$UB','$UC')) users_left,
       (select count(*) from public.payments where studio_id='$S') payments_left;
SQL
run "$T/cleanup.sql" | grep -E "ERROR|studios_left|users_left|payments_left"; }
trap cleanup EXIT

cat > "$T/fixture.sql" <<SQL
begin;
insert into public.studios (id,name,slug,stripe_connected_account_id,public_directory_enabled,subscription_status)
  values ('$S','GC352 conc studio','t-gc352-conc','acct_gc352Conc',true,'active');
insert into public.appointments (id,studio_id,appointment_type,status,starts_at,ends_at,roster_capacity) values
  ('$K1','$S','group_class','scheduled',now()+interval '2 days',now()+interval '2 days 1 hour',1),
  ('$K2','$S','group_class','scheduled',now()+interval '2 days',now()+interval '2 days 1 hour',1),
  ('$K3','$S','group_class','scheduled',now()+interval '2 days',now()+interval '2 days 1 hour',null);
insert into public.group_class_enrollment_policies (studio_id,appointment_id,publicly_discoverable,self_enrollment_allowed,accepted_funding_types,direct_payment_amount)
  select '$S', k, true, true, array['direct_payment'], 20.00 from unnest(array['$K1','$K2','$K3']::uuid[]) k;
insert into public.clients (id,studio_id,first_name,last_name,status) values ('$CL','$S','Conc','Staff','active');
insert into auth.users (id,email) values ('$UA','t-gc352-conc-a@example.test'),('$UB','t-gc352-conc-b@example.test'),('$UC','t-gc352-conc-c@example.test');
insert into public.profiles (id,email) values ('$UA','t-gc352-conc-a@example.test'),('$UB','t-gc352-conc-b@example.test'),('$UC','t-gc352-conc-c@example.test') on conflict (id) do nothing;
insert into auth.sessions (id,user_id,created_at,updated_at) values
  ('$PA','$UA',now()-interval '1 minute',now()),('$PB','$UB',now()-interval '1 minute',now()),('$PC','$UC',now()-interval '1 minute',now()),
  ('$LA','$UA',now()+interval '1 second',now()),('$LB','$UB',now()+interval '1 second',now()),('$LC','$UC',now()+interval '1 second',now());
insert into auth.mfa_amr_claims (id,session_id,created_at,updated_at,authentication_method) values
  (gen_random_uuid(),'$PA',now(),now(),'otp'),(gen_random_uuid(),'$PB',now(),now(),'otp'),(gen_random_uuid(),'$PC',now(),now(),'otp'),
  (gen_random_uuid(),'$LA',now(),now(),'password'),(gen_random_uuid(),'$LB',now(),now(),'password'),(gen_random_uuid(),'$LC',now(),now(),'password');
do \$\$
declare u uuid; p uuid; r text;
begin
  for u, p in select * from (values ('$UA'::uuid,'$PA'::uuid),('$UB'::uuid,'$PB'::uuid),('$UC'::uuid,'$PC'::uuid)) v(u,p) loop
    perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated','session_id',p)::text, true);
    set local role authenticated;
    r := public.record_email_proof_web();
    reset role;
    if r <> 'binding_required' or not public.complete_email_binding(u, p) then raise exception 'fixture binding failed for %', u; end if;
  end loop;
end \$\$;
commit;
SQL
run "$T/fixture.sql" | grep -E "ERROR" && { echo "fixture failed"; exit 1; }

val() { echo "$1" > "$T/v.sql"; run "$T/v.sql" | grep -E '"v"' | head -1 | sed -E 's/.*"v": *"([^"]*)".*/\1/'; }
as_user() { echo "select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated','session_id','$2')::text, true); set local role authenticated;"; }
as_service() { echo "select set_config('request.jwt.claims', json_build_object('role','service_role')::text, true); set local role service_role;"; }
start_sql() { echo "begin; $(as_user "$1" "$2") select hold_id from public.start_public_class_purchase('$3','Conc','Buyer'); reset role; select pg_sleep($4); commit;"; }
staff_enroll_sql() { echo "begin; insert into public.appointment_attendees (studio_id,appointment_id,client_id,status,source,billing_type) values ('$S','$K2','$CL','booked','staff','free_comped'); commit;"; }

scenario() { # name firstsql secondsql
  echo "$2" > "$T/$1.first.sql"; echo "$3" > "$T/$1.second.sql"
  ( run "$T/$1.first.sql" > "$T/$1.first.out" ) & p1=$!
  sleep 7
  s2=$(date +%s); run "$T/$1.second.sql" > "$T/$1.second.out"; e2=$(date +%s)
  wait $p1
  echo "$((e2 - s2))" > "$T/$1.second.elapsed"
}
fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2] expected [$3]"; fail=1; fi; }
blocked() { [ "$(cat "$T/$1.second.elapsed")" -ge 3 ] && echo yes || echo no; }
has() { grep -q "$2" "$T/$1" && echo yes || echo no; }

# SC1: A's start holds the one-seat class row; B's start waits, then sees A's live hold and is refused.
scenario sc1 "$(start_sql "$UA" "$LA" "$K1" 12)" "$(start_sql "$UB" "$LB" "$K1" 0)"
check "SC1 final seat: second purchaser blocked (>=3s)" "$(blocked sc1)" yes
check "SC1 final seat: first purchaser got the hold" "$(has sc1.first.out ERROR)" no
check "SC1 final seat: second purchaser refused GC35_CLASS_FULL" "$(has sc1.second.out GC35_CLASS_FULL)" yes
check "SC1 final seat: exactly one live hold" "$(val "select count(*)::text as v from public.group_class_enrollment_holds where appointment_id='$K1' and status='held'")" 1

# SC2: A's start holds class 2's row; a staff enrollment waits on the roster trigger lock, then counts A's hold.
scenario sc2 "$(start_sql "$UA" "$LA" "$K2" 12)" "$(staff_enroll_sql)"
check "SC2 hold vs staff enroll: staff insert blocked (>=3s)" "$(blocked sc2)" yes
check "SC2 hold vs staff enroll: staff refused (seat held)" "$(has sc2.second.out 'no available seats remaining')" yes
check "SC2 hold vs staff enroll: no attendee booked" "$(val "select count(*)::text as v from public.appointment_attendees where appointment_id='$K2'")" 0

# SC3: C's hold has a checkout; C's release holds the hold row lock while a finalize for the same checkout arrives.
echo "begin; $(as_user "$UC" "$LC") select hold_id from public.start_public_class_purchase('$K3','Conc','Release'); reset role; commit;" > "$T/sc3.prep1.sql"
run "$T/sc3.prep1.sql" | grep -E "ERROR" && fail=1
H3=$(val "select id::text as v from public.group_class_enrollment_holds where appointment_id='$K3' and purchaser_user_id='$UC'")
echo "begin; $(as_service) select hold_id from public.attach_public_class_purchase_checkout('$H3','acct_gc352Conc','cs_test_gc352conc3',now()+interval '30 minutes'); reset role; commit;" > "$T/sc3.prep2.sql"
run "$T/sc3.prep2.sql" | grep -E "ERROR" && fail=1
scenario sc3 \
  "begin; $(as_user "$UC" "$LC") select hold_status from public.release_public_class_purchase('$H3'); reset role; select pg_sleep(12); commit;" \
  "begin; $(as_service) select outcome, conflict_reason from public.finalize_public_class_purchase('$H3','acct_gc352Conc','cs_test_gc352conc3','pi_test_gc352conc3',2000,'usd'); reset role; commit;"
check "SC3 release vs finalize: finalize blocked (>=3s)" "$(blocked sc3)" yes
check "SC3 release vs finalize: finalize saw the release (conflict hold_released)" "$(has sc3.second.out hold_released)" yes
check "SC3 release vs finalize: hold is a conflict with paid evidence and no client" "$(val "select h.status || '/' || h.conflict_reason || '/' || p.status::text || '/' || coalesce(p.client_id::text,'none') as v from public.group_class_enrollment_holds h join public.payments p on p.id = h.payment_id where h.id='$H3'")" "conflict/hold_released/paid/none"

check "no deadlock or lock timeout in any session" "$(cat "$T"/*.out | grep -ciE 'deadlock|lock timeout|could not obtain lock')" 0
exit $fail
