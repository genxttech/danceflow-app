#!/bin/bash
# RB4 applied-chain integrity run. Own container cf1rb4-pg, no host ports. Local only.
export MSYS_NO_PATHCONV=1
# Local layout comes from the environment (not committed): QA_RUN = the QA run directory (outside the repo), REPO_ROOT = the main checkout holding the refs, INT3_WT = the integration-3 worktree.
: "${QA_RUN:?set QA_RUN}" "${REPO_ROOT:?set REPO_ROOT}" "${INT3_WT:?set INT3_WT}"; export QA_RUN REPO_ROOT INT3_WT
E=$QA_RUN/evidence/rb4; FC=$QA_RUN/fullchain; Q=$QA_RUN
C=cf1rb4-pg; REF=origin/cf1/integration-3; REPO=$REPO_ROOT; M=src/lib/supabase/migrations
SK=20260721234500_create_commerce_cover_images.sql,20260918030000_landmark1a_slice5a_capability_activation_bridge.sql,20261005090000_launchsec1b_client_photos_private_storage.sql,20261006090000_launchsec1b2_public_asset_storage_authorization.sql
CR=20260831090000_user_has_client_portal_access_helper.sql,20260715_payroll_prep_v1_pay_periods_batches.sql,20260715_payroll_operations_completion.sql
LOG=$E/run.log; : > $LOG
log() { echo "$*" | tee -a $LOG; }
psq() { docker exec -i -e PGPASSWORD=postgres $C psql -U ${PSU:-postgres} -h localhost -d postgres -q -v ON_ERROR_STOP=1 "$@"; }
fpall() { for f in $Q/fp.sql $E/fp_ext.sql; do docker exec -i -e PGPASSWORD=postgres $C psql -U supabase_admin -h localhost -d postgres -Atq < $f; done | sort; }
snap() { docker exec -i -e PGPASSWORD=postgres $C psql -U supabase_admin -h localhost -d postgres -Atq < $E/fn_md5.sql > $E/snaps/$1.tsv; }
blob() { git -C $REPO show $REF:$M/$1; }
applyf() { # label path-in-migrations user
  local o; o=$(blob "$2" | docker exec -i -e PGPASSWORD=postgres $C psql -U $3 -h localhost -d postgres -q -v ON_ERROR_STOP=1 -1 2>&1)
  if echo "$o" | grep -q ERROR; then log "APPLY FAIL $1 $2: $(echo "$o" | grep -m2 ERROR | tr '\n' ' ' | cut -c1-300)"; return 1; fi; return 0; }
if [ "$1" = build ]; then
docker rm -f -v $C >/dev/null 2>&1
log "REF $REF = $(git -C $REPO rev-parse $REF)"
docker run -d --name $C --memory 1500m --cpus 2 -e POSTGRES_PASSWORD=postgres public.ecr.aws/supabase/postgres:17.6.1.106 postgres -D /etc/postgresql -c supautils.hint_roles= >/dev/null
ok=0; for i in $(seq 1 80); do if docker exec $C psql -U postgres -d postgres -At -c 'select 1' >/dev/null 2>&1; then ok=$((ok+1)); [ $ok -ge 3 ] && break; sleep 4; else ok=0; sleep 3; fi; done
A="docker exec -i -e PGPASSWORD=postgres $C psql -h localhost -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1"
$A < $FC/bootstrap.sql && $A -c "alter table auth.users add column if not exists email_confirmed_at timestamptz, add column if not exists banned_until timestamptz, add column if not exists deleted_at timestamptz;" || { log bootstrap FAIL; exit 4; }
docker exec -i -e PGPASSWORD=postgres $C psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < $REPO_ROOT/backups/danceflow-production-pre-accounting-v1-2026-07-15.sql >/dev/null 2>&1 || { log dump FAIL; exit 4; }
export CHAIN_CONTAINER=$C
grep -v '^20270' $FC/ord_b.txt > $E/ord_b_pre2027.txt; grep '^20270' $FC/ord_b.txt > $E/ord_2027_precf1.txt
cp $FC/ord_a.txt $E/ord_a.txt
BL=$E/build.log; : > $BL
node $QA_RUN/fullchain/build.mjs --ref $REF --order $QA_RUN/evidence/rb4/ord_a.txt --stop --skip $SK --crlf $CR --log $QA_RUN/evidence/rb4/build.log >/dev/null 2>&1 || { log 'build A FAIL'; exit 4; }
docker exec -e PGPASSWORD=postgres $C psql -U postgres -d postgres -q -c 'alter table public.appointments enable trigger appointments_sync_membership_usage_for_private_lesson' || exit 4
node $QA_RUN/fullchain/build.mjs --ref $REF --order $QA_RUN/evidence/rb4/ord_b_pre2027.txt --stop --skip $SK --crlf $CR --log $QA_RUN/evidence/rb4/build.log >/dev/null 2>&1 || { log 'build B FAIL'; exit 4; }
log "PRE-2027 chain: $(grep -c '^OK' $BL) applied, $(grep -c '^SKIP' $BL) skipped, $(grep -c '^FAIL' $BL) failed"
fpall > $E/fp_00_pre_competition.txt; snap 00_pre_competition
log "snapshot pre-competition: $(wc -l < $E/fp_00_pre_competition.txt) fp lines"
fi
