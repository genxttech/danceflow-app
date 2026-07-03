alter table public.user_favorites
  add column if not exists partner_profile_id uuid references public.dancer_partner_profiles(id) on delete cascade;

create index if not exists user_favorites_partner_profile_idx
  on public.user_favorites (user_id, partner_profile_id)
  where target_type = 'partner_profile' and partner_profile_id is not null;
