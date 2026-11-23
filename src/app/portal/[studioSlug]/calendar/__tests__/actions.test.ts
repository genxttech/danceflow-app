import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAdmin } from "@/lib/calendar-feeds/__tests__/fakeAdmin";

const S1 = "11111111-1111-4111-8111-111111111111";
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let admin: FakeAdmin;
let signedIn: { id: string } | null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedIn } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

import { createOrRotateDancerFeedAction, revokeDancerFeedAction, updateDancerFeedAction } from "../actions";

const env = { ...process.env };
beforeEach(() => {
  process.env.CALENDAR_FEEDS_ENABLED = "true";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
  signedIn = { id: U };
  admin = new FakeAdmin({
    studios: [{ id: S1, slug: "demo" }],
    calendar_feed_settings: [{ studio_id: S1, enabled: true }],
    client_account_links: [{ studio_id: S1, user_id: U, client_id: "c1", status: "linked", can_view_schedule: true }],
    clients: [{ id: "c1", studio_id: S1, first_name: "Ann", last_name: "A" }],
    calendar_feed_tokens: [],
  });
  admin.rpcHandlers.calendar_feed_issue_token = () => ({ data: "tok-1", error: null });
  admin.rpcHandlers.calendar_feed_revoke = () => ({ data: true, error: null });
  admin.rpcHandlers.calendar_feed_set_detail = () => ({ data: true, error: null });
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

describe("dancer feed actions", () => {
  it("creates a link: secret returned once, only the hash reaches the database", async () => {
    const state = await createOrRotateDancerFeedAction({}, form({ detailLevel: "standard" }));
    expect(state.error).toBeUndefined();
    expect(state.urls?.https).toMatch(/^https:\/\/app\.example\.test\/calendar\/feed\/[A-Za-z0-9_-]{43}\.ics$/);
    const secret = state.urls!.https.split("/calendar/feed/")[1].replace(".ics", "");
    expect(JSON.stringify(admin.rpcCalls)).not.toContain(secret);
    expect(admin.rpcCalls[0].args).toMatchObject({ p_studio: S1, p_kind: "dancer_account", p_user: U, p_detail: "standard", p_actor: U });
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
    expect(admin.rpcCalls).toHaveLength(0);
  });

  it("is off when the environment flag is off, even for an enabled studio", async () => {
    process.env.CALENDAR_FEEDS_ENABLED = "false";
    expect((await createOrRotateDancerFeedAction({}, form())).error).toBeTruthy();
    expect(admin.rpcCalls).toHaveLength(0);
  });

  it("only offers an overlap when replacing an existing link", async () => {
    await createOrRotateDancerFeedAction({}, form({ keepOldLink: "on" }));
    expect(admin.rpcCalls[0].args.p_overlap_seconds).toBe(0);
    admin.tables.calendar_feed_tokens = [{ id: "old", studio_id: S1, subject_kind: "dancer_account", subject_user_id: U, status: "active", superseded_at: null, token_prefix: "abcdef", detail_level: "minimal", created_at: "2026-11-01T00:00:00Z", expires_at: "2028-01-01T00:00:00Z" }];
    await createOrRotateDancerFeedAction({}, form({ keepOldLink: "on" }));
    expect(admin.rpcCalls[1].args.p_overlap_seconds).toBe(3600);
  });

  it("revoke and update act on the caller's own studio-scoped token only", async () => {
    admin.tables.calendar_feed_tokens = [
      { id: "mine", studio_id: S1, subject_kind: "dancer_account", subject_user_id: U, status: "active", superseded_at: null, token_prefix: "abcdef", detail_level: "minimal", created_at: "2026-11-01T00:00:00Z", expires_at: "2028-01-01T00:00:00Z" },
      { id: "theirs", studio_id: S1, subject_kind: "dancer_account", subject_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "active", superseded_at: null, token_prefix: "zzzzzz", detail_level: "minimal", created_at: "2026-11-01T00:00:00Z", expires_at: "2028-01-01T00:00:00Z" },
    ];
    const forged = form({ tokenId: "theirs" });
    await revokeDancerFeedAction({}, forged);
    expect(admin.rpcCalls[0].args).toMatchObject({ p_token_id: "mine", p_studio: S1, p_subject_user: U });
    await updateDancerFeedAction({}, form({ detailLevel: "standard", tokenId: "theirs" }));
    expect(admin.rpcCalls[1].args).toMatchObject({ p_token_id: "mine", p_studio: S1, p_subject_user: U, p_detail: "standard" });
  });

  it("drops requested profiles the account does not control", async () => {
    admin.tables.client_account_links.push({ studio_id: S1, user_id: U, client_id: "c2", status: "linked", can_view_schedule: true });
    admin.tables.clients.push({ id: "c2", studio_id: S1, first_name: "Kid", last_name: "K" });
    const f = form();
    f.append("includeClientId", "c2");
    f.append("includeClientId", "someone-elses-profile");
    await createOrRotateDancerFeedAction({}, f);
    expect(admin.rpcCalls[0].args.p_include_client_ids).toEqual(["c2"]);
  });

  it("returns generic errors when the database fails", async () => {
    admin.rpcHandlers.calendar_feed_issue_token = () => ({ data: null, error: { message: "relation x secret" } });
    const state = await createOrRotateDancerFeedAction({}, form());
    expect(state.error).toBeTruthy();
    expect(state.error).not.toMatch(/relation|secret/);
  });
});
