import type { Metadata, Viewport } from "next";
import "./globals.css";

const siteUrl = "https://www.idanceflow.com";

// Brand-neutral 1200x630 card (canonical logo on --brand-surface), built by scripts/brand/build-logo-family.mjs.
const ogImage = "/brand/danceflow-og-1200x630.png";

export const viewport: Viewport = {
  themeColor: "#5b145e", // --brand-primary
};

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "DanceFlow | Dance Studio CRM, Scheduler, and Event Management",
    template: "%s | DanceFlow",
  },
  description:
    "DanceFlow helps dance studios, independent instructors, organizers, and dancers manage scheduling, clients, events, registrations, portals, payments, and public discovery.",
  applicationName: "DanceFlow",
  keywords: [
    "dance studio CRM",
    "dance studio scheduler",
    "dance studio management software",
    "dance event registration",
    "dance event ticketing",
    "ballroom dance studio software",
    "country dance studio software",
    "dance instructor scheduling",
  ],
  authors: [{ name: "DanceFlow" }],
  creator: "DanceFlow",
  publisher: "DanceFlow",
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "DanceFlow",
    title: "DanceFlow | Dance Studio CRM, Scheduler, and Event Management",
    description:
      "Manage your dance studio, grow your community, publish events, collect registrations, and help dancers discover studios and events in one connected platform.",
    images: [
      {
        url: ogImage,
        width: 1200,
        height: 630,
        alt: "DanceFlow",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "DanceFlow | Dance Studio CRM, Scheduler, and Event Management",
    description:
      "DanceFlow helps studios, instructors, organizers, and dancers connect through scheduling, CRM, events, portals, payments, and public discovery.",
    images: [ogImage],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900">{children}</body>
    </html>
  );
}
