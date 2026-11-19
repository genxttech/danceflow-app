#!/usr/bin/env bash
# Anonymous, read-only smoke for web release R+1 (no accounts, no writes). Usage: web-r1-smoke.sh <base-url> [label]
# AVAIL_EXPECT overrides the status expected for the availability route (default 401 on a promoted release build). Use 404 against a build that
# does not have the route yet (the pre-release deployment), and 302/401 as the staged URL answers behind Vercel SSO (check what it returns first).
# Exit status is 1 if any check FAILs.
B="${1:-https://www.idanceflow.com}"; L="${2:-run}"; FAILS=0
echo "# smoke $L $(date -u +%FT%TZ) base=$B"
chk(){ # path expect
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$B$1"); ok=FAIL; if [ "$code" = "$2" ]; then ok=ok; else FAILS=$((FAILS+1)); fi
  echo "$ok  GET $1 -> $code (expect $2)"; }
chk / 200
chk /login 200
chk /discover/studios 200
chk /embed/class/x 404
chk /api/cron/sms-price-monitor 401
chk /api/cron/sms-usage-reconcile 401
chk /api/notifications/send 401
chk /api/cron/sms-price-sweep 401
chk /api/student/events/00000000-0000-4000-8000-000000000000/availability "${AVAIL_EXPECT:-401}"
echo -n "frame headers /login: "; curl -sI --max-time 20 "$B/login" | grep -iE "^x-frame-options|^content-security-policy" | tr -d '\r' | cut -c1-90 | tr '\n' ' '; echo
[ "$FAILS" -eq 0 ] && echo "SMOKE: PASS" || { echo "SMOKE: FAIL ($FAILS)"; exit 1; }
