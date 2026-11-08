-- Rollback of 20261216090000 (read-only orphan exposure and alert-status views). The functions own no data and write nothing, so there is nothing to refuse on;
-- roll the application back first (the admin tooling calls them).
drop function if exists public.tw4_prov_orphan_exposure(uuid, uuid, boolean);
drop function if exists public.tw4_prov_orphan_alert_status(uuid, uuid);
