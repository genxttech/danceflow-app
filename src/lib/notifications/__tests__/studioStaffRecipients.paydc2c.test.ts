import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createOwnershipFakeSupabase, type Row } from "@/lib/payments/__tests__/ownershipFakes";
import { getStudioStaffNotificationEmails } from "@/lib/notifications/studioStaffRecipients";

/** PAY-DC-2C: dispute notice recipients (D6): active owners/admins of one studio, capped, with fallback. */

function client(rows: Record<string, Row[]>, users: Record<string, string | null>) {
  const fake = createOwnershipFakeSupabase(rows);
  const lookups: string[] = [];
  const supabase = {
    ...fake.client,
    auth: {
      admin: {
        getUserById: async (id: string) => {
          lookups.push(id);
          return { data: { user: { email: users[id] ?? null } }, error: null };
        },
      },
    },
  } as unknown as SupabaseClient;
  return { supabase, lookups };
}

describe("getStudioStaffNotificationEmails", () => {
  it("returns only this studio's active owner/admin emails, normalized and de-duplicated", async () => {
    const { supabase, lookups } = client(
      {
        user_studio_roles: [
          { studio_id: "studio-1", user_id: "owner", role: "studio_owner", active: true },
          { studio_id: "studio-1", user_id: "admin", role: "studio_admin", active: true },
          { studio_id: "studio-1", user_id: "admin-dup", role: "studio_admin", active: true },
          { studio_id: "studio-1", user_id: "front", role: "front_desk", active: true },
          { studio_id: "studio-1", user_id: "old-owner", role: "studio_owner", active: false },
          { studio_id: "studio-2", user_id: "other-owner", role: "studio_owner", active: true },
        ],
        studios: [{ id: "studio-1", email: "studio@one.test" }],
      },
      {
        owner: " Owner@One.test ",
        admin: "admin@one.test",
        "admin-dup": "ADMIN@one.test",
        front: "front@one.test",
        "old-owner": "old@one.test",
        "other-owner": "owner@two.test",
      },
    );

    await expect(getStudioStaffNotificationEmails(supabase, "studio-1")).resolves.toEqual([
      "owner@one.test",
      "admin@one.test",
    ]);
    expect(lookups).not.toContain("front");
    expect(lookups).not.toContain("old-owner");
    expect(lookups).not.toContain("other-owner");
  });

  it("caps recipients at 5", async () => {
    const roles = Array.from({ length: 8 }, (_, index) => ({
      studio_id: "studio-1",
      user_id: `u${index}`,
      role: "studio_admin",
      active: true,
    }));
    const users = Object.fromEntries(roles.map((role) => [role.user_id, `${role.user_id}@one.test`]));
    const { supabase } = client({ user_studio_roles: roles, studios: [] }, users);

    await expect(getStudioStaffNotificationEmails(supabase, "studio-1")).resolves.toHaveLength(5);
  });

  it("falls back to the studio's own email when no staff address exists", async () => {
    const { supabase } = client(
      {
        user_studio_roles: [{ studio_id: "studio-1", user_id: "owner", role: "studio_owner", active: true }],
        studios: [
          { id: "studio-1", email: "Contact@One.test" },
          { id: "studio-2", email: "contact@two.test" },
        ],
      },
      { owner: null },
    );

    await expect(getStudioStaffNotificationEmails(supabase, "studio-1")).resolves.toEqual(["contact@one.test"]);
  });

  it("returns no recipients when neither staff nor studio email exists", async () => {
    const { supabase } = client({ user_studio_roles: [], studios: [{ id: "studio-1", email: null }] }, {});
    await expect(getStudioStaffNotificationEmails(supabase, "studio-1")).resolves.toEqual([]);
  });
});
