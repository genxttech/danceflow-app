import type { MetadataRoute } from "next";

const siteUrl = "https://www.idanceflow.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/app",
          "/app/",
          "/account",
          "/account/",
          "/portal",
          "/portal/",
          "/platform",
          "/platform/",
          "/api",
          "/api/",
        ],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}