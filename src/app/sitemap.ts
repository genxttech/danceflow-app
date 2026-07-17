import type { MetadataRoute } from "next";
import { createClient } from "@/lib/supabase/server";
import { knowledgebaseArticles } from "@/content/knowledgebase/articles";

const siteUrl = "https://www.idanceflow.com";

export const revalidate = 3600;

type PublicStudioSitemapRow = {
  slug: string | null;
  updated_at: string | null;
  billing_plan: string | null;
  subscription_status: string | null;
};

type PublicEventSitemapRow = {
  slug: string | null;
  updated_at: string | null;
  studios:
    | {
        billing_plan: string | null;
        subscription_status: string | null;
      }
    | {
        billing_plan: string | null;
        subscription_status: string | null;
      }[]
    | null;
};

function hasActivePublicAccess(studio: {
  billing_plan?: string | null;
  subscription_status?: string | null;
} | null | undefined) {
  if (!studio) return false;

  const status = (studio.subscription_status ?? "").trim().toLowerCase();

  return status === "active" || status === "trialing";
}

function getStudio(value: PublicEventSitemapRow["studios"]) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function safeDate(value: string | null | undefined) {
  if (!value) return new Date();

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return new Date();
  }

  return date;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: `${siteUrl}/`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${siteUrl}/discover/studios`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${siteUrl}/discover/events`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${siteUrl}/knowledgebase`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${siteUrl}/get-started`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${siteUrl}/login`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.2,
    },
    {
      url: `${siteUrl}/privacy`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${siteUrl}/terms`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${siteUrl}/acceptable-use`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.2,
    },
    {
      url: `${siteUrl}/dpa`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.2,
    },
    {
      url: `${siteUrl}/electronic-signature-consent`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.2,
    },
    {
      url: `${siteUrl}/refund-policy`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.2,
    },
    {
      url: `${siteUrl}/security`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${siteUrl}/sms-consent`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.2,
    },
  ];

  const articleRoutes: MetadataRoute.Sitemap = knowledgebaseArticles
    .filter((article) => article.audience !== "app")
    .map((article) => ({
      url: `${siteUrl}/knowledgebase/${article.slug}`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.6,
    }));

  try {
    const supabase = await createClient();

    const [{ data: studios }, { data: events }] = await Promise.all([
      supabase
        .from("studios")
        .select("slug, updated_at, billing_plan, subscription_status")
        .eq("public_directory_enabled", true)
        .not("slug", "is", null)
        .order("updated_at", { ascending: false }),

      supabase
        .from("events")
        .select("slug, updated_at, studios ( billing_plan, subscription_status )")
        .eq("status", "published")
        .eq("visibility", "public")
        .eq("public_directory_enabled", true)
        .not("slug", "is", null)
        .order("updated_at", { ascending: false }),
    ]);

    const studioRoutes: MetadataRoute.Sitemap = (
      (studios ?? []) as PublicStudioSitemapRow[]
    )
      .filter((studio) => Boolean(studio.slug) && hasActivePublicAccess(studio))
      .map((studio) => ({
        url: `${siteUrl}/studios/${studio.slug}`,
        lastModified: safeDate(studio.updated_at),
        changeFrequency: "weekly",
        priority: 0.85,
      }));

    const eventRoutes: MetadataRoute.Sitemap = (
      (events ?? []) as PublicEventSitemapRow[]
    )
      .filter((event) => Boolean(event.slug) && hasActivePublicAccess(getStudio(event.studios)))
      .map((event) => ({
        url: `${siteUrl}/events/${event.slug}`,
        lastModified: safeDate(event.updated_at),
        changeFrequency: "daily",
        priority: 0.85,
      }));

    return [
      ...staticRoutes,
      ...articleRoutes,
      ...studioRoutes,
      ...eventRoutes,
    ];
  } catch {
    return [...staticRoutes, ...articleRoutes];
  }
}