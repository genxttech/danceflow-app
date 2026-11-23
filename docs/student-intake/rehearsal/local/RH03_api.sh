#!/usr/bin/env bash
# RH03 — G10 through the Supabase API (Kong -> GoTrue / PostgREST) on the disposable stack only.
# Uses the stack's local default keys (printed by `supabase start`), synthetic @nsi-rh.test users. Prints no tokens.
set -u
API="http://127.0.0.1:56321"
DB="supabase_db_nsi-g7-rehearsal"
W="$(cd "$(dirname "$0")" && pwd)"
eval "$(supabase status --workdir "$W" -o env 2>/dev/null | grep -E '^(PUBLISHABLE_KEY|SECRET_KEY|ANON_KEY|SERVICE_ROLE_KEY)=')"
PUB="${PUBLISHABLE_KEY:-$ANON_KEY}"; SEC="${SECRET_KEY:-$SERVICE_ROLE_KEY}"
[ -n "$PUB" ] && [ -n "$SEC" ] || { echo "keys not found"; exit 1; }
S1=11111111-1111-1111-1111-111111111111; C1=c0000000-0000-0000-0000-000000000001; C2=c0000000-0000-0000-0000-000000000002
json() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(eval('o'+process.argv[1]))}catch(e){console.log('PARSE_ERR')}})" "$1"; }
psqlc() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "$1"; }
results=()
rec() { results+=("$1|$2|$3|$4"); }

mkuser() { curl -s -X POST "$API/auth/v1/admin/users" -H "apikey: $SEC" -H "Authorization: Bearer $SEC" -H "Content-Type: application/json" \
  -d "{\"email\":\"$1\",\"password\":\"$PW\",\"email_confirm\":true}" | json '.id'; }
PW="${NSI_RH_SYNTHETIC_PASSWORD:?set NSI_RH_SYNTHETIC_PASSWORD at run time (never committed)}"
mkuser2() { curl -s -X POST "$API/auth/v1/admin/users" -H "apikey: $SEC" -H "Authorization: Bearer $SEC" -H "Content-Type: application/json" \
  -d "{\"email\":\"$1\",\"password\":\"$PW\",\"email_confirm\":true}" | json '.id'; }
token() { curl -s -X POST "$API/auth/v1/token?grant_type=password" -H "apikey: $PUB" -H "Content-Type: application/json" \
  -d "{\"email\":\"$1\",\"password\":\"$PW\"}" | json '.access_token'; }

ADMIN_ID=$(mkuser2 admin@nsi-rh.test); USER_ID=$(mkuser2 user@nsi-rh.test)
echo "synthetic users created: admin=$ADMIN_ID user=$USER_ID"
psqlc "insert into public.nsi_rh_profiles values ('$ADMIN_ID','platform_admin'),('$USER_ID',null) on conflict do nothing;
       insert into public.nsi_rh_requests(studio_id, client_id, answers) values ('$S1','$C1','{\"q\":\"synthetic-api-1\"}'),('$S1','$C1','{\"q\":\"synthetic-api-2\"}'),('$S1','$C2','{\"q\":\"synthetic-api-3\"}');" >/dev/null
ADMIN_JWT=$(token admin@nsi-rh.test); USER_JWT=$(token user@nsi-rh.test)
[ ${#ADMIN_JWT} -gt 100 ] && [ ${#USER_JWT} -gt 100 ] || { echo "token fetch failed"; exit 1; }

call() { # $1=bearer-or-empty $2=apikey $3=fn $4=body $5=extra header
  local auth=(); [ -n "$1" ] && auth=(-H "Authorization: Bearer $1")
  local extra=(); [ -n "${5:-}" ] && extra=(-H "$5")
  curl -s -o /tmp/nsi_rh_body.$$ -w '%{http_code}' -X POST "$API/rest/v1/rpc/$3" -H "apikey: $2" "${auth[@]}" "${extra[@]}" -H "Content-Type: application/json" -d "$4"
}
body() { head -c 220 /tmp/nsi_rh_body.$$ | tr '\n' ' '; }

# G10-A1 ordinary authenticated user denied
c=$(call "$USER_JWT" "$PUB" intake_erase_client "{\"p_studio\":\"$S1\",\"p_client\":\"$C1\",\"p_reason\":\"synthetic\"}")
rec G10-A1 "ordinary authenticated user denied" "$c $(body)" "$([[ $c == 403 || $c == 401 ]] && grep -q 42501 /tmp/nsi_rh_body.$$ && echo PASS || echo FAIL)"

# G10-A2 service-role-only caller denied (no user identity)
c=$(call "" "$SEC" intake_erase_client "{\"p_studio\":\"$S1\",\"p_client\":\"$C1\",\"p_reason\":\"synthetic\"}")
rec G10-A2 "service-role-only caller denied" "$c $(body)" "$([[ $c == 401 || $c == 403 ]] && echo PASS || echo FAIL)"

# G10-A3 anon (publishable key, no user) denied
c=$(call "" "$PUB" intake_erase_client "{\"p_studio\":\"$S1\",\"p_client\":\"$C1\",\"p_reason\":\"synthetic\"}")
rec G10-A3 "anon caller denied" "$c $(body)" "$([[ $c == 401 || $c == 403 ]] && echo PASS || echo FAIL)"

# G10-A4 spoofed actor parameter (user JWT claims to act as admin) denied
c=$(call "$USER_JWT" "$PUB" intake_erase_client "{\"p_studio\":\"$S1\",\"p_client\":\"$C1\",\"p_reason\":\"synthetic\",\"p_actor\":\"$ADMIN_ID\"}")
rec G10-A4 "spoofed p_actor parameter denied (no such signature)" "$c $(body)" "$([[ $c != 200 ]] && echo PASS || echo FAIL)"

# G10-A5 forged claims: user token with payload rewritten to admin sub, original signature
FORGED=$(node -e "const t=process.argv[1].split('.');const p=JSON.parse(Buffer.from(t[1],'base64url'));p.sub=process.argv[2];t[1]=Buffer.from(JSON.stringify(p)).toString('base64url');console.log(t.join('.'))" "$USER_JWT" "$ADMIN_ID")
c=$(call "$FORGED" "$PUB" intake_erase_client "{\"p_studio\":\"$S1\",\"p_client\":\"$C1\",\"p_reason\":\"synthetic\"}")
rec G10-A5 "forged claims (re-written sub, stale signature) rejected" "$c $(body)" "$([[ $c == 401 ]] && echo PASS || echo FAIL)"

# G10-A6 forged unsigned token (alg none) rejected
NONE=$(node -e "const h=Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url');const p=Buffer.from(JSON.stringify({sub:process.argv[1],role:'authenticated',aud:'authenticated',exp:Math.floor(Date.now()/1000)+600})).toString('base64url');console.log(h+'.'+p+'.')" "$ADMIN_ID")
c=$(call "$NONE" "$PUB" intake_erase_client "{\"p_studio\":\"$S1\",\"p_client\":\"$C1\",\"p_reason\":\"synthetic\"}")
rec G10-A6 "unsigned alg=none token rejected" "$c $(body)" "$([[ $c == 401 ]] && echo PASS || echo FAIL)"

# G10-A7 direct call to the private implementation is not reachable
c=$(call "$ADMIN_JWT" "$PUB" erase_client_impl "{\"p_studio\":\"$S1\",\"p_client\":\"$C1\",\"p_actor\":\"$ADMIN_ID\",\"p_reason\":\"x\"}" "Content-Profile: intake_private")
rec G10-A7 "private implementation not exposed (Content-Profile intake_private)" "$c $(body)" "$([[ $c != 200 ]] && echo PASS || echo FAIL)"
c=$(call "$ADMIN_JWT" "$PUB" erase_client_impl "{\"p_studio\":\"$S1\",\"p_client\":\"$C1\",\"p_actor\":\"$ADMIN_ID\",\"p_reason\":\"x\"}")
rec G10-A7b "private implementation not resolvable in public" "$c $(body)" "$([[ $c != 200 ]] && echo PASS || echo FAIL)"

# G10-A8 admin without reason refused
c=$(call "$ADMIN_JWT" "$PUB" intake_erase_client "{\"p_studio\":\"$S1\",\"p_client\":\"$C1\",\"p_reason\":\" \"}")
rec G10-A8 "platform admin without reason refused" "$c $(body)" "$([[ $c != 200 ]] && echo PASS || echo FAIL)"

# G10-A9 platform admin authorized
c=$(call "$ADMIN_JWT" "$PUB" intake_erase_client "{\"p_studio\":\"$S1\",\"p_client\":\"$C1\",\"p_reason\":\"synthetic rehearsal\"}")
rec G10-A9 "platform admin authorized (rows erased)" "$c $(body)" "$([[ $c == 200 ]] && [[ "$(cat /tmp/nsi_rh_body.$$)" == 2 ]] && echo PASS || echo FAIL)"

# G10-A10 actual authenticated actor recorded; executed as restricted role; other client untouched
row=$(psqlc "select actor_user_id||'|'||exec_role from public.nsi_rh_audit where client_ref='$C1' and event_type='erasure_record' order by created_at desc limit 1")
c2=$(psqlc "select count(*) from public.nsi_rh_requests where client_id='$C2'")
rec G10-A10 "audit actor = admin auth.uid(); exec_role = intake_destructive; C2 intact" "$row c2=$c2" "$([[ "$row" == "$ADMIN_ID|intake_destructive" && "$c2" == 1 ]] && echo PASS || echo FAIL)"

# G10-A11 barrier: release by ordinary user denied; by admin allowed and appended
c=$(call "$USER_JWT" "$PUB" intake_release_erasure_barrier "{\"p_studio\":\"$S1\",\"p_client\":\"$C1\",\"p_reason\":\"synthetic\"}")
rec G10-A11a "barrier release by ordinary user denied" "$c $(body)" "$([[ $c != 200 && $c != 204 ]] && echo PASS || echo FAIL)"
c=$(call "$ADMIN_JWT" "$PUB" intake_release_erasure_barrier "{\"p_studio\":\"$S1\",\"p_client\":\"$C1\",\"p_reason\":\"synthetic rehearsal\"}")
rel=$(psqlc "select count(*)||'|'||max(actor_user_id::text) from public.nsi_rh_audit where client_ref='$C1' and event_type='erasure_barrier_released'")
rec G10-A11b "barrier release by admin appended with admin actor" "$c rel=$rel" "$([[ ($c == 200 || $c == 204) && "$rel" == "1|$ADMIN_ID" ]] && echo PASS || echo FAIL)"

# G10-A12 caller identity crossed the private boundary without role access to auth
au=$(psqlc "select has_schema_privilege('intake_destructive','auth','USAGE')")
rec G10-A12 "restricted role has no auth schema USAGE (actor passed from wrapper)" "auth_usage=$au" "$([[ $au == f ]] && echo PASS || echo FAIL)"

rm -f /tmp/nsi_rh_body.$$
printf '%s\n' "${results[@]}"
pass=$(printf '%s\n' "${results[@]}" | grep -c '|PASS$'); echo "SUMMARY: $pass/${#results[@]} passed"
