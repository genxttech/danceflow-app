begin;

alter table public.outbound_deliveries
add column if not exists body_html text;

notify pgrst, 'reload schema';

commit;