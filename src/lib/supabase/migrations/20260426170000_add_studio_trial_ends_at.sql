alter table studios
add column if not exists trial_ends_at timestamp with time zone;

create index if not exists studios_trial_ends_at_idx
on studios (trial_ends_at);