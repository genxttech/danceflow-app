/*
  Notification tap routing. Delivery is blocked on push credentials (FCM/APNs), but the tap handler is pure and ready:
  a push payload names a record by id, and the app opens the screen for it. The payload is untrusted data: only
  well-formed ids of known kinds are routed, everything else lands on Today. The server still authorizes the screen's
  own request, so a stale or foreign id shows the normal not-found / no-access state and leaks nothing.
*/

export type NotificationTarget =
  | { pathname: "/appointments/[id]"; params: { id: string; studioId: string } }
  | { pathname: "/clients/[id]"; params: { id: string; studioId: string } }
  | { pathname: "/today" };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (value: unknown) => (typeof value === "string" ? value : null);

export function routeForNotification(data: unknown): NotificationTarget {
  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const studioId = text(record.studioId);
  const id = text(record.id);
  const kind = text(record.type);

  if (studioId && id && ID.test(studioId) && ID.test(id)) {
    if (kind === "appointment") return { pathname: "/appointments/[id]", params: { id, studioId } };
    if (kind === "client") return { pathname: "/clients/[id]", params: { id, studioId } };
  }
  return { pathname: "/today" };
}
