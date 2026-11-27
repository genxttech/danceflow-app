#!/usr/bin/env bash
# NSI I3-1 (M12) lifecycle harness. LOCAL DISPOSABLE CONTAINERS ONLY (nsi-i2-*). Builds its own container.
#   M1-M11 -> M12; boundary suites at M12; mutation probes (the M12 suite must FAIL on each mutated copy, then the good file is re-applied);
#   rollback M12 restores the M11 fingerprint EXACTLY; rollback refused once an M12 audit event exists; forward again reproduces M12; replays.
# usage: nsi_i3_1_lifecycle_local.sh <public-schema-dump.sql>
set -u
PUB="${1:?schema dump}"
D="$(cd "$(dirname "$0")" && pwd)"; M="$D/.."; R="$M/rollback"
TMPD="${TMPDIR:-/tmp}"
FP="${NSI_APPT_FP:-ff651a6c438d40a001e52ef1625c9043}"
FILES=(20261118090000_nsi_i1_m1_config_helpers 20261118091000_nsi_i1_m2_governance 20261118092000_nsi_i1_m3_live_personal 20261118093000_nsi_i1_m4_retained_evidence 20261118094000_nsi_i1_m5_functions 20261118095000_nsi_i2_eligibility_preview 20261118096000_nsi_i2_m7_pilot_grants 20261118097000_nsi_i2_m8_lesson_types_simulation 20261118098000_nsi_i2_m9_template_archiving 20261118099000_nsi_i2_m10_ensure_request_evaluator 20261118100000_nsi_i2_m11_ensure_request_hardening 20261118101000_nsi_i3_m12_invitations_sessions)
RB12=20261118101000_nsi_i3_m12_invitations_sessions_rollback
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
apply() { o=$(applyfile "$1" "$M/${FILES[$(($2-1))]}.sql") || { bad "apply M$2: $o"; return 1; }; return 0; }
fp() { docker exec -i "$1" psql -U postgres -At -f - < "$D/nsi_i2_catalog_fingerprint_local.sql" 2>&1 | head -1; }
suite() { r=$(LINES_OUT=2 "$D/run_i2_m7_m9_local.sh" "$1" "$2" "$FP" | grep -E "SUITE" | head -1); say "   $3: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "$3: $r"; }
legacy() { for f in test_T_nsi_i1_foundation test_T_nsi_i2_local; do
    r=$({ echo "set nsi.test_local = 'on'; set nsi.appointments_fp = '$FP';"; cat "$D/$f.sql"; } | docker exec -i "$1" psql -U postgres -q 2>&1 | grep -E "SUITE" | head -1 | cut -c1-3000)
    say "   $2 $f: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "$2 $f: $r"; done; }

say "== forward M1-M11, then M12"
C=nsi-i2-m12; newdb $C; for n in 1 2 3 4 5 6 7 8 9 10 11; do apply $C $n || exit 1; done
F11=$(fp $C); say "   fingerprint M11: $F11"
apply $C 12 || exit 1
F12=$(fp $C); say "   fingerprint M12: $F12"; [ "$F11" != "$F12" ] || bad "M12 did not change the catalog"
suite $C test_T_nsi_i3_1_local.sql "M12 boundary suite"
suite $C test_T_nsi_i2_m11_ensure_request_local.sql "M11 suite on M12"
suite $C test_T_nsi_i2_m10_ensure_request_local.sql "M10 suite on M12"
suite $C test_T_nsi_i2_m7_grants_local.sql "M7 suite on M12"
suite $C test_T_nsi_i2_m9_archiving_local.sql "M9 suite on M12"
legacy $C "M12"
r=$(docker exec -i $C psql -U postgres -q < "$D/test_T_nsi_i3_1_devsafe.sql" 2>&1 | grep -E "SUITE" | head -1 | cut -c1-1500)
say "   level-10 DEV-safe suite (no fixtures, safe for shared DEV): ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "level-10 DEV-safe suite: $r"

say "== mutation probes (each mutated M12 must make the suite FAIL; the good file is re-applied afterwards)"
mutate() { # label sed-expression expected-substring
  sed "$2" "$M/${FILES[11]}.sql" > "$TMPD/m12_mut.sql"
  cmp -s "$M/${FILES[11]}.sql" "$TMPD/m12_mut.sql" && { bad "probe $1: the mutation changed nothing"; return; }
  o=$(applyfile $C "$TMPD/m12_mut.sql") || { say "   probe $1: mutated file refused by the migration itself ($(echo "$o" | cut -c1-100)): detected"; return; }
  r=$(LINES_OUT=2 "$D/run_i2_m7_m9_local.sh" $C test_T_nsi_i3_1_local.sql "$FP" | grep -E "SUITE" | head -1)
  if echo "$r" | grep -q "FAIL" && echo "$r" | grep -q "$3"; then say "   probe $1: detected ($3)"; else bad "probe $1 NOT detected: ${r:0:200}"; fi
  apply $C 12 || true
}
mutate "context skips link_valid" 's/  if not intake_private.link_valid(s.invitation_id) then return; end if;/  null;/' "S05"
mutate "issue skips assert_staff" "s/v_role text := intake_private.assert_staff(p_studio_id, 'send');/v_role text := 'studio_owner'::text;/" "S01"
mutate "exchange skips the rate limit" "s/  if not public.intake_rate_limit_hit(sha256(convert_to('intake\/exchange\/v1|', 'UTF8') || p_token_hash), 20, 600) then return; end if;/  null;/" "S08b"
mutate "link_valid ignores the generation" 's|  if i.generation <> (select max(x.generation)|  if false and i.generation <> (select max(x.generation)|' "S03b"
mutate "link_valid ignores the erasure barrier" 's|  if intake_private.erasure_barrier_active(q.studio_id, q.client_id) then return false; end if;|  null;|' "S05"
mutate "link_valid ignores a dead appointment" 's|  return intake_private.request_has_live_target(q.id);|  return true;|' "S05"
mutate "erase leaves the sessions" 's|    where s.request_id = q.id and q.studio_id = p_studio_id and q.client_id = p_client_id;|    where false and s.request_id = q.id and q.studio_id = p_studio_id and q.client_id = p_client_id;|' "S10"
mutate "purge ignores legal holds" "s|      and not intake_private.client_has_active_hold(x.studio_id, intake_private.subject_of('intake_sessions', x.request_id, null))|      and true|" "S11"
mutate "issue ignores the expected generation" 's|  if v_gen <> p_generation then|  if false and v_gen <> p_generation then|' "S13a"
mutate "issue skips the live-appointment pre-check" 's|  if not intake_private.request_has_live_target(q.id) then|  if false and not intake_private.request_has_live_target(q.id) then|' "S13b"
mutate "exchange counts unknown tokens" 's|  if i.id is null then return; end if;\r\?$|  if i.id is null then perform public.intake_rate_limit_hit(sha256(p_token_hash), 20, 600); return; end if;|' "S13c"
[ "$(fp $C)" = "$F12" ] && say "   catalog identical after the probes (good file re-applied)" || bad "catalog differs after the probes"
suite $C test_T_nsi_i3_1_local.sql "M12 boundary suite after the probes"

say "== rollback restores M11 exactly; refused once an M12 audit event exists"
e=$(applyfile $C "$R/$RB12.sql") && [ "$(fp $C)" = "$F11" ] && say "   rollback M12 -> M11 fingerprint identical" || bad "rollback M12: $e"
suite $C test_T_nsi_i2_m11_ensure_request_local.sql "M11 suite after rollback (back on M11)"
apply $C 12; [ "$(fp $C)" = "$F12" ] && say "   re-applied M12 fingerprint identical" || bad "re-apply differs"
docker exec -i $C psql -U postgres -q -c "insert into public.studios (id,name,slug) values ('a5400000-0000-0000-0000-0000000000f1','LC','lc-f1'); select intake_private.audit_write('a5400000-0000-0000-0000-0000000000f1','invitation_issued','staff',null,'studio_owner',null,null,null,null,null,'{}'::jsonb,'operational');" >/dev/null 2>&1
e=$(applyfile $C "$R/$RB12.sql"); echo "$e" | grep -q "refused" && say "   rollback refused once an M12 audit event exists" || bad "rollback not refused: $e"
[ "$(fp $C)" = "$F12" ] && say "   refused rollback left the catalog unchanged" || bad "refused rollback changed the catalog"

say "== replays on an M12 database"
apply $C 12 && say "   replay M12 ok"; [ "$(fp $C)" = "$F12" ] && say "   fingerprint unchanged by the M12 replay" || bad "M12 replay changed the catalog"
e=$(applyfile $C "$M/${FILES[10]}.sql"); echo "$e" | grep -q "catalog self-check failed" && say "   replay M11 fails closed" || bad "replay M11 did not fail closed: $e"
[ "$(fp $C)" = "$F12" ] || bad "failed replay of M11 changed the catalog"
say "== concurrency harness C1-C4 on the M12 container (commits fixtures; runs last)"
r=$(bash "$D/concurrency/nsi_i3_1_concurrency_local.sh" $C 8 2>&1 | tail -14); echo "$r" | sed 's/^/   /'
echo "$r" | grep -q "SUMMARY concurrency M12: failures=0 deadlocks=0" || bad "concurrency harness"
say "== lock-order probes: removing lock_client must be caught by the deterministic concurrency checks (C5)"
lockprobe() { # label sed-expression
  sed "$2" "$M/${FILES[11]}.sql" > "$TMPD/m12_lockmut.sql"
  cmp -s "$M/${FILES[11]}.sql" "$TMPD/m12_lockmut.sql" && { bad "lock probe $1: the mutation changed nothing"; return; }
  o=$(applyfile $C "$TMPD/m12_lockmut.sql") || { bad "lock probe $1: mutated file did not apply: $o"; return; }
  r=$(ONLY=C5 RUNID=$3 bash "$D/concurrency/nsi_i3_1_concurrency_local.sh" $C 8 2>&1 | tail -8)
  if echo "$r" | grep -qE "^C5[abc] .*(waited=|lockable=)" && echo "$r" | grep -q "SUMMARY concurrency M12: failures=[1-9]"; then say "   lock probe $1: detected"; else bad "lock probe $1 NOT detected: $(echo "$r" | tr '\n' ' ' | cut -c1-240)"; fi
  apply $C 12 || true
}
lockprobe "exchange without lock_client" 's|  perform intake_private.lock_client(i.studio_id, v_client);|  null;|' 50
lockprobe "issue without lock_client" 's|  perform intake_private.lock_client(p_studio_id, v_client);|  null;|' 60
[ "$(fp $C)" = "$F12" ] && say "   catalog identical after the lock probes" || bad "catalog differs after the lock probes"
docker rm -f $C >/dev/null 2>&1
say "SUMMARY m12 lifecycle: failures=$fail"
[ "$fail" = "0" ]
