import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAdmin } from "@/lib/calendar-feeds/__tests__/fakeAdmin";

const S1 = "11111111-1111-4111-8111-111111111111";
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let admin: FakeAdmin;
let signedIn: { id: string } | null;
const revalidated: string[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedIn } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidated.push(p) }));

import { createOrRotateDancerFeedAction, revokeDancerFeedAction, updateDancerFeedAction } from "../actions";

const env = { ...process.env };
const token = (id: string, user: string, over: Record<string, unknown> = {}) => ({
  id, studio_id: S1, subject_kind: "dancer_account", subject_user_id: user, status: "active", superseded_at: null,
  token_prefix: "abcdef", detail_level: "minimal", include_client_ids: null, created_at: "2026-11-01T00:00:00Z", last_accessed_at: null,
  expires_at: "2099-01-01T00:00:00Z", ...over,
});

beforeEach(() => {
  process.env.CALENDAR_FEEDS_ENABLED = "true";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
  signedIn = { id: U };
  revalidated.length = 0;
  admin = new FakeAdmin({
    studios: [{ id: S1, slug: "demo" }],
    calendar_feed_settings: [{ studio_id: S1, enabled: true }],
    client_account_links: [{ studio_id: S1, user_id: U, client_id: "c1", status: "linked", can_view_schedule: true }],
    clients: [{ id: "c1", studio_id: S1, first_name: "Ann", last_name: "A" }],
    calendar_feed_tokens: [],
  });
  admin.rpcHandlers.calendar_feed_issue_token = () => ({ data: "tok-1", error: null });
  admin.rpcHandlers.calendar_feed_revoke_subject = () => ({ data: 1, error: null });
  admin.rpcHandlers.calendar_feed_set_detail = () => ({ data: true, error: null });
  admin.rpcHandlers.calendar_feed_rate_check = () => ({ data: [{ allowed: true, hits: 1, retry_after_seconds: 1 }], error: null });
});
afterEach(() => {
  process.env = { ...env };
});

const form = (extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.set("studioSlug", "demo");
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
};
const issueCalls = () => admin.rpcCalls.filter((c) => c.fn === "calendar_feed_issue_token");

describe("dancer feed actions", () => {
  it("creates a link: secret returned once, only the hash reaches the database, page revalidated", async () => {
    const state = await createOrRotateDancerFeedAction({}, form({ detailLevel: "standard" }));
    expect(state.error).toBeUndefined();
    expect(state.op).toBe("create");
    expect(state.urls?.https).toMatch(/^https:\/\/app\.example\.test\/calendar\/feed\/[A-Za-z0-9_-]{43}\.ics$/);
    const secret = state.urls!.https.split("/calendar/feed/")[1].replace(".ics", "");
    expect(JSON.stringify(admin.rpcCalls)).not.toContain(secret);
    expect(issueCalls()[0].args).toMatchObject({ p_studio: S1, p_kind: "dancer_account", p_user: U, p_detail: "standard", p_actor: U });
    expect(revalidated).toContain("/portal/demo/calendar");
  });

  it("refuses anonymous users, disabled studios, unknown studios and users without a linked profile", async () => {
    signedIn = null;
    expect((await createOrRotateDancerFeedAction({}, form())).error).toBeTruthy();
    signedIn = { id: U };
    admin.tables.calendar_feed_settings = [{ studio_id: S1, enabled: false }];
    expect((await createOrRotateDancerFeedAction({}, form())).error).toBeTruthy();
    admin.tables.calendar_feed_settings = [{ studio_id: S1, enabled: true }];
    expect((await createOrRotateDancerFeedAction({}, form({ studioSlug: "nope" }))).error).toBeTruthy();
    admin.tables.client_account_links = [];
    expect((await createOrRotateDancerFeedAction({}, form())).error).toBeTruthy();
    expect(issueCalls()).toHaveLength(0);
  });

  it("is off when the environment flag is off, even for an enabled studio", async () => {
    process.env.CALENDAR_FEEDS_ENABLED = "false";
    expect((await createOrRotateDancerFeedAction({}, form())).error).toBeTruthy();
    expect(issueCalls()).toHaveLength(0);
  });

  it("throttles creating links and fails closed when the limiter is unavailable", async () => {
    admin.rpcHandlers.calendar_feed_rate_check = () => ({ data: [{ allowed: false, hits: 11, retry_after_seconds: 30 }], error: null });
    expect((await createOrRotateDancerFeedAction({}, form())).error).toMatch(/Too many/);
    admin.rpcHandlers.calendar_feed_rate_check = () => ({ data: null, error: { message: "down" } });
    expect((await createOrRotateDancerFeedAction({}, form())).error).toMatch(/Too many/);
    expect(issueCalls()).toHaveLength(0);
  });

  it("only offers an overlap when replacing an existing link", async () => {
    await createOrRotateDancerFeedAction({}, form({ keepOldLink: "on" }));
    expect(issueCalls()[0].args.p_overlap_seconds).toBe(0);
    admin.tables.calendar_feed_tokens = [token("old", U)];
    await createOrRotateDancerFeedAction({}, form({ keepOldLink: "on" }));
    expect(issueCalls()[1].args.p_overlap_seconds).toBe(3600);
  });

  it("turn off revokes every live link of the caller (current and overlapping), scoped to studio and user; forged ids are ignored", async () => {
    admin.tables.calendar_feed_tokens = [token("mine", U), token("theirs", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")];
    const state = await revokeDancerFeedAction({}, form({ tokenId: "theirs", subjectUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
    expect(state.message).toMatch(/turned off/);
    const call = admin.rpcCalls.find((c) => c.fn === "calendar_feed_revoke_subject")!;
    expect(call.args).toMatchObject({ p_studio: S1, p_kind: "dancer_account", p_user: U, p_reason: "user" });
    expect(revalidated).toContain("/portal/demo/calendar");
  });

  it("turn off still works when the studio switch was turned off or the profile link was lost (revoking is never blocked)", async () => {
    admin.tables.calendar_feed_settings = [{ studio_id: S1, enabled: false }];
    admin.tables.client_account_links = [];
    const state = await revokeDancerFeedAction({}, form());
    expect(state.error).toBeUndefined();
    expect(admin.rpcCalls.some((c) => c.fn === "calendar_feed_revoke_subject")).toBe(true);
    signedIn = null;
    expect((await revokeDancerFeedAction({}, form())).error).toBeTruthy();
  });

  it("update acts on the caller's own token only and reports a link that changed underneath", async () => {
    admin.tables.calendar_feed_tokens = [token("mine", U), token("theirs", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")];
    const ok = await updateDancerFeedAction({}, form({ detailLevel: "standard", tokenId: "theirs" }));
    expect(ok.message).toMatch(/saved/);
    expect(admin.rpcCalls.find((c) => c.fn === "calendar_feed_set_detail")!.args).toMatchObject({ p_token_id: "mine", p_studio: S1, p_subject_user: U, p_detail: "standard" });
    admin.rpcHandlers.calendar_feed_set_detail = () => ({ data: false, error: null });
    expect((await updateDancerFeedAction({}, form({ detailLevel: "standard" }))).error).toMatch(/changed/);
  });

  it("with several profiles an empty choice is refused, not treated as everybody; foreign ids are dropped", async () => {
    admin.tables.client_account_links.push({ studio_id: S1, user_id: U, client_id: "c2", status: "linked", can_view_schedule: true });
    admin.tables.clients.push({ id: "c2", studio_id: S1, first_name: "Kid", last_name: "K" });
    const none = await createOrRotateDancerFeedAction({}, form());
    expect(none.error).toMatch(/at least one/);
    expect(issueCalls()).toHaveLength(0);
    const f = form();
    f.append("includeClientId", "c2");
    f.append("includeClientId", "someone-elses-profile");
    await createOrRotateDancerFeedAction({}, f);
    expect(issueCalls()[0].args.p_include_client_ids).toEqual(["c2"]);
    const all = form();
    all.append("includeClientId", "c1");
    all.append("includeClientId", "c2");
    await createOrRotateDancerFeedAction({}, all);
    expect(issueCalls()[1].args.p_include_client_ids).toBeNull();
  });

  it("returns generic errors when the database fails", async () => {
    admin.rpcHandlers.calendar_feed_issue_token = () => ({ data: null, error: { message: "relation x secret" } });
    const state = await createOrRotateDancerFeedAction({}, form());
    expect(state.error).toBeTruthy();
    expect(state.error).not.toMatch(/relation|secret/);
  });
});
