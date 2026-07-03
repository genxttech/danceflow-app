alter table public.studio_job_postings
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

create index if not exists studio_job_postings_location_idx
  on public.studio_job_postings (latitude, longitude)
  where status = 'published' and latitude is not null and longitude is not null;
