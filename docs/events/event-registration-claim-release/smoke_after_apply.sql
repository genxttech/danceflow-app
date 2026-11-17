-- READ-ONLY smoke, run ONLY after the function migration is applied. The runner role has no JWT, so auth.uid() is null: the
-- function must return 0 BEFORE reaching its UPDATE (a read-only transaction would reject the UPDATE, so a non-zero or an
-- error here is itself a failure signal). It proves the function exists, resolves my_verified_email-free early exit, and writes nothing.
select jsonb_build_object(
  'returns_when_no_user', public.claim_my_event_registrations(),
  'auth_uid_is_null', auth.uid() is null
) as smoke;
