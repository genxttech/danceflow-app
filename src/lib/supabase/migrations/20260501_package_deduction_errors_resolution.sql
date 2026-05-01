alter table public.appointment_package_deduction_errors
add column if not exists resolved_at timestamptz,
add column if not exists resolution_notes text;

create index if not exists appointment_package_deduction_errors_unresolved_idx
on public.appointment_package_deduction_errors (created_at desc)
where resolved_at is null;