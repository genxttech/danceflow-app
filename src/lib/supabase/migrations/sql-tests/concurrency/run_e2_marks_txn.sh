#!/usr/bin/env bash
# Competition E2 -- multi-transaction test: marks can only be inserted in the transaction that created their ballot.
#
# NOT RUN YET (written while slot 2 was with another team). The single-transaction SQL suite cannot cover this rule because
# every fixture and every probe shares one txid. Run it with the concurrency script, once the DB slot is back:
#     bash run_e2_marks_txn.sh [container]      (E1 + O1 + E2 applied; superuser supabase_admin)
# It leaves committed ballots from run_e2_submit_vs_lock.sh (KEEP=1), probes them from FRESH transactions, then removes the
# fixtures. Prints "E2 MARKS-TXN PASS (<n> checks)" or "E2 MARKS-TXN FAIL: ...".
#
# Probes (each in its own psql connection = its own transaction):
#   1 a mark inserted for an OLD, committed ballot in a new transaction is refused (COMP_BALLOT_IMMUTABLE)
#   2 same for the latest version of a correction chain
#   3 a mark for a NEW ballot written in the SAME transaction as the ballot is accepted (positive control), then rolled back
#   4 a ballot inserted in one transaction cannot receive its marks from a second, later transaction even after commit
#   5 UPDATE/DELETE of the committed marks in a new transaction are refused (append-only), nothing changed afterwards
set -u
export MSYS_NO_PATHCONV=1
C="${1:-e2-qa-db}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -At "$@"; }
U() { printf '00000000-0000-0000-0000-e20ff3%06x' "$((16#$1))"; }
EV=$(U e0); R3=$(U 83); H3=$(U d3); E31=$(U 931); E32=$(U 932); J1=$(U a1); J2=$(U a2)
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }

cleanup() {
  SU -c "set session_replication_role = replica; update public.event_competition_heats set lock_state='open' where event_id='$EV'; reset session_replication_role;" >/dev/null 2>&1
  SU -c "delete from public.events where id='$EV'; delete from public.studios where id::text like '00000000-0000-0000-0000-e20ff3%'; delete from public.verified_email_identities where user_id::text like '00000000-0000-0000-0000-e20ff3%'; delete from public.profiles where id::text like '00000000-0000-0000-0000-e20ff3%'; delete from auth.users where id::text like '00000000-0000-0000-0000-e20ff3%';" >/dev/null 2>&1
}
trap cleanup EXIT

# Fixtures: round 3 has judge 1's correction chain v1..v3 on heat 3 (committed by the concurrency script).
KEEP=1 bash "$HERE/run_e2_submit_vs_lock.sh" "$C" >/dev/null 2>&1
OFF1=$(SU -c "select id from public.event_competition_officials where event_id='$EV' and user_id='$J1'")
OFF2=$(SU -c "select id from public.event_competition_officials where event_id='$EV' and user_id='$J2'")
B1=$(SU -c "select id from public.event_competition_ballots where round_id='$R3' and official_id='$OFF1' and version=1")
B3=$(SU -c "select id from public.event_competition_ballots where round_id='$R3' and official_id='$OFF1' and version=3")
ok "fixture: chain v1 and v3 exist" $([ -n "$B1" ] && [ -n "$B3" ] && echo 1 || echo 0)
MARKS_BEFORE=$(SU -c "select count(*) from public.event_competition_marks where event_id='$EV'")

# 1 + 2: a later transaction cannot add a mark to a committed ballot (old version and latest version)
for B in "$B1" "$B3"; do
  OUT=$(SU -v ON_ERROR_STOP=1 -c "insert into public.event_competition_marks (event_id, ballot_id, entry_id, mark) values ('$EV', '$B', '$E31', '1'::jsonb)" 2>&1)
  ok "later transaction cannot add a mark to committed ballot $B" $(echo "$OUT" | grep -q "COMP_BALLOT_IMMUTABLE" && echo 1 || echo 0)
done

# 3: positive control -- ballot + mark in ONE transaction is accepted (judge 2 has no ballot on heat 3), then rolled back
OUT=$(SU -v ON_ERROR_STOP=1 <<SQL 2>&1
begin;
insert into public.event_competition_ballots (event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by)
  values ('$EV', '$R3', '$H3', '$OFF2', 'ordinal_rank', 1, 1, 'judge_web', '$J2');
insert into public.event_competition_marks (event_id, ballot_id, entry_id, mark)
  select '$EV', b.id, '$E31', '1'::jsonb from public.event_competition_ballots b where b.round_id = '$R3' and b.official_id = '$OFF2';
select 'SAME_TXN_OK';
rollback;
SQL
)
ok "ballot and mark in the same transaction are accepted (control)" $(echo "$OUT" | grep -q "SAME_TXN_OK" && echo 1 || echo 0)
ok "the control left no ballot behind" $([ "$(SU -c "select count(*) from public.event_competition_ballots where round_id='$R3' and official_id='$OFF2'")" = "0" ] && echo 1 || echo 0)

# 4: ballot committed in transaction 1; marks offered by transaction 2 are refused
SU -v ON_ERROR_STOP=1 -c "insert into public.event_competition_ballots (event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by) values ('$EV', '$R3', '$H3', '$OFF2', 'ordinal_rank', 1, 1, 'judge_web', '$J2')" >/dev/null 2>&1
B2=$(SU -c "select id from public.event_competition_ballots where round_id='$R3' and official_id='$OFF2'")
OUT=$(SU -v ON_ERROR_STOP=1 -c "insert into public.event_competition_marks (event_id, ballot_id, entry_id, mark) values ('$EV', '$B2', '$E31', '1'::jsonb)" 2>&1)
ok "marks for a ballot committed earlier are refused (second transaction)" $(echo "$OUT" | grep -q "COMP_BALLOT_IMMUTABLE" && echo 1 || echo 0)

# 5: committed marks are append-only from a new transaction and unchanged afterwards
OUT=$(SU -v ON_ERROR_STOP=1 -c "update public.event_competition_marks set mark = '9'::jsonb where ballot_id = '$B1'" 2>&1)
ok "UPDATE of committed marks is refused" $(echo "$OUT" | grep -q "append-only" && echo 1 || echo 0)
OUT=$(SU -v ON_ERROR_STOP=1 -c "delete from public.event_competition_marks where ballot_id = '$B1'" 2>&1)
ok "DELETE of committed marks is refused" $(echo "$OUT" | grep -q "append-only" && echo 1 || echo 0)
ok "mark rows unchanged by the probes" $([ "$(SU -c "select count(*) from public.event_competition_marks where event_id='$EV'")" = "$MARKS_BEFORE" ] && echo 1 || echo 0)

if [ -z "$FAILS" ]; then echo "E2 MARKS-TXN PASS ($PASS checks)"; exit 0; fi
echo "E2 MARKS-TXN FAIL:$FAILS"; exit 1
