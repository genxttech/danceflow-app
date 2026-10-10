import { competitionWorkspaceHref } from "@/lib/competition/workspaceLink";

export type CompetitionNavKey =
  | "overview"
  | "entries"
  | "check_in"
  | "divisions"
  | "schedule"
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

export function competitionNav(eventId: string): CompetitionNavItem[] {
  const base = competitionWorkspaceHref(eventId);
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

/** Which nav item a pathname belongs to (readiness and generation live under Schedule & Heats). */
export function activeNavKey(eventId: string, pathname: string): CompetitionNavKey {
  const base = competitionWorkspaceHref(eventId);
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  if (rest.startsWith("/registrations")) return "entries";
  if (rest.startsWith("/checkin")) return "check_in";
  if (rest.startsWith("/divisions")) return "divisions";
  if (rest.startsWith("/schedule") || rest.startsWith("/readiness") || rest.startsWith("/generation") || rest.startsWith("/advanced/schedule")) return "schedule";
  if (rest.startsWith("/settings") || rest.startsWith("/advanced")) return "settings";
  return "overview";
}
