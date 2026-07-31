-- LUMI mobile AI response reporting.
begin;

create table if not exists public.lumi_response_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  prompt text not null,
  response text not null,
  source text not null default 'student_mobile',
  status text not null default 'open'
    check (status in ('open', 'reviewed', 'dismissed', 'actioned')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewer_user_id uuid references auth.users(id) on delete set null,
  review_notes text
);

create index if not exists lumi_response_reports_user_created_idx
  on public.lumi_response_reports (user_id, created_at desc);

create index if not exists lumi_response_reports_status_created_idx
  on public.lumi_response_reports (status, created_at desc);

alter table public.lumi_response_reports enable row level security;

drop policy if exists "Users can submit LUMI response reports"
  on public.lumi_response_reports;

create policy "Users can submit LUMI response reports"
on public.lumi_response_reports
for insert to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can read their LUMI response reports"
  on public.lumi_response_reports;

create policy "Users can read their LUMI response reports"
on public.lumi_response_reports
for select to authenticated
using (auth.uid() = user_id);

commit;
