export type PublicNavPath =
  | "home"
  | "discover"
  | "studios"
  | "events"
  | "partners"
  | "jobs"
  | "marketplace"
  | "pricing"
  | "account"
  | "favorites";

export type PublicNavItem = {
  key: PublicNavPath;
  label: string;
  href: string;
  authOnly?: boolean;
};

export const PUBLIC_NAV_ITEMS: PublicNavItem[] = [
  { key: "home", label: "Home", href: "/" },
  { key: "discover", label: "Discover", href: "/discover" },
  { key: "studios", label: "Studios", href: "/discover/studios" },
  { key: "events", label: "Events", href: "/discover/events" },
  { key: "marketplace", label: "Marketplace", href: "/marketplace" },
  { key: "pricing", label: "Pricing", href: "/get-started" },
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
  if (pathname === "/discover") return "discover";
  if (under(pathname, "/discover/studios") || under(pathname, "/studios")) return "studios";
  if (under(pathname, "/discover/events") || under(pathname, "/events")) return "events";
  if (under(pathname, "/marketplace")) return "marketplace";
  if (under(pathname, "/get-started")) return "pricing";
  if (under(pathname, "/favorites")) return "favorites";
  if (under(pathname, "/account")) return "account";
  return null;
}
