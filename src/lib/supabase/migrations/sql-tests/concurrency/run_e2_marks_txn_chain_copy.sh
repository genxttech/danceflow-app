#!/usr/bin/env bash
# LABELLED CHAIN COPY of run_e2_marks_txn.sh -- marks can only be inserted in the transaction that created their ballot.
# ============================================================================================================================================
# THIS IS NOT THE ORIGINAL RACE. A PASS HERE IS NEVER A PASS OF THE ORIGINAL. The original is unchanged.
# ============================================================================================================================================
# Why: the original takes its fixtures from run_e2_submit_vs_lock.sh (KEEP=1, output discarded). Beside later packages that script's fixtures are
# refused (R-15: an uncleared entry cannot be placed into a published heat; pilot restrictions: ballots only for a started heat), so no ballot
# chain exists and every probe of the original fails for that reason alone.
# What differs: this copy builds its OWN minimal fixtures (one round, one heat, two entries, judge 1's chain v1..v3, submitted one after another,
# through submit_competition_ballot) and, only where installed, clears the entries through set_competition_entry_eligibility (adult
# participants) and marks the heat complete before the ballots. No gate or guard is disabled for those steps; heat, entry and version rows are
# written in replica mode as the original does (ENABLE ALWAYS guards still fire). The nine probes and their names are the original's.
# Not covered here (the original's fixture script covers them): concurrent submit against lock, concurrent corrections.
#   bash run_e2_marks_txn_chain_copy.sh <container>     LOCAL DISPOSABLE QA DATABASE ONLY; fixtures COMMIT and are not removed.
# Prints "chain: ..." then "E2 MARKS-TXN CHAIN-COPY PASS (<n> checks)" or "E2 MARKS-TXN CHAIN-COPY FAIL: ...".
set -u
export MSYS_NO_PATHCONV=1
C="${1:?container}"
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -At "$@"; }
SUX() { SU -v ON_ERROR_STOP=1 "$@"; }
U() { printf '00000000-0000-0000-0000-e20ff4%06x' "$((16#$1))"; }
MGR=$(U a0); J1=$(U a1); J2=$(U a2); J3=$(U a3); STUDIO=$(U 51); EV=$(U e0); PG=$(U 61); CT=$(U 62); DV=$(U 73); R3=$(U 83); V=$(U c1); H3=$(U d3); E31=$(U 931); E32=$(U 932)
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }
die() { echo "E2 MARKS-TXN CHAIN-COPY FAIL: fixture step '$1' refused: $(echo "$2" | grep -m1 ERROR | cut -c1-300)"; exit 1; }
as_user() { echo "set role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, false);"; }
S4=$(SU -c "select (to_regprocedure('public.set_competition_entry_eligibility(uuid,text,text,text[],uuid)') is not null)::int")
P1=$(SU -c "select count(*) from pg_trigger where tgname = 'zz_compp1_ballots' and not tgisinternal")
echo "chain: r15-clearance=$S4 pilot-restrictions=$P1"

OUT=$(SUX <<SQL 2>&1
insert into auth.users (id, email) values ('$MGR','t-e2k-mgr@example.test'),('$J1','t-e2k-j1@example.test'),('$J2','t-e2k-j2@example.test'),('$J3','t-e2k-j3@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'E2K ' || split_part(email,'@',1) from auth.users where id::text like '00000000-0000-0000-0000-e20ff4%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
  select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id::text like '00000000-0000-0000-0000-e20ff4%';
insert into public.studios (id, name, slug) values ('$STUDIO','E2K Studio','t-e2k-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$MGR','$STUDIO','studio_owner',true),('$J1','$STUDIO','instructor',true),('$J2','$STUDIO','instructor',true),('$J3','$STUDIO','instructor',true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values ('$EV','$STUDIO','E2K Comp','t-e2k-e','competition', current_date+30, current_date+30,'published','public',true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
  values ('$PG','$EV','$STUDIO','P','country','relative','skating','configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$CT','$EV','$PG','C','single_dance','pro_am','open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values ('$DV','$EV','$PG','$CT','D3','open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
  values ('$R3','$EV','$PG','$DV','R3','final',1,'draft','ordinal_majority');
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values
  ('$E31','$EV','$PG','$DV','E31','confirmed','eligible','301'), ('$E32','$EV','$PG','$DV','E32','confirmed','eligible','302');
SQL
) || die base "$OUT"

if [ "$S4" = 1 ]; then
  OUT=$(SUX <<SQL 2>&1
insert into public.event_competition_competitors (id, event_id, first_name, last_name, created_via, date_of_birth) values
  ('$(U 7c1)','$EV','Dancer','One','staff', date '1985-06-15'), ('$(U 7c2)','$EV','Dancer','Two','staff', date '1985-06-15');
insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, dance_role, display_name) values
  ('$EV','$E31','$(U 7c1)','dancer','leader','One'), ('$EV','$E32','$(U 7c2)','dancer','leader','Two');
$(as_user "$MGR")
select public.set_competition_entry_eligibility('$E31', 'eligible', 'criteria_verified_by_organizer', '{}'::text[], gen_random_uuid());
select public.set_competition_entry_eligibility('$E32', 'eligible', 'criteria_verified_by_organizer', '{}'::text[], gen_random_uuid());
SQL
) || die clearance "$OUT"
fi

OUT=$(SUX <<SQL 2>&1
set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values ('$V','$EV',1,'v1','published',now());
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status) values ('$H3','$EV','$DV','$R3',1,'$CT','$V','scheduled');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values ('$EV','$DV','$H3','$E31',1),('$EV','$DV','$H3','$E32',2);
set session_replication_role = origin;
SQL
) || die order "$OUT"
OUT=$(SUX <<SQL 2>&1
$(as_user "$MGR")
select public.add_competition_official('$EV','$J1','judge','$(U f001)');
select public.add_competition_official('$EV','$J2','judge','$(U f002)');
select public.add_competition_official('$EV','$J3','judge','$(U f003)');
select public.assign_competition_panel_member('$R3', (select id from public.event_competition_officials where event_id='$EV' and user_id='$J1'), 'A', '$(U f101)');
select public.assign_competition_panel_member('$R3', (select id from public.event_competition_officials where event_id='$EV' and user_id='$J2'), 'B', '$(U f201)');
select public.assign_competition_panel_member('$R3', (select id from public.event_competition_officials where event_id='$EV' and user_id='$J3'), 'C', '$(U f301)');
SQL
) || die officials "$OUT"
OUT=$(SUX -c "set session_replication_role = replica; update public.event_competition_rounds set status='active' where id='$R3';" 2>&1) || die "round active" "$OUT"
if [ "$P1" != 0 ]; then
  OUT=$(SUX -c "set session_replication_role = replica; update public.event_competition_heats set status='complete' where id='$H3';" 2>&1) || die "heat complete" "$OUT"
fi
marks() { echo "'[{\"entry_id\":\"$E31\",\"value\":$1},{\"entry_id\":\"$E32\",\"value\":$2}]'::jsonb"; }
for step in "1 2|c101|" "2 1|c102|first fix" "1 2|c103|second fix"; do
  IFS='|' read -r vals req why <<<"$step"
  OUT=$(SUX <<SQL 2>&1
$(as_user "$J1")
select public.submit_competition_ballot('$R3','$H3',$(marks $vals),'$(U $req)'$([ -n "$why" ] && echo ",'$why'"));
SQL
) || die "ballot $req" "$OUT"
done

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

# 3: positive control -- ballot + mark in ONE transaction is accepted (judge 2 has no ballot on this heat), then rolled back
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
ok "ballot and mark in the same transaction are accepted (control)" $(echo "$OUT" | grep -q "SAME_TXN_OK" && ! echo "$OUT" | grep -q ERROR && echo 1 || echo 0)
ok "the control left no ballot behind" $([ "$(SU -c "select count(*) from public.event_competition_ballots where round_id='$R3' and official_id='$OFF2'")" = "0" ] && echo 1 || echo 0)

# 4: ballot committed in transaction 1; marks offered by transaction 2 are refused
OUT=$(SU -v ON_ERROR_STOP=1 -c "insert into public.event_competition_ballots (event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by) values ('$EV', '$R3', '$H3', '$OFF2', 'ordinal_rank', 1, 1, 'judge_web', '$J2')" 2>&1)
B2=$(SU -c "select id from public.event_competition_ballots where round_id='$R3' and official_id='$OFF2'")
OUT=$(SU -v ON_ERROR_STOP=1 -c "insert into public.event_competition_marks (event_id, ballot_id, entry_id, mark) values ('$EV', '$B2', '$E31', '1'::jsonb)" 2>&1)
ok "marks for a ballot committed earlier are refused (second transaction)" $([ -n "$B2" ] && echo "$OUT" | grep -q "COMP_BALLOT_IMMUTABLE" && echo 1 || echo 0)

# 5: committed marks are append-only from a new transaction and unchanged afterwards
OUT=$(SU -v ON_ERROR_STOP=1 -c "update public.event_competition_marks set mark = '9'::jsonb where ballot_id = '$B1'" 2>&1)
ok "UPDATE of committed marks is refused" $(echo "$OUT" | grep -q "append-only" && echo 1 || echo 0)
OUT=$(SU -v ON_ERROR_STOP=1 -c "delete from public.event_competition_marks where ballot_id = '$B1'" 2>&1)
ok "DELETE of committed marks is refused" $(echo "$OUT" | grep -q "append-only" && echo 1 || echo 0)
ok "mark rows unchanged by the probes" $([ "$MARKS_BEFORE" -gt 0 ] && [ "$(SU -c "select count(*) from public.event_competition_marks where event_id='$EV'")" = "$MARKS_BEFORE" ] && echo 1 || echo 0)

if [ -z "$FAILS" ]; then echo "E2 MARKS-TXN CHAIN-COPY PASS ($PASS checks)"; exit 0; fi
echo "E2 MARKS-TXN CHAIN-COPY FAIL:$FAILS"; exit 1
