-- CF1 RB4 hosted READ-ONLY catalog check. NOT EXECUTED. Needs the owner approval named in docs/qa/cf1-rb4-hosted-readonly-request-2026-11-07.md.
-- Run once per target: DEV (epdrtzcydvnoidwrepqz, repo link) and PROD (hvsujyfbftfffxpfmlpb, fresh scratch --workdir link):
--   supabase db query --linked -f docs/qa/cf1-rb4-int5/hosted/readonly_catalog_check.sql
-- Reads ONLY pg_catalog / information_schema. No application table is selected from, no row is read. The transaction is READ ONLY and always rolled back.
begin read only;
set local statement_timeout = '10s';

-- Q1 CF1 existence (expected on a database where CF1 is not applied: every number 0).
select 'Q1' as q,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and (left(p.proname, 5) = '_cf1_' or left(p.proname, 4) = 'cf1_' or strpos(p.proname, '_cf1_') > 0)) as cf1_functions,
  (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname in ('competition_cf1_od17_audit', 'competition_cf1_od17_enforcement', 'competition_cf1_rb3_gate_overrides', 'competition_cf1_rb3_reconciliations', 'event_competition_ballot_corrections', 'event_competition_correction_causes', 'event_competition_correction_cosigns', 'event_competition_final_withdrawal_request_cancellations', 'event_competition_final_withdrawal_requests', 'event_competition_final_withdrawals', 'event_competition_result_publications', 'event_competition_round_advancement_entries', 'event_competition_round_advancement_heats', 'event_competition_round_advancement_revocations', 'event_competition_round_advancements', 'event_competition_round_capacity_events', 'event_competition_round_exclusions')) as cf1_tables,
  (select count(*) from pg_trigger t where not t.tgisinternal and left(t.tgname, 4) = 'cf1_') as cf1_triggers,
  to_regclass('public.event_competition_correction_causes') is not null as a7_causes_table;

-- Q2 pre-CF1 pins of the functions CF1 redefines. pre_base = expected md5 on the pre-R2 base, pre_r2 = after R2, post_cf1 = after the CF1 chain.
-- md5 = md5(pg_get_functiondef with CR removed), the same definition the migrations pin.
with expected(sig, pre_base, pre_r2, post_cf1) as (values
    ('_comp10d_copy_floor_plan(uuid,uuid)', '8162a7341b7bcd00a141e81392c8c602', '8162a7341b7bcd00a141e81392c8c602', 'd8a61d3432db9f4b116227bff575a2ee'),
    ('_comp10d_guard_floor_heat()', 'bd20973caffce985813daadde8be947a', 'bd20973caffce985813daadde8be947a', 'f34af508b3da4d249c0245a8c16d8f0b'),
    ('_comp10d_guard_heat_child()', '9bb78230385387a3c6a39e66f2d9f8d0', '9bb78230385387a3c6a39e66f2d9f8d0', 'f4b9277a0d6e2867640210ef513e5c5b'),
    ('_compe2_guard_mark_insert()', '786bdf3604fa36e5f8328ecc0d5385ad', '786bdf3604fa36e5f8328ecc0d5385ad', '055adcc12d8f903a7570c93008f303a9'),
    ('_compe2_heat_entries(uuid)', 'f275ced91a3b319aaf0835f67bfe174d', 'f275ced91a3b319aaf0835f67bfe174d', 'fdcb8728dde030c8d9772fdaf2963524'),
    ('_compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)', '4e16740112345ac0c306e841b82ac473', '4e16740112345ac0c306e841b82ac473', 'e5cecd7b4cff91bbdb7222cc5061b4d9'),
    ('_compe2_round_entries(uuid)', 'f0da6935a3dcc04320f7636da6655a3b', 'f0da6935a3dcc04320f7636da6655a3b', '64859bac497c22fd7472b9e7ae6fc986'),
    ('_compe2_round_heats(uuid)', '1e75e888142ed1727eb6b2d6c8c0a906', '1e75e888142ed1727eb6b2d6c8c0a906', '7a5a1563a9450e2ec3b807a69737f9f4'),
    ('_compf2_evidence(uuid,text,text)', '2b1c9a22be4a4c4a4e5ba43adee37306', '2b1c9a22be4a4c4a4e5ba43adee37306', '415a823b4a689cae26b8a20187af58e7'),
    ('approve_competition_round_result(uuid,uuid,text,uuid)', '0650367be64e3d1b4387a3dbceba3d4a', '0650367be64e3d1b4387a3dbceba3d4a', 'ac33e456925e64665db1ea0547bae18b'),
    ('calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)', 'ddaa45cbb518f7592f5ca6dd0ba00176', 'ddaa45cbb518f7592f5ca6dd0ba00176', 'bc3cc4397e740444a4d4a53d93b499cc'),
    ('competition_audit_log(uuid,uuid,integer)', 'd38b87512d066907b37702addc6cd116', 'd38b87512d066907b37702addc6cd116', 'f6bb04ec82b4e39d2df0ef438a223ba1'),
    ('competition_judge_ballot_sheet(uuid)', '21cd3df42b8789e3b1baade47a0231d0', '21cd3df42b8789e3b1baade47a0231d0', '2506cb2f466d1738fb1a8f298e805b5f'),
    ('competition_round_ballot_status(uuid)', 'a3f5226acc9a40cdedd83d9c0a0fee24', 'a3f5226acc9a40cdedd83d9c0a0fee24', '7d3bebe922fed33604666009d3a593a5'),
    ('competition_round_results_review(uuid)', 'c842be1dafce548cd279f1d2d6f6f1d0', 'c842be1dafce548cd279f1d2d6f6f1d0', 'c9d747907caad0a88b75da1c53862f43'),
    ('complete_competition_round(uuid,uuid)', 'dd0e1cd4c02bb51bbd75471c113a1f9f', 'dd0e1cd4c02bb51bbd75471c113a1f9f', 'e4c105ac6ea9017eb7f3c5fa5dea789f'),
    ('lock_competition_round_ballots(uuid,uuid)', '6e4175342d51ffe274d70ce413bae8c3', '6e4175342d51ffe274d70ce413bae8c3', 'c4ba327df7943d559ab52ccd07d20ea0'),
    ('set_competition_round_heat_capacity(uuid,integer)', '4fbc864079928710917ea67d7968d8bb', '4fbc864079928710917ea67d7968d8bb', 'acd3d68f8971b0292910d6c64236ec39'),
    ('validate_competition_heat_schedule_placement()', 'f2079401a3a92c3289405547d2fe511b', 'f2079401a3a92c3289405547d2fe511b', '2359c5515dcc8a1c10f87ee32faa3d4b')
), cur as (
  select p.oid::regprocedure::text as sig, md5(replace(pg_get_functiondef(p.oid), E'', '')) as md5_now,
         pg_get_userbyid(p.proowner) as owner, coalesce(p.proacl::text, '') as acl, p.prosecdef, p.proconfig::text as cfg
  from pg_proc p where p.pronamespace = 'public'::regnamespace)
select 'Q2' as q, e.sig, c.md5_now,
       case when c.md5_now is null then 'ABSENT'
            when c.md5_now = e.pre_base then 'MATCH_PRE_BASE'
            when c.md5_now = e.pre_r2 then 'MATCH_PRE_R2'
            when c.md5_now = e.post_cf1 then 'ALREADY_POST_CF1'
            else 'MISMATCH' end as verdict,
       c.owner, c.acl, c.prosecdef, c.cfg
from expected e left join cur c using (sig) order by e.sig;

-- Q3 R2 ledger and dependency presence (R2 is a branch-only migration: absent is a legitimate state, it decides the RB3 mode).
select 'Q3' as q,
  to_regclass('public.event_order_refunds') is not null as order_refunds,
  to_regclass('public.event_order_refund_allocations') is not null as refund_allocations,
  to_regclass('public.event_competition_refund_exception_scopes') is not null as refund_scopes,
  (select md5(replace(pg_get_functiondef(p.oid), E'', '')) from pg_proc p where p.oid = to_regprocedure('public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)')) as checkin_payment_md5_informational;

-- Q4 migration-history table EXISTENCE only (rows are not read).
select 'Q4' as q, to_regclass('supabase_migrations.schema_migrations') is not null as history_table_exists;

rollback;
