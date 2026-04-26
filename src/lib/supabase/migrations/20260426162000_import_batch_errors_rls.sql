-- Allow studio owner/front desk to review imports by writing validation errors
alter table import_batch_errors enable row level security;

drop policy if exists "Studio staff can view import batch errors"
on import_batch_errors;

create policy "Studio staff can view import batch errors"
on import_batch_errors
for select
using (
  exists (
    select 1
    from import_batches b
    join user_studio_roles usr
      on usr.studio_id = b.studio_id
    where b.id = import_batch_errors.import_batch_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'front_desk')
  )
);

drop policy if exists "Studio staff can create import batch errors"
on import_batch_errors;

create policy "Studio staff can create import batch errors"
on import_batch_errors
for insert
with check (
  exists (
    select 1
    from import_batches b
    join user_studio_roles usr
      on usr.studio_id = b.studio_id
    where b.id = import_batch_errors.import_batch_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'front_desk')
  )
);

drop policy if exists "Studio staff can delete import batch errors"
on import_batch_errors;

create policy "Studio staff can delete import batch errors"
on import_batch_errors
for delete
using (
  exists (
    select 1
    from import_batches b
    join user_studio_roles usr
      on usr.studio_id = b.studio_id
    where b.id = import_batch_errors.import_batch_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'front_desk')
  )
);