-- Marketing M-0 / C1 -- historical organizer-unsubscribe repair: PRODUCTION PREFLIGHT (READ-ONLY). NOT RUN.
--
-- Purpose: size the organizer unsubscribes that the pre-M-0 page acknowledged ("You have been unsubscribed") but never
-- stored, because its upsert used onConflict "organizer_id,email" against an expression unique index (42P10, ignored).
--
-- Run only with explicit owner authorization, from a fresh scratch workdir linked to PROD, AFTER the M-0 application is
-- promoted (so no new legacy-page rows can appear and the affected set is closed). One read-only transaction.
-- Output is aggregate counts only: no email address, name, token, organizer name or message content is returned.
--
-- Evidence signature (verified in code on main 858e74eb): the ONLY writer of
--   status = 'unsubscribed' AND error_message = 'Recipient unsubscribed from organizer marketing'
-- is src/app/unsubscribe/organizer-marketing/[token]/page.tsx (pre-M-0), which ran on a plain GET of the unsubscribe
-- link with the service role. It set only status + error_message; it did NOT clear sent_at or provider_message_id, and
-- the table had no updated_at, so the time of the request was never recorded.
-- Rows set 'unsubscribed' for other reasons carry different messages and are excluded:
--   'Suppressed by organizer unsubscribe list'  (generation-time; pre-M-0 and M-0)
--   'Unsubscribed before send'                  (M-0 unsubscribe; always stored with its organizer record)
--
-- Evidence classes (per row):
--   A  delivered, then the link was requested: signature + sent_at IS NOT NULL + provider_message_id IS NOT NULL.
--      The unsubscribe URL was requested and the system confirmed the unsubscribe to the requester. Whether a human or
--      a mail-security link scanner made the request cannot be determined from stored data.
--   B  signature but no delivery evidence (sent_at or provider_message_id missing): the token is not shown to have
--      been delivered in an email (e.g. exposed another way). Review only; never repaired automatically.
-- A row is "missing" only when no organizer_marketing_unsubscribes record exists for (organizer_id, lower(email)).

begin transaction read only;
set local statement_timeout = '30s';

with sig as (
  select r.id, r.organizer_id, lower(btrim(r.email)) as email, r.campaign_id, r.sent_at, r.provider_message_id,
         (r.sent_at is not null and r.provider_message_id is not null) as delivered
  from public.organizer_marketing_campaign_recipients r
  where r.status = 'unsubscribed'
    and r.error_message = 'Recipient unsubscribed from organizer marketing'
),
missing as (
  select s.* from sig s
  where not exists (select 1 from public.organizer_marketing_unsubscribes u
                    where u.organizer_id = s.organizer_id and lower(u.email) = s.email)
),
addr as (
  select organizer_id, email,
         bool_or(delivered) as has_class_a,
         min(sent_at) filter (where delivered) as earliest_delivery_flipped
  from missing group by organizer_id, email
)
select 'R1 signature rows (all)' as check_name, count(*)::text as result from sig
union all
select 'R2 signature rows already stored (C1 did not lose them)', ((select count(*) from sig) - (select count(*) from missing))::text
union all
select 'R3 missing rows, class A (delivered, link requested)', count(*) filter (where delivered)::text from missing
union all
select 'R4 missing rows, class B (no delivery evidence; review only)', count(*) filter (where not delivered)::text from missing
union all
select 'R5 distinct organizer+address to restore (class A)', count(*) filter (where has_class_a)::text from addr
union all
select 'R6 distinct organizer+address with class B only', count(*) filter (where not has_class_a)::text from addr
union all
select 'R7 organizers affected (class A)', count(distinct organizer_id) filter (where has_class_a)::text from addr
union all
select 'R8 class-A addresses whose contact is already unsubscribed / active / no contact row',
       count(*) filter (where c.status = 'unsubscribed')::text || ' / ' ||
       count(*) filter (where c.status is distinct from 'unsubscribed' and c.id is not null)::text || ' / ' ||
       count(*) filter (where c.id is null)::text
from addr a
left join lateral (select oc.id, oc.status from public.organizer_contacts oc
                   where oc.organizer_id = a.organizer_id and lower(oc.email) = a.email limit 1) c on true
where a.has_class_a
union all
-- Upper bound: the request time is unknown, but it was after that row's delivery. Any later delivery to the same
-- address by the same organizer MAY have been sent after the person asked to stop.
select 'R9 later deliveries to class-A addresses (upper bound of possible post-opt-out sends)',
       count(*)::text || ' rows / ' || count(distinct (l.organizer_id, lower(l.email)))::text || ' addresses'
from public.organizer_marketing_campaign_recipients l
join addr a on a.organizer_id = l.organizer_id and a.email = lower(btrim(l.email)) and a.has_class_a
where l.status = 'sent' and l.sent_at > a.earliest_delivery_flipped
union all
select 'R10 class-A addresses with pending/sending rows now (would be suppressed at claim only after repair)',
       count(distinct (p.organizer_id, lower(p.email)))::text
from public.organizer_marketing_campaign_recipients p
join addr a on a.organizer_id = p.organizer_id and a.email = lower(btrim(p.email)) and a.has_class_a
where p.status in ('pending', 'sending')
union all
select 'R11 age of class-A evidence (earliest / latest delivery that was later flipped)',
       coalesce(min(earliest_delivery_flipped)::date::text, 'none') || ' / ' ||
       coalesce(max(earliest_delivery_flipped)::date::text, 'none')
from addr where has_class_a;

rollback;

-- ---------------------------------------------------------------------------------------------------------------------
-- REPAIR (separately authorized; NOT part of this preflight). Shape only, for review:
--   * class A only; one record per distinct (organizer_id, lower(email));
--   * INSERT ... ON CONFLICT (organizer_id, lower(email)) DO NOTHING  -- never overwrites an existing record;
--   * source = 'm0_c1_repair', reason = 'Restored: unsubscribe link request acknowledged by the pre-M-0 page; record was
--     not stored (C1). Request time unknown; after the delivery of campaign <campaign_id>.';
--   * unsubscribed_at = time of repair (the true request time is unknown and is not fabricated);
--     campaign_id / recipient_id = the earliest class-A row, as evidence links;
--   * organizer_contacts are NOT modified (consent state is not overwritten; the stored record alone suppresses at
--     every M-0 claim); recipient rows are NOT modified;
--   * verification: R3/R5 counts equal inserted rows; re-running the preflight shows R3 = 0;
--   * rollback: DELETE FROM organizer_marketing_unsubscribes WHERE source = 'm0_c1_repair' (run as the service role;
--     the M-0 guard blocks client roles only).
