import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@/lib/documents/pdf";

/**
 * BR-3D2c1: the completion certificate previously printed persisted
 * `source_sha256`/`signed_sha256` text without ever re-checking that the
 * currently-stored signed artifact still matches `signed_sha256`. This
 * proves the new download+hash+compare gate: a match still produces a real
 * certificate PDF, and every failure mode (missing bucket/path/hash,
 * storage error, missing blob, or an actual hash mismatch) fails closed to
 * the route's existing generic `404 "Certificate unavailable"` response --
 * with no bucket, path, or hash ever appearing in that response body.
 *
 * `canManageDocumentsRole` is the REAL implementation (not mocked) --
 * only `getCurrentStudioContext` is mocked, matching the established
 * BR-3D2a authorizationGate.test.ts technique of using a throwing admin
 * client to prove a denied role never reaches the data layer at all.
 */

const STUDIO_ID = "studio-1";
const ENVELOPE_ID = "envelope-1";

const SIGNED_BYTES = new Uint8Array([5, 5, 5, 5]);
const CORRECT_SIGNED_SHA256 = sha256Hex(SIGNED_BYTES);

const getCurrentStudioContextMock = vi.fn();
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...args: unknown[]) => getCurrentStudioContextMock(...args),
}));

type Fixture = {
  envelope: Record<string, unknown> | null;
  download: { data: unknown; error: unknown } | "THROW";
};

class UnexpectedQueryError extends Error {
  constructor(table: string) {
    super(`UNEXPECTED_QUERY:${table}`);
  }
}

function throwingAdminClient() {
  return {
    from(table: string) {
      throw new UnexpectedQueryError(table);
    },
  };
}

function makeAdminClient(fixture: Fixture) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      if (table === "document_sign_envelopes") {
        chain.maybeSingle = () => Promise.resolve({ data: fixture.envelope, error: null });
      } else if (table === "studios") {
        chain.maybeSingle = () =>
          Promise.resolve({ data: { name: "Test Studio", public_name: null, public_logo_url: null }, error: null });
      } else {
        throw new Error(`unexpected table ${table}`);
      }
      return chain;
    },
    storage: {
      from: (bucket: string) => ({
        download: (path: string) => {
          if (fixture.download === "THROW") {
            throw new Error("UNEXPECTED_STORAGE_ACCESS");
          }
          expect(bucket).toBeTruthy();
          expect(path).toBeTruthy();
          return Promise.resolve(fixture.download);
        },
      }),
    },
  };
}

function signedBlob() {
  return { arrayBuffer: async () => SIGNED_BYTES.buffer };
}

function mockStudioContext(studioRole: string) {
  getCurrentStudioContextMock.mockResolvedValue({
    studioId: STUDIO_ID,
    studioRole,
    isPlatformAdmin: false,
    userId: "user-1",
    email: "staff@example.test",
  });
}

function baseEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    id: ENVELOPE_ID,
    title: "Test Waiver",
    status: "completed",
    signer_name: "Jane Doe",
    signer_email: "jane@example.test",
    source_sha256: "a".repeat(64),
    signed_sha256: CORRECT_SIGNED_SHA256,
    signed_bucket: "documents",
    signed_path: "path/to/signed.pdf",
    sent_at: null,
    viewed_at: null,
    started_at: null,
    completed_at: new Date().toISOString(),
    signature_method: "typed",
    signed_timezone: "UTC",
    consent_text: "I agree.",
    ...overrides,
  };
}

async function callRoute() {
  const { GET } = await import("../route");
  return GET(new Request("https://example.test/certificate"), {
    params: Promise.resolve({ envelopeId: ENVELOPE_ID }),
  });
}

beforeEach(() => {
  vi.resetModules();
  getCurrentStudioContextMock.mockReset();
});

describe("GET certificate -- authorization regression (unchanged)", () => {
  it("a non-manager role is denied before any query is reached", async () => {
    mockStudioContext("instructor");
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: throwingAdminClient }));

    const response = await callRoute();

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toBe("Not found");
  });
});

describe("GET certificate -- signed-artifact verification", () => {
  it("a matching signed artifact hash produces a real certificate PDF", async () => {
    mockStudioContext("studio_owner");
    const fixture: Fixture = {
      envelope: baseEnvelope(),
      download: { data: signedBlob(), error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    const bytes = new Uint8Array(await response.arrayBuffer());
    // A real PDF starts with the "%PDF-" magic header -- proves pdf-lib actually generated a document.
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("a downloaded-artifact hash mismatch fails closed to the generic response", async () => {
    mockStudioContext("studio_owner");
    const fixture: Fixture = {
      envelope: baseEnvelope(),
      download: { data: { arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer }, error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toBe("Certificate unavailable");
    expect(body).not.toMatch(/documents|path\/to|sha|hash/i);
  });

  it("a storage download failure fails closed to the generic response", async () => {
    mockStudioContext("studio_owner");
    const fixture: Fixture = {
      envelope: baseEnvelope(),
      download: { data: null, error: { message: "not found" } },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Certificate unavailable");
  });

  it("missing storage data (no error, no blob) fails closed", async () => {
    mockStudioContext("studio_owner");
    const fixture: Fixture = {
      envelope: baseEnvelope(),
      download: { data: null, error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Certificate unavailable");
  });

  it("a missing signed_sha256 fails closed before attempting a download", async () => {
    mockStudioContext("studio_owner");
    const fixture: Fixture = {
      envelope: baseEnvelope({ signed_sha256: null }),
      download: "THROW",
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Certificate unavailable");
  });

  it("a missing signed_bucket/signed_path fails closed before attempting a download", async () => {
    mockStudioContext("studio_owner");
    const fixture: Fixture = {
      envelope: baseEnvelope({ signed_bucket: null, signed_path: null }),
      download: "THROW",
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Certificate unavailable");
  });

  it("a byte-conversion failure during verification is caught and fails closed", async () => {
    mockStudioContext("studio_owner");
    const throwingBlob = {
      arrayBuffer: async () => {
        throw new Error("corrupt stream");
      },
    };
    const fixture: Fixture = {
      envelope: baseEnvelope(),
      download: { data: throwingBlob, error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Certificate unavailable");
  });

  it("a non-completed envelope is still denied (existing behavior, unaffected by the new check)", async () => {
    mockStudioContext("studio_owner");
    const fixture: Fixture = {
      envelope: baseEnvelope({ status: "sent" }),
      download: "THROW",
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Certificate unavailable");
  });
});

describe("GET certificate -- BR-3D2c2 historical consent evidence (no rewrite)", () => {
  it("succeeds using a historical persisted consent value that differs from today's canonical text", async () => {
    // "I agree." (this file's own default fixture value, unrelated to any
    // current consent constant) stands in for a pre-D2c2 historical row.
    // The route must render successfully using exactly what is persisted.
    mockStudioContext("studio_owner");
    const fixture: Fixture = {
      envelope: baseEnvelope({ consent_text: "I agree." }),
      download: { data: signedBlob(), error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("the certificate route has no access to today's canonical consent constant, so it cannot substitute it for historical evidence", () => {
    // Structural, not source-regex-on-behavior: this asserts an import
    // boundary, not application logic. Confirmed empirically that pdf-lib's
    // default pdf.save() compresses page content streams, so the rendered
    // text itself is not present as plain bytes in the output PDF and
    // cannot be asserted on directly without parsing/decompressing it --
    // this import-boundary check plus the passing historical-value render
    // above together prove the required invariant.
    const routeSource = readFileSync(fileURLToPath(new URL("../route.ts", import.meta.url)), "utf8");
    expect(routeSource).not.toMatch(/@\/lib\/documents\/consent/);
  });
});
