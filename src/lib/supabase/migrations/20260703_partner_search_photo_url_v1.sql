alter table public.dancer_partner_profiles
  add column if not exists photo_url text;

comment on column public.dancer_partner_profiles.photo_url
  is 'Optional dancer profile photo URL for Partner Search listings. External contact details and promotional imagery remain subject to moderation.';
