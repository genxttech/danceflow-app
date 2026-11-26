#!/usr/bin/env bash
# NSI I3-2 (M16b) lifecycle harness. LOCAL DISPOSABLE CONTAINERS ONLY (nsi-i2-*). Builds its own containers.
#   container 1 (LC): M1-M16a -> M16b; suites; suite-level mutation probes; replays and refusals; rollback to M16a exact; preflight
#   container 2 (RACE): M1-M16b; M16b races, M16a / M15 / M14 races (regression); harness-level probes
# usage: nsi_i3_2_m16b_lifecycle_local.sh <public-schema-dump.sql> [all|suite|probes|rest|race]
set -u
PUB="${1:?schema dump}"; STAGE="${2:-all}"
D="$(cd "$(dirname "$0")" && pwd)"; M="$D/.."; R="$M/rollback"
TMPD="${TMPDIR:-/tmp}"
FP="${NSI_APPT_FP:-ff651a6c438d40a001e52ef1625c9043}"
FILES=(20261118090000_nsi_i1_m1_config_helpers 20261118091000_nsi_i1_m2_governance 20261118092000_nsi_i1_m3_live_personal 20261118093000_nsi_i1_m4_retained_evidence 20261118094000_nsi_i1_m5_functions 20261118095000_nsi_i2_eligibility_preview 20261118096000_nsi_i2_m7_pilot_grants 20261118097000_nsi_i2_m8_lesson_types_simulation 20261118098000_nsi_i2_m9_template_archiving 20261118099000_nsi_i2_m10_ensure_request_evaluator 20261118100000_nsi_i2_m11_ensure_request_hardening 20261118101000_nsi_i3_m12_invitations_sessions 20261118102000_nsi_i3_m13_purge_hardening 20261118103000_nsi_i3_m14_hold_semantics 20261118104000_nsi_i3_m15_minor_determination 20261118105000_nsi_i3_m16a_guardian_attestation 20261118106000_nsi_i3_m16b_guardian_challenge)
fail=0
say() { echo "$*"; }
bad() { echo "FAIL: $*"; fail=$((fail+1)); }
newdb() {
  local C="$1"; docker rm -f "$C" >/dev/null 2>&1
  docker run -d --name "$C" -e POSTGRES_PASSWORD=postgres public.ecr.aws/supabase/postgres:17.6.1.106 >/dev/null
  for i in $(seq 1 30); do docker exec "$C" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done; sleep 8
  docker exec -i "$C" psql -U postgres -q -c "create schema if not exists extensions" >/dev/null 2>&1
  docker exec -i "$C" psql -U postgres -q < "$PUB" >/dev/null 2>&1
  docker exec -e PGPASSWORD=postgres -i "$C" psql -h localhost -U supabase_admin -d postgres -q -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid \$\$" >/dev/null 2>&1
}
applyfile() { out=$(docker exec -i "$1" psql -U postgres -q -v ON_ERROR_STOP=1 < "$2" 2>&1 | grep -iE "^ERROR|FATAL" | head -2); [ -n "$out" ] && { echo "$out"; return 1; }; return 0; }
apply() { o=$(applyfile "$1" "$M/${FILES[$(($2-1))]}.sql") || { bad "apply M$2 on $1: $o"; return 1; }; return 0; }
fp() { docker exec -i "$1" psql -U postgres -At -f - < "$D/nsi_i2_catalog_fingerprint_local.sql" 2>&1 | head -1; }
suite() { r=$(LINES_OUT=2 "$D/run_i2_m7_m9_local.sh" "$1" "$2" "$FP" | grep -E "SUITE" | head -1); say "   $3: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "$3: $r"; }
legacy() { for f in test_T_nsi_i1_foundation test_T_nsi_i2_local; do
    r=$({ echo "set nsi.test_local = 'on'; set nsi.appointments_fp = '$FP';"; cat "$D/$f.sql"; } | docker exec -i "$1" psql -U postgres -q 2>&1 | grep -E "SUITE" | head -1 | cut -c1-3000)
    say "   $2 $f: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "$2 $f: $r"; done; }
devsafe() { for f in test_T_nsi_i3_1_devsafe test_T_nsi_i3_3_devsafe test_T_nsi_i3_2_devsafe test_T_nsi_i3_2_m16b_devsafe; do
    r=$(docker exec -i "$1" psql -U postgres -q < "$D/$f.sql" 2>&1 | grep -E "SUITE" | head -1 | cut -c1-1500)
    say "   $f: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "$f: $r"; done; }
upto() { local C="$1" n="$2"; newdb "$C"; for i in $(seq 1 "$n"); do apply "$C" "$i" || return 1; done; }
sql() { docker exec -i "$1" psql -U postgres -At -c "$2" 2>&1; }

M16B="${FILES[16]}"
RBM16B=20261118106000_nsi_i3_m16b_guardian_challenge_rollback
RBM16=20261118105000_nsi_i3_m16a_guardian_attestation_rollback
EXPECT16="${NSI_EXPECT16:-63e82e902ac004b406195a9164b944b2|807}"
SHAPE="select md5(coalesce((select string_agg(conrelid::regclass::text || conname || pg_get_constraintdef(oid), ';' order by conrelid::regclass::text, conname) from pg_constraint where conrelid in ('public.intake_invitations'::regclass, 'public.intake_sessions'::regclass, 'public.intake_respondents'::regclass)), '') || coalesce((select string_agg(indexdef, ';' order by indexname) from pg_indexes where schemaname = 'public' and tablename like 'intake\_%'), '') || coalesce((select string_agg(table_name || column_name, ';' order by table_name, column_name) from information_schema.columns where table_schema = 'public' and table_name like 'intake\_%'), ''))"

C=nsi-i2-m16b
if [ "$STAGE" = "all" ] || [ "$STAGE" = "suite" ] || [ "$STAGE" = "probes" ] || [ "$STAGE" = "rest" ]; then
say "== container LC: M1-M16a, then M16b"
upto $C 16 || exit 1
F16=$(fp $C); say "   fingerprint M16a: $F16"; [ "$F16" = "$EXPECT16" ] || bad "M16a fingerprint is not the DEV-applied value ($EXPECT16)"
SHAPE16=$(sql $C "$SHAPE")
apply $C 17 || exit 1
F17=$(fp $C); say "   fingerprint M16b: $F17"; [ "$F16" != "$F17" ] || bad "M16b did not change the catalog"
suite $C test_T_nsi_i3_2_m16b_local.sql "M16b boundary suite"
fi
if [ "$STAGE" = "all" ] || [ "$STAGE" = "suite" ]; then
suite $C test_T_nsi_i3_2_m16a_local.sql "M16a suite on M16b"
suite $C test_T_nsi_i3_3_m15_local.sql "M15 suite on M16b"
suite $C test_T_nsi_i3_1_m14_local.sql "M14 suite on M16b"
suite $C test_T_nsi_i3_1_m13_local.sql "M13 suite on M16b"
suite $C test_T_nsi_i3_1_local.sql "M12 suite on M16b"
suite $C test_T_nsi_i2_m11_ensure_request_local.sql "M11 suite on M16b"
legacy $C "M16b"
devsafe $C
fi

if [ "$STAGE" = "all" ] || [ "$STAGE" = "probes" ]; then
say "== suite-level mutation probes on M16b (each mutated copy must make the named check FAIL; the good file is re-applied afterwards)"
mutate() { # label function from to expected-check
  node -e '
    const fs = require("fs"); const [src, out, fn, from, to] = process.argv.slice(1);
    const s = fs.readFileSync(src, "utf8").replace(/\r\n/g, "\n");
    const a = s.indexOf("create or replace function " + fn + "("); if (a < 0) { console.error("no function " + fn); process.exit(2); }
    const b = s.indexOf("\nend $$;", a); const body = s.slice(a, b);
    const n = body.split(from).length - 1; if (n !== 1) { console.error("matches " + n); process.exit(2); }
    fs.writeFileSync(out, s.slice(0, a) + body.replace(from, () => to) + s.slice(b));
  ' "$M/$M16B.sql" "$TMPD/m16b_mut.sql" "$2" "$3" "$4" || { bad "probe $1: the mutation did not apply to the source"; return; }
  o=$(applyfile $C "$TMPD/m16b_mut.sql") || { bad "probe $1: the mutated file did not apply: $o"; apply $C 17; return; }
  r=$(LINES_OUT=2 "$D/run_i2_m7_m9_local.sh" $C test_T_nsi_i3_2_m16b_local.sql "$FP" | grep -E "SUITE|^ERROR" | head -1)
  if echo "$r" | grep -qE "FAIL|ERROR" && echo "$r" | grep -q "$5"; then say "   probe $1: detected ($5)"; else bad "probe $1 NOT detected ($5): ${r:0:240}"; fi
  apply $C 17 || true
}
RQ=public.intake_guardian_request_invitation; FI=public.intake_guardian_finalize_invitation; TG=public.intake_guardian_challenge_target
IS=public.intake_issue_email_challenge; VE=public.intake_verify_email_challenge; RG=intake_private.respondents_guard; LV=intake_private.link_valid
ER=intake_private.erase_client_impl; PU=intake_private.purge_expired_impl
mutate "request without the minor check" $RQ "if v_minor is distinct from true then return 'not_minor'; end if;" "null;" "B02"
mutate "request ignores a linked recipient" $RQ "if q.guardian_recipient_link_id is not null then return 'recipient_link_set'; end if;" "null;" "B02"
mutate "request keeps the old invitation" $RQ "where i.request_id = q.id and i.audience = 'guardian' and i.revoked_at is null;" "where false;" "B03"
mutate "request keeps old sessions" $RQ "where s.request_id = q.id and s.audience = 'guardian' and s.revoked_at is null;" "where false;" "B03"
mutate "request keeps open challenges" $RQ "where c.request_id = q.id and c.consumed_at is null and c.superseded_at is null;" "where false;" "B03"
mutate "request keeps the respondent" $RQ "where p.request_id = q.id and p.role = 'guardian' and p.superseded_at is null;" "where false;" "B03"
mutate "finalize ignores pending expiry" $FI "if g.expires_at <= now() then return 'expired'; end if;" "null;" "B04b"
mutate "finalize ignores a later staff revoke" $FI "i.revoked_reason = 'staff_revoked' and i.revoked_at > g.requested_at" "false" "B04b"
mutate "finalize without the minor check" $FI "if v_minor is distinct from true then return 'not_minor'; end if;" "null;" "B04b"
mutate "finalize ignores a linked recipient" $FI "if q.guardian_recipient_link_id is not null then return 'recipient_link_set'; end if;" "null;" "B04b"
mutate "finalize keeps an interim respondent" $FI "where p.request_id = q.id and p.role = 'guardian' and p.superseded_at is null;" "where false;" "B04c"
mutate "address read ignores the bound recipient" $TG "and p.email_hmac = i.recipient_email_hmac and p.email_hmac_kid = i.recipient_email_hmac_kid;" ";" "B07a"
mutate "address read ignores assurance" $TG "and p.assurance = 'declared_unverified' and p.email is not null" "and p.email is not null" "B07a"
mutate "issue ignores the send-to hash" $IS "or i.recipient_email_hmac is distinct from p_send_to_email_hmac or i.recipient_email_hmac_kid is distinct from p_send_to_kid then" "then" "B07b"
mutate "issue ignores the respondent hash" $IS "if i.recipient_email_hmac is distinct from p.email_hmac or i.recipient_email_hmac_kid is distinct from p.email_hmac_kid" "if false" "B07b"
mutate "issue ignores the buckets" $IS "if not v_ok then return 'limited'; end if;" "null;" "B08a"
mutate "no hourly cap" $IS "interval '60 minutes') >= 5" "interval '60 minutes') >= 500" "B08b"
mutate "no daily cap" $IS "interval '24 hours') >= 10" "interval '24 hours') >= 500" "B08b"
mutate "no per-invitation cap" $IS "where c.invitation_id = i.id) >= 50 then" "where c.invitation_id = i.id) >= 500 then" "B08b"
mutate "issue keeps the open challenge" $IS "where c.respondent_id = p.id and c.consumed_at is null and c.superseded_at is null;" "where false;" "B08b"
mutate "verify does not count" $VE "set attempts = x.attempts + 1 where x.id = c.id;" "set attempts = x.attempts where x.id = c.id;" "B09a"
mutate "verify never locks" $VE "if c.attempts >= 5 then return 'locked'; end if;" "null;" "B09a"
mutate "verify ignores expiry" $VE "if c.expires_at <= now() then return 'expired'; end if;" "null;" "B09b"
mutate "verify ignores the invitation" $VE " or c.invitation_id <> s.invitation_id then return 'invalid'" " then return 'invalid'" "B09b"
mutate "verify ignores existing assurance" $VE "if p.assurance <> 'declared_unverified' then return 'already_done'; end if;" "null;" "B09b"
mutate "guard without consumption" $RG "and c.consumed_at is not null " "" "B10"
mutate "guard allows a revoked invitation" $RG "and i.audience = 'guardian' and i.revoked_at is null" "and i.audience = 'guardian'" "B10"
mutate "guard allows an older generation" $RG "and i.generation = (select max(x.generation) from public.intake_invitations x" "and i.generation <= (select max(x.generation) from public.intake_invitations x" "B10"
mutate "guard ignores the hash" $RG "and c.email_hmac = new.email_hmac and c.email_hmac_kid = new.email_hmac_kid" "" "B10"
mutate "guardian link ignores the determination" $LV "if v_minor is distinct from true then return false; end if;" "null;" "B06"
mutate "guardian link ignores a linked recipient" $LV "if q.guardian_recipient_link_id is not null then return false; end if;" "null;" "B06"
mutate "recipient not immutable" intake_private.invitations_update_guard "or new.recipient_email_hmac is distinct from old.recipient_email_hmac or new.recipient_email_hmac_kid is distinct from old.recipient_email_hmac_kid" "" "B05a"
mutate "student re-issue ends all sessions" public.intake_issue_invitation "and s.audience = 'student' and s.revoked_at is null;" "and s.revoked_at is null;" "B06"
mutate "revoke-all keeps open requests" public.intake_revoke_invitations "where g.request_id = p_request_id and g.studio_id = p_studio_id and g.finalized_at is null and g.superseded_at is null;" "where false;" "B04b"
mutate "pending rows mutable" intake_private.guardian_requests_update_guard "or new.recipient_email_hmac <> old.recipient_email_hmac or new.recipient_email_hmac_kid <> old.recipient_email_hmac_kid" "" "B05b"
mutate "attempts can jump" intake_private.challenges_update_guard "new.attempts <> old.attempts + 1 or " "" "B05b"
mutate "challenge hash unchecked on insert" intake_private.challenges_insert_guard "if p.email_hmac is distinct from new.email_hmac or p.email_hmac_kid is distinct from new.email_hmac_kid then" "if false then" "B05b"
mutate "erase keeps challenges" $ER "delete from public.intake_email_challenges where studio_id = p_studio_id and client_id = p_client_id;" "null;" "B11"
mutate "erase keeps pending requests" $ER "delete from public.intake_guardian_invitation_requests where studio_id = p_studio_id and client_id = p_client_id;" "null;" "B11"
mutate "purge deletes consumed challenges" $PU "where x.consumed_at is null and x.expires_at < now() - interval '24 hours'" "where x.expires_at < now() - interval '24 hours'" "B12b"
mutate "purge ignores the invitation state" $PU "and (i.expires_at < now() - interval '24 hours' or i.revoked_at < now() - interval '24 hours')
      and (x.studio_id" "and (x.studio_id" "B12b"
mutate "purge drops referenced pending rows" $PU "and i.expires_at < now() - interval '90 days'
                      and not exists (select 1 from public.intake_email_challenges ch where ch.invitation_id = i.id)))" "and i.expires_at < now() - interval '90 days'))" "B12b"
mutate "purge deletes unexpired requests" $PU "where ((x.finalized_at is null and x.expires_at < now())" "where ((x.finalized_at is null)" "B12c"
mutate "purge deletes referenced invitations" $PU "      and not exists (select 1 from public.intake_sessions s2 where s2.invitation_id = x.id)
         and not exists (select 1 from public.intake_email_challenges ch where ch.invitation_id = x.id)
         and not exists (select 1 from public.intake_guardian_invitation_requests g2 where g2.finalized_invitation_id = x.id)" "      and not exists (select 1 from public.intake_sessions s2 where s2.invitation_id = x.id)" "B12a"
[ "$(fp $C)" = "$F17" ] && say "   catalog identical after the probes" || bad "catalog differs after the probes"
suite $C test_T_nsi_i3_2_m16b_local.sql "M16b boundary suite after the probes"
fi

if [ "$STAGE" = "all" ] || [ "$STAGE" = "rest" ]; then
say "== replays and refusals on an M16b database"
apply $C 17 && say "   replay M16b ok"; [ "$(fp $C)" = "$F17" ] && say "   fingerprint unchanged by the M16b replay" || bad "M16b replay changed the catalog"
e=$(applyfile $C "$M/${FILES[15]}.sql"); echo "$e" | grep -qE "later NSI migration|requires M15" && say "   M16a replay over M16b refused" || bad "M16a replay over M16b not refused: $e"
e=$(applyfile $C "$R/$RBM16.sql"); echo "$e" | grep -q "later NSI migration" && say "   M16a rollback over M16b refused" || bad "M16a rollback over M16b not refused: $e"
[ "$(fp $C)" = "$F17" ] && say "   refusals left the catalog unchanged" || bad "refusals changed the catalog"
sql $C "create or replace function intake_private.zz_m16c_probe() returns void language sql as \$\$ select 1 -- nsi-body:m16c \$\$;" >/dev/null
e=$(applyfile $C "$M/$M16B.sql"); echo "$e" | grep -q "later NSI migration" && say "   M16b replay refused when an m16c marker exists" || bad "M16b replay not refused with an m16c marker: $e"
e=$(applyfile $C "$R/$RBM16B.sql"); echo "$e" | grep -q "later NSI migration" && say "   M16b rollback refused when an m16c marker exists" || bad "M16b rollback not refused with an m16c marker: $e"
sql $C "drop function intake_private.zz_m16c_probe();" >/dev/null

say "== rollback refusals, one row type at a time"
X=a5a00000-0000-0000-0000-0000000000e1
refuse() { # label insert delete expected
  sql $C "set session_replication_role = replica; $2" >/dev/null
  e=$(applyfile $C "$R/$RBM16B.sql"); echo "$e" | grep -q "$4" && say "   rollback refused: $1" || bad "rollback not refused ($1): $e"
  sql $C "set session_replication_role = replica; $3" >/dev/null
}
refuse "pending request row" "insert into public.intake_guardian_invitation_requests (id, studio_id, request_id, client_id, recipient_email_hmac, recipient_email_hmac_kid, requested_by, expires_at) values ('$X', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'h', 1, gen_random_uuid(), now() + interval '1 minute');" "delete from public.intake_guardian_invitation_requests where id = '$X';" "guardian invitation request rows exist"
refuse "challenge row" "insert into public.intake_email_challenges (id, studio_id, request_id, client_id, respondent_id, invitation_id, email_hmac, email_hmac_kid, code_hash, expires_at) values ('$X', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'h', 1, sha256('x'::bytea), now());" "delete from public.intake_email_challenges where id = '$X';" "email challenge rows exist"
refuse "guardian invitation" "insert into public.intake_invitations (id, studio_id, request_id, audience, generation, kid, token_salt, token_hash, issued_by, pinned_version_id, expires_at, recipient_email_hmac, recipient_email_hmac_kid) values ('$X', gen_random_uuid(), gen_random_uuid(), 'guardian', 1, 'kid00001', decode(repeat('ab', 16), 'hex'), sha256('y'::bytea), 'two_party', gen_random_uuid(), now(), 'h', 1);" "delete from public.intake_invitations where id = '$X';" "guardian invitations exist"
refuse "guardian session" "insert into public.intake_sessions (id, studio_id, request_id, invitation_id, audience, session_hash, idle_seconds, idle_expires_at, absolute_expires_at) values ('$X', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'guardian', sha256('z'::bytea), 600, now(), now());" "delete from public.intake_sessions where id = '$X';" "guardian sessions exist"
refuse "verified respondent" "insert into public.intake_respondents (id, studio_id, request_id, client_id, role, display_name, declared_relationship, assurance) values ('$X', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'guardian', 'x', 'parent', 'email_code_verified');" "delete from public.intake_respondents where id = '$X';" "email_code_verified respondents exist"
for ev in guardian_invitation_requested guardian_invitation_issued guardian_email_challenge_issued guardian_email_verified; do
  refuse "$ev event" "insert into public.intake_audit_events (studio_id, event_type, actor_type, retention_class, retention_state) values (gen_random_uuid(), '$ev', 'system', 'operational', 'pending_policy');" "delete from public.intake_audit_events where event_type = '$ev';" "audit events exist"
done
[ "$(fp $C)" = "$F17" ] && say "   refused rollbacks left the catalog unchanged" || bad "refused rollbacks changed the catalog"

say "== rollback restores M16a exactly"
e=$(applyfile $C "$R/$RBM16B.sql") && [ "$(fp $C)" = "$F16" ] && say "   rollback M16b -> M16a fingerprint identical" || bad "rollback M16b: $e (fp $(fp $C))"
[ "$(sql $C "$SHAPE")" = "$SHAPE16" ] && say "   constraints, indexes and columns identical to M16a" || bad "constraints / indexes / columns differ from M16a after rollback"
suite $C test_T_nsi_i3_2_m16a_local.sql "M16a suite after rollback"
suite $C test_T_nsi_i3_3_m15_local.sql "M15 suite after rollback"
suite $C test_T_nsi_i3_1_m14_local.sql "M14 suite after rollback"
e=$(applyfile $C "$R/$RBM16B.sql"); echo "$e" | grep -q "refused" && say "   second rollback refused on an M16a database" || bad "rollback not refused on M16a: $e"

say "== forward preflight: two current guardian respondents on one request"
sql $C "set session_replication_role = replica; insert into public.intake_respondents (studio_id, request_id, client_id, role, display_name, declared_relationship, assurance) select '$X', '$X', '$X', 'guardian', 'x', 'parent', 'declared_unverified' from generate_series(1, 2);" >/dev/null
e=$(applyfile $C "$M/$M16B.sql"); echo "$e" | grep -q "more than one current guardian respondent" && say "   M16b refused with the count" || bad "preflight did not refuse: $e"
[ "$(fp $C)" = "$F16" ] && [ "$(sql $C "$SHAPE")" = "$SHAPE16" ] && say "   the refused migration changed nothing" || bad "the refused migration changed the catalog"
sql $C "set session_replication_role = replica; delete from public.intake_respondents where request_id = '$X';" >/dev/null
apply $C 17; [ "$(fp $C)" = "$F17" ] && say "   re-applied M16b fingerprint identical" || bad "re-apply differs"
fi
[ "$STAGE" = "all" ] && docker rm -f $C >/dev/null 2>&1

if [ "$STAGE" = "all" ] || [ "$STAGE" = "race" ]; then
say "== container RACE: M1-M16b; M16b races, M16a / M15 / M14 races (regression), harness-level probes"
C=nsi-i2-m16br; upto $C 17 || exit 1
r=$(bash "$D/concurrency/nsi_m16b_race_local.sh" $C 0 2>&1 | tail -40); echo "$r" | sed 's/^/   [M16b] /'
echo "$r" | grep -q "SUMMARY m16b races: failures=0" || bad "M16b race harness"
r=$(bash "$D/concurrency/nsi_m16a_race_local.sh" $C 0 2>&1 | tail -30); echo "$r" | sed 's/^/   [M16a on M16b] /'
echo "$r" | grep -q "SUMMARY m16a races: failures=0" || bad "M16a race harness on M16b"
r=$(bash "$D/concurrency/nsi_m15_race_local.sh" $C 100 2>&1 | tail -30); echo "$r" | sed 's/^/   [M15 on M16b] /'
echo "$r" | grep -q "SUMMARY m15 races: failures=0" || bad "M15 race harness on M16b"
r=$(bash "$D/concurrency/nsi_m14_race_local.sh" $C fixed 200 2>&1 | tail -22); echo "$r" | sed 's/^/   [M14 on M16b] /'
echo "$r" | grep -q "SUMMARY m14 races (fixed): failures=0" || bad "M14 race harness on M16b"
raceprobe() { # label offset scenario function from to
  node -e '
    const fs = require("fs"); const [src, out, fn, from, to] = process.argv.slice(1);
    const s = fs.readFileSync(src, "utf8").replace(/\r\n/g, "\n");
    const a = s.indexOf("create or replace function " + fn + "("); const b = s.indexOf("\nend $$;", a); const body = s.slice(a, b);
    if (a < 0 || body.split(from).length !== 2) { console.error("mutation does not match once"); process.exit(2); }
    fs.writeFileSync(out, s.slice(0, a) + body.replace(from, () => to) + s.slice(b));
  ' "$M/$M16B.sql" "$TMPD/m16b_race_mut.sql" "$4" "$5" "$6" || { bad "race probe $1: the mutation did not apply"; return; }
  o=$(applyfile $C "$TMPD/m16b_race_mut.sql") || { bad "race probe $1: mutated file did not apply: $o"; apply $C 17; return; }
  r=$(bash "$D/concurrency/nsi_m16b_race_local.sh" $C $2 2>&1 | tail -40)
  if echo "$r" | grep -q "SUMMARY m16b races: failures=[1-9]" && echo "$r" | grep -E "FAIL" | grep -q "$3"; then say "   race probe $1: detected ($3)"; else bad "race probe $1 NOT detected ($3)"; fi
  apply $C 17 || true
}
raceprobe "request without lock_client" 1000 "A1" public.intake_guardian_request_invitation "perform intake_private.lock_client(p_studio_id, v_client);" "null;"
raceprobe "issue without lock_client" 2000 "A2" public.intake_issue_email_challenge "perform intake_private.lock_client(s.studio_id, v_client);" "null;"
raceprobe "verify without lock_client" 3000 "A3" public.intake_verify_email_challenge "perform intake_private.lock_client(s.studio_id, v_client);" "null;"
raceprobe "finalize without lock_client" 4000 "B1" public.intake_guardian_finalize_invitation "perform intake_private.lock_client(v_studio, v_client);" "null;"
raceprobe "verify without the isolation guard" 5000 "E1" public.intake_verify_email_challenge "if current_setting('transaction_isolation') <> 'read committed' then" "if false then"
raceprobe "purge deletes challenges of unlocked clients" 6000 "P1" intake_private.purge_expired_impl "and (x.studio_id::text || ':' || x.client_id::text) = any (v_locked)
      and not intake_private.client_has_active_hold(x.studio_id, x.client_id)
    order by x.expires_at, x.id limit p_limit);
  get diagnostics v_c = row_count;" "and not intake_private.client_has_active_hold(x.studio_id, x.client_id)
    order by x.expires_at, x.id limit p_limit);
  get diagnostics v_c = row_count;"
docker rm -f $C >/dev/null 2>&1
fi
say "SUMMARY m16b lifecycle ($STAGE): failures=$fail"
[ "$fail" = "0" ]
