-- Marketing M-0 / C1 repair candidates (READ-ONLY, single statement; aggregate counts only).
-- Same logic as src/lib/supabase/migrations/sql-tests/m0_c1_repair_preflight_readonly.sql, without its transaction
-- control so it runs under sb.sh read modes.
with sig as (
  select r.id, r.organizer_id, lower(btrim(r.email)) as email, r.campaign_id, r.sent_at, r.provider_message_id,
         (r.sent_at is not null and r.provider_message_id is not null) as delivered
  from public.organizer_marketing_campaign_recipients r
  where r.status = 'unsubscribed' and r.error_message = 'Recipient unsubscribed from organizer marketing'
),
missing as (
  select s.* from sig s
  where not exists (select 1 from public.organizer_marketing_unsubscribes u where u.organizer_id = s.organizer_id and lower(u.email) = s.email)
),
addr as (
  select organizer_id, email, bool_or(delivered) as has_class_a, min(sent_at) filter (where delivered) as earliest_delivery_flipped
  from missing group by organizer_id, email
)
select 'R1 signature rows (all)' as check_name, count(*)::text as result from sig
union all select 'R2 signature rows already stored', ((select count(*) from sig) - (select count(*) from missing))::text
union all select 'R3 missing rows, class A (delivered, link requested)', count(*) filter (where delivered)::text from missing
union all select 'R4 missing rows, class B (no delivery evidence; review only)', count(*) filter (where not delivered)::text from missing
union all select 'R5 distinct organizer+address to restore (class A)', count(*) filter (where has_class_a)::text from addr
union all select 'R6 distinct organizer+address with class B only', count(*) filter (where not has_class_a)::text from addr
union all select 'R7 organizers affected (class A)', count(distinct organizer_id) filter (where has_class_a)::text from addr
union all
select 'R8 class-A addresses whose contact is already unsubscribed / active / no contact row',
       count(*) filter (where c.status = 'unsubscribed')::text || ' / ' || count(*) filter (where c.status is distinct from 'unsubscribed' and c.id is not null)::text || ' / ' || count(*) filter (where c.id is null)::text
from addr a
left join lateral (select oc.id, oc.status from public.organizer_contacts oc where oc.organizer_id = a.organizer_id and lower(oc.email) = a.email limit 1) c on true
where a.has_class_a
union all
select 'R9 later deliveries to class-A addresses (upper bound of possible post-opt-out sends)',
       count(*)::text || ' rows / ' || count(distinct (l.organizer_id, lower(l.email)))::text || ' addresses'
from public.organizer_marketing_campaign_recipients l
join addr a on a.organizer_id = l.organizer_id and a.email = lower(btrim(l.email)) and a.has_class_a
where l.status = 'sent' and l.sent_at > a.earliest_delivery_flipped
union all
select 'R10 class-A addresses with pending/sending rows now', count(distinct (p.organizer_id, lower(p.email)))::text
from public.organizer_marketing_campaign_recipients p
join addr a on a.organizer_id = p.organizer_id and a.email = lower(btrim(p.email)) and a.has_class_a
where p.status in ('pending', 'sending')
union all
select 'R11 age of class-A evidence (earliest / latest delivery later flipped)',
       coalesce(min(earliest_delivery_flipped)::date::text, 'none') || ' / ' || coalesce(max(earliest_delivery_flipped)::date::text, 'none')
from addr where has_class_a;
