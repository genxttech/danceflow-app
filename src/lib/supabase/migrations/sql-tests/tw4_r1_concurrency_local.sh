#!/usr/bin/env bash
# TW-4 R1 two-session concurrency checks (LOCAL / DISPOSABLE postgres only). Real, committed data and two simultaneous psql sessions:
#   C1  two simultaneous claims of the same studio: exactly one wins, the other waits for the first to finish and is then refused (55P03)
#   C2  two simultaneous begin_step calls for the PAID brand on one lease: exactly one is told to execute, the other is told to reconcile
#   C3  the paid brand step cannot start for a second run after the first run's lease expired and was taken over (the old holder is refused)
#   C4  closing the window stops the next step to begin (the kill switch takes effect when the change commits); reopening resumes
# usage: tw4_r1_concurrency_local.sh <container>   (a container that already has TW-4A, 4A.1, R1 and R1.1 applied; e.g. tw4a-sqlvalidate)
set -u
C="${1:-tw4a-sqlvalidate}"
P="docker exec -i $C psql -U postgres -At -v ON_ERROR_STOP=0"
TMP="$(mktemp -d)"
fail=0
ok()   { echo "PASS $1"; }
bad()  { echo "FAIL $1 :: $2"; fail=1; }

S=a5c10000-0000-4000-8000-00000000000a
ADM=a5c10000-0000-4000-8000-000000000401
OWN=a5c10000-0000-4000-8000-000000000101
SID_BU="BU$(printf 'a%.0s' $(seq 1 32))"

cleanup() {
  $P -c "delete from public.studio_sms_registrations where studio_id='$S'; delete from public.studios where id='$S'; delete from auth.users where id in ('$ADM','$OWN');" >/dev/null 2>&1
}
cleanup
$P -q -c "
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
 ('$ADM','00000000-0000-0000-0000-000000000000','authenticated','authenticated','padmin@tw4conc.invalid',now(),now()),
 ('$OWN','00000000-0000-0000-0000-000000000000','authenticated','authenticated','owner@tw4conc.invalid',now(),now());
insert into public.profiles (id, platform_role) values ('$ADM','platform_admin'),('$OWN',null) on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug) values ('$S','TW4 Concurrency Studio','tw4-concurrency-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$OWN','$S','studio_owner',true);
insert into public.studio_sms_onboarding_access (studio_id, enabled, reason) values ('$S', true, 'concurrency fixtures');
insert into public.studio_sms_onboarding (studio_id, created_by, legal_name, entity_type, industry, website_choice, address_line1, city, region, postal_code,
  rep_first_name, rep_last_name, rep_title, rep_position, rep_email, rep_phone, ein_ciphertext, ein_key_id, ein_last4, ein_stored_at)
values ('$S','$OWN','Concurrency LLC','llc','EDUCATION','danceflow','1 Test Way','Portland','OR','97201','Syn','Thetic','Owner','ceo','o@tw4conc.invalid','+15035550100',
  'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCC','v1','9999',now());
update public.studio_sms_onboarding set state='submitted_for_checks', submission_seq=1, submitted_at=now(), attested_by='$OWN', attested_at=now(),
  attestation_version='tw4a-v1', attestation='{\"authorized\":true,\"accurate\":true,\"opt_in_only\":true,\"fees_terms\":true}'::jsonb where studio_id='$S';
select public.tw4_runner_set_window('$S','$ADM',24,'concurrency fixtures');
" || { echo "fixture setup failed"; exit 2; }
ONB=$($P -c "select id from public.studio_sms_onboarding where studio_id='$S'")

# ---- C1: two simultaneous claims -----------------------------------------------------------------------------------------------
( $P -c "begin; select 'A:' || ((public.tw4_runner_claim('$S','$ADM','owner-a',300))->>'state'); select pg_sleep(2); commit;" > "$TMP/c1a" 2>&1 ) &
sleep 0.6
start=$(date +%s%N)
$P -c "select 'B:' || ((public.tw4_runner_claim('$S','$ADM','owner-b',300))->>'state');" > "$TMP/c1b" 2>&1
end=$(date +%s%N)
wait
elapsed_ms=$(( (end - start) / 1000000 ))
if grep -q "A:submitted_for_checks" "$TMP/c1a" && grep -q "55P03\|another run holds the lease" "$TMP/c1b" && ! grep -q "^B:" "$TMP/c1b" && [ "$elapsed_ms" -gt 1000 ]; then ok "C1 one claim wins; the other waited (${elapsed_ms} ms) and was refused"; else bad C1 "$(cat $TMP/c1a $TMP/c1b | tr '\n' ' ')"; fi
$P -q -c "select public.tw4_runner_release('$ONB','owner-a');" >/dev/null

# ---- C2: two simultaneous paid-step begins on one lease ------------------------------------------------------------------------
$P -q -c "select public.tw4_runner_claim('$S','$ADM','owner-c',300);" >/dev/null
$P -q -c "select public.tw4_runner_begin_step('$ONB','owner-c','S1','df:t:S1',false,null); select public.tw4_runner_finish_step('$ONB','owner-c','S1','succeeded','$SID_BU',null,null);" >/dev/null
( $P -c "begin; select 'A:' || ((public.tw4_runner_begin_step('$ONB','owner-c','B1','df:t:B1',true,'$ADM',false))->>'action'); select pg_sleep(2); commit;" > "$TMP/c2a" 2>&1 ) &
sleep 0.6
$P -c "select 'B:' || ((public.tw4_runner_begin_step('$ONB','owner-c','B1','df:t:B1',true,'$ADM',false))->>'action');" > "$TMP/c2b" 2>&1
wait
if grep -q "A:execute" "$TMP/c2a" && grep -q "B:reconcile" "$TMP/c2b"; then ok "C2 exactly one paid begin executes; the concurrent one is told to reconcile"; else bad C2 "$(cat $TMP/c2a $TMP/c2b | tr '\n' ' ')"; fi
nrows=$($P -c "select count(*) from public.studio_sms_provisioning_steps where onboarding_id='$ONB' and step_key='B1'")
[ "$nrows" = "1" ] && ok "C2b one ledger row for the paid step" || bad C2b "rows=$nrows"

# ---- C3: lease takeover: the old holder is refused ----------------------------------------------------------------------------------
$P -q -c "update public.studio_sms_onboarding set lease_expires_at = now() - interval '1 second' where id='$ONB';" >/dev/null
$P -c "select 'T:' || ((public.tw4_runner_claim('$S','$ADM','owner-d',300))->>'state');" > "$TMP/c3a" 2>&1
$P -c "select public.tw4_runner_begin_step('$ONB','owner-c','B1','df:t:B1',true,'$ADM',false);" > "$TMP/c3b" 2>&1
$P -c "select public.tw4_runner_finish_step('$ONB','owner-c','B1','succeeded','BN$(printf 'b%.0s' $(seq 1 32))',null,null);" > "$TMP/c3c" 2>&1
if grep -q "^T:submitted_for_checks" "$TMP/c3a" && grep -q "lease not held\|55P03" "$TMP/c3b" && grep -q "lease not held\|55P03" "$TMP/c3c"; then ok "C3 after takeover the old lease holder can neither begin nor finish a step"; else bad C3 "$(cat $TMP/c3a $TMP/c3b $TMP/c3c | tr '\n' ' ')"; fi
st=$($P -c "select status from public.studio_sms_provisioning_steps where onboarding_id='$ONB' and step_key='B1'")
[ "$st" = "in_flight" ] && ok "C3b the open paid step was not completed by the cut-off holder" || bad C3b "status=$st"

# ---- C4: the kill switch takes effect as soon as the window change commits --------------------------------------------------------
# (a step that begins in the instant BEFORE the change commits still sees the open window: ordinary read-committed behavior, documented in the dry-run report)
$P -q -c "select public.tw4_runner_set_window('$S','$ADM',0,'kill switch');" >/dev/null
$P -c "select public.tw4_runner_begin_step('$ONB','owner-d','S2','df:t:S2',false,null);" > "$TMP/c4b" 2>&1
if grep -q "window for this studio is closed" "$TMP/c4b"; then ok "C4 the first step to begin after the window change committed is refused"; else bad C4 "$(cat $TMP/c4b | tr '
' ' ')"; fi
$P -q -c "select public.tw4_runner_set_window('$S','$ADM',24,'reopen');" >/dev/null
$P -c "select (public.tw4_runner_begin_step('$ONB','owner-d','S2','df:t:S2',false,null))->>'action';" > "$TMP/c4c" 2>&1
if grep -q "execute" "$TMP/c4c"; then ok "C4b reopening the window lets the lease holder continue"; else bad C4b "$(cat $TMP/c4c | tr '
' ' ')"; fi

cleanup
rm -rf "$TMP"
[ "$fail" = "0" ] && echo "R1 CONCURRENCY PASS" || echo "R1 CONCURRENCY FAIL"
exit $fail
