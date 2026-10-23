import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * W-3 public SEO: the sitemap lists every Discover hub and the marketplace, and the public
 * organizer and marketplace item pages emit their own metadata, but only for publicly visible
 * records. Anything not public gets noindex instead of inheriting the indexable site default.
 */
const state = vi.hoisted(() => ({
  serverRow: null as Record<string, unknown> | null,
  adminRow: null as Record<string, unknown> | null,
  serverThrows: false,
}));

function query(result: () => { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "not", "order", "in", "gte", "limit"]) {
    builder[method] = () => builder;
  }
  builder.single = async () => result();
  builder.maybeSingle = async () => result();
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (state.serverThrows) throw new Error("no database in unit tests");
    return {
      from: () =>
        query(() =>
          state.serverRow ? { data: state.serverRow, error: null } : { data: null, error: { message: "not found" } },
        ),
    };
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => query(() => ({ data: state.adminRow, error: null })),
  }),
}));

vi.mock("@/lib/mux/server", () => ({
  createSignedMuxThumbnailUrl: () => ({ url: "https://image.mux.com/signed.jpg" }),
}));

const SITE = "https://www.idanceflow.com";
const DEFAULT_OG = `${SITE}/brand/danceflow-og-1200x630.png`;

beforeEach(() => {
  state.serverRow = null;
  state.adminRow = null;
  state.serverThrows = false;
});

describe("sitemap", () => {
  it("lists the Discover hubs and the marketplace alongside the existing routes", async () => {
    state.serverThrows = true;
    const { default: sitemap } = await import("../sitemap");
    const entries = await sitemap();
    const byUrl = new Map(entries.map((entry) => [entry.url, entry]));

    for (const path of [
      "/discover",
      "/discover/studios",
      "/discover/events",
      "/discover/classes",
      "/discover/partners",
      "/discover/jobs",
      "/marketplace",
    ]) {
      const entry = byUrl.get(`${SITE}${path}`);
      expect(entry, path).toBeDefined();
      expect(entry!.priority).toBeGreaterThanOrEqual(0.7);
      expect(entry!.priority).toBeLessThan(1);
    }

    expect(byUrl.get(`${SITE}/`)?.priority).toBe(1);
    expect(new Set(entries.map((entry) => entry.url)).size).toBe(entries.length);
  });
});

const organizer = {
  id: "org-1",
  name: "Desert Swing Society",
  slug: "desert-swing",
  description: "Monthly   West Coast Swing\nsocials and workshops.",
  contact_email: null,
  contact_phone: null,
  logo_url: "/uploads/logo.png",
  cover_image_url: null,
  website_url: null,
  city: "Phoenix",
  state: "AZ",
  active: true,
};

describe("organizer profile metadata", () => {
  const params = (slug: string) => Promise.resolve({ slug });

  it("uses the organizer's name, description, canonical URL and image", async () => {
    state.serverRow = organizer;
    const { generateMetadata } = await import("../organizers/[slug]/page");
    const metadata = await generateMetadata({ params: params("desert-swing") });

    expect(metadata.title).toBe("Desert Swing Society");
    expect(metadata.description).toBe("Monthly West Coast Swing socials and workshops.");
    expect(metadata.alternates?.canonical).toBe(`${SITE}/organizers/desert-swing`);
    expect(metadata.openGraph?.url).toBe(`${SITE}/organizers/desert-swing`);
    expect(metadata.openGraph?.images).toEqual([
      { url: `${SITE}/uploads/logo.png`, alt: "Desert Swing Society on DanceFlow" },
    ]);
    expect(metadata.robots).toBeUndefined();
  });

  it("falls back to a generated description and the default OG image", async () => {
    state.serverRow = { ...organizer, description: "  ", logo_url: null };
    const { generateMetadata } = await import("../organizers/[slug]/page");
    const metadata = await generateMetadata({ params: params("desert-swing") });

    expect(metadata.description).toBe("Upcoming dance events from Desert Swing Society in Phoenix, AZ on DanceFlow.");
    expect(metadata.twitter).toMatchObject({ images: [DEFAULT_OG] });
  });

  it("is noindex when the organizer is missing or inactive, or the slug is invalid", async () => {
    const { generateMetadata } = await import("../organizers/[slug]/page");

    expect((await generateMetadata({ params: params("desert-swing") })).robots).toEqual({ index: false, follow: true });
    state.serverRow = organizer;
    const invalid = await generateMetadata({ params: params("../etc") });
    expect(invalid.robots).toEqual({ index: false, follow: true });
    expect(invalid.alternates).toBeUndefined();
  });
});

const catalogItem = {
  id: "item-1",
  studio_id: "studio-1",
  name: "Rumba Basics",
  description: "Learn the box step.",
  item_type: "digital_video",
  price: 19,
  currency: "USD",
  image_url: "https://cdn.example.com/rumba.jpg",
  active: true,
  published: true,
  marketplace_visible: true,
  studios: {
    name: "ConfiDance LLC",
    public_name: "ConfiDance",
    subscription_status: "active",
    stripe_connect_charges_enabled: true,
  },
  commerce_digital_content: {
    instructor_name: null,
    skill_level: null,
    dance_style: null,
    duration_seconds: null,
    summary: null,
    status: "published",
    release_at: null,
    mux_upload_status: "ready",
    mux_playback_id: "playback-1",
  },
};

describe("marketplace item metadata", () => {
  const params = (catalogItemId: string) => Promise.resolve({ catalogItemId });

  it("uses the item name, studio, canonical URL and cover image for a public item", async () => {
    state.adminRow = catalogItem;
    const { generateMetadata } = await import("../marketplace/[catalogItemId]/page");
    const metadata = await generateMetadata({ params: params("item-1") });

    expect(metadata.title).toBe("Rumba Basics by ConfiDance");
    expect(metadata.description).toBe("Learn the box step.");
    expect(metadata.alternates?.canonical).toBe(`${SITE}/marketplace/item-1`);
    expect(metadata.openGraph?.images).toEqual([
      { url: "https://cdn.example.com/rumba.jpg", alt: "Rumba Basics on DanceFlow" },
    ]);
    expect(metadata.robots).toBeUndefined();
  });

  it("never uses an expiring signed video thumbnail as the OG image", async () => {
    state.adminRow = { ...catalogItem, image_url: null };
    const { generateMetadata } = await import("../marketplace/[catalogItemId]/page");
    const metadata = await generateMetadata({ params: params("item-1") });

    expect(metadata.twitter).toMatchObject({ images: [DEFAULT_OG] });
  });

  it.each([
    ["missing", null],
    ["not marketplace visible", { ...catalogItem, marketplace_visible: false }],
    ["unpublished", { ...catalogItem, published: false }],
    ["studio not subscribed", { ...catalogItem, studios: { ...catalogItem.studios, subscription_status: "canceled" } }],
    ["not yet released", {
      ...catalogItem,
      commerce_digital_content: { ...catalogItem.commerce_digital_content, release_at: "2999-01-01T00:00:00Z" },
    }],
  ])("is noindex and exposes nothing when the item is %s", async (_label, row) => {
    state.adminRow = row;
    const { generateMetadata } = await import("../marketplace/[catalogItemId]/page");
    const metadata = await generateMetadata({ params: params("item-1") });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.title).toBe("Marketplace");
    expect(metadata.description).toBeUndefined();
    expect(metadata.openGraph).toBeUndefined();
  });
});
