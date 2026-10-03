/**
 * BR-4B: copy for the three public business audience pages. Same rules as homeCopy.ts: only
 * capabilities that exist today, no Featured Events promotion, Partner Match only as listings,
 * ARIA described by what it does (suggests, surfaces, runs approved automation within owner-set
 * limits), and no Competition OS claims (judging, scoring, results, live heats).
 *
 * Trial length and founder wording are never stored here; pages derive them from the plan
 * definitions and `isFounderPricingActive()` (see `buildTrialLine` in homeCopy.ts).
 */

export type AudienceKey = "studios" | "instructors" | "organizers";

export const AUDIENCE_LINKS: Array<{ key: AudienceKey; label: string; href: string }> = [
  { key: "studios", label: "Studios", href: "/for-studios" },
  { key: "instructors", label: "Independent instructors", href: "/for-instructors" },
  { key: "organizers", label: "Organizers", href: "/for-organizers" },
];

/** Dancers stay on Discover; the switcher offers it as the fourth path. */
export const DANCER_LINK = { label: "Dancers", href: "/discover" } as const;

export const SUPPORT_MAILTO = "mailto:support@idanceflow.com";

export type ProofRow = { title: string; summary: string; proof: string[] };

/* ----------------------------------------------------------------------------------------- */
/* Studios                                                                                    */
/* ----------------------------------------------------------------------------------------- */

export const STUDIOS_PAGE = {
  metaTitle: "Software for Dance Studios",
  metaDescription:
    "DanceFlow connects studio scheduling, clients, packages, payments and documents, and points out what needs attention next.",
  eyebrow: "For dance studio owners",
  headline: "Run the studio without chasing the details.",
  support:
    "DanceFlow keeps scheduling, clients, packages, payments and paperwork connected, and points out what needs your attention next.",
  cta: { label: "See plans and start your trial", href: "/get-started/studio" },
  dayHeading: "Run the day-to-day",
  dayIntro: "The work that fills a studio week, in one connected place.",
  dayRows: [
    {
      title: "Scheduling that matches how you teach",
      summary:
        "Private lessons, group classes and intro lessons share one schedule, with instructors and rooms in view.",
      proof: [
        "Booking requests from your public profile land in front of your team",
        "Confirmations and changes go to dancers by email",
        "Group class rosters and check-in",
      ],
    },
    {
      title: "Clients, packages and memberships",
      summary: "Know who your clients are and what they have left, without a second spreadsheet.",
      proof: [
        "Client records with lesson credits that update as lessons happen",
        "Packages and memberships you set up once",
        "Leads from your public inquiry form, ready to follow up",
      ],
    },
    {
      title: "Payments and paperwork",
      summary: "Take payment and collect signatures without leaving DanceFlow.",
      proof: [
        "Card payments through Stripe",
        "E-signature waivers and agreements, tracked from sent to signed",
        "Reports and exports, plus instructor pay preparation",
      ],
    },
  ] satisfies ProofRow[],
  attentionHeading: "See what needs attention",
  attentionBody:
    "ARIA, DanceFlow's operations assistant, looks across your studio for things like packages nearing renewal, pending booking requests and unsigned documents, then suggests the next step.",
  attentionControl:
    "You choose how much it does on its own for each area: handle automatically, prepare for your review, notify only, or off. Billing, access and refund decisions always stay with you.",
  foundHeading: "Be found by the dancers looking for you",
  foundBody:
    "Your public studio profile can appear in Discover, where dancers search by place and style, and its inquiry form turns interest into intro lesson requests you can follow up on.",
  closeHeading: "Start with a free trial",
} as const;

/* ----------------------------------------------------------------------------------------- */
/* Independent instructors                                                                    */
/* ----------------------------------------------------------------------------------------- */

export const INSTRUCTORS_PAGE = {
  metaTitle: "Software for Independent Dance Instructors",
  metaDescription:
    "If you teach on your own, DanceFlow gives you scheduling, clients, packages, payments and documents, with a public profile dancers can find.",
  eyebrow: "For independent instructors",
  headline: "Run your teaching business, not a pile of spreadsheets.",
  support:
    "If you teach on your own, DanceFlow gives you the same tools studios use for scheduling, clients, packages, payments and documents, so more of your week goes to teaching.",
  cta: { label: "See plans and start your trial", href: "/get-started/studio" },
  stagesHeading: "Your teaching, in one place",
  stages: [
    {
      title: "Get found",
      body: "Publish a public profile that can appear in Discover and take intro lesson requests from dancers looking for a teacher.",
    },
    {
      title: "Teach",
      body: "Keep private lessons and classes on one schedule, with confirmations and changes sent for you.",
    },
    {
      title: "Keep students coming back",
      body: "Track packages, take payment, collect signed waivers and send follow-up, with ARIA pointing out renewals and pending requests.",
    },
  ],
  startHeading: "How you start",
  startIntro:
    "DanceFlow's plans are called studio plans. As an independent instructor you use the same plans and tools, and your workspace can carry your own teaching name.",
  steps: [
    { title: "Pick a plan", body: "Review the pricing before you create anything." },
    { title: "Create your account", body: "Confirm your email and set a password." },
    { title: "Launch your workspace", body: "Add your first students, lessons and packages." },
  ],
  closeHeading: "Try it on your own schedule",
} as const;

/* ----------------------------------------------------------------------------------------- */
/* Organizers                                                                                 */
/* ----------------------------------------------------------------------------------------- */

export const ORGANIZERS_PAGE = {
  metaTitle: "Event Tools for Dance Organizers",
  metaDescription:
    "Publish dance events, sell tickets, check people in with QR codes and settle up afterward, with transparent event pricing.",
  eyebrow: "For event organizers",
  headline: "From event page to check-in, in one place.",
  support:
    "Publish your event, sell tickets, welcome people with QR check-in and settle up afterward, for workshops, socials, showcases and festivals.",
  cta: { label: "See organizer pricing and start your trial", href: "/get-started/organizer" },
  flowHeading: "The whole event, start to finish",
  flow: [
    {
      title: "Publish",
      body: "A public event page that can appear in Discover, with early bird pricing and optional guest coach private lesson slots.",
    },
    {
      title: "Sell",
      body: "Tickets with checkout, payment collection through Stripe, and a confirmation with a QR code for every buyer.",
    },
    {
      title: "Check in",
      body: "Scan ticket codes at the door and see who has arrived, then review attendance afterward.",
    },
    {
      title: "Settle up",
      body: "Closeout and settlement reports with financial summaries you can export.",
    },
  ],
  peopleHeading: "Stay in touch with your people",
  peopleBody:
    "Keep organizer contacts and send campaigns about your events, so the people who came to one event hear about the next.",
  pricingNote:
    "Event pricing is shown in full before you create an account, including platform and payment processing fees.",
  closeHeading: "See the pricing, then start your trial",
} as const;
