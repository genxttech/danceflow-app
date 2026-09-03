import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

/**
 * H3: choosePortalDestinationAction is the only place that sets the
 * portal_selected_studio_id remembered-studio cookie. Its contract, per the
 * approved H3 plan: the posted field is a studioId ONLY (never a client-
 * supplied clientId); the server re-fetches this user's currently-linked
 * destinations fresh (scoped to the authenticated user.id from
 * supabase.auth.getUser(), never from the request) and verifies the posted
 * studioId is still among them before doing anything; the representative
 * client for that studio is always derived server-side via the same
 * deterministic tie-break automatic routing uses -- never taken from the
 * request.
 */

const STUDIO_A = "studio-a";
const STUDIO_B = "studio-b";
const STUDIO_UNLINKED = "studio-not-linked";
const USER_ID = "user-1";
const CLIENT_SELF = "client-self";
const CLIENT_GUARDIAN = "client-guardian";
const CLIENT_B = "client-b";
const FORGED_CLIENT_ID = "someone-elses-client-id";

function table(rows: Row[]) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

let currentTables: { client_account_links: FakeTable };

function setFixture(rows: Row[]) {
  currentTables = { client_account_links: table(rows) };
  return currentTables;
}

function linkRow(overrides: Partial<Row> = {}): Row {
  return {
    id: `link-${Math.random().toString(36).slice(2)}`,
    user_id: USER_ID,
    studio_id: STUDIO_A,
    client_id: CLIENT_SELF,
    relationship_type: "self",
    is_primary: false,
    status: "linked",
    created_at: "2026-01-01T00:00:00.000Z",
    studios: { slug: "studio-a-slug", name: "Studio A", public_name: null },
    clients: { is_independent_instructor: false },
    ...overrides,
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createFakeEntitlementClient(currentTables),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID } } }),
    },
  }),
}));

const cookieStore = new Map<string, string>();
const setCookieCalls: { name: string; value: string; options: Record<string, unknown> }[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined,
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      setCookieCalls.push({ name, value, options: options ?? {} });
      cookieStore.set(name, value);
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const { choosePortalDestinationAction } = await import("@/app/portal/choose/actions");

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function expectRedirectDigest(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("Expected a redirect (NEXT_REDIRECT) but none occurred.");
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (!digest) throw error;
    return digest;
  }
}

beforeEach(() => {
  cookieStore.clear();
  setCookieCalls.length = 0;
});

describe("choosePortalDestinationAction", () => {
  it("valid posted studioId -> sets the cookie to that studio and redirects to its representative destination", async () => {
    setFixture([
      linkRow({ studio_id: STUDIO_A, client_id: CLIENT_SELF }),
      linkRow({
        studio_id: STUDIO_B,
        client_id: CLIENT_B,
        studios: { slug: "studio-b-slug", name: "Studio B", public_name: null },
      }),
    ]);

    const digest = await expectRedirectDigest(
      choosePortalDestinationAction(formDataFor({ studioId: STUDIO_B })),
    );

    expect(digest).toContain("/portal/studio-b-slug?client=client-b");
    expect(setCookieCalls).toHaveLength(1);
    expect(setCookieCalls[0]).toMatchObject({
      name: "portal_selected_studio_id",
      value: STUDIO_B,
      options: expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
        maxAge: 60 * 60 * 24 * 180,
      }),
    });
  });

  it("resolves the representative client via the deterministic tie-break, not a posted clientId", async () => {
    setFixture([
      linkRow({
        studio_id: STUDIO_A,
        client_id: CLIENT_GUARDIAN,
        relationship_type: "guardian",
        is_primary: false,
        created_at: "2026-01-01T00:00:00.000Z",
      }),
      linkRow({
        studio_id: STUDIO_A,
        client_id: CLIENT_SELF,
        relationship_type: "self",
        is_primary: true,
        created_at: "2026-01-05T00:00:00.000Z",
      }),
    ]);

    // A forged/extraneous clientId in the POST must be completely ignored --
    // the server derives the representative client itself.
    const digest = await expectRedirectDigest(
      choosePortalDestinationAction(
        formDataFor({ studioId: STUDIO_A, clientId: FORGED_CLIENT_ID }),
      ),
    );

    expect(digest).toContain(`client=${CLIENT_SELF}`);
    expect(digest).not.toContain(FORGED_CLIENT_ID);
  });

  it("tampered/stale posted studioId (not among the user's currently-linked studios) -> no cookie set, no redirect into a portal", async () => {
    setFixture([linkRow({ studio_id: STUDIO_A, client_id: CLIENT_SELF })]);

    const digest = await expectRedirectDigest(
      choosePortalDestinationAction(formDataFor({ studioId: STUDIO_UNLINKED })),
    );

    expect(digest).toContain("/portal/choose");
    expect(digest).not.toContain("client=");
    expect(setCookieCalls).toHaveLength(0);
  });

  it("missing studioId in the POST -> no cookie set, bounces back to the chooser", async () => {
    setFixture([linkRow({ studio_id: STUDIO_A, client_id: CLIENT_SELF })]);

    const digest = await expectRedirectDigest(
      choosePortalDestinationAction(formDataFor({})),
    );

    expect(digest).toContain("/portal/choose");
    expect(setCookieCalls).toHaveLength(0);
  });
});
