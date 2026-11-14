/*
  Guest discovery. A signed-out visitor may browse what studios have made public: the Discover tab,
  the event lists, an event's page, and studio pages. Everything else (Today, Learn, Wallet, bookings,
  tickets, purchases, partner messages, marketplace, settings, registration) needs an account.

  This is a route allow-list over expo-router segments, so a new screen is protected by default. It is
  a navigation rule only: the data behind public screens is still read through the same anonymous,
  RLS-limited queries, and every account-specific read or write keeps its own server-side checks.
*/

/** Routes that are not behind the gate because they are how a visitor signs in. */
const AUTH_ROOTS = new Set(["(auth)", "auth"]);

/** Discover's public sub-areas. `marketplace` (purchases) is deliberately absent. */
const PUBLIC_DISCOVER_AREAS = new Set(["events", "studios"]);

function clean(segments: readonly string[]) {
  return segments.filter((segment) => segment.length > 0);
}

export function guestMayView(segments: readonly string[]): boolean {
  const [root, second, third] = clean(segments);

  // The index route only redirects (to sign-in or Today).
  if (root === undefined || root === "index") return true;
  if (AUTH_ROOTS.has(root)) return true;

  if (root === "(tabs)") return second === "discover";

  if (root === "discover") return second === undefined || PUBLIC_DISCOVER_AREAS.has(second);

  // Studio pages (overview, about, styles, staff, offerings, events, contact) are public listings.
  if (root === "studios") return true;

  // An event's page is public; registering, orders and everything else under /events is not.
  if (root === "events") return second !== undefined && second !== "orders" && third === undefined;

  return false;
}

/** Whether a visitor without an account is looking at the tab group's Discover tab. */
export function isGuestDiscoverTab(segments: readonly string[]) {
  const [root, second] = clean(segments);
  return root === "(tabs)" && second === "discover";
}
