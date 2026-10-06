import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * GC-3.4A: the public class pages render signed out (no auth call is ever made, the only data access is the public read
 * functions), show truthful states, and never offer a mutating action.
 */

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, series: [] as Array<Record<string, unknown>>, rpcCalls: [] as string[], getUser: vi.fn() }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/components/public/PublicShell", () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: h.getUser },
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { slug: "salsa-house", name: "Salsa House", public_name: "Salsa House", city: "Austin", state: "TX", subscription_status: "active" }, error: null }) }) }) }),
    }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push(name);
      if (name === "public_group_class_series") return { data: h.series, error: null };
      const id = args.p_appointment_id as string | null;
      return { data: id ? h.rows.filter((r) => r.appointment_id === id) : h.rows, error: null };
    },
  }),
}));

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "33333333-3333-4333-8333-333333333333";
const ROOT = "22222222-2222-4222-8222-222222222222";
const SUCC = "44444444-4444-4444-8444-444444444444";

const row = (over: Record<string, unknown> = {}) => ({
  appointment_id: ID, series_id: ROOT, series_root_id: ROOT, studio_slug: "salsa-house", studio_name: "Salsa House", studio_logo_url: null,
  studio_city: "Austin", studio_state: "TX", time_zone: "America/New_York", title: "Salsa Level 1",
  starts_at: "2030-11-02T22:00:00+00:00", ends_at: "2030-11-02T23:00:00+00:00", instructor_name: "Pat Public", location_label: "Main Floor",
  capacity: 10, spots_remaining: 4, availability: "available", enrollment_state: "open", public_state: "upcoming", ...over,
});

const html = (node: unknown) => renderToStaticMarkup(node as never);

beforeEach(() => {
  h.rows = [row()];
  h.series = [{ series_root_id: ROOT, studio_slug: "salsa-house", studio_name: "Salsa House", studio_logo_url: null, studio_city: "Austin", studio_state: "TX", time_zone: "America/New_York", title: "Salsa Level 1", upcoming_count: 2 }];
  h.rpcCalls.length = 0;
  h.getUser.mockReset();
});

const detail = (await import("../[appointmentId]/page")).default;
const seriesPage = (await import("../series/[seriesId]/page")).default;
const studioList = (await import("../page")).default;
const discoverList = (await import("@/app/discover/classes/page")).default;
const { default: PublicClassCard } = await import("@/components/public/PublicClassCard");
const { parsePublicGroupClass } = await import("@/lib/public/groupClasses");

describe("class card", () => {
  it("shows what, when, studio, location, instructor, availability and one primary action", () => {
    const out = html(createElement(PublicClassCard, { item: parsePublicGroupClass(row())! }));
    expect(out).toContain("Salsa Level 1");
    expect(out).toContain("Sat, Nov 2, 6:00 PM – 7:00 PM");
    expect(out).toContain("Salsa House");
    expect(out).toContain("Main Floor");
    expect(out).toContain("with Pat Public");
    expect(out).toContain("4 spots left");
    expect(out.match(/<a /g)).toHaveLength(1);
    expect(out).toContain(`href="/studios/salsa-house/classes/${ID}"`);
    expect(out).toContain("View class");
    expect(out).not.toMatch(/sign in|log in|package|membership|funding|price|\$|<form|<button/i);
  });
  it("can omit the studio on a studio page", () => {
    const out = html(createElement(PublicClassCard, { item: parsePublicGroupClass(row())!, showStudio: false }));
    expect(out).not.toContain("Salsa House");
  });
});

describe("occurrence detail page", () => {
  it("renders signed out without ever asking for a user, via the public read function only", async () => {
    const out = html(await detail({ params: Promise.resolve({ studioSlug: "salsa-house", appointmentId: ID }) }));
    expect(h.getUser).not.toHaveBeenCalled();
    expect(h.rpcCalls).toEqual(["public_group_class_occurrences"]);
    for (const text of ["Salsa Level 1", "Salsa House", "Austin, TX", "Main Floor", "Pat Public", "4 spots left", "Up to 10 dancers", "Sat, Nov 2"]) expect(out).toContain(text);
    expect(out).toContain("See all dates");
    expect(out).toContain(`/studios/salsa-house/classes/series/${ROOT}`);
  });
  it("offers no mutating control and no payment language; the registration placeholder is honest", async () => {
    const out = html(await detail({ params: Promise.resolve({ studioSlug: "salsa-house", appointmentId: ID }) }));
    expect(out).toContain("Registration options coming next");
    expect(out).not.toMatch(/<form|<button|type="submit"|checkout|pay now|buy|price|\$\d/i);
  });
  it("a cancelled class says so and drops the registration placeholder", async () => {
    h.rows = [row({ public_state: "cancelled", enrollment_state: "closed" })];
    const out = html(await detail({ params: Promise.resolve({ studioSlug: "salsa-house", appointmentId: ID }) }));
    expect(out).toContain("This class has been cancelled.");
    expect(out).toContain("Cancelled");
    expect(out).not.toContain("Registration options coming next");
  });
  it("a past class says so", async () => {
    h.rows = [row({ public_state: "past", enrollment_state: "closed" })];
    const out = html(await detail({ params: Promise.resolve({ studioSlug: "salsa-house", appointmentId: ID }) }));
    expect(out).toContain("This class has already taken place.");
  });
  it("a full class shows Class full", async () => {
    h.rows = [row({ availability: "full", spots_remaining: 0, enrollment_state: "full" })];
    expect(html(await detail({ params: Promise.resolve({ studioSlug: "salsa-house", appointmentId: ID }) }))).toContain("Class full");
  });
  it("a hidden / unknown / invalid id is not found", async () => {
    h.rows = [];
    await expect(detail({ params: Promise.resolve({ studioSlug: "salsa-house", appointmentId: ID }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(detail({ params: Promise.resolve({ studioSlug: "salsa-house", appointmentId: "nope" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("a wrong or outdated studio slug is corrected by redirect to the canonical path (id is identity)", async () => {
    await expect(detail({ params: Promise.resolve({ studioSlug: "old-name", appointmentId: ID }) })).rejects.toThrow(`NEXT_REDIRECT:/studios/salsa-house/classes/${ID}`);
  });
});

describe("series page", () => {
  it("lists upcoming dates, each linking to its own occurrence id", async () => {
    h.rows = [row(), row({ appointment_id: ID2, starts_at: "2030-11-09T23:00:00+00:00", ends_at: "2030-11-10T00:00:00+00:00", series_id: SUCC })];
    const out = html(await seriesPage({ params: Promise.resolve({ studioSlug: "salsa-house", seriesId: ROOT }) }));
    expect(h.getUser).not.toHaveBeenCalled();
    expect(out).toContain("Upcoming dates");
    expect(out).toContain(`/studios/salsa-house/classes/${ID}`);
    expect(out).toContain(`/studios/salsa-house/classes/${ID2}`);
    // 6 PM local on both sides of the DST end
    expect((out.match(/6:00 PM – 7:00 PM/g) ?? []).length).toBe(2);
  });
  it("a successor-series id redirects to the lineage root", async () => {
    await expect(seriesPage({ params: Promise.resolve({ studioSlug: "salsa-house", seriesId: SUCC }) })).rejects.toThrow(`NEXT_REDIRECT:/studios/salsa-house/classes/series/${ROOT}`);
  });
  it("an unknown or hidden series is not found; an empty series says so", async () => {
    h.series = [];
    await expect(seriesPage({ params: Promise.resolve({ studioSlug: "salsa-house", seriesId: ROOT }) })).rejects.toThrow("NEXT_NOT_FOUND");
    h.series = [{ series_root_id: ROOT, studio_slug: "salsa-house", studio_name: "Salsa House", time_zone: "America/New_York", title: "Salsa", upcoming_count: 0 }];
    h.rows = [];
    expect(html(await seriesPage({ params: Promise.resolve({ studioSlug: "salsa-house", seriesId: ROOT }) }))).toContain("no upcoming dates");
  });
});

describe("listings", () => {
  it("studio listing renders cards for the studio and an empty state", async () => {
    const out = html(await studioList({ params: Promise.resolve({ studioSlug: "salsa-house" }) }));
    expect(out).toContain("Classes at Salsa House");
    expect(out).toContain("Salsa Level 1");
    h.rows = [];
    expect(html(await studioList({ params: Promise.resolve({ studioSlug: "salsa-house" }) }))).toContain("No upcoming classes are listed right now");
  });
  it("global listing is labelled Classes, separate from Events, and signed-out friendly", async () => {
    const out = html(await discoverList());
    expect(h.getUser).not.toHaveBeenCalled();
    expect(out).toContain("Find a dance class");
    expect(out).toContain('href="/discover/events"');
    h.rows = [];
    expect(html(await discoverList())).toContain("No upcoming classes are listed yet");
  });
});

describe("source guarantees", () => {
  const files = [
    "src/app/studios/[studioSlug]/classes/page.tsx",
    "src/app/studios/[studioSlug]/classes/[appointmentId]/page.tsx",
    "src/app/studios/[studioSlug]/classes/series/[seriesId]/page.tsx",
    "src/app/discover/classes/page.tsx",
    "src/components/public/PublicClassCard.tsx",
  ];
  it("no page uses the admin client, a server action, an appointments table read or the legacy events model", () => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/createAdminClient|"use server"|from\("appointments"\)|from\("events"\)|event_type|self_enroll|selfEnroll/);
    }
  });
  it("discovery hub and sub navigation link to Classes", () => {
    expect(readFileSync("src/app/discover/page.tsx", "utf8")).toContain('"/discover/classes"');
    expect(readFileSync("src/components/public/DiscoverSubNav.tsx", "utf8")).toContain('"/discover/classes"');
  });
});
