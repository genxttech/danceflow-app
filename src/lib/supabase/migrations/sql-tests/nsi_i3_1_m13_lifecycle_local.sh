#!/usr/bin/env bash
# NSI I3-1 (M13) lifecycle harness. LOCAL DISPOSABLE CONTAINERS ONLY (nsi-i2-*). Builds its own container.
#   M1-M12 -> M13; suites; mutation probes (each mutated M13 must make a suite or the deterministic concurrency check fail); rollback restores
#   the M12 fingerprint EXACTLY; re-apply; replays; concurrency harness C1-C7 last.
# usage: nsi_i3_1_m13_lifecycle_local.sh <public-schema-dump.sql>
set -u
PUB="${1:?schema dump}"
D="$(cd "$(dirname "$0")" && pwd)"; M="$D/.."; R="$M/rollback"
TMPD="${TMPDIR:-/tmp}"
FP="${NSI_APPT_FP:-ff651a6c438d40a001e52ef1625c9043}"
FILES=(20261118090000_nsi_i1_m1_config_helpers 20261118091000_nsi_i1_m2_governance 20261118092000_nsi_i1_m3_live_personal 20261118093000_nsi_i1_m4_retained_evidence 20261118094000_nsi_i1_m5_functions 20261118095000_nsi_i2_eligibility_preview 20261118096000_nsi_i2_m7_pilot_grants 20261118097000_nsi_i2_m8_lesson_types_simulation 20261118098000_nsi_i2_m9_template_archiving 20261118099000_nsi_i2_m10_ensure_request_evaluator 20261118100000_nsi_i2_m11_ensure_request_hardening 20261118101000_nsi_i3_m12_invitations_sessions 20261118102000_nsi_i3_m13_purge_hardening)
RB13=20261118102000_nsi_i3_m13_purge_hardening_rollback
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

say "== forward M1-M12, then M13"
C=nsi-i2-m13; newdb $C; for n in 1 2 3 4 5 6 7 8 9 10 11 12; do apply $C $n || exit 1; done
F12=$(fp $C); say "   fingerprint M12: $F12"
suite $C test_T_nsi_i3_1_local.sql "M12 suite on M12"
apply $C 13 || exit 1
F13=$(fp $C); say "   fingerprint M13: $F13"; [ "$F12" != "$F13" ] || bad "M13 did not change the catalog"
suite $C test_T_nsi_i3_1_m13_local.sql "M13 boundary suite"
suite $C test_T_nsi_i3_1_local.sql "M12 suite on M13"
suite $C test_T_nsi_i2_m11_ensure_request_local.sql "M11 suite on M13"
legacy $C "M13"
r=$(docker exec -i $C psql -U postgres -q < "$D/test_T_nsi_i3_1_devsafe.sql" 2>&1 | grep -E "SUITE" | head -1 | cut -c1-1500)
say "   level-10 DEV-safe suite: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "level-10 DEV-safe suite: $r"

say "== mutation probes on M13 (each mutated copy must make the suite FAIL; the good file is re-applied afterwards)"
mutate() { # label sed-expression expected-substring
  sed "$2" "$M/${FILES[12]}.sql" > "$TMPD/m13_mut.sql"
  cmp -s "$M/${FILES[12]}.sql" "$TMPD/m13_mut.sql" && { bad "probe $1: the mutation changed nothing"; return; }
  o=$(applyfile $C "$TMPD/m13_mut.sql") || { say "   probe $1: mutated file refused by the migration itself: detected"; return; }
  r=$(LINES_OUT=2 "$D/run_i2_m7_m9_local.sh" $C test_T_nsi_i3_1_m13_local.sql "$FP" | grep -E "SUITE" | head -1)
  if echo "$r" | grep -q "FAIL" && echo "$r" | grep -q "$3"; then say "   probe $1: detected ($3)"; else bad "probe $1 NOT detected: \${r:0:200}"; fi
  apply $C 13 || true
}
mutate "purge candidate clients unbounded" 's|    ) c order by c.k limit c_max_clients) x;|    ) c order by c.k limit 100000) x;|' "P01"
mutate "purge ignores legal holds" 's|      and not intake_private.client_has_active_hold(x.studio_id, q.client_id)|      and true|' "P02"
mutate "revoke_session audited as student" "s|'session_revoked', 'system', null|'session_revoked', 'student', null|" "P03"
[ "$(fp $C)" = "$F13" ] && say "   catalog identical after the probes" || bad "catalog differs after the probes"
suite $C test_T_nsi_i3_1_m13_local.sql "M13 boundary suite after the probes"

say "== lock probe: the purge without try_lock_client must be caught by the deterministic check C7"
sed "s|   where intake_private.try_lock_client(split_part(k.k, ':', 1)::uuid, split_part(k.k, ':', 2)::uuid);|   where true;|" "$M/${FILES[12]}.sql" > "$TMPD/m13_lock.sql"
cmp -s "$M/${FILES[12]}.sql" "$TMPD/m13_lock.sql" && bad "lock probe: the mutation changed nothing" || {
  o=$(applyfile $C "$TMPD/m13_lock.sql") || bad "lock probe did not apply: $o"
  r=$(ONLY=C7 RUNID=70 bash "$D/concurrency/nsi_i3_1_concurrency_local.sh" $C 8 2>&1 | tail -6)
  if echo "$r" | grep -qE "^C7 held_rows=" && echo "$r" | grep -q "SUMMARY concurrency M12: failures=[1-9]"; then say "   lock probe purge without try_lock_client: detected"; else bad "lock probe NOT detected: $(echo "$r" | tr '\n' ' ' | cut -c1-240)"; fi
  apply $C 13 || true; }
[ "$(fp $C)" = "$F13" ] && say "   catalog identical after the lock probe" || bad "catalog differs after the lock probe"

say "== lock-removal probes on the M12 functions (separate per writer; each caught by its own deterministic check)"
lockprobe12() { # label sed-expression expected-line-prefix runid
  sed "$2" "$M/${FILES[11]}.sql" > "$TMPD/m12_lockmut2.sql"
  cmp -s "$M/${FILES[11]}.sql" "$TMPD/m12_lockmut2.sql" && { bad "lock probe $1: the mutation changed nothing"; return; }
  o=$(applyfile $C "$TMPD/m12_lockmut2.sql") || { bad "lock probe $1: mutated M12 did not apply: $o"; return; }
  apply $C 13 || true
  r=$(ONLY=C5 RUNID=$4 bash "$D/concurrency/nsi_i3_1_concurrency_local.sh" $C 8 2>&1 | tail -8)
  if echo "$r" | grep -qE "^$3 .*(waited=|lockable=)" && echo "$r" | grep -q "SUMMARY concurrency M12: failures=[1-9]"; then say "   lock probe $1: detected ($3)"; else bad "lock probe $1 NOT detected: $(echo "$r" | tr '\n' ' ' | cut -c1-240)"; fi
  apply $C 12 || true; apply $C 13 || true
}
lockprobe12 "bulk key revoke without lock_client" 's|  perform intake_private.lock_client(r.studio_id, v_client);|  null;|' C5b 80
lockprobe12 "staff revoke without lock_client" '/create or replace function public.intake_revoke_invitations/,/^end \$\$;/ s|  perform intake_private.lock_client(p_studio_id, v_client);|  null;|' C5d 90
lockprobe12 "issue without lock_client" '/create or replace function public.intake_issue_invitation/,/^end \$\$;/ s|  perform intake_private.lock_client(p_studio_id, v_client);|  null;|' C5c 100
[ "$(fp $C)" = "$F13" ] && say "   catalog identical after the M12 lock probes (good M12 and M13 re-applied)" || bad "catalog differs after the M12 lock probes"

say "== rollback restores M12 exactly"
e=$(applyfile $C "$R/$RB13.sql") && [ "$(fp $C)" = "$F12" ] && say "   rollback M13 -> M12 fingerprint identical" || bad "rollback M13: $e"
suite $C test_T_nsi_i3_1_local.sql "M12 suite after rollback (back on M12)"
e=$(applyfile $C "$R/$RB13.sql"); echo "$e" | grep -q "refused" && say "   second rollback refused on an M12 database" || bad "rollback not refused on M12: $e"
apply $C 13; [ "$(fp $C)" = "$F13" ] && say "   re-applied M13 fingerprint identical" || bad "re-apply differs"
say "== replays on an M13 database"
apply $C 13 && say "   replay M13 ok"; [ "$(fp $C)" = "$F13" ] && say "   fingerprint unchanged by the M13 replay" || bad "M13 replay changed the catalog"
e=$(applyfile $C "$M/${FILES[11]}.sql") && [ "$(fp $C)" = "$F12" ] && say "   replaying M12 on M13 downgrades the purge and revoke_session bodies to M12 (fingerprint equals M12): documented limitation, M13 restores" || bad "M12 replay on M13: $e"
apply $C 13; [ "$(fp $C)" = "$F13" ] || bad "M13 did not restore after the M12 replay"
say "== concurrency harness C1-C7 on the M13 container (commits fixtures; runs last)"
r=$(bash "$D/concurrency/nsi_i3_1_concurrency_local.sh" $C 8 2>&1 | tail -18); echo "$r" | sed 's/^/   /'
echo "$r" | grep -q "SUMMARY concurrency M12: failures=0 deadlocks=0" || bad "concurrency harness"
docker rm -f $C >/dev/null 2>&1
say "SUMMARY m13 lifecycle: failures=$fail"
[ "$fail" = "0" ]
