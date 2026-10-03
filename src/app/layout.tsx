import type { Metadata, Viewport } from "next";
import "./globals.css";
import {
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
  SITE_OG_DESCRIPTION,
  SITE_TITLE,
  SITE_TWITTER_DESCRIPTION,
} from "@/lib/public/homeCopy";

const siteUrl = "https://www.idanceflow.com";

// Brand-neutral 1200x630 card (canonical logo on --brand-surface), built by scripts/brand/build-logo-family.mjs.
const ogImage = "/brand/danceflow-og-1200x630.png";

export const viewport: Viewport = {
  themeColor: "#5b145e", // --brand-primary
};

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: SITE_TITLE,
    template: "%s | DanceFlow",
  },
  description: SITE_DESCRIPTION,
  applicationName: "DanceFlow",
  keywords: SITE_KEYWORDS,
  authors: [{ name: "DanceFlow" }],
  creator: "DanceFlow",
  publisher: "DanceFlow",
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "DanceFlow",
    title: SITE_TITLE,
    description: SITE_OG_DESCRIPTION,
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
    title: SITE_TITLE,
    description: SITE_TWITTER_DESCRIPTION,
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
