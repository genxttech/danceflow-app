/**
 * W-2 public navigation: two equal audiences.
 *
 *   For Dancers ▾  |  For Business ▾  |  Favorites / Account when signed in
 *
 * Dancers go to /discover (there is no /for-dancers route), so the "discover" key is the For
 * Dancers group. Plans and the free trial are reached from For Business; account creation and
 * the business trial stay distinct actions in the header.
 */
export type PublicNavPath = "home" | "discover" | "business" | "account" | "favorites";

export type PublicNavChild = {
  label: string;
  href: string;
  /** Draw a separator above this entry (desktop disclosure and mobile group). */
  dividerBefore?: boolean;
};

export type PublicNavItem = {
  key: PublicNavPath;
  label: string;
  href: string;
  authOnly?: boolean;
  /** Grouped destinations; the item's own href is the first child's destination. */
  children?: PublicNavChild[];
};

export const DANCER_NAV_CHILDREN: PublicNavChild[] = [
  { label: "Discover home", href: "/discover" },
  { label: "Studios", href: "/discover/studios" },
  { label: "Classes", href: "/discover/classes" },
  { label: "Events", href: "/discover/events" },
  { label: "Dance partners", href: "/discover/partners" },
  { label: "Jobs", href: "/discover/jobs" },
  { label: "Learning", href: "/marketplace" },
];

export const BUSINESS_NAV_CHILDREN: PublicNavChild[] = [
  { label: "Studios", href: "/for-studios" },
  { label: "Independent instructors", href: "/for-instructors" },
  { label: "Organizers", href: "/for-organizers" },
  { label: "Plans & free trial", href: "/get-started", dividerBefore: true },
  { label: "Meet ARIA", href: "/for-studios#meet-aria" },
];

export const PUBLIC_NAV_ITEMS: PublicNavItem[] = [
  { key: "discover", label: "For Dancers", href: "/discover", children: DANCER_NAV_CHILDREN },
  { key: "business", label: "For Business", href: "/for-studios", children: BUSINESS_NAV_CHILDREN },
  { key: "favorites", label: "Favorites", href: "/favorites", authOnly: true },
  { key: "account", label: "Account", href: "/account", authOnly: true },
];

/** Signed-out header actions. Account creation and the business trial are separate on purpose. */
export const PUBLIC_AUTH_ACTIONS = {
  logIn: { label: "Log In", href: "/login?intent=public" },
  createAccount: { label: "Create free account", href: "/signup?intent=public" },
  startTrial: { label: "Start free trial", href: "/get-started/studio" },
} as const;

function under(pathname: string, base: string) {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Which primary nav item a pathname belongs to (null when none applies). */
export function activePublicNavKey(pathname: string | null): PublicNavPath | null {
  if (!pathname) return null;
  if (pathname === "/") return "home";
  if (
    under(pathname, "/discover") ||
    under(pathname, "/studios") ||
    under(pathname, "/events") ||
    under(pathname, "/marketplace")
  ) {
    return "discover";
  }
  if (
    under(pathname, "/for-studios") ||
    under(pathname, "/for-instructors") ||
    under(pathname, "/for-organizers") ||
    under(pathname, "/get-started")
  ) {
    return "business";
  }
  if (under(pathname, "/favorites")) return "favorites";
  if (under(pathname, "/account")) return "account";
  return null;
}

/** Whether a child link is the current page (hash links never are; their page has its own entry). */
export function isCurrentPublicNavChild(pathname: string | null, href: string): boolean {
  return !href.includes("#") && pathname === href;
}
