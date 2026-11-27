#!/usr/bin/env bash
# NSI I2 M7-M9 concurrency harness K4 (review P2-1): archive vs default change / lesson-type selection, and concurrent grants.
# LOCAL DISPOSABLE CONTAINERS ONLY (nsi-i2-*). Commits synthetic fixtures; discard the container afterwards.
#   K4a  archive holds its transaction open while "set as default" runs      -> never (archived AND default)
#   K4b  "set as default" holds its transaction open while archive runs      -> never (archived AND default)
#   K4c  archive holds its transaction open while "select lesson type" runs  -> never (archived AND selected)
#   K4d  "select lesson type" holds its transaction open while archive runs  -> never (archived AND selected)
#   K4e  N concurrent platform-admin grants for one studio/capability        -> exactly one unrevoked grant
set -u
DB="${1:?container}"; N="${2:-3}"
case "$DB" in nsi-i2-*|supabase_db_nsi*) ;; *) echo "refused: disposable local container only"; exit 2;; esac
export MSYS_NO_PATHCONV=1
q() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
S=a5600000-0000-0000-0000-00000000000a
OWN=a5600000-0000-0000-0000-000000000101; PADM=a5600000-0000-0000-0000-000000000401
as() { # user role sql
  docker exec -i "$DB" psql -U postgres -d postgres -X -At -c "select set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"$2\"}', false); set role $2; $3" 2>&1
}
q "insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
     ('$OWN','00000000-0000-0000-0000-000000000000','authenticated','authenticated','k4-owner@nsi-test.invalid',now(),now()),
     ('$PADM','00000000-0000-0000-0000-000000000000','authenticated','authenticated','k4-padmin@nsi-test.invalid',now(),now()) on conflict do nothing;
   insert into public.profiles (id, platform_role) values ('$OWN', null), ('$PADM', 'platform_admin') on conflict (id) do update set platform_role = excluded.platform_role;
   insert into public.studios (id, name, slug) values ('$S', 'K4', 'nsi-i2-k4') on conflict do nothing;
   insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$OWN', '$S', 'studio_owner', true) on conflict do nothing;
   insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at) values
     ('$S','config_preview','k4 harness','$PADM', now()+interval '30 days'), ('$S','live_collection','k4 harness','$PADM', now()+interval '30 days');" >/dev/null
fail=0
mk_tpl() { # id name
  q "insert into public.intake_templates (id, studio_id, name) values ('$1', '$S', '$2') on conflict do nothing;
     insert into public.intake_template_versions (studio_id, template_id, version_number, status, schema, schema_sha256, max_answer_bytes, published_at)
     select '$S', '$1', 1, 'published', '{\"sections\":[]}'::jsonb, 'x', 10, now() where not exists (select 1 from public.intake_template_versions where template_id = '$1');" >/dev/null
}
check_default() { # template round label
  bad=$(q "select count(*) from public.intake_templates t join public.intake_settings s on s.default_template_id = t.id where t.id = '$1' and t.status = 'archived';")
  [ "$bad" = "0" ] || { fail=$((fail+1)); echo "K4 $3 round $2: template $1 is archived AND the studio default"; }
}
check_sel() {
  bad=$(q "select count(*) from public.intake_templates t join public.intake_service_assignments a on a.template_id = t.id where t.id = '$1' and t.status = 'archived';")
  [ "$bad" = "0" ] || { fail=$((fail+1)); echo "K4 $3 round $2: template $1 is archived AND selected for a lesson type"; }
}
q "insert into public.intake_settings (studio_id, enabled, default_template_id) values ('$S', false, null) on conflict (studio_id) do nothing;" >/dev/null
for i in $(seq 1 "$N"); do
  T=$(printf 'a5600000-0000-0000-0001-%012d' "$i"); mk_tpl "$T" "K4a $i"
  tmp=$(mktemp)
  as $OWN authenticated "select public.intake_archive_template('$S','$T'); select pg_sleep(3);" >"$tmp.1" 2>&1 &
  sleep 1
  as $OWN authenticated "select public.intake_update_settings('$S', jsonb_build_object('default_template_id','$T'));" >"$tmp.2" 2>&1 &
  wait; check_default "$T" "$i" K4a
  T=$(printf 'a5600000-0000-0000-0002-%012d' "$i"); mk_tpl "$T" "K4b $i"
  as $OWN authenticated "select public.intake_update_settings('$S', jsonb_build_object('default_template_id','$T')); select pg_sleep(3);" >"$tmp.1" 2>&1 &
  sleep 1
  as $OWN authenticated "select public.intake_archive_template('$S','$T');" >"$tmp.2" 2>&1 &
  wait; check_default "$T" "$i" K4b
  q "update public.intake_settings set default_template_id = null where studio_id = '$S';" >/dev/null
  T=$(printf 'a5600000-0000-0000-0003-%012d' "$i"); mk_tpl "$T" "K4c $i"
  as $OWN authenticated "select public.intake_archive_template('$S','$T'); select pg_sleep(3);" >"$tmp.1" 2>&1 &
  sleep 1
  as $OWN authenticated "select public.intake_set_service_type('$S','coaching', true, '$T');" >"$tmp.2" 2>&1 &
  wait; check_sel "$T" "$i" K4c
  q "delete from public.intake_service_assignments where studio_id = '$S';" >/dev/null
  T=$(printf 'a5600000-0000-0000-0004-%012d' "$i"); mk_tpl "$T" "K4d $i"
  as $OWN authenticated "select public.intake_set_service_type('$S','coaching', true, '$T'); select pg_sleep(3);" >"$tmp.1" 2>&1 &
  sleep 1
  as $OWN authenticated "select public.intake_archive_template('$S','$T');" >"$tmp.2" 2>&1 &
  wait; check_sel "$T" "$i" K4d
  q "delete from public.intake_service_assignments where studio_id = '$S';" >/dev/null
  rm -f "$tmp" "$tmp.1" "$tmp.2"
done
echo "K4a-d archive vs default/selection races: rounds=$N failures=$fail"
# K4e: concurrent grants
g=0
for i in $(seq 1 "$N"); do
  tmp=$(mktemp)
  for k in 1 2 3; do as $PADM authenticated "select public.intake_grant_feature('$S','live_collection','k4e round $i session $k', 30);" >"$tmp.$k" 2>&1 & done
  wait
  n=$(q "select count(*) from public.intake_feature_grants where studio_id = '$S' and capability = 'live_collection' and revoked_at is null;")
  ok=$(cat "$tmp".* | grep -cE '^[0-9a-f-]{36}$')
  if [ "$n" != "1" ] || [ "$ok" -lt 1 ]; then g=$((g+1)); echo "K4e round $i: unrevoked=$n successes=$ok :: $(cat "$tmp".* | tr '\n' ' ' | cut -c1-300)"; fi
  rm -f "$tmp".*
done
echo "K4e concurrent grants: rounds=$N failures=$g"
cat=$(q "select intake_private.assert_catalog();")
echo "catalog after races: [${cat:-ok}]"
echo "SUMMARY archive-race/grant concurrency: failures=$((fail+g))"
[ "$((fail+g))" = "0" ] && [ -z "$cat" ]
