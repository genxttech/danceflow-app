/*
  Maps the current route to LUMI's screen descriptor, from the pathname (screens stay untouched). Only the event id from the route is reported;
  the sanitizer re-validates it (uuid) and the server re-authorizes.
*/

export type RouteDescriptor = { screenId: string; entityIds?: Record<string, string> } | null;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function descriptorForRoute(pathname: string, params: Params): RouteDescriptor {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/home") return { screenId: "today" };
  if (path === "/schedule") return { screenId: "schedule" };
  if (path === "/wallet") return { screenId: "wallet" };
  if (path === "/discover/events" || path.startsWith("/discover/events/")) return { screenId: "events-list" };
  if (/^\/events\/[^/]+$/.test(path)) {
    const eventId = one(params.id);
    return { screenId: "event-detail", entityIds: eventId ? { eventId } : {} };
  }
  return null;
}
