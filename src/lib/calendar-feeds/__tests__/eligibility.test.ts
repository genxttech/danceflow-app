import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isSubjectEligible, WORKSPACE_ALLOWED_STATUSES } from "../eligibility";
import type { FeedSubject } from "../events";
import { FakeAdmin } from "./fakeAdmin";

const NOW = new Date("2026-12-01T12:00:00Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const subject = (subjectKind: FeedSubject["subjectKind"]): FeedSubject => ({ studioId: S1, subjectKind, subjectUserId: U, detailLevel: "minimal", includeClientIds: null });
const world = (studioStatus = "active") => new FakeAdmin({ studios: [{ id: S1, subscription_status: studioStatus }], user_account_status: [] });

describe("feed subject eligibility", () => {
  it("allows an active account (with or without a status row)", async () => {
    expect(await isSubjectEligible(world(), subject("staff"), NOW)).toBe(true);
    const admin = world();
    admin.tables.user_account_status = [{ user_id: U, status: "active" }];
    expect(await isSubjectEligible(admin, subject("dancer_account"), NOW)).toBe(true);
  });

  it("denies a banned, missing, deactivated or pending-deletion account", async () => {
    const banned = world();
    banned.users[U] = { id: U, banned_until: "2099-01-01T00:00:00Z" };
    expect(await isSubjectEligible(banned, subject("staff"), NOW)).toBe(false);
    const expiredBan = world();
    expiredBan.users[U] = { id: U, banned_until: "2020-01-01T00:00:00Z" };
    expect(await isSubjectEligible(expiredBan, subject("staff"), NOW)).toBe(true);
    const gone = world();
    gone.users[U] = null;
    expect(await isSubjectEligible(gone, subject("dancer_account"), NOW)).toBe(false);
    for (const status of ["deactivated", "pending_deletion"]) {
      const admin = world();
      admin.tables.user_account_status = [{ user_id: U, status }];
      expect(await isSubjectEligible(admin, subject("dancer_account"), NOW)).toBe(false);
      expect(await isSubjectEligible(admin, subject("staff"), NOW)).toBe(false);
    }
  });

  it("staff feeds follow the workspace subscription; dancer schedule feeds do not", async () => {
    for (const status of ["past_due", "canceled", "unpaid", "paused", ""]) {
      expect(await isSubjectEligible(world(status), subject("staff"), NOW)).toBe(false);
      expect(await isSubjectEligible(world(status), subject("dancer_account"), NOW)).toBe(true);
    }
    expect(await isSubjectEligible(world("trialing"), subject("staff"), NOW)).toBe(true);
  });

  it("throws (never allows) when a check cannot be performed", async () => {
    const down = world();
    down.authError = { status: 500 };
    await expect(isSubjectEligible(down, subject("staff"), NOW)).rejects.toThrow();
  });

  it("keeps the same allowed workspace statuses as the app", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/auth/studio.ts"), "utf8");
    const body = source.slice(source.indexOf("export function isWorkspaceAccessAllowedStatus")).split("\n}")[0];
    expect([...body.matchAll(/status === "(\w+)"/g)].map((m) => m[1])).toEqual(WORKSPACE_ALLOWED_STATUSES);
  });
});
