import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveCommerceThumbnail } from "@/lib/commerce/thumbnail";

type Params = Promise<{ catalogItemId: string }>;

type StudioRow = {
  name: string | null;
  public_name: string | null;
  subscription_status: string | null;
  stripe_connect_charges_enabled: boolean | null;
};

type DigitalContentRow = {
  instructor_name: string | null;
  skill_level: string | null;
  dance_style: string | null;
  duration_seconds: number | null;
  summary: string | null;
  status: string | null;
  release_at: string | null;
  mux_upload_status: string | null;
  mux_playback_id: string | null;
};

type CatalogItemRow = {
  id: string;
  studio_id: string;
  name: string;
  description: string | null;
  item_type: string;
  price: number | string;
  currency: string;
  image_url: string | null;
  active: boolean;
  published: boolean;
  marketplace_visible: boolean;
  studios: StudioRow | StudioRow[] | null;
  commerce_digital_content: DigitalContentRow | DigitalContentRow[] | null;
};

function one<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function money(value: number | string, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number(value ?? 0));
}

const siteUrl = "https://www.idanceflow.com";
const defaultOgImage = `${siteUrl}/brand/danceflow-og-1200x630.png`;

// Shared by generateMetadata and the page so a request runs the item query once.
// Returns null unless the item passes every public marketplace visibility check.
const loadPublicMarketplaceItem = cache(async (catalogItemId: string) => {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("commerce_catalog_items")
    .select(`
      id,
      studio_id,
      name,
      description,
      item_type,
      price,
      currency,
      image_url,
      active,
      published,
      marketplace_visible,
      studios:studio_id (
        name,
        public_name,
        subscription_status,
        stripe_connect_charges_enabled
      ),
      commerce_digital_content (
        instructor_name,
        skill_level,
        dance_style,
        duration_seconds,
        summary,
        status,
        release_at,
        mux_upload_status,
        mux_playback_id
      )
    `)
    .eq("id", catalogItemId)
    .maybeSingle<CatalogItemRow>();

  const studio = one(data?.studios);
  const content = one(data?.commerce_digital_content);
  const available =
    !error &&
    data?.active === true &&
    data?.published === true &&
    data?.marketplace_visible === true &&
    ["digital_video", "video_series"].includes(data?.item_type ?? "") &&
    ["active", "trialing"].includes(studio?.subscription_status ?? "") &&
    studio?.stripe_connect_charges_enabled === true &&
    content?.status === "published" &&
    (!content.release_at ||
      new Date(content.release_at).getTime() <= Date.now()) &&
    (data?.item_type === "video_series" ||
      content?.mux_upload_status === "ready");

  if (!available || !data) return null;
  return { admin, data, studio, content };
});

function absoluteUrl(value: string | null | undefined) {
  if (!value) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return value.startsWith("/") ? `${siteUrl}${value}` : `${siteUrl}/${value}`;
}

function itemDescription(text: string | null | undefined, studioName: string) {
  const clean = text?.replace(/\s+/g, " ").trim();
  if (clean) return clean.length > 160 ? `${clean.slice(0, 157).trimEnd()}...` : clean;
  return `Digital dance instruction from ${studioName} on DanceFlow.`;
}

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { catalogItemId } = await params;
  const item = await loadPublicMarketplaceItem(catalogItemId);

  if (!item) {
    return {
      title: "Marketplace",
      robots: { index: false, follow: true },
    };
  }

  const { data, studio, content } = item;
  const studioName = studio?.public_name?.trim() || studio?.name || "a dance studio";
  const title = data.name;
  const description = itemDescription(content?.summary || data.description, studioName);
  const canonicalUrl = `${siteUrl}/marketplace/${data.id}`;
  // Only the catalog item's own image; generated video thumbnails need a signed lookup.
  const imageUrl = absoluteUrl(data.image_url) || defaultOgImage;

  return {
    title: `${title} by ${studioName}`,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: `${title} | DanceFlow Marketplace`,
      description,
      url: canonicalUrl,
      siteName: "DanceFlow",
      type: "website",
      images: [
        {
          url: imageUrl,
          alt: `${title} on DanceFlow`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | DanceFlow Marketplace`,
      description,
      images: [imageUrl],
    },
  };
}

export default async function MarketplaceItemPage({
  params,
}: {
  params: Params;
}) {
  const { catalogItemId } = await params;
  const item = await loadPublicMarketplaceItem(catalogItemId);

  if (!item) notFound();

  const { admin, data, studio, content } = item;

  const thumbnail = await resolveCommerceThumbnail({
    supabase: admin,
    item: {
      id: data.id,
      item_type: data.item_type,
      image_url: data.image_url,
      commerce_digital_content: content,
    },
  });

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10 sm:px-6 lg:px-8">
      <article className="mx-auto max-w-5xl overflow-hidden rounded-[36px] border border-slate-200 bg-white shadow-sm">
        <div className="aspect-video bg-[linear-gradient(135deg,#ede9fe,#fdf2f8)]">
          {thumbnail.imageUrl ? (
            <img
              src={thumbnail.imageUrl}
              alt={`${data.name} cover`}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-lg font-semibold text-violet-700">
              DanceFlow Digital Learning
            </div>
          )}
        </div>
        <div className="p-6 md:p-8">
          <Link
            href="/marketplace"
            className="text-sm font-semibold text-[#6B21A8] hover:underline"
          >
            Back to Marketplace
          </Link>
          <p className="mt-6 text-xs font-bold uppercase tracking-[0.18em] text-violet-700">
            {data.item_type === "video_series"
              ? "Video series"
              : "Digital video"}
          </p>
          <h1 className="mt-3 break-words text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
            {data.name}
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            {studio?.public_name?.trim() || studio?.name || "Dance studio"}
          </p>
          <p className="mt-5 max-w-3xl text-base leading-7 text-slate-700">
            {content?.summary || data.description || "Studio-created digital dance instruction."}
          </p>
          <div className="mt-6 flex flex-wrap gap-2 text-sm">
            {content?.instructor_name ? (
              <span className="rounded-full bg-slate-100 px-3 py-1.5">
                Instructor: {content.instructor_name}
              </span>
            ) : null}
            {content?.dance_style ? (
              <span className="rounded-full bg-slate-100 px-3 py-1.5">
                {content.dance_style}
              </span>
            ) : null}
            {content?.skill_level ? (
              <span className="rounded-full bg-slate-100 px-3 py-1.5 capitalize">
                {content.skill_level.replaceAll("_", " ")}
              </span>
            ) : null}
            {content?.duration_seconds ? (
              <span className="rounded-full bg-slate-100 px-3 py-1.5">
                {Math.max(1, Math.round(Number(content.duration_seconds) / 60))} min
              </span>
            ) : null}
          </div>
          <div className="mt-8 flex flex-col gap-3 rounded-3xl bg-violet-50 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm text-slate-600">Price</p>
              <p className="mt-1 text-3xl font-semibold text-slate-950">
                {money(data.price, String(data.currency ?? "USD").toUpperCase())}
              </p>
            </div>
            <div className="max-w-md text-sm leading-6 text-slate-600">
              <p className="font-semibold text-slate-800">Purchase in the DanceFlow student app</p>
              <p className="mt-1">
                Sign in, open Marketplace, and select this item. Access appears
                in Learn and the receipt appears in Wallet after payment.
              </p>
            </div>
          </div>
        </div>
      </article>
    </main>
  );
}
