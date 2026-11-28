// Builds gsub_dev_validate.sql: runs the exact PROD body templates (with substituted test constants) inside one transaction that always rolls back.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const S = randomUUID();
const body = (kind, name, legal) =>
  "do $b$\ndeclare\n" + readFileSync(`docs/twilio/ops-sql/${kind}.body.sql`, "utf8").replaceAll("__STUDIO__", S).replaceAll("__NAME__", name).replaceAll("__LEGAL__", legal).replaceAll("__CAP_CENTS__", "100") + "end $b$;\n";
const t = (label, text, okKey) =>
  `  begin execute $q$${text}$q$; v_res := v_res || jsonb_build_object('${label}', ${okKey ?? "'NOT_REFUSED'"}); exception when others then v_res := v_res || jsonb_build_object('${label}', sqlerrm); end;\n`;
const L = "Rehearsal Dance, LLC";
let sql = `do $outer$
declare v_res jsonb := '{}'::jsonb; v_owner uuid := gen_random_uuid();
begin
  set local session_replication_role = replica;
  insert into public.studios (id,name,slug,subscription_status,timezone) values ('${S}','Rehearsal Studio','gsub-r-${S.slice(0, 8)}','active','America/New_York');
  insert into public.user_studio_roles (user_id, studio_id, role, active) values (v_owner, '${S}', 'studio_owner', true);
  set local session_replication_role = origin;
`;
sql += t("access_wrong_name", body("access", "Other Studio", L));
sql += t("access_ok", body("access", "Rehearsal Studio", L), `(select enabled from public.studio_sms_onboarding_access where studio_id='${S}')::text`);
sql += t("access_idempotent", body("access", "Rehearsal Studio", L), "'ok'");
sql += t("entity_no_onboarding", body("entity", "Rehearsal Studio", L));
sql += `  set local session_replication_role = replica;
  insert into public.studio_sms_onboarding (studio_id,state,legal_name,ein_last4,submission_seq) values ('${S}','draft','${L}','0000',0);
  set local session_replication_role = origin;
`;
sql += t("entity_draft", body("entity", "Rehearsal Studio", L));
sql += `  set local session_replication_role = replica;
  update public.studio_sms_onboarding set state='submitted_for_checks', attested_at=now(), attested_by=gen_random_uuid(), ein_stored_at=now(), rep_first_name='R', rep_last_name='Rep', rep_email='rep@example.test', address_line1='1 Test St', submission_seq=1, submitted_at=now() where studio_id='${S}';
  set local session_replication_role = origin;
`;
sql += t("entity_attested_by_non_owner", body("entity", "Rehearsal Studio", L));
sql += `  set local session_replication_role = replica; update public.studio_sms_onboarding set attested_by = v_owner where studio_id='${S}'; set local session_replication_role = origin;
`;
sql += t("entity_wrong_legal", body("entity", "Rehearsal Studio", "Someone Else LLC"));
sql += t("entity_ok", body("entity", "Rehearsal Studio", L), `(select e.spend_cap_cents from public.studio_sms_legal_entities e join public.studio_sms_entity_studios s on s.legal_entity_id=e.id where s.studio_id='${S}')::text`);
sql += t("entity_replay", body("entity", "Rehearsal Studio", L));
sql += `  set local session_replication_role = replica; update public.studio_sms_onboarding set legal_name='GenX TotalTech LLC' where studio_id='${S}'; set local session_replication_role = origin;
`;
sql += t("genx_subject", body("entity", "Rehearsal Studio", "GenX TotalTech LLC"));
sql += `  v_res := v_res || jsonb_build_object('twilio_account_rows', (select count(*) from public.studio_sms_twilio_accounts), 'audit', (select jsonb_agg(action order by created_at) from public.studio_sms_onboarding_audit where studio_id='${S}'));
  raise exception 'GSUB_RESULT %', v_res::text;
end $outer$;
`;
writeFileSync("docs/twilio/ops-sql/gsub_dev_validate.sql", sql);
console.log("written", sql.length);
