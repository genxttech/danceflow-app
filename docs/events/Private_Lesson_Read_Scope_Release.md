# Private lessons: read-scope release

Scope: `event_guest_coaches` and `event_private_lesson_slots`. Migration `20270223150000_private_lesson_read_scope.sql`.
Nothing here is applied or deployed by merging; each hosted step below is an owner gate.

## Readers and writers

| Surface | Client before | After |
|---|---|---|
| Public event page `/events/[slug]` (open slots, coach name/bio/photo) | caller session | server (named columns) when the event is publicly listed, else caller session |
| Guest-coach schedule page and calendar download `/coach-schedule/[token]` | caller session | link resolved server-side; slots read server-side for that coach and event when listed, else caller session |
| Same two routes: release of expired holds (update) | caller session | unchanged |
| Staff pages: event overview, edit, private lessons; event actions | caller session | unchanged code; read access now comes from the staff policies |
| Private-lesson and cart checkout, release routes, payment webhook | service role | unchanged |
| Database functions (cart lifecycle) | definer / service role | unchanged |
| Mobile apps | no access | unchanged |

`event_private_lesson_blocks` is not changed.

## Access after the migration

- Visitors and signed-in people with no role on the event: no direct table access.
- Event creator: unchanged manage access.
- Studio owner and admin; front desk for studio-hosted events; organizer owner, admin and staff for their organizer's events;
  platform admin: read access to the same rows as before (published, publicly listed events of an active or trial studio).
- Narrowed on purpose: instructors and other roles, and front desk on organizer-hosted events, no longer read these rows.

## Apply order (app first)

1. Deploy the app change to the live line. It works with the database as it is today.
2. Verify on production: a public event with open slots still lists them; a guest-coach schedule link and its calendar download
   still open; the staff private-lessons page still lists slots.
3. Apply the migration with `sb.sh prod-apply` and its approved SHA-256.
4. Postflight (read only): the two tables have exactly two policies each, none for role `public` or `anon`; under
   `set local role anon` both tables return zero rows. Repeat the checks in step 2.
5. Rotate guest-coach links (below).

What breaks in the wrong order:

- SQL before the app: the public event page silently stops listing private lessons (bookings cannot start from it), and guest-coach
  schedule links and calendar subscriptions return "not found". Checkout, payments and staff pages keep working.
- App rolled back while the SQL is applied: the same breakage. Roll the SQL back first, then the app.

The live line differs from main in none of the files this change edits except one unrelated line in the public event page
(checked against commit e84ed0f3); re-check against the commit that is live at release time.

## Rotating guest-coach links

Existing links must be treated as no longer private. Rotate them after step 4, so that new links are never readable the old way.

1. Preflight (read only): `select count(*) from public.event_guest_coaches where schedule_token_enabled and active;`
2. Tell the affected studios that coach schedule links will change and calendar subscriptions must be re-added.
3. Owner-approved production write:

   ```sql
   begin;
   update public.event_guest_coaches
      set schedule_token = default, schedule_token_created_at = now(), updated_at = now();
   commit;
   ```

4. Postflight (read only): the row count is unchanged and no `schedule_token_created_at` predates the rotation. Do not print links.
5. Studio staff copy each new link from the event's private-lessons page and send it to the coach. Only the event creator can
   regenerate a single link from that page.

Rotation cannot be undone, and old links stop working immediately. It needs no app deploy.

## Rollback

`rollback/20270223150000_private_lesson_read_scope_rollback.sql` restores the previous policies. It also restores the broad
visitor access, so prefer fixing forward.
