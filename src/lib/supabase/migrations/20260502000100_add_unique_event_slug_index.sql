create unique index if not exists events_slug_lower_unique_idx
on public.events (lower(slug))
where slug is not null;