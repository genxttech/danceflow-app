/**
 * BR-4A: public homepage and site-metadata copy, in one place so the message hierarchy stays
 * consistent and so the claims guard (`homeCopy.br4a.test.ts`) has a single source to check.
 *
 * Copy here may only describe capabilities that are real today. See the canonical roadmap
 * (docs/roadmap/DanceFlow_Master_Roadmap.md, Phase 3 and the Featured Events / Partner Match
 * modules) for the current restrictions. In particular: no Featured Events promotion claims,
 * Partner Match is described only as dance partner listings, ARIA is described by what it does
 * today (surfacing what needs attention, suggestions, approved automation), and there are no
 * competition judging/scoring/results claims.
 *
 * Pricing/trial wording is NOT stored here: it is derived at render time from the same helpers
 * the pricing pages use (see `buildTrialLine`).
 */

export const SITE_TITLE = "DanceFlow | The dance platform that helps do the work";

export const SITE_DESCRIPTION =
  "DanceFlow helps dance studios, instructors and organizers run the business, and helps dancers discover studios, events, dance partners and jobs.";

export const SITE_OG_DESCRIPTION =
  "Scheduling, clients, payments, documents and events in one place for studios, instructors and organizers, plus a public way for dancers to find studios, events and dance partners.";

export const SITE_TWITTER_DESCRIPTION =
  "The dance platform that helps do the work, not just track it. For studios, instructors, organizers and dancers.";

export const SITE_KEYWORDS = [
  "dance studio software",
  "dance studio scheduling",
  "dance instructor software",
  "dance event ticketing",
  "dance event registration",
  "find dance studios",
  "find dance events",
  "ballroom dance studio software",
  "country dance studio software",
];

export const HOME_HERO = {
  eyebrow: "For studios, instructors, organizers and dancers",
  headline: "The dance platform that helps do the work—not just track it.",
  support:
    "DanceFlow connects the business side of dance with the dancers and experiences that make the community grow.",
  primaryCta: { label: "Start your free trial", href: "/get-started/studio" },
  secondaryCta: { label: "Or explore studios, events and dance partners", href: "/discover" },
  imageAlt: "DanceFlow connects studio operations, public discovery, and dance events",
} as const;

export type HomeConcept = {
  title: string;
  summary: string;
  /** Shipped capabilities that back the summary; revealed on demand. */
  proof: string[];
};

export const HOME_WORK_HEADING = "Software that does more than keep records.";

export const HOME_WORK_INTRO =
  "Dance businesses run on a hundred small tasks. DanceFlow keeps them connected and helps move them forward.";

export const HOME_CONCEPTS: HomeConcept[] = [
  {
    title: "Run the day-to-day",
    summary:
      "Scheduling, clients, packages, memberships and payments stay connected, so the front desk spends less time reconciling.",
    proof: [
      "Private lessons and group classes on one schedule",
      "Packages and memberships that track lesson credits",
      "Payments, reports and instructor pay preparation",
    ],
  },
  {
    title: "Stay connected to your dancers",
    summary:
      "Portals, documents and follow-up keep every dancer informed without chasing people one message at a time.",
    proof: [
      "A student portal for schedules, documents and lesson progress",
      "E-signature documents and waivers with a signed certificate",
      "Booking confirmations, email reminders and email campaigns",
    ],
  },
  {
    title: "Turn interest into participation",
    summary:
      "Public profiles, inquiry forms and event pages turn curiosity into intro lessons, registrations and attendance.",
    proof: [
      "A public studio profile with an intro lesson request form",
      "Event pages with ticketing, early bird pricing and QR check-in",
      "Digital lessons and series sold through the Marketplace",
    ],
  },
  {
    title: "Keep the business moving",
    summary:
      "ARIA surfaces what needs attention, like renewals, pending requests and unsigned documents, and helps with follow-up within the limits you set.",
    proof: [
      "Suggestions and operational insights in the ARIA Operations Center",
      "Automation you control: handle automatically, prepare for review, notify only, or off",
      "Billing, access and refund decisions stay with you",
    ],
  },
];

export const HOME_AUDIENCE_HEADING = "Who DanceFlow is for";

export type HomeAudience = { name: string; line: string; cta: string; href: string };

/** Business audiences link to their dedicated pages (BR-4B); dancers stay on Discover. */
export const HOME_AUDIENCES: HomeAudience[] = [
  {
    name: "Studio owners",
    line: "Run the studio, from the first inquiry to the renewal.",
    cta: "For studios",
    href: "/for-studios",
  },
  {
    name: "Independent instructors",
    line: "Run your teaching business with the same tools studios use.",
    cta: "For instructors",
    href: "/for-instructors",
  },
  {
    name: "Organizers",
    line: "Publish events, sell tickets and check people in.",
    cta: "For organizers",
    href: "/for-organizers",
  },
  {
    name: "Dancers",
    line: "Find studios, events, dance partners and jobs near you.",
    cta: "Explore Discover",
    href: "/discover",
  },
];

export const HOME_DISCOVERY = {
  heading: "A public home for the dance community.",
  body:
    "Dancers can find studios, events, dance partner listings and jobs in one place, and studios and organizers are found by dancers who are looking for them. A free account lets you save favorites and keep your registrations together.",
  links: [
    { label: "Studios", href: "/discover/studios" },
    { label: "Events", href: "/discover/events" },
    { label: "Dance partner listings", href: "/discover/partners" },
    { label: "Jobs", href: "/discover/jobs" },
    { label: "Learning", href: "/marketplace" },
  ],
} as const;

export const HOME_TRUST = {
  heading: "Built to be relied on.",
  items: [
    {
      title: "Access that matches the role",
      body: "Owners, admins, front desk and instructors each see and do what their role allows.",
    },
    {
      title: "Documents you can stand behind",
      body: "E-signature documents are tracked from sent to signed, with a signed certificate.",
    },
    {
      title: "Clear terms",
      body: "Plain legal pages and a published security overview, with support one email away.",
    },
  ],
  links: [
    { label: "Security", href: "/security" },
    { label: "Privacy", href: "/privacy" },
    { label: "Terms", href: "/terms" },
  ],
} as const;

export const HOME_FINAL_CTA = {
  heading: "Ready to let DanceFlow help do the work?",
  primaryCta: { label: "Start your free trial", href: "/get-started/studio" },
  supportLink: { label: "Questions? Talk to us", href: "mailto:support@idanceflow.com" },
} as const;

export const HOME_JSON_LD = {
  organization:
    "DanceFlow is a dance platform with software for studios, instructors and organizers, and a public discovery experience for dancers.",
  website:
    "DanceFlow helps dance studios, instructors and organizers run the business, and helps dancers discover studios, events, dance partners and jobs.",
  application:
    "DanceFlow is business software for dance studios, instructors and organizers, with a public way for dancers to find studios, events, dance partner listings and jobs.",
  offer:
    "DanceFlow offers free dancer discovery accounts and trial options for studio and organizer workspaces.",
};

/**
 * One short line under the primary CTAs. Trial length and founder-pricing wording are passed in
 * from the pricing logic (`getPlansByAudience("studio")[0].trialDays`, `isFounderPricingActive()`).
 * No remaining-studio count is ever shown.
 */
export function buildTrialLine(input: {
  trialDays: number;
  founderPricingActive: boolean;
  /** Who the trial is for; defaults to studios. Independent instructors use the studio plans. */
  audience?: "studios" | "instructors" | "organizers";
}) {
  const audienceLabel = {
    studios: "studios",
    instructors: "independent instructors",
    organizers: "organizers",
  }[input.audience ?? "studios"];
  const base = `${input.trialDays}-day free trial for ${audienceLabel}`;
  return input.founderPricingActive ? `${base}. Founder pricing is available during launch.` : `${base}.`;
}
