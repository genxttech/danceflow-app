import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LAUNCH-SEC-2A (#3): tenant RLS writes to organizers/organizer_users are
 * closed, so createOrganizerAction -- their only legitimate writer -- now
 * writes with the service role. This suite proves:
 *   1. the owner + active Organizer plan path still creates the organizer and
 *      the creator's organizer_admin access row, through the admin client;
 *   2. owner authority is re-established from the caller's own active
 *      studio_owner/organizer_owner row for the exact workspace;
 *   3. every denial fires before any admin write, and the tenant client never
 *      writes either table.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const state = vi.hoisted(() => ({
  user: { id: "owner-1" } as { id: string } | null,
  context: { studioId: "studio-1", studioRole: "organizer_owner" } as Record<string, unknown>,
  capabilities: { studioId: "studio-1", isActive: true, planCode: "organizer" } as Record<string, unknown> | null,
  ownerRow: { id: "usr-1" } as { id: string } | null,
  existingOrganizer: null as Record<string, unknown> | null,
  ownerLookups: [] as Array<Record<string, unknown>>,
  adminWrites: [] as Array<{ table: string; op: string; payload: unknown; options?: unknown }>,
  tenantWrites: [] as string[],
}));

vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => state.context }));
vi.mock("@/lib/billing/access", () => ({
  getCurrentWorkspaceCapabilitiesForUser: async () => state.capabilities,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: state.existingOrganizer, error: null }),
        insert: () => {
          state.tenantWrites.push(`${table}.insert`);
          return builder;
        },
        upsert: async () => {
          state.tenantWrites.push(`${table}.upsert`);
          return { error: null };
        },
      };
      return builder;
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = { table };
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        in: (column: string, values: unknown) => {
          filters[column] = values;
          return builder;
        },
        limit: () => builder,
        maybeSingle: async () => {
          state.ownerLookups.push(filters);
          return { data: state.ownerRow, error: null };
        },
        insert: (payload: unknown) => {
          state.adminWrites.push({ table, op: "insert", payload });
          return {
            select: () => ({ single: async () => ({ data: { id: "org-1" }, error: null }) }),
          };
        },
        upsert: async (payload: unknown, options?: unknown) => {
          state.adminWrites.push({ table, op: "upsert", payload, options });
          return { error: null };
        },
      };
      return builder;
    },
  }),
}));

import { createOrganizerAction } from "../actions";

function form() {
  const data = new FormData();
  data.set("name", "Spring Showcase Org");
  data.set("slug", "spring-showcase");
  data.set("active", "on");
  return data;
}

async function run() {
  try {
    return await createOrganizerAction({ error: "" }, form());
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT")) return { redirected: digest.split(";")[2] };
    throw error;
  }
}

beforeEach(() => {
  state.user = { id: "owner-1" };
  state.context = { studioId: "studio-1", studioRole: "organizer_owner" };
  state.capabilities = { studioId: "studio-1", isActive: true, planCode: "organizer" };
  state.ownerRow = { id: "usr-1" };
  state.existingOrganizer = null;
  state.ownerLookups = [];
  state.adminWrites = [];
  state.tenantWrites = [];
});

describe("LAUNCH-SEC-2A createOrganizerAction", () => {
  it("creates the organizer and the creator's organizer_admin row through the service role", async () => {
    const result = await run();
    expect(result).toEqual({ redirected: "/app/organizers" });

    expect(state.ownerLookups).toEqual([
      {
        table: "user_studio_roles",
        user_id: "owner-1",
        studio_id: "studio-1",
        active: true,
        role: ["studio_owner", "organizer_owner"],
      },
    ]);

    expect(state.adminWrites).toHaveLength(2);
    const [organizerInsert, accessUpsert] = state.adminWrites;
    expect(organizerInsert.table).toBe("organizers");
    expect(organizerInsert.payload).toMatchObject({ studio_id: "studio-1", name: "Spring Showcase Org", slug: "spring-showcase", active: true });
    // No billing/payment authority is ever written from the form.
    for (const field of [
      "billing_plan",
      "subscription_status",
      "platform_fee_bps",
      "stripe_customer_id",
      "stripe_subscription_id",
      "stripe_connected_account_id",
    ]) {
      expect(organizerInsert.payload).not.toHaveProperty(field);
    }
    expect(accessUpsert).toEqual({
      table: "organizer_users",
      op: "upsert",
      payload: { organizer_id: "org-1", user_id: "owner-1", role: "organizer_admin", active: true },
      options: { onConflict: "organizer_id,user_id" },
    });
    expect(state.tenantWrites).toEqual([]);
  });

  it.each(["organizer_admin", "studio_admin", "front_desk", "instructor"])(
    "context role %s is denied before any write",
    async (role) => {
      state.context = { studioId: "studio-1", studioRole: role };
      const result = await run();
      expect(result).toEqual({ error: "Only the organizer owner can create or manage the organizer profile." });
      expect(state.adminWrites).toEqual([]);
      expect(state.tenantWrites).toEqual([]);
    },
  );

  it("an organizer_owner context without an owner row for this workspace is denied", async () => {
    state.ownerRow = null;
    const result = await run();
    expect(result).toEqual({ error: "Only the organizer owner can create or manage the organizer profile." });
    expect(state.adminWrites).toEqual([]);
  });

  it("a platform admin without an owner row is not given new write authority", async () => {
    state.context = { studioId: "studio-1", studioRole: "platform_admin" };
    state.ownerRow = null;
    const result = await run();
    expect(result).toEqual({ error: "Only the organizer owner can create or manage the organizer profile." });
    expect(state.adminWrites).toEqual([]);
  });

  it("an inactive Organizer plan is denied before any write", async () => {
    state.capabilities = { studioId: "studio-1", isActive: false, planCode: "organizer" };
    const result = await run();
    expect(result).toEqual({ error: "Organizer features require an active Organizer plan." });
    expect(state.ownerLookups).toEqual([]);
    expect(state.adminWrites).toEqual([]);
  });

  it("a second organizer for the workspace is still refused", async () => {
    state.existingOrganizer = { id: "org-0", name: "Existing", slug: "existing" };
    const result = await run();
    expect(result).toEqual({ error: expect.stringMatching(/already has an organizer profile/) });
    expect(state.adminWrites).toEqual([]);
  });
});
