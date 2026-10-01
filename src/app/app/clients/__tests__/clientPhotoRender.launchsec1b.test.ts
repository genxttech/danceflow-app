import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * LAUNCH-SEC-1B Stage 1: the three active client-photo render paths (client
 * detail, client edit, client QR identity) render only a server-created signed
 * URL. The stored photo value (legacy public URL or bare object path) never
 * reaches the markup or the client component, missing/invalid/foreign values
 * fall back to initials, and the QR page signs only after its token RPC
 * resolved the client.
 */

vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    const error = new Error("NOT_FOUND");
    (error as unknown as { digest: string }).digest = "NEXT_NOT_FOUND";
    throw error;
  },
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/app/clients",
  useSearchParams: () => new URLSearchParams(),
}));

const PROJECT_URL = "https://abcdefghijklmnopqrst.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_URL = PROJECT_URL;

const STUDIO = "11111111-2222-4333-8444-555555555555";
const CLIENT = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const OTHER_CLIENT = "12345678-90ab-4cde-8f01-234567890abc";
const OBJECT_UUID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const PATH = `${STUDIO}/${CLIENT}/1759276800000-${OBJECT_UUID}.webp`;
const LEGACY_URL = `${PROJECT_URL}/storage/v1/object/public/client-photos/${PATH}`;
const FOREIGN_PATH = `${STUDIO}/${OTHER_CLIENT}/1759276800000-${OBJECT_UUID}.webp`;
const SIGNED_URL = "https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/sign/client-photos/x?token=signed-token";

const events: string[] = [];
const signCalls: { bucket: string; path: string; ttl: number }[] = [];
let signFails = false;

function adminClient() {
  return {
    storage: {
      from(bucket: string) {
        return {
          async createSignedUrl(path: string, ttl: number) {
            events.push("sign");
            signCalls.push({ bucket, path, ttl });
            return signFails
              ? { data: null, error: { message: "Object not found" } }
              : { data: { signedUrl: SIGNED_URL }, error: null };
          },
          getPublicUrl() {
            throw new Error("getPublicUrl must never be used for client photos");
          },
        };
      },
    },
    from: () => permissiveChain("admin", null),
    rpc: async () => ({ data: [], error: null }),
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminClient(),
}));

// A permissive PostgREST-style chain: every builder method returns the chain,
// single()/maybeSingle() resolve to the per-table row, and awaiting the chain
// resolves to an empty list.
function permissiveChain(table: string, singleRow: unknown): unknown {
  const target = {} as Record<string, unknown>;
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
      }
      if (prop === "single" || prop === "maybeSingle") {
        return async () => ({ data: singleRow, error: null });
      }
      return () => proxy;
    },
  });
  void table;
  return proxy;
}

let clientRow: Record<string, unknown> = {};
let qrRpcResult: { data: unknown; error: unknown } = { data: [], error: null };

const STUDIO_ROW = {
  id: STUDIO,
  name: "Harbor Dance",
  public_name: "Harbor Dance",
  slug: "harbor-dance",
  timezone: "America/New_York",
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1", email: "owner@example.test" } }, error: null }),
    },
    from(table: string) {
      if (table === "clients") return permissiveChain(table, clientRow);
      if (table === "studios") return permissiveChain(table, STUDIO_ROW);
      return permissiveChain(table, null);
    },
    rpc: async (fn: string) => {
      events.push(`rpc:${fn}`);
      if (fn === "get_client_by_qr_token_for_checkin") return qrRpcResult;
      return { data: [], error: null };
    },
    storage: {
      from() {
        throw new Error("tenant storage client must not be used for client photos");
      },
    },
  }),
}));

const studioContext = { studioId: STUDIO, studioRole: "studio_owner", isPlatformAdmin: false };
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => studioContext,
}));

const capturedEditFormProps: Record<string, unknown>[] = [];
vi.mock("../[id]/edit/EditClientForm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../[id]/edit/EditClientForm")>();
  return {
    default: (props: Record<string, unknown>) => {
      capturedEditFormProps.push(props);
      return React.createElement(actual.default, props as never);
    },
  };
});

const { default: ClientIdentityPage } = await import("../../client-identity/[token]/page");
const { default: EditClientPage } = await import("../[id]/edit/page");
const { default: ClientDetailPage } = await import("../[id]/page");

function baseClientRow(photo: unknown) {
  return {
    id: CLIENT,
    studio_id: STUDIO,
    first_name: "Jane",
    last_name: "Doe",
    email: null,
    phone: null,
    birthday: null,
    address_line1: null,
    address_line2: null,
    city: null,
    state: null,
    postal_code: null,
    country: null,
    status: "active",
    skill_level: null,
    dance_interests: null,
    dance_goals: null,
    referral_source: null,
    notes: null,
    photo_url: photo,
    is_independent_instructor: false,
    linked_instructor_id: null,
    created_at: "2026-09-01T00:00:00.000Z",
  };
}

function expectNoStoredValue(markup: string) {
  expect(markup).not.toContain(PATH);
  expect(markup).not.toContain("/object/public/");
}

beforeEach(() => {
  events.length = 0;
  signCalls.length = 0;
  signFails = false;
  capturedEditFormProps.length = 0;
  clientRow = baseClientRow(null);
  qrRpcResult = { data: [], error: null };
});

async function renderQr() {
  const element = await ClientIdentityPage({
    params: Promise.resolve({ token: "a-valid-looking-qr-token-1234567890" }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element as React.ReactElement);
}

function qrClient(photo: unknown, id = CLIENT) {
  return { id, first_name: "Jane", last_name: "Doe", photo_url: photo, skill_level: null };
}

describe("client QR identity page", () => {
  it.each([
    ["bare object path", PATH],
    ["legacy public URL", LEGACY_URL],
  ])("renders only the signed URL for a %s, signing after the token RPC", async (_label, stored) => {
    qrRpcResult = { data: [qrClient(stored)], error: null };

    const markup = await renderQr();

    expect(markup).toContain(`src="${SIGNED_URL.replace(/&/g, "&amp;")}"`);
    expectNoStoredValue(markup);
    expect(signCalls).toEqual([{ bucket: "client-photos", path: PATH, ttl: 600 }]);
    expect(events.indexOf("sign")).toBeGreaterThan(events.indexOf("rpc:get_client_by_qr_token_for_checkin"));
  });

  it.each([
    ["missing photo", null],
    ["foreign URL", "https://example.test/photo.jpg"],
    ["another client's object", FOREIGN_PATH],
    ["malformed path", `${PATH}?download=1`],
  ])("falls back to initials with no signing for a %s", async (_label, stored) => {
    qrRpcResult = { data: [qrClient(stored)], error: null };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const markup = await renderQr();
    warn.mockRestore();

    expect(markup).not.toContain("<img");
    expect(markup).toContain(">JD<");
    expect(signCalls).toEqual([]);
  });

  it("falls back to initials when signing fails (no public fallback)", async () => {
    qrRpcResult = { data: [qrClient(PATH)], error: null };
    signFails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const markup = await renderQr();
    warn.mockRestore();

    expect(markup).not.toContain("<img");
    expectNoStoredValue(markup);
  });

  it("an unresolved token never signs anything", async () => {
    qrRpcResult = { data: [], error: null };

    const result = await renderQr().catch((e) => e);

    expect((result as { digest?: string }).digest).toBe("NEXT_NOT_FOUND");
    expect(signCalls).toEqual([]);
  });
});

describe("client edit page and EditClientForm", () => {
  async function renderEdit() {
    const element = await EditClientPage({ params: Promise.resolve({ id: CLIENT }) });
    return renderToStaticMarkup(element as React.ReactElement);
  }

  it.each([
    ["bare object path", PATH],
    ["legacy public URL", LEGACY_URL],
  ])("passes only photoSignedUrl (never photo_url) for a %s", async (_label, stored) => {
    clientRow = baseClientRow(stored);

    const markup = await renderEdit();

    expect(capturedEditFormProps).toHaveLength(1);
    const props = capturedEditFormProps[0];
    expect(props.photoSignedUrl).toBe(SIGNED_URL);
    expect(props.client).not.toHaveProperty("photo_url");
    expect(JSON.stringify(props)).not.toContain(PATH);
    expect(markup).toContain(`src="${SIGNED_URL.replace(/&/g, "&amp;")}"`);
    expectNoStoredValue(markup);
    expect(signCalls).toEqual([{ bucket: "client-photos", path: PATH, ttl: 600 }]);
  });

  it.each([
    ["missing photo", null],
    ["foreign URL", "https://example.test/photo.jpg"],
    ["another client's object", FOREIGN_PATH],
  ])("passes null and renders initials for a %s", async (_label, stored) => {
    clientRow = baseClientRow(stored);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const markup = await renderEdit();
    warn.mockRestore();

    expect(capturedEditFormProps[0].photoSignedUrl).toBeNull();
    expect(markup).not.toMatch(/<img[^>]*alt="Jane Doe"/);
    expect(signCalls).toEqual([]);
  });

  it("a role without client edit access is redirected before any signing", async () => {
    studioContext.studioRole = "instructor";
    clientRow = baseClientRow(PATH);
    try {
      const result = await renderEdit().catch((e) => e);
      expect((result as { digest?: string }).digest).toMatch(/^NEXT_REDIRECT;replace;\/app;/);
      expect(signCalls).toEqual([]);
    } finally {
      studioContext.studioRole = "studio_owner";
    }
  });
});

describe("client detail page", () => {
  async function renderDetail() {
    const element = await ClientDetailPage({
      params: Promise.resolve({ id: CLIENT }),
      searchParams: Promise.resolve({}),
    } as never);
    return renderToStaticMarkup(element as React.ReactElement);
  }

  it.each([
    ["bare object path", PATH],
    ["legacy public URL", LEGACY_URL],
  ])("renders only the signed URL for a %s", async (_label, stored) => {
    clientRow = baseClientRow(stored);

    const markup = await renderDetail();

    expect(markup).toMatch(/<img src="[^"]*signed-token" alt="Jane Doe"/);
    expectNoStoredValue(markup);
    expect(signCalls).toEqual([{ bucket: "client-photos", path: PATH, ttl: 600 }]);
  });

  it.each([
    ["missing photo", null],
    ["foreign URL", "https://example.test/photo.jpg"],
    ["another client's object", FOREIGN_PATH],
  ])("renders initials with no signing for a %s", async (_label, stored) => {
    clientRow = baseClientRow(stored);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const markup = await renderDetail();
    warn.mockRestore();

    expect(markup).not.toMatch(/alt="Jane Doe"/);
    expect(markup).not.toContain("https://example.test/photo.jpg");
    expect(signCalls).toEqual([]);
  });

  it("a role without client view access is redirected before any signing", async () => {
    studioContext.studioRole = "instructor";
    clientRow = baseClientRow(PATH);
    try {
      const result = await renderDetail().catch((e) => e);
      expect((result as { digest?: string }).digest).toMatch(/^NEXT_REDIRECT;replace;\/app;/);
      expect(signCalls).toEqual([]);
    } finally {
      studioContext.studioRole = "studio_owner";
    }
  });
});
