export type PartnerSearchFilters = {
  intents: readonly string[];
  latitude: number | null;
  longitude: number | null;
  query: string;
  radiusMiles: number;
  role: string;
  skill: string;
  styles: readonly string[];
};

export function partnerProfileAnchor(profileId: string) {
  return `partner-${profileId}`;
}

// Rebuilds the listing URL from the already-normalized filters, so the login return path never carries raw input.
export function partnerSearchReturnPath(filters: PartnerSearchFilters) {
  const search = new URLSearchParams();
  if (filters.query) search.set("q", filters.query);
  for (const intent of filters.intents) search.append("intent", intent);
  if (filters.role) search.set("role", filters.role);
  if (filters.skill) search.set("skill", filters.skill);
  for (const style of filters.styles) search.append("style", style);
  if (filters.latitude !== null && filters.longitude !== null) {
    search.set("lat", String(filters.latitude));
    search.set("lng", String(filters.longitude));
    search.set("radius", String(filters.radiusMiles));
  }

  const queryString = search.toString();
  return queryString ? `/discover/partners?${queryString}` : "/discover/partners";
}

// The login page validates `next` with normalizeLocalRedirectPath; this only ever produces a local path.
export function partnerConnectLoginHref(returnPath: string, profileId: string) {
  const search = new URLSearchParams({
    intent: "public",
    next: `${returnPath}#${partnerProfileAnchor(profileId)}`,
  });
  return `/login?${search.toString()}`;
}
