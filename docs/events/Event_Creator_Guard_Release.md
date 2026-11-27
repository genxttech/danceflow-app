# Event creator guard: release note

Migration `20270223160000_event_creator_guard.sql`. Database only; no application change. Nothing is applied by merging.

## What depends on `events.created_by`
- Row-level policies: guest coaches, private-lesson blocks and slots (manage); event schedule items (read, add, edit, delete).
- One database function used by competition finals management.
- Writers: application inserts that record the signed-in user; server fixtures. No application or database code updates it
  (the one database function that updates events does not set it).

## Behaviour after apply
- A signed-in caller can create an event only with itself, or nobody, as creator.
- The creator cannot be changed by signed-in callers or the service role. Writing the same value back is allowed.
- Maintenance, if ever needed and separately approved: on a direct database-owner connection (not through the API), in one
  transaction,
  `set local app.event_creator_maintenance = 'on';` then the update.
- Ordinary event editing, creation, duplication and deletion are unchanged. No policy or grant changes.

## Compatibility
No application path changes an existing creator. A path that did would now receive error 42501.
Safe in either order relative to application releases and to migration 20270223150000.

No foreign key references `events.created_by` on DEV or production (checked read only), so deleting a user does not update it.

## Apply sequence (each step needs owner approval)
1. Preflight (read only): the trigger `zz_protect_event_creator` and function `protect_event_creator` do not exist; record the
   history evidence query output.
2. Apply with `sb.sh prod-apply` and the approved SHA-256.
3. Postflight (read only): the trigger exists and is enabled; re-run the history evidence query.

## Rollback
`rollback/20270223160000_event_creator_guard_rollback.sql` removes the trigger and function; nothing else was changed.

## Not covered

See `Event_Role_Access_Design_Note.md`: who may move an event between studios or organizers, who may create or delete events,
and creator-only access that outlives a staff role are unchanged by this guard.
