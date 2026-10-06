import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createOwnershipFakeSupabase, type Row } from "@/lib/payments/__tests__/ownershipFakes";
import { getStudioRegistrationNotificationEmails, getStudioStaffNotificationEmails } from "@/lib/notifications/studioStaffRecipients";

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

/** GC-S1F: registration notice recipients = owners + admins + front desk of one studio; the shared helper is unchanged. */
describe("getStudioRegistrationNotificationEmails", () => {
  const roles = [
    { studio_id: "studio-1", user_id: "owner", role: "studio_owner", active: true },
    { studio_id: "studio-1", user_id: "admin", role: "studio_admin", active: true },
    { studio_id: "studio-1", user_id: "front", role: "front_desk", active: true },
    { studio_id: "studio-1", user_id: "front-old", role: "front_desk", active: false },
    { studio_id: "studio-1", user_id: "instructor", role: "instructor", active: true },
    { studio_id: "studio-2", user_id: "front-2", role: "front_desk", active: true },
    { studio_id: "studio-2", user_id: "owner-2", role: "studio_owner", active: true },
  ];
  const users = {
    owner: "owner@one.test",
    admin: "admin@one.test",
    front: " Front@One.test ",
    "front-old": "old-front@one.test",
    instructor: "teacher@one.test",
    "front-2": "front@two.test",
    "owner-2": "owner@two.test",
  };

  it("includes the owner, admin and active front desk of this studio only", async () => {
    const { supabase, lookups } = client({ user_studio_roles: roles, studios: [{ id: "studio-1", email: "studio@one.test" }] }, users);
    const emails = await getStudioRegistrationNotificationEmails(supabase, "studio-1");
    expect([...emails].sort()).toEqual(["admin@one.test", "front@one.test", "owner@one.test"]);
    for (const excluded of ["front-old", "instructor", "front-2", "owner-2"]) expect(lookups).not.toContain(excluded);
  });

  it("emails a person once even when several records resolve to the same address", async () => {
    const { supabase } = client(
      { user_studio_roles: roles, studios: [] },
      { ...users, front: "OWNER@one.test" },
    );
    const emails = await getStudioRegistrationNotificationEmails(supabase, "studio-1");
    expect(emails.filter((e) => e === "owner@one.test")).toHaveLength(1);
    expect([...emails].sort()).toEqual(["admin@one.test", "owner@one.test"]);
  });

  it("front desk alone is enough; falls back to the studio contact email only when nobody applicable has an address", async () => {
    const onlyFront = client({ user_studio_roles: roles.filter((r) => r.user_id === "front"), studios: [{ id: "studio-1", email: "studio@one.test" }] }, users);
    await expect(getStudioRegistrationNotificationEmails(onlyFront.supabase, "studio-1")).resolves.toEqual(["front@one.test"]);
    const none = client({ user_studio_roles: roles.filter((r) => r.studio_id === "studio-2"), studios: [{ id: "studio-1", email: "Studio@One.test" }] }, users);
    await expect(getStudioRegistrationNotificationEmails(none.supabase, "studio-1")).resolves.toEqual(["studio@one.test"]);
  });

  it("leaves getStudioStaffNotificationEmails (other call sites) owner/admin only", async () => {
    const { supabase } = client({ user_studio_roles: roles, studios: [] }, users);
    await expect(getStudioStaffNotificationEmails(supabase, "studio-1")).resolves.toEqual(["owner@one.test", "admin@one.test"]);
  });
});
