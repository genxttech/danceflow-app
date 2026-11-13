-- Rollback for 20270216090000_website_embed_settings.sql. Re-runnable. Roll the APP back first (or accept that, without the functions,
-- embeds fail closed and class details disappear). Dropping the table discards every studio's saved embed settings, including any
-- "embeds off" switch: a studio that had turned its embeds off would have them on again if the app is rolled back to a version
-- that does not read the table, so export the table first if that matters.
drop function if exists public.public_group_class_extras(text, uuid[]);
drop function if exists public.set_studio_embed_settings(uuid, boolean, boolean, boolean, boolean, text, text, text);
drop function if exists public.get_studio_embed_settings(uuid);
drop function if exists public.public_studio_embed_settings(text);
drop function if exists public._embed_can_manage(uuid);
drop table if exists public.studio_embed_settings;
