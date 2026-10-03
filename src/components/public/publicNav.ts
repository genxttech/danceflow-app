/**
 * BR-4B public navigation: a deliberately small model.
 *
 *   Discover  |  For Business (Studios, Independent instructors, Organizers)  |  Favorites / Account when signed in
 *
 * Studios, Events, Jobs, Dance partners and Marketplace live under Discover (its context bar and
 * the footer). Plans and pricing are reached from each business page and from the Get Started
 * footer link, so no top-level label promises a pricing page that does not exist.
 */
export type PublicNavPath = "home" | "discover" | "business" | "account" | "favorites";

export type PublicNavChild = {
  label: string;
  href: string;
};

export type PublicNavItem = {
  key: PublicNavPath;
  label: string;
  href: string;
  authOnly?: boolean;
  /** Grouped destinations; the item's own href is the first child's destination. */
  children?: PublicNavChild[];
};

export const BUSINESS_NAV_CHILDREN: PublicNavChild[] = [
  { label: "Studios", href: "/for-studios" },
  { label: "Independent instructors", href: "/for-instructors" },
  { label: "Organizers", href: "/for-organizers" },
];

export const PUBLIC_NAV_ITEMS: PublicNavItem[] = [
  { key: "discover", label: "Discover", href: "/discover" },
  { key: "business", label: "For Business", href: "/for-studios", children: BUSINESS_NAV_CHILDREN },
  { key: "favorites", label: "Favorites", href: "/favorites", authOnly: true },
  { key: "account", label: "Account", href: "/account", authOnly: true },
];

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
