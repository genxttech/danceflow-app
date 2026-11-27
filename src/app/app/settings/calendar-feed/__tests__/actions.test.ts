import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAdmin } from "@/lib/calendar-feeds/__tests__/fakeAdmin";

const S1 = "11111111-1111-4111-8111-111111111111";
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let admin: FakeAdmin;
let ctx: { studioId: string; userId: string; studioRole: string };

vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => ctx }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { adminRevokeAllFeedsAction, adminRevokeStaffFeedAction, createOrRotateStaffFeedAction, revokeStaffFeedAction, updateStaffFeedAction } from "../actions";

const env = { ...process.env };
beforeEach(() => {
  process.env.CALENDAR_FEEDS_ENABLED = "true";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
  ctx = { studioId: S1, userId: U, studioRole: "instructor" };
  admin = new FakeAdmin({
    calendar_feed_settings: [{ studio_id: S1, enabled: true }],
    instructors: [{ id: "i1", studio_id: S1, user_id: U, active: true }],
    calendar_feed_tokens: [{ id: "t1", studio_id: S1, subject_kind: "staff", subject_user_id: U, status: "active", superseded_at: null, token_prefix: "abcdef", detail_level: "minimal", created_at: "2026-11-01T00:00:00Z", last_accessed_at: null, expires_at: "2099-01-01T00:00:00Z" }],
  });
  admin.rpcHandlers.calendar_feed_issue_token = () => ({ data: "tok", error: null });
  admin.rpcHandlers.calendar_feed_revoke_subject = () => ({ data: 1, error: null });
  admin.rpcHandlers.calendar_feed_revoke_studio = () => ({ data: 4, error: null });
  admin.rpcHandlers.calendar_feed_set_detail = () => ({ data: true, error: null });
  admin.rpcHandlers.calendar_feed_rate_check = () => ({ data: [{ allowed: true, hits: 1, retry_after_seconds: 1 }], error: null });
});
afterEach(() => {
  process.env = { ...env };
});

const form = (extra: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
};

describe("staff feed actions", () => {
  it("an active instructor can create a link (hash only, studio and user from the session, not the form)", async () => {
    const state = await createOrRotateStaffFeedAction({}, form({ studioId: "forged", userId: OTHER, detailLevel: "standard" }));
    expect(state.urls?.https).toMatch(/\/calendar\/feed\/[A-Za-z0-9_-]{43}\.ics$/);
    expect(admin.rpcCalls.find((c) => c.fn === "calendar_feed_issue_token")!.args).toMatchObject({ p_studio: S1, p_user: U, p_kind: "staff", p_detail: "standard" });
  });

  it("refuses staff who are not active instructors and disabled studios", async () => {
    admin.tables.instructors = [{ id: "i1", studio_id: S1, user_id: U, active: false }];
    expect((await createOrRotateStaffFeedAction({}, form())).error).toBeTruthy();
    expect((await updateStaffFeedAction({}, form({ detailLevel: "standard" }))).error).toBeTruthy();
    admin.tables.instructors = [{ id: "i1", studio_id: S1, user_id: U, active: true }];
    admin.tables.calendar_feed_settings = [{ studio_id: S1, enabled: false }];
    expect((await createOrRotateStaffFeedAction({}, form())).error).toBeTruthy();
    expect(admin.rpcCalls.filter((c) => c.fn === "calendar_feed_issue_token")).toHaveLength(0);
  });

  it("turning off one's own link works without the switch or an active instructor row and always targets the caller", async () => {
    admin.tables.calendar_feed_settings = [];
    admin.tables.instructors = [];
    const state = await revokeStaffFeedAction({}, form({ subjectUserId: OTHER }));
    expect(state.message).toMatch(/turned off/);
    expect(admin.rpcCalls.find((c) => c.fn === "calendar_feed_revoke_subject")!.args).toMatchObject({ p_studio: S1, p_kind: "staff", p_user: U, p_reason: "user" });
  });
});

describe("owner/admin actions", () => {
  it("non-managers cannot revoke other people's links or the whole studio", async () => {
    await adminRevokeStaffFeedAction(form({ subjectUserId: OTHER }));
    await adminRevokeAllFeedsAction();
    expect(admin.rpcCalls.filter((c) => c.fn.startsWith("calendar_feed_revoke"))).toHaveLength(0);
  });

  it("a manager revokes a staff member's links scoped to their own studio, even when the switch is off", async () => {
    ctx = { studioId: S1, userId: U, studioRole: "studio_admin" };
    admin.tables.calendar_feed_settings = [];
    await adminRevokeStaffFeedAction(form({ subjectUserId: OTHER }));
    expect(admin.rpcCalls.find((c) => c.fn === "calendar_feed_revoke_subject")!.args).toMatchObject({ p_studio: S1, p_kind: "staff", p_user: OTHER, p_reason: "admin", p_actor_kind: "admin" });
  });

  it("forged non-uuid ids are ignored and database failures never throw out of the action", async () => {
    ctx = { studioId: S1, userId: U, studioRole: "studio_owner" };
    await adminRevokeStaffFeedAction(form({ subjectUserId: "not-a-uuid; drop table" }));
    expect(admin.rpcCalls).toHaveLength(0);
    admin.rpcHandlers.calendar_feed_revoke_subject = () => ({ data: null, error: { message: "boom" } });
    admin.rpcHandlers.calendar_feed_revoke_studio = () => ({ data: null, error: { message: "boom" } });
    await expect(adminRevokeStaffFeedAction(form({ subjectUserId: OTHER }))).resolves.toBeUndefined();
    await expect(adminRevokeAllFeedsAction()).resolves.toBeUndefined();
  });

  it("revoke-all targets only the caller's studio", async () => {
    ctx = { studioId: S1, userId: U, studioRole: "studio_owner" };
    await adminRevokeAllFeedsAction();
    expect(admin.rpcCalls.find((c) => c.fn === "calendar_feed_revoke_studio")!.args).toMatchObject({ p_studio: S1, p_reason: "incident" });
  });
});
