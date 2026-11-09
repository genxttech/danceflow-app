#!/usr/bin/env bash
# Competition CF1 F3 -- multi-session probes for publication on a THROWAWAY local Postgres container.
#
#   CONTAINER=cf1f3-pg DBUSER=supabase_admin bash test_T_competition_cf1_f3_concurrency.sh
#
# The database must already carry the chain through CF1 A7 and F3 (20270122090000). The script COMMITS synthetic fixtures (UUID block
# ...-<run tag>XXXXXX, a random 6-hex tag per run so a re-run never collides) and leaves them: run it only on a disposable container. Never against a shared or hosted DB.
# Every race is deterministic: session A holds the round row lock inside an open transaction (pg_sleep), session B starts after A has the lock and
# must wait for it. Probes:
#   1  two managers publish the same approved round with different request ids     -> exactly one publication; the loser is refused
#   2  the same request id from two sessions                                        -> one write, the other replays
#   3  publish vs open_correction (publish first)                                   -> the publication exists, the correction follows, the version is stale
#   4  open_correction vs publish (correction first)                                -> nothing is published (round not approved)
#   5  supersede-publish of v2 vs withdraw of v1 (publish first)                    -> v1 superseded, withdraw refused, one current publication
#   6  withdraw of v1 vs publish of v2 (withdraw first)                             -> v1 withdrawn (not superseded), v2 current
#   7  two withdraws of the same publication, different request ids                 -> one wins, one refused
#   8  two withdraws on a COMPLETE round (owner decision), different request ids    -> one wins, one refused, round stays complete
#   9  the same withdraw request id from two sessions on a complete round          -> one write, the other replays
#   10 complete vs withdraw (complete first)                                        -> the withdraw succeeds on the complete round
#   11 withdraw vs complete (withdraw first)                                        -> complete refused (no current publication)
set -u
C="${CONTAINER:?set CONTAINER}"
DBUSER="${DBUSER:-postgres}"
FAILS=0
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT
psq() { docker exec -i "$C" psql -U "$DBUSER" -h localhost -d postgres -At -q "$@"; }
TAG=$(printf '%06x' $(( (RANDOM * 32768 + RANDOM) % 16777216 )))
u() { echo "00000000-0000-0000-0000-$TAG$1"; }
M1=$(u 000001); M2=$(u 000002); EV=$(u 00e001); ST=$(u 00a001); P=$(u 001001); CT=$(u 002001)
ok() { echo "PASS  $1"; }
bad() { echo "FAIL  $1  ($2)"; FAILS=$((FAILS + 1)); }
as_sql() { printf "set role authenticated;\nselect set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', false);\n%s\n" "$1" "$2"; }
q() { psq -c "$1"; }

echo "== fixtures =="
psq -v ON_ERROR_STOP=1 <<SQL
set session_replication_role = replica;
insert into auth.users (id, email) values ('$M1', 't-$TAG-m1@example.test'), ('$M2', 't-$TAG-m2@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'CF1F3 ' || split_part(email, '@', 1) from auth.users where email like 't-$TAG-%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where email like 't-$TAG-%';
insert into public.studios (id, name, slug) values ('$ST', 'CF1 F3 Race Studio', 't-$TAG-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$M1', '$ST', 'studio_owner', true), ('$M2', '$ST', 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values ('$EV', '$ST', 'CF1 F3 Race', 't-$TAG-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
values ('$P', '$EV', '$ST', 'P', 'country', 'relative', 'skating', 'configured', 'none');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$CT', '$EV', '$P', 'C', 'single_dance', 'pro_am', 'open');
SQL

# mk K: round K (own division, 3 entries) approved with approved version 1 (+ approval). Version ids ...007K01, v2 ...007K02.
mk() {
  k=$1; R=$(u "00600$k"); D=$(u "00300$k")
  psq -v ON_ERROR_STOP=1 <<SQL
set session_replication_role = replica;
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values ('$D', '$EV', '$P', '$CT', 'D$k', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
values ('$R', '$EV', '$P', '$D', 'R$k', 'final', 1, 'approved', 'ordinal_majority');
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select '$(u "0080${k}0")'::uuid, '$EV', '$P', '$D', 'e$k', 'confirmed', 'eligible', '${k}0';
SQL
}
# ver K N STATUS: result version N of round K
ver() {
  k=$1; n=$2; st=$3; R=$(u "00600$k")
  psq -v ON_ERROR_STOP=1 <<SQL
set session_replication_role = replica;
insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, status, request_id)
values ('$(u "007${k}0$n")', '$EV', '$R', $n, 'studio_ordinal_majority', '1', public._compf2_input_hash('$R', 'studio_ordinal_majority', '1'), repeat('a', 64), '{}', '[]', '$M1', '$st', gen_random_uuid());
insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, placement) values ('$EV', '$(u "007${k}0$n")', '$(u "0080${k}0")', 1);
SQL
  [ "$st" = approved ] && psq -v ON_ERROR_STOP=1 -c "set session_replication_role = replica; insert into public.event_competition_result_approvals (event_id, result_version_id, approved_by, calculated_by, request_id) values ('$EV', '$(u "007${k}0$n")', '$M2', '$M1', gen_random_uuid());"
}
# pub K N VERSIONNO: a CURRENT publication N of round K for version VERSIONNO (fixture, replica mode)
pub() {
  k=$1; n=$2; vn=$3; R=$(u "00600$k")
  psq -v ON_ERROR_STOP=1 -c "set session_replication_role = replica; insert into public.event_competition_result_publications (id, event_id, round_id, result_version_id, publication_version, visibility, published_by, request_id)
    values ('$(u "00a${k}0$n")', '$EV', '$R', '$(u "007${k}0$vn")', $n, 'entrants', '$M1', gen_random_uuid());"
}
PUB() { echo "select public.publish_competition_round_result('$(u "00600$1")', '$(u "007$1"0"$2")', 'entrants', '$3');"; }
WD() { echo "select public.withdraw_competition_round_result('$(u "00600$1")', '$(u "00a$1"0"$2")', 'raced withdraw', '$3');"; }
# hold USER SQL SECONDS: runs SQL in a transaction that keeps the round lock for SECONDS
hold() { { as_sql "$1" "begin;"; echo "$2"; echo "select pg_sleep($3);"; echo "commit;"; } | psq -v ON_ERROR_STOP=0 2>&1; }
run() { as_sql "$1" "$2" | psq -v ON_ERROR_STOP=0 2>&1; }
pubs() { q "select count(*) from public.event_competition_result_publications where round_id = '$(u "00600$1")'"; }
cur() { q "select count(*) from public.event_competition_result_publications where round_id = '$(u "00600$1")' and withdrawn_at is null and superseded_by is null"; }
rst() { q "select status from public.event_competition_rounds where id = '$(u "00600$1")'"; }

# --- 1 two publishers, different request ids
mk 1; ver 1 1 approved
hold "$M1" "$(PUB 1 1 $(u 0e0001))" 3 > $TMPD/f3c1a.out &
sleep 1
run "$M2" "$(PUB 1 1 $(u 0e0002))" > $TMPD/f3c1b.out
wait
if [ "$(pubs 1)" = 1 ] && [ "$(cur 1)" = 1 ] && [ "$(rst 1)" = published ] && grep -q 'COMP_RESULT_INVALID_TRANSITION' $TMPD/f3c1b.out && [ "$(q "select count(*) from public.event_competition_result_events where kind = 'result_published' and round_id = '$(u 006001)'")" = 1 ]; then
  ok "1 two publishers: exactly one publication, one audit row; the loser is refused"; else bad "1 two publishers" "pubs=$(pubs 1) cur=$(cur 1) status=$(rst 1) $(head -c 200 $TMPD/f3c1b.out)"; fi

# --- 2 same request id from two sessions
mk 2; ver 2 1 approved
hold "$M1" "$(PUB 2 1 $(u 0e0003))" 3 > $TMPD/f3c2a.out &
sleep 1
run "$M1" "$(PUB 2 1 $(u 0e0003))" > $TMPD/f3c2b.out
wait
if [ "$(pubs 2)" = 1 ] && grep -q '"replayed": true' $TMPD/f3c2b.out && [ "$(q "select count(*) from public.event_competition_result_events where request_id = '$(u 0e0003)'")" = 1 ]; then
  ok "2 same request id: one write, the second session replays"; else bad "2 same request id" "pubs=$(pubs 2) $(head -c 200 $TMPD/f3c2b.out)"; fi

# --- 3 publish first, then open_correction waits and follows
mk 3; ver 3 1 approved
hold "$M1" "$(PUB 3 1 $(u 0e0004))" 3 > $TMPD/f3c3a.out &
sleep 1
run "$M1" "select public.open_competition_round_correction('$(u 006003)', 'raced correction', '$(u 0e0005)');" > $TMPD/f3c3b.out
wait
if [ "$(pubs 3)" = 1 ] && [ "$(cur 3)" = 1 ] && [ "$(rst 3)" = ballots_locked ] && [ "$(q "select status from public.event_competition_result_versions where id = '$(u 007301)'")" = stale ]; then
  ok "3 publish then correction: publication current, round in correction, version stale"; else bad "3 publish then correction" "pubs=$(pubs 3) cur=$(cur 3) status=$(rst 3) $(head -c 300 $TMPD/f3c3b.out)"; fi

# --- 4 correction first, then publish is refused
mk 4; ver 4 1 approved
hold "$M1" "select public.open_competition_round_correction('$(u 006004)', 'raced correction', '$(u 0e0006)');" 3 > $TMPD/f3c4a.out &
sleep 1
run "$M1" "$(PUB 4 1 $(u 0e0007))" > $TMPD/f3c4b.out
wait
if [ "$(pubs 4)" = 0 ] && [ "$(rst 4)" = ballots_locked ] && grep -q 'COMP_RESULT_INVALID_TRANSITION' $TMPD/f3c4b.out; then
  ok "4 correction then publish: nothing published, the publish is refused"; else bad "4 correction then publish" "pubs=$(pubs 4) status=$(rst 4) $(head -c 300 $TMPD/f3c4b.out)"; fi

# --- 5 publish v2 (supersede) first, then withdraw v1 is refused
mk 5; ver 5 1 stale; pub 5 1 1; ver 5 2 approved
hold "$M1" "$(PUB 5 2 $(u 0e0008))" 3 > $TMPD/f3c5a.out &
sleep 1
run "$M2" "$(WD 5 1 $(u 0e0009))" > $TMPD/f3c5b.out
wait
if [ "$(pubs 5)" = 2 ] && [ "$(cur 5)" = 1 ] && [ "$(q "select superseded_by is not null and withdrawn_at is null from public.event_competition_result_publications where id = '$(u 00a501)'")" = t ] && grep -q 'COMP_PUBLICATION_NOT_CURRENT' $TMPD/f3c5b.out; then
  ok "5 supersede then withdraw: v1 superseded, the late withdraw is refused, one current publication"; else bad "5 supersede vs withdraw" "pubs=$(pubs 5) cur=$(cur 5) $(head -c 300 $TMPD/f3c5b.out)"; fi

# --- 6 withdraw v1 first, then publish v2 (no supersede stamp)
mk 6; ver 6 1 stale; pub 6 1 1; ver 6 2 approved
hold "$M2" "$(WD 6 1 $(u 0e000a))" 3 > $TMPD/f3c6a.out &
sleep 1
run "$M1" "$(PUB 6 2 $(u 0e000b))" > $TMPD/f3c6b.out
wait
if [ "$(pubs 6)" = 2 ] && [ "$(cur 6)" = 1 ] && [ "$(q "select withdrawn_at is not null and superseded_by is null from public.event_competition_result_publications where id = '$(u 00a601)'")" = t ] && [ "$(rst 6)" = published ]; then
  ok "6 withdraw then publish: v1 withdrawn (not superseded), v2 current"; else bad "6 withdraw vs supersede" "pubs=$(pubs 6) cur=$(cur 6) status=$(rst 6) $(head -c 300 $TMPD/f3c6b.out)"; fi

# --- 7 two withdraws of the same publication
mk 7; ver 7 1 approved; pub 7 1 1
psq -v ON_ERROR_STOP=1 -c "set session_replication_role = replica; update public.event_competition_rounds set status = 'published' where id = '$(u 006007)';"
hold "$M1" "$(WD 7 1 $(u 0e000c))" 3 > $TMPD/f3c7a.out &
sleep 1
run "$M2" "$(WD 7 1 $(u 0e000d))" > $TMPD/f3c7b.out
wait
if [ "$(cur 7)" = 0 ] && [ "$(q "select count(*) from public.event_competition_result_events where kind = 'result_withdrawn' and round_id = '$(u 006007)'")" = 1 ] && grep -q 'COMP_PUBLICATION_NOT_CURRENT' $TMPD/f3c7b.out; then
  ok "7 two withdraws: one wins, one audit row, the other is refused"; else bad "7 double withdraw" "cur=$(cur 7) $(head -c 300 $TMPD/f3c7b.out)"; fi

# --- 8 owner decision: withdraw on a COMPLETE round; two withdraws with different request ids
mk 8; ver 8 1 approved; pub 8 1 1
psq -v ON_ERROR_STOP=1 -c "set session_replication_role = replica; update public.event_competition_rounds set status = 'complete' where id = '$(u 006008)';"
hold "$M1" "$(WD 8 1 $(u 0e000e))" 3 > $TMPD/f3c8a.out &
sleep 1
run "$M2" "$(WD 8 1 $(u 0e000f))" > $TMPD/f3c8b.out
wait
if [ "$(cur 8)" = 0 ] && [ "$(rst 8)" = complete ] && [ "$(pubs 8)" = 1 ] && [ "$(q "select count(*) from public.event_competition_result_events where kind = 'result_withdrawn' and round_id = '$(u 006008)'")" = 1 ] && grep -q 'COMP_PUBLICATION_NOT_CURRENT' $TMPD/f3c8b.out; then
  ok "8 complete round, two withdraws: one wins, one audit row, round stays complete, the other is refused"; else bad "8 complete double withdraw" "cur=$(cur 8) status=$(rst 8) $(head -c 300 $TMPD/f3c8b.out)"; fi

# --- 9 complete round, same request id from two sessions: one write, one replay
mk 9; ver 9 1 approved; pub 9 1 1
psq -v ON_ERROR_STOP=1 -c "set session_replication_role = replica; update public.event_competition_rounds set status = 'complete' where id = '$(u 006009)';"
hold "$M1" "$(WD 9 1 $(u 0e0010))" 3 > $TMPD/f3c9a.out &
sleep 1
run "$M1" "$(WD 9 1 $(u 0e0010))" > $TMPD/f3c9b.out
wait
if [ "$(cur 9)" = 0 ] && [ "$(q "select count(*) from public.event_competition_result_events where request_id = '$(u 0e0010)'")" = 1 ] && grep -q '"replayed": true' $TMPD/f3c9b.out; then
  ok "9 complete round, same request id: one write, the second session replays"; else bad "9 complete same request" "cur=$(cur 9) $(head -c 300 $TMPD/f3c9b.out)"; fi

# --- 10 complete first (from published), then the withdraw follows on the now-complete round
mk a; ver a 1 approved; pub a 1 1
psq -v ON_ERROR_STOP=1 -c "set session_replication_role = replica; update public.event_competition_rounds set status = 'published' where id = '$(u 00600a)';"
COMPL() { echo "select public.complete_competition_round('$(u "00600$1")', '$2');"; }
hold "$M1" "$(COMPL a $(u 0e0011))" 3 > $TMPD/f3c10a.out &
sleep 1
run "$M2" "$(WD a 1 $(u 0e0012))" > $TMPD/f3c10b.out
wait
if [ "$(rst a)" = complete ] && [ "$(cur a)" = 0 ] && [ "$(q "select count(*) from public.event_competition_result_events where kind = 'result_withdrawn' and round_id = '$(u 00600a)' and refs ->> 'round_status' = 'complete'")" = 1 ]; then
  ok "10 complete then withdraw: the round completes, the late withdraw succeeds on the complete round (audit says complete)"; else bad "10 complete then withdraw" "status=$(rst a) cur=$(cur a) $(head -c 300 $TMPD/f3c10b.out)"; fi

# --- 11 withdraw first (from published), then complete is refused (no current publication)
mk b; ver b 1 approved; pub b 1 1
psq -v ON_ERROR_STOP=1 -c "set session_replication_role = replica; update public.event_competition_rounds set status = 'published' where id = '$(u 00600b)';"
hold "$M2" "$(WD b 1 $(u 0e0013))" 3 > $TMPD/f3c11a.out &
sleep 1
run "$M1" "$(COMPL b $(u 0e0014))" > $TMPD/f3c11b.out
wait
if [ "$(rst b)" = published ] && [ "$(cur b)" = 0 ] && grep -q 'COMP_PUBLICATION_REQUIRES_APPROVAL' $TMPD/f3c11b.out; then
  ok "11 withdraw then complete: the complete is refused (no current publication), round stays published"; else bad "11 withdraw then complete" "status=$(rst b) cur=$(cur b) $(head -c 300 $TMPD/f3c11b.out)"; fi

echo "== done: $FAILS failure(s) =="
[ "$FAILS" = 0 ] && echo "CONCURRENCY PASS" || echo "CONCURRENCY FAIL"
exit "$FAILS"
