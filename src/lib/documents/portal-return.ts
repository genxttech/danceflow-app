/*
  Phase 8C: carries the portal Documents context (studio + selected client) through the token signing surface so a
  guardian returns to the client they were signing for. The values are only shape-validated here; the portal page
  they lead back to re-verifies the signed-in user's relationship to that client, so a tampered value can never
  grant access -- it can only fall back.
*/

const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PortalReturn = { studioSlug: string; clientId: string };

export function parsePortalReturn(studioSlug: unknown, clientId: unknown): PortalReturn | null {
  if (typeof studioSlug !== "string" || typeof clientId !== "string") return null;
  if (!SLUG.test(studioSlug) || !UUID.test(clientId)) return null;
  return { studioSlug, clientId };
}

export function portalReturnQuery(value: PortalReturn | null) {
  return value ? `portal=${encodeURIComponent(value.studioSlug)}&client=${encodeURIComponent(value.clientId)}` : "";
}

export function portalDocumentsHref(value: PortalReturn) {
  return `/portal/${encodeURIComponent(value.studioSlug)}/documents?client=${encodeURIComponent(value.clientId)}`;
}
