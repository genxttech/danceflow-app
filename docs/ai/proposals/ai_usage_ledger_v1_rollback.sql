-- PROPOSAL ONLY. NOT APPLIED. Rollback for ai_usage_ledger_v1.sql. Deploy the application without ledger calls first.
-- Dropping the ledger destroys usage history: export it before running this on any database that has rows.

begin;

drop function if exists public.ai_settle(uuid, text, bigint, text, integer, integer, integer, text);
drop function if exists public.ai_reserve(text, text, uuid, text, uuid, uuid, text, bigint);
drop table if exists public.ai_usage_ledger;
drop table if exists public.ai_spend_controls;

commit;
