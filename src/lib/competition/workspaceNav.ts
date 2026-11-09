import { competitionWorkspaceHref } from "@/lib/competition/workspaceLink";

export type CompetitionNavKey =
  | "overview"
  | "entries"
  | "check_in"
  | "divisions"
  | "schedule"
  | "day_of"
  | "officials"
  | "scoring"
  | "results"
  | "awards"
  | "settings";

export type CompetitionNavItem = {
  key: CompetitionNavKey;
  label: string;
  /** null = not built yet: rendered as a disabled item, never as a link. */
  href: string | null;
  available: boolean;
  /** Shown for items that are not available yet. */
  note?: string;
  child?: boolean;
};

const LATER = "Available in a later Competition OS release.";

/**
 * `finalsEnabled` comes from the server (`competitionFinalsEnabled()` in the workspace layout). It defaults to false, so a caller that does
 * not pass it gets the live release navigation: Day-of, Officials and Ballots are not listed, and Officials/Scoring stay "Later".
 */
export function competitionNav(eventId: string, finalsEnabled = false): CompetitionNavItem[] {
  const base = competitionWorkspaceHref(eventId);
  if (!finalsEnabled) {
    return [
      { key: "overview", label: "Overview", href: base, available: true },
      { key: "entries", label: "Entries", href: `${base}/registrations`, available: true },
      { key: "check_in", label: "Check-in", href: `${base}/checkin`, available: true, child: true },
      { key: "divisions", label: "Divisions", href: `${base}/divisions`, available: true },
      { key: "schedule", label: "Schedule & Heats", href: `${base}/schedule`, available: true },
      { key: "officials", label: "Officials", href: null, available: false, note: LATER },
      { key: "scoring", label: "Scoring", href: null, available: false, note: LATER },
      { key: "results", label: "Results", href: null, available: false, note: LATER },
      { key: "awards", label: "Awards", href: null, available: false, note: LATER },
      { key: "settings", label: "Settings", href: `${base}/settings`, available: true },
    ];
  }
  return [
    { key: "overview", label: "Overview", href: base, available: true },
    { key: "entries", label: "Entries", href: `${base}/registrations`, available: true },
    { key: "check_in", label: "Check-in", href: `${base}/checkin`, available: true, child: true },
    { key: "divisions", label: "Divisions", href: `${base}/divisions`, available: true },
    { key: "schedule", label: "Schedule & Heats", href: `${base}/schedule`, available: true },
    { key: "day_of", label: "Day-of", href: `${base}/day-of`, available: true },
    { key: "officials", label: "Officials", href: `${base}/officials`, available: true },
    { key: "scoring", label: "Ballots", href: `${base}/ballots`, available: true },
    { key: "results", label: "Results", href: null, available: false, note: LATER },
    { key: "awards", label: "Awards", href: null, available: false, note: LATER },
    { key: "settings", label: "Settings", href: `${base}/settings`, available: true },
  ];
}

/** Which nav item a pathname belongs to (readiness and generation live under Schedule & Heats). */
export function activeNavKey(eventId: string, pathname: string): CompetitionNavKey {
  const base = competitionWorkspaceHref(eventId);
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  if (rest.startsWith("/registrations")) return "entries";
  if (rest.startsWith("/checkin")) return "check_in";
  if (rest.startsWith("/divisions")) return "divisions";
  if (rest.startsWith("/schedule") || rest.startsWith("/readiness") || rest.startsWith("/generation") || rest.startsWith("/advanced/schedule")) return "schedule";
  if (rest.startsWith("/day-of")) return "day_of";
  if (rest.startsWith("/officials")) return "officials";
  if (rest.startsWith("/ballots")) return "scoring";
  if (rest.startsWith("/settings") || rest.startsWith("/advanced")) return "settings";
  return "overview";
}
