-- Student app favorites write access
-- Allows signed-in dancers to save/remove their own public studio and event favorites.

alter table public.user_favorites enable row level security;

drop policy if exists "Users can add their own favorites" on public.user_favorites;
create policy "Users can add their own favorites"
on public.user_favorites
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can remove their own favorites" on public.user_favorites;
create policy "Users can remove their own favorites"
on public.user_favorites
for delete
to authenticated
using (auth.uid() = user_id);
