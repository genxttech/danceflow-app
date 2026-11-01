-- Reconstructed base tables the D24 M3-C migration references (same approach as scripts/qa/d24-m3c-sql.sh). clients/appointments/events/payments are stand-ins, not the real schema.
-- user_studio_roles and auth.uid()/auth.jwt() come from auth-roles.sql.
create table public.clients (id uuid primary key default gen_random_uuid(), studio_id uuid not null references public.studios(id), first_name text);
create table public.appointments (id uuid primary key default gen_random_uuid(), studio_id uuid not null references public.studios(id));
create table public.events (id uuid primary key default gen_random_uuid(), studio_id uuid references public.studios(id));
create table public.payments (id uuid primary key default gen_random_uuid(), studio_id uuid not null references public.studios(id), amount numeric);
