# Design note: role-based access for event resources (not implemented)

Separate workstream from the creator-field guard. Nothing here is approved or built.

## Today
- Event update, insert and delete policies allow any active studio role, and organizer staff for organizer events, on whole rows.
- Management of private lessons and schedule items is granted by the event's creator field alone. A creator keeps it after leaving
  the studio or losing the role.
- Staff read access to private lessons (private-lesson read-scope change) is decided from the event's current studio and organizer.
  Those two columns are themselves editable under the broad update policy, so a role check built on them is only as strong as
  the control over who may change them.

## Direction
1. One definer function per capability (view, manage) that decides from active studio role, organizer role and the resource's own
   studio and organizer, not from the creator.
2. Restrict who may change `events.studio_id` and `events.organizer_id`; moving an event between hosts becomes an explicit,
   audited action.
3. Require resource rows (coaches, slots, schedule items) to match their event's studio and organizer.
4. Split event update rights by role (ordinary content versus ownership, money and publication fields), and limit delete.
5. Replace creator-only policies with the capability functions; keep the creator as history only.

## Migration cautions
- Inventory who relies on creator-only access today (creators without a manager role, platform-created events).
- Narrow only; any widening needs its own decision.
- Competition finals management also consults the event creator; coordinate with the Competition owner.
