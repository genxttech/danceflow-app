-- Rollback of 20270223160000: removes exactly the trigger and function it added. WARNING: the event creator becomes writable again.
begin;
set local lock_timeout = '5s';
drop trigger if exists zz_protect_event_creator on public.events;
drop function if exists public.protect_event_creator();
commit;
