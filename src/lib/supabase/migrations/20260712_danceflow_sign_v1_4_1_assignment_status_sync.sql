-- DanceFlow Sign V1.4.1
-- Keep the legacy document assignment ledger synchronized with
-- the unified DanceFlow Sign envelope lifecycle.

begin;

create or replace function public.sync_document_assignment_from_sign_envelope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  effective_completed_at timestamptz;
begin
  if new.assignment_id is null then
    return new;
  end if;

  if new.status = 'completed' then
    effective_completed_at := coalesce(new.completed_at, now());

    update public.document_assignments
    set
      status = 'signed',
      signed_at = coalesce(signed_at, effective_completed_at),
      completed_at = coalesce(completed_at, effective_completed_at)
    where id = new.assignment_id
      and studio_id = new.studio_id
      and status not in ('void', 'waived', 'signed');
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_document_assignment_from_sign_envelope
on public.document_sign_envelopes;

create trigger trg_sync_document_assignment_from_sign_envelope
after insert or update of status, completed_at, assignment_id
on public.document_sign_envelopes
for each row
execute function public.sync_document_assignment_from_sign_envelope();

-- Repair assignments for documents that were already completed before
-- this synchronization trigger existed.
update public.document_assignments da
set
  status = 'signed',
  signed_at = coalesce(da.signed_at, dse.completed_at, now()),
  completed_at = coalesce(da.completed_at, dse.completed_at, now())
from public.document_sign_envelopes dse
where dse.assignment_id = da.id
  and dse.studio_id = da.studio_id
  and dse.status = 'completed'
  and da.status not in ('void', 'waived', 'signed');

commit;
