create table if not exists appointment_package_deduction_errors (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid,
  studio_id uuid,
  client_id uuid,
  client_package_id uuid,
  appointment_type text,
  error_message text,
  created_at timestamp with time zone not null default now()
);