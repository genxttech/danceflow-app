#!/usr/bin/env bash
# Micro-experiment (no NSI objects): does a STABLE (or VOLATILE) SECURITY DEFINER function called from a volatile plpgsql BEFORE DELETE
# trigger see a row committed by another session WHILE the DELETE statement waited for a row lock?
# Plain tables, two scenarios, three sessions each (blocker B, deleter A, inserter H). LOCAL DISPOSABLE CONTAINERS ONLY (nsi-i2-*).
# usage: stable_snapshot_experiment_local.sh <container>
set -u
DB="${1:?container}"
case "$DB" in nsi-i2-*) ;; *) echo "refused: container must be a disposable local stack"; exit 2;; esac
export MSYS_NO_PATHCONV=1
p() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -v ON_ERROR_STOP=0 -c "$1" 2>&1; }
p "drop schema if exists exp cascade; create schema exp;" >/dev/null
for VOL in stable volatile; do
  p "create table exp.t_$VOL (id int primary key);
     create table exp.holds_$VOL (id int primary key, effective_at timestamptz not null default now());
     insert into exp.t_$VOL values (1);
     create function exp.is_held_$VOL() returns boolean language sql $VOL security definer set search_path = pg_catalog, pg_temp as \$\$ select exists (select 1 from exp.holds_$VOL) \$\$;
     create function exp.guard_$VOL() returns trigger language plpgsql as \$\$ begin if exp.is_held_$VOL() then raise exception 'held (seen by the guard)' using errcode = '42501'; end if; return old; end \$\$;
     create trigger g before delete on exp.t_$VOL for each row execute function exp.guard_$VOL();" >/dev/null
  # B holds a row lock; A (deleter) starts and waits; H inserts + commits a hold while A waits; B commits; A's delete proceeds
  ( p "begin; select id from exp.t_$VOL where id = 1 for update; select pg_sleep(6); commit;" > /tmp/exp_b_$VOL.out ) &
  sleep 1.5
  ( p "delete from exp.t_$VOL where id = 1;" > /tmp/exp_a_$VOL.out ) &
  sleep 1.5
  p "insert into exp.holds_$VOL (id) values (1);" > /tmp/exp_h_$VOL.out
  wait
  left=$(p "select count(*) from exp.t_$VOL;")
  echo "function volatility=$VOL: hold committed during the delete's row-lock wait; rows left in t=$left; delete output: $(tr '\n' ' ' < /tmp/exp_a_$VOL.out | cut -c1-120)"
done
p "drop schema exp cascade;" >/dev/null
