-- TW-4F LOST-DEVICE RESET for the single-owner price authorization. OWNER-LEVEL, VISIBLE, ONE TRANSACTION. Never run without the runbook preconditions
-- (docs/twilio/TW-4F_Price_Publication_Runbook.md, section G): the freeze was set FOR THIS INCIDENT with the verification reference in its reason, the owner has been verified through a
-- channel outside the lost device, and the waiting period has passed. Run it with the SQL runner stopping at the first error (psql -v ON_ERROR_STOP=1, or the Supabase CLI, which runs the file as one batch).
--
-- Replace the placeholders before running (public values only; a private key never exists outside the authenticator):
--   @@TICKET@@     the written reference of the verification (at least 10 characters, letters digits space . _ - only, no quotes; it must ALSO appear in the freeze reason and is stored in the audit)
--   @@OWNER_UID@@  the auth.users id of the platform administrator (the sole owner)
--   @@CRED_HEX@@ @@X_HEX@@ @@Y_HEX@@   the NEW key's credential id and P-256 public key (hex), from /platform/sms/key-setup
--   @@LABEL@@      3 to 60 characters, same charset as the ticket
--   @@INCIDENT_START@@  when the device was lost or the incident began, ISO 8601 with offset (for example 2026-11-10T08:00:00Z); recorded in the audit. The freeze must be at or after this time OR carry the ticket
--                  in its reason (an existing freeze, such as the recovery key's fixed-text freeze, cannot be rewritten while pricing is frozen).
--
-- What it does: refuses unless pricing has been frozen for at least 72 hours and the freeze belongs to this incident (ticket in its reason, or frozen at or after the incident start); serialises against credential changes (the same advisory lock the credential functions take, then both tables); cancels every pending credential change;
-- revokes EVERY active credential (the lost one, any spare, any recovery key); clears a recovery hold; installs the new key as the only primary (enrolled as an ordinary bootstrap key, NOT as a
-- recovery-enrolled key, so there is no permanent thaw bypass); RE-STARTS the freeze clock after the new key is installed (so the new key may lift THIS freeze; like any primary key it can also lift a LATER freeze,
-- because it exists by then: that is inherent to having a primary key, not a property of the reset); writes an immutable audit row per revoked credential and for the new one (ticket, database session user, transaction id, the
-- previous freeze time); emits a monitoring event. Published prices are untouched; pending price proposals are NOT touched (reject them first, runbook G step 4).
-- Pricing stays frozen: the new key must prove itself (_tw4price_attest_begin / _tw4price_attest_finish) and then lift the freeze with its own thaw ceremony.
begin;
set local lock_timeout = '5s';
select pg_advisory_xact_lock(hashtext('tw4price:cred'));
lock table public.studio_sms_price_credentials, public.studio_sms_price_credential_changes in exclusive mode;

do $$
declare cfg public.studio_sms_price_auth_config;
begin
  select * into cfg from public.studio_sms_price_auth_config;
  if cfg.rp_id is null then
    raise exception 'lost-device reset refused: the price authorization is not bootstrapped' using errcode = '55000';
  end if;
  if char_length(btrim('@@TICKET@@')) < 10 or '@@TICKET@@' like '%@@%' or char_length(btrim('@@LABEL@@')) not between 3 and 60 or '@@LABEL@@' like '%@@%' then
    raise exception 'lost-device reset refused: a written verification reference of at least 10 characters and a label of 3 to 60 characters are required' using errcode = '22023';
  end if;
  if not cfg.frozen or cfg.frozen_at is null or cfg.frozen_at > clock_timestamp() - interval '72 hours' then
    raise exception 'lost-device reset refused: pricing must have been frozen for at least 72 hours (frozen_at = %)', cfg.frozen_at using errcode = '55000';
  end if;
  if position('@@TICKET@@' in coalesce(cfg.freeze_reason, '')) = 0 and cfg.frozen_at < '@@INCIDENT_START@@'::timestamptz then
    raise exception 'lost-device reset refused: the freeze must belong to this incident (the verification reference in its reason, or set at or after the incident start); freeze set at %', cfg.frozen_at using errcode = '55000';
  end if;
  if not public._tw4price_admin_active('@@OWNER_UID@@'::uuid) then
    raise exception 'lost-device reset refused: the owner is not an active registered platform administrator' using errcode = '42501';
  end if;
  if exists (select 1 from public.studio_sms_price_credentials where pub_x = decode('@@X_HEX@@', 'hex') and pub_y = decode('@@Y_HEX@@', 'hex')) then
    raise exception 'lost-device reset refused: that public key was already registered (a revoked key is never reused)' using errcode = '22023';
  end if;
  if not public._tw4price_p256_oncurve(public._tw4price_bytes2num(decode('@@X_HEX@@', 'hex')), public._tw4price_bytes2num(decode('@@Y_HEX@@', 'hex'))) then
    raise exception 'lost-device reset refused: not a valid P-256 public key' using errcode = '22023';
  end if;
end $$;

-- _tw4price_audit switches the write flag off when it returns, so ALL protected writes happen first (flag on) and the audit rows after them.
create temporary table _tw4_reset_revoked on commit drop as select credential_id from public.studio_sms_price_credentials where status = 'active';
create temporary table _tw4_reset_ctx on commit drop as select frozen_at as prev_frozen_at, recovery_hold as prev_recovery_hold from public.studio_sms_price_auth_config;
select set_config('tw4.priceauth_write', 'on', true);

update public.studio_sms_price_credential_changes
   set status = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by = '@@OWNER_UID@@'::uuid
 where status = 'pending';

update public.studio_sms_price_credentials
   set status = 'revoked', revoked_at = clock_timestamp(), revoked_note = left('owner-level lost-device reset: @@TICKET@@', 300)
 where status = 'active';

insert into public.studio_sms_price_credentials (credential_id, pub_x, pub_y, role, label, enrolled_via)
values (decode('@@CRED_HEX@@', 'hex'), decode('@@X_HEX@@', 'hex'), decode('@@Y_HEX@@', 'hex'), 'primary', '@@LABEL@@', 'bootstrap');

-- the freeze clock restarts AFTER the new key exists, and a recovery hold (set by the recovery key's freeze) is cleared: no recovery key exists any more to clear it
update public.studio_sms_price_auth_config set recovery_hold = false, frozen = true, frozen_at = clock_timestamp() where singleton;
select set_config('tw4.priceauth_write', 'off', true);

do $$
declare r record; c record;
begin
  select * into c from _tw4_reset_ctx;
  for r in select credential_id from _tw4_reset_revoked loop
    perform public._tw4price_audit('credential_revoked', '@@OWNER_UID@@'::uuid, null, null, r.credential_id,
      jsonb_build_object('via', 'owner_level_reset', 'ticket', '@@TICKET@@', 'incident_start', '@@INCIDENT_START@@', 'db_session_user', session_user::text, 'txid', txid_current(), 'previous_frozen_at', c.prev_frozen_at, 'previous_recovery_hold', c.prev_recovery_hold));
  end loop;
end $$;
select public._tw4price_audit('credential_bootstrapped', '@@OWNER_UID@@'::uuid, null, null, decode('@@CRED_HEX@@', 'hex'),
  jsonb_build_object('via', 'owner_level_reset', 'ticket', '@@TICKET@@', 'label', '@@LABEL@@', 'db_session_user', session_user::text, 'txid', txid_current()));
select public._tw4price_emit_safe('credential_replaced', '@@OWNER_UID@@'::uuid, jsonb_build_object('via', 'owner_level_reset', 'ticket', '@@TICKET@@'));

commit;
