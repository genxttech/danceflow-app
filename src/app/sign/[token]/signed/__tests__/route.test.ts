import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * BR-3D2b2: the public completed-signed-document download route
 * (`/sign/[token]/signed`) previously never checked `expires_at` at all --
 * a completed envelope's public token worked indefinitely. This adds a
 * single expiry check after the existing completed/bucket/path guard,
 * with no envelope mutation: a completed envelope's `status` must remain
 * "completed" forever (it is a legal record), only the *public token's*
 * usability lapses once `expires_at` has passed. Authenticated portal
 * access (BR-3D2b1, already live) remains the durable retrieval path.
 *
 * Unlike the BR-3D2b1 portal-route mock (which let `.eq()` ignore its
 * arguments), this mock captures every `.select`/`.eq` call so the test
 * can assert `expires_at` was actually requested and the lookup still
 * filters by `token_hash` -- not just that the route "did something
 * given a fixture." `.update` and `.storage.download` are wired to
 * throw when invoked unexpectedly, so an accidental mutation or an
 * expiry check that fails to short-circuit before storage access would
 * fail the test loudly rather than silently pass.
 */

const TOKEN = "test-token-abc";

const hashSigningTokenMock = vi.fn();
hashSigningTokenMock.mockReturnValue("hashed-token");
vi.mock("@/lib/documents/signing", () => ({
  hashSigningToken: (...args: unknown[]) => hashSigningTokenMock(...args),
}));

const consumePublicSigningRateLimitMock = vi.fn();
vi.mock("@/lib/documents/public-signing-security", () => ({
  consumePublicSigningRateLimit: (...args: unknown[]) =>
    consumePublicSigningRateLimitMock(...args),
  PUBLIC_PDF_HEADERS: {
    "Content-Type": "application/pdf",
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
  },
  requestIp: () => "127.0.0.1",
}));

type Fixture = {
  envelope: Record<string, unknown> | null;
  download: { data: unknown; error: unknown } | "THROW";
};

const selectCalls: string[] = [];
const eqCalls: Array<{ column: string; value: unknown }> = [];

function makeAdminClient(fixture: Fixture) {
  return {
    from(table: string) {
      if (table !== "document_sign_envelopes") {
        throw new Error(`unexpected table ${table}`);
      }
      const chain: Record<string, unknown> = {};
      chain.select = (columns: string) => {
        selectCalls.push(columns);
        return chain;
      };
      chain.eq = (column: string, value: unknown) => {
        eqCalls.push({ column, value });
        return chain;
      };
      chain.maybeSingle = () => Promise.resolve({ data: fixture.envelope, error: null });
      chain.update = () => {
        throw new Error("UNEXPECTED_UPDATE: completed envelope must never be mutated");
      };
      return chain;
    },
    storage: {
      from: (bucket: string) => ({
        download: (path: string) => {
          if (fixture.download === "THROW") {
            throw new Error("UNEXPECTED_STORAGE_ACCESS: expiry denial must short-circuit before storage");
          }
          expect(bucket).toBeTruthy();
          expect(path).toBeTruthy();
          return Promise.resolve(fixture.download);
        },
      }),
    },
  };
}

function pdfBlob() {
  return { arrayBuffer: async () => new TextEncoder().encode("%PDF-1.4 fake").buffer };
}

function request() {
  return new Request(`https://example.test/sign/${TOKEN}/signed`);
}

function callRoute() {
  return import("../route").then(({ GET }) =>
    GET(request(), { params: Promise.resolve({ token: TOKEN }) }),
  );
}

const future = new Date(Date.now() + 60_000).toISOString();
const past = new Date(Date.now() - 60_000).toISOString();

beforeEach(() => {
  vi.resetModules();
  selectCalls.length = 0;
  eqCalls.length = 0;
  hashSigningTokenMock.mockClear();
  consumePublicSigningRateLimitMock.mockReset();
  consumePublicSigningRateLimitMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });
});

describe("GET /sign/[token]/signed -- valid access", () => {
  it("returns the signed PDF for a completed envelope with a future expiry", async () => {
    const fixture: Fixture = {
      envelope: {
        title: "Studio Waiver",
        status: "completed",
        signed_bucket: "documents",
        signed_path: "path/to/file.pdf",
        expires_at: future,
      },
      download: { data: pdfBlob(), error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="studio-waiver-signed.pdf"',
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; frame-ancestors 'self'",
    );
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");

    // .select must have actually requested expires_at, not merely a fixture the mock happened to provide.
    expect(selectCalls.some((c) => c.includes("expires_at"))).toBe(true);
    // The lookup must still filter by token_hash.
    expect(eqCalls).toContainEqual({ column: "token_hash", value: "hashed-token" });
    expect(consumePublicSigningRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "signed_pdf", tokenHash: "hashed-token" }),
    );
  });
});

describe("GET -- expiry enforcement", () => {
  it("denies access when expires_at is exactly now", async () => {
    const now = new Date(Date.now()).toISOString();
    const fixture: Fixture = {
      envelope: {
        title: "Waiver",
        status: "completed",
        signed_bucket: "documents",
        signed_path: "path.pdf",
        expires_at: now,
      },
      download: "THROW",
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
  });

  it("denies access when expires_at is in the past", async () => {
    const fixture: Fixture = {
      envelope: {
        title: "Waiver",
        status: "completed",
        signed_bucket: "documents",
        signed_path: "path.pdf",
        expires_at: past,
      },
      download: "THROW",
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
  });

  it("allows access when expires_at is in the future", async () => {
    const fixture: Fixture = {
      envelope: {
        title: "Waiver",
        status: "completed",
        signed_bucket: "documents",
        signed_path: "path.pdf",
        expires_at: future,
      },
      download: { data: pdfBlob(), error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(200);
  });

  it("fails closed on a malformed/unparseable expires_at", async () => {
    const fixture: Fixture = {
      envelope: {
        title: "Waiver",
        status: "completed",
        signed_bucket: "documents",
        signed_path: "path.pdf",
        expires_at: "not-a-real-date",
      },
      download: "THROW",
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
  });

  it("fails closed on a null expires_at (DB-impossible in production, defensive-only)", async () => {
    const fixture: Fixture = {
      envelope: {
        title: "Waiver",
        status: "completed",
        signed_bucket: "documents",
        signed_path: "path.pdf",
        expires_at: null,
      },
      download: "THROW",
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
  });
});

describe("GET -- record integrity on expired-completed access", () => {
  it("never calls .update, never reissues a token, and never touches storage", async () => {
    const fixture: Fixture = {
      envelope: {
        title: "Waiver",
        status: "completed",
        signed_bucket: "documents",
        signed_path: "path.pdf",
        expires_at: past,
      },
      download: "THROW",
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    // The admin fake's .update and storage.download both throw if invoked at all --
    // a passing 404 here (rather than an uncaught throw) proves neither path executes.
    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(hashSigningTokenMock).toHaveBeenCalledTimes(1); // the original token was hashed once for lookup, never re-issued
  });
});

describe("GET -- existing denial behavior (regression)", () => {
  it("404s on an invalid/unknown token", async () => {
    const fixture: Fixture = { envelope: null, download: "THROW" };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
  });

  it("404s on a non-completed envelope", async () => {
    const fixture: Fixture = {
      envelope: {
        title: "Waiver",
        status: "sent",
        signed_bucket: null,
        signed_path: null,
        expires_at: future,
      },
      download: "THROW",
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
  });

  it("404s when signed_bucket/signed_path are missing on an otherwise-completed envelope", async () => {
    const fixture: Fixture = {
      envelope: {
        title: "Waiver",
        status: "completed",
        signed_bucket: null,
        signed_path: null,
        expires_at: future,
      },
      download: "THROW",
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
  });

  it("404s when storage download fails for a valid, unexpired, completed envelope", async () => {
    const fixture: Fixture = {
      envelope: {
        title: "Waiver",
        status: "completed",
        signed_bucket: "documents",
        signed_path: "path.pdf",
        expires_at: future,
      },
      download: { data: null, error: { message: "not found" } },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
  });
});

describe("GET -- enumeration resistance", () => {
  it("the expired-token response is identical in status and body to the generic unavailable response", async () => {
    const expiredFixture: Fixture = {
      envelope: {
        title: "Waiver",
        status: "completed",
        signed_bucket: "documents",
        signed_path: "path.pdf",
        expires_at: past,
      },
      download: "THROW",
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(expiredFixture) }));
    const expiredResponse = await callRoute();
    const expiredBody = await expiredResponse.text();

    vi.resetModules();
    consumePublicSigningRateLimitMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });
    const invalidFixture: Fixture = { envelope: null, download: "THROW" };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(invalidFixture) }));
    const invalidResponse = await callRoute();
    const invalidBody = await invalidResponse.text();

    expect(expiredResponse.status).toBe(invalidResponse.status);
    expect(expiredBody).toBe(invalidBody);
    expect(expiredBody).not.toMatch(/expired/i);
    expect(expiredBody).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no timestamp leaked
  });
});

describe("GET -- rate limiting preserved", () => {
  it("returns 429 with Retry-After when the rate limiter denies, before any envelope lookup", async () => {
    consumePublicSigningRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => ({
        from: () => {
          throw new Error("envelope lookup must not run when rate-limited");
        },
      }),
    }));

    const response = await callRoute();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
  });
});
