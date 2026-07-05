create table if not exists public.workspace_onboarding_preferences (
  id uuid primary key default gen_random_uuid(),

  studio_id uuid not null references public.studios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  checklist_type text not null default 'studio',
  dismissed_at timestamp with time zone null,
  completed_at timestamp with time zone null,

  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  constraint workspace_onboarding_preferences_checklist_type_check
    check (
      checklist_type in (
        'studio',
        'organizer'
      )
    ),

  constraint workspace_onboarding_preferences_unique_user_workspace
    unique (studio_id, user_id, checklist_type)
);

create index if not exists workspace_onboarding_preferences_studio_id_idx
on public.workspace_onboarding_preferences(studio_id);

create index if not exists workspace_onboarding_preferences_user_id_idx
on public.workspace_onboarding_preferences(user_id);

alter table public.workspace_onboarding_preferences enable row level security;

drop policy if exists "Users can view their own onboarding preferences"
on public.workspace_onboarding_preferences;

drop policy if exists "Users can manage their own onboarding preferences"
on public.workspace_onboarding_preferences;

create policy "Users can view their own onboarding preferences"
on public.workspace_onboarding_preferences
for select
using (
  user_id = auth.uid()
);

create policy "Users can manage their own onboarding preferences"
on public.workspace_onboarding_preferences
for all
using (
  user_id = auth.uid()
)
with check (
  user_id = auth.uid()
);

notify pgrst, 'reload schema';