/*
  Maps the current route to ARIA's screen descriptor. Done from the pathname (not inside each screen) so the Phase 1A screens stay untouched.
  Only ids from the route are reported; the sanitizer re-validates them (uuid shape) and the server re-authorizes.
*/

export type RouteDescriptor = { screenId: string; entityIds?: Record<string, string> } | null;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function descriptorForRoute(pathname: string, params: Params): RouteDescriptor {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/today" || path === "/") return { screenId: "today" };
  if (path === "/pulse") return { screenId: "pulse" };
  if (path === "/clients") return { screenId: "clients" };
  const studioId = one(params.studioId);
  if (/^\/clients\/[^/]+$/.test(path) && path !== "/clients/new") {
    const clientId = one(params.id);
    return { screenId: "client-detail", entityIds: { ...(clientId ? { clientId } : {}), ...(studioId ? { studioId } : {}) } };
  }
  if (/^\/appointments\/[^/]+$/.test(path)) {
    const appointmentId = one(params.id);
    return { screenId: "appointment-detail", entityIds: { ...(appointmentId ? { appointmentId } : {}), ...(studioId ? { studioId } : {}) } };
  }
  return null;
}
