#!/usr/bin/env bash
# Runs one NSI I2 M7-M9 boundary test file against the disposable local container (fixtures prepended).
# usage: run_i2_m7_m9_local.sh <container nsi-i2-*> <test file> [appointments_fp]
set -u
DB="${1:?container}"; T="${2:?test file}"; FP="${3:-e0c4db1b4d1b027df0e6e1593d0f14ce}"
case "$DB" in nsi-i2-*|supabase_db_nsi*) ;; *) echo "refused: disposable local container only"; exit 2;; esac
D="$(cd "$(dirname "$0")" && pwd)"
{ echo "set nsi.test_local = 'on'; set nsi.appointments_fp = '$FP';"; cat "$D/nsi_i2_fixtures_local.sql" "$D/$T"; } \
  | docker exec -i "$DB" psql -U postgres -q 2>&1 | grep -E "SUITE|^ERROR|CONTEXT" | head -${LINES_OUT:-4} | cut -c1-4000
