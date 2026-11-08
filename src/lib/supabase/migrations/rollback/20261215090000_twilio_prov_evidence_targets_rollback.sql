-- Rollback of 20261215090000 (evidence targets getter). The function is read-only and owns no data, so there is nothing to refuse on; roll the application back first
-- (the evidence recorder calls it).
drop function if exists public.tw4_prov_evidence_targets(uuid, text);
