import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";

const siteUrl = "https://www.idanceflow.com";

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
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "DanceFlow",
    title: "DanceFlow | Dance Studio CRM, Scheduler, and Event Management",
    description:
      "Manage your dance studio, grow your community, publish events, collect registrations, and help dancers discover studios and events in one connected platform.",
    images: [
      {
        url: "/brand/danceflow-home-hero.png",
        width: 1400,
        height: 1000,
        alt: "DanceFlow connects dance studio operations and dancers",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "DanceFlow | Dance Studio CRM, Scheduler, and Event Management",
    description:
      "DanceFlow helps studios, instructors, organizers, and dancers connect through scheduling, CRM, events, portals, payments, and public discovery.",
    images: ["/brand/danceflow-home-hero.png"],
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
      <body className="min-h-screen bg-white text-slate-900">
        <div className="flex min-h-screen flex-col">
          <main className="flex-1">{children}</main>

          <footer className="border-t border-slate-200 bg-white">
            <div className="mx-auto flex max-w-7xl flex-col gap-3 px-6 py-6 text-sm text-slate-600 md:flex-row md:items-center md:justify-between">
              <p>© {new Date().getFullYear()} DanceFlow. All rights reserved.</p>

              <div className="flex flex-wrap items-center gap-4">
                <Link
                  href="/privacy-policy"
                  className="transition hover:text-slate-900"
                >
                  Privacy Policy
                </Link>

                <Link
                  href="/terms-and-conditions"
                  className="transition hover:text-slate-900"
                >
                  Terms & Conditions
                </Link>
              </div>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}