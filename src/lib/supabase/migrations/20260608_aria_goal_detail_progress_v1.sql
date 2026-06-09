-- 20260608_aria_goal_detail_progress_v1.sql
-- ARIA Goals Detail + Progress V1
-- Adds progress tracking fields used by /app/aria/goals/[id].

alter table public.aria_goals
add column if not exists current_value numeric,
add column if not exists progress_notes text,
add column if not exists completed_at timestamptz,
add column if not exists archived_at timestamptz;

create index if not exists idx_aria_goals_studio_status_updated
  on public.aria_goals (studio_id, status, updated_at desc);

create index if not exists idx_aria_goals_studio_target_date
  on public.aria_goals (studio_id, target_date);
