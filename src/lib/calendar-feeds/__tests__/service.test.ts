/* eslint-disable @typescript-eslint/no-explicit-any -- test env tweak */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowMint, feedBaseUrl, feedUrls, feedsEnabledForStudio, getFeedStatus, isUuid, issueFeed, listStaffFeeds, revokeAllStudioFeeds, revokeFeed, revokeSubjectFeeds, setFeedDetail } from "../service";
import { parseDetail, pickIncludedProfiles, resolveDancerProfiles, resolveSelection } from "../authz";
import { hashFeedSecret, parseFeedSecret } from "../token";
import { FakeAdmin } from "./fakeAdmin";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const env = { ...process.env };
beforeEach(() => {
  process.env.CALENDAR_FEEDS_ENABLED = "true";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
});
afterEach(() => {
  process.env = { ...env };
});

describe("service", () => {
  it("issueFeed sends only the hash to the database and returns the secret once", async () => {
    const admin = new FakeAdmin();
    admin.rpcHandlers.calendar_feed_issue_token = () => ({ data: "token-id-1", error: null });
    const issued = await issueFeed(admin, { studioId: S1, kind: "dancer_account", userId: U, detail: "minimal", includeClientIds: null, actorId: U, origin: "https://app.example.test" });
    const secret = parseFeedSecret(issued.urls.https.split("/calendar/feed/")[1]);
    expect(secret).not.toBeNull();
    const args = admin.rpcCalls[0].args;
    expect(args.p_token_hash).toBe(hashFeedSecret(secret!));
    expect(JSON.stringify(args)).not.toContain(secret!);
    expect(args.p_prefix).toBe(secret!.slice(0, 6));
    expect(issued.urls.webcal.startsWith("webcal://app.example.test/calendar/feed/")).toBe(true);
    expect(issued.tokenId).toBe("token-id-1");
  });

  it("issueFeed fails with a generic error (no database text)", async () => {
    const admin = new FakeAdmin();
    admin.rpcHandlers.calendar_feed_issue_token = () => ({ data: null, error: { message: "calendar feeds are not enabled; secret detail" } });
    await expect(issueFeed(admin, { studioId: S1, kind: "staff", userId: U, detail: "minimal", includeClientIds: null, actorId: U, origin: "https://x.test" })).rejects.toThrow(/Could not create/);
    await expect(issueFeed(admin, { studioId: S1, kind: "staff", userId: U, detail: "minimal", includeClientIds: null, actorId: U, origin: "https://x.test" })).rejects.not.toThrow(/secret detail/);
  });

  it("revoke and set_detail always pass the studio (and subject) so the database can guard tenants", async () => {
    const admin = new FakeAdmin();
    admin.rpcHandlers.calendar_feed_revoke = () => ({ data: true, error: null });
    admin.rpcHandlers.calendar_feed_set_detail = () => ({ data: true, error: null });
    admin.rpcHandlers.calendar_feed_revoke_studio = () => ({ data: 3, error: null });
    expect(await revokeFeed(admin, { tokenId: "t", studioId: S1, subjectUserId: U, reason: "user", actorId: U, actorKind: "user" })).toBe(true);
    expect(await setFeedDetail(admin, { tokenId: "t", studioId: S1, subjectUserId: U, detail: "standard", includeClientIds: null, actorId: U })).toBe(true);
    expect(await revokeAllStudioFeeds(admin, { studioId: S1, actorId: U })).toBe(3);
    expect(admin.rpcCalls[0].args).toMatchObject({ p_studio: S1, p_subject_user: U, p_reason: "user" });
    expect(admin.rpcCalls[1].args).toMatchObject({ p_studio: S1, p_subject_user: U });
    expect(admin.rpcCalls[2].args).toMatchObject({ p_studio: S1, p_reason: "incident" });
  });

  it("getFeedStatus and listStaffFeeds never select the token hash and filter by studio", async () => {
    const admin = new FakeAdmin({
      calendar_feed_tokens: [
        { id: "a", studio_id: S1, subject_kind: "staff", subject_user_id: U, status: "active", superseded_at: null, token_hash: "h".repeat(64), token_prefix: "abcdef", detail_level: "minimal", include_client_ids: null, created_at: "2026-11-01T00:00:00Z", last_accessed_at: null, expires_at: "2028-11-01T00:00:00Z" },
        { id: "b", studio_id: S2, subject_kind: "staff", subject_user_id: U, status: "active", superseded_at: null, token_hash: "i".repeat(64), token_prefix: "zzzzzz", detail_level: "standard", include_client_ids: null, created_at: "2026-11-01T00:00:00Z", last_accessed_at: null, expires_at: "2028-11-01T00:00:00Z" },
      ],
      instructors: [{ user_id: U, studio_id: S1, first_name: "Sam", last_name: "Lee" }],
    });
    const status = await getFeedStatus(admin, S1, "staff", U);
    expect(status?.id).toBe("a");
    expect(JSON.stringify(status)).not.toContain("hhhh");
    const list = await listStaffFeeds(admin, S1);
    expect(list.map((r) => r.id)).toEqual(["a"]);
    expect(list[0].name).toBe("Sam Lee");
    for (const q of admin.queries) {
      expect(q.select ?? "").not.toContain("token_hash");
      expect(q.filters.some((f) => f.col === "studio_id" && f.val === S1)).toBe(true);
    }
  });

  it("feeds are available only when the env flag AND the studio switch are on", async () => {
    const admin = new FakeAdmin({ calendar_feed_settings: [{ studio_id: S1, enabled: true }, { studio_id: S2, enabled: false }] });
    expect(await feedsEnabledForStudio(admin, S1)).toBe(true);
    expect(await feedsEnabledForStudio(admin, S2)).toBe(false);
    expect(await feedsEnabledForStudio(admin, "33333333-3333-4333-8333-333333333333")).toBe(false);
    process.env.CALENDAR_FEEDS_ENABLED = "false";
    expect(await feedsEnabledForStudio(admin, S1)).toBe(false);
  });

  it("builds URLs only from a configured https origin", () => {
    expect(feedBaseUrl()).toBe("https://app.example.test");
    process.env.NEXT_PUBLIC_APP_URL = "http://evil.test";
    process.env.NEXT_PUBLIC_SITE_URL = "";
    expect(feedBaseUrl()).toBeNull();
    expect(feedUrls("https://a.test", "S").webcal).toBe("webcal://a.test/calendar/feed/S.ics");
  });
});

describe("authz helpers", () => {
  it("resolveDancerProfiles returns only linked, schedule-visible profiles of this studio", async () => {
    const admin = new FakeAdmin({
      client_account_links: [
        { studio_id: S1, user_id: U, client_id: "c1", status: "linked", can_view_schedule: true },
        { studio_id: S1, user_id: U, client_id: "c2", status: "linked", can_view_schedule: false },
        { studio_id: S1, user_id: U, client_id: "c3", status: "invited", can_view_schedule: true },
        { studio_id: S2, user_id: U, client_id: "c4", status: "linked", can_view_schedule: true },
      ],
      clients: [
        { id: "c1", studio_id: S1, first_name: "Ann", last_name: "A" },
        { id: "c4", studio_id: S2, first_name: "Other", last_name: "Studio" },
      ],
    });
    expect((await resolveDancerProfiles(admin, S1, U)).map((p) => p.id)).toEqual(["c1"]);
  });

  it("pickIncludedProfiles drops ids the account may not use and maps 'all' to null", () => {
    expect(pickIncludedProfiles(["x", "c1"], ["c1", "c2"])).toEqual(["c1"]);
    expect(pickIncludedProfiles(["x"], ["c1", "c2"])).toBeNull();
    expect(pickIncludedProfiles(["c1", "c2"], ["c1", "c2"])).toBeNull();
    expect(pickIncludedProfiles([], ["c1"])).toBeNull();
  });

  it("parseDetail defaults to minimal", () => {
    expect(parseDetail("standard")).toBe("standard");
    expect(parseDetail("everything")).toBe("minimal");
    expect(parseDetail(null)).toBe("minimal");
  });
});

describe("service: review hardening", () => {
  it("an expired token is not reported as on", async () => {
    const row = (expires: string) => ({ id: "a", studio_id: S1, subject_kind: "staff", subject_user_id: U, status: "active", superseded_at: null, token_prefix: "abcdef", detail_level: "minimal", include_client_ids: null, created_at: "2026-11-01T00:00:00Z", last_accessed_at: null, expires_at: expires });
    expect(await getFeedStatus(new FakeAdmin({ calendar_feed_tokens: [row("2099-01-01T00:00:00Z")] }), S1, "staff", U)).not.toBeNull();
    expect(await getFeedStatus(new FakeAdmin({ calendar_feed_tokens: [row("2020-01-01T00:00:00Z")] }), S1, "staff", U)).toBeNull();
    const list = await listStaffFeeds(new FakeAdmin({ calendar_feed_tokens: [row("2020-01-01T00:00:00Z")] }), S1);
    expect(list).toHaveLength(0);
  });

  it("revokeSubjectFeeds passes studio, kind and subject and reports the count", async () => {
    const admin = new FakeAdmin();
    admin.rpcHandlers.calendar_feed_revoke_subject = () => ({ data: 2, error: null });
    expect(await revokeSubjectFeeds(admin, { studioId: S1, kind: "dancer_account", subjectUserId: U, reason: "user", actorId: U, actorKind: "user" })).toBe(2);
    expect(admin.rpcCalls[0].args).toMatchObject({ p_studio: S1, p_kind: "dancer_account", p_user: U });
    admin.rpcHandlers.calendar_feed_revoke_subject = () => ({ data: null, error: { message: "x" } });
    await expect(revokeSubjectFeeds(admin, { studioId: S1, kind: "staff", subjectUserId: U, reason: "admin", actorId: U, actorKind: "admin" })).rejects.toThrow(/Could not/);
  });

  it("allowMint is per person, hashed, and fails closed", async () => {
    const admin = new FakeAdmin();
    admin.rpcHandlers.calendar_feed_rate_check = () => ({ data: [{ allowed: true, hits: 1, retry_after_seconds: 1 }], error: null });
    expect(await allowMint(admin, U)).toBe(true);
    expect(String(admin.rpcCalls[0].args.p_key)).not.toContain(U);
    admin.rpcHandlers.calendar_feed_rate_check = () => ({ data: [{ allowed: false }], error: null });
    expect(await allowMint(admin, U)).toBe(false);
    admin.rpcHandlers.calendar_feed_rate_check = () => ({ data: null, error: { message: "x" } });
    expect(await allowMint(admin, U)).toBe(false);
  });

  it("isUuid and the production-only localhost rule", () => {
    expect(isUuid(U)).toBe(true);
    expect(isUuid("nope")).toBe(false);
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    expect(feedBaseUrl()).toBe("http://localhost:3000");
    (process.env as any).NODE_ENV = "production";
    expect(feedBaseUrl()).toBeNull();
  });

  it("resolveSelection refuses an empty choice with several profiles and maps all-chosen to null", () => {
    expect(resolveSelection([], ["a", "b"]).ok).toBe(false);
    expect(resolveSelection(["zzz"], ["a", "b"]).ok).toBe(false);
    expect(resolveSelection(["a"], ["a", "b"])).toEqual({ ok: true, includeClientIds: ["a"] });
    expect(resolveSelection(["a", "b"], ["a", "b"])).toEqual({ ok: true, includeClientIds: null });
    expect(resolveSelection([], ["a"])).toEqual({ ok: true, includeClientIds: null });
  });
});
