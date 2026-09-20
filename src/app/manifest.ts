import type { MetadataRoute } from "next";

// Web app manifest. Icons come from the canonical BR-1 family (couple symbol).
// display "browser": supplies icons and colours without making the site an installable app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "DanceFlow",
    short_name: "DanceFlow",
    start_url: "/",
    display: "browser",
    background_color: "#fff9f3", // --brand-surface
    theme_color: "#5b145e", // --brand-primary
    icons: [
      { src: "/brand/icons/danceflow-pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/icons/danceflow-pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/icons/danceflow-pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
