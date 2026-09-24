import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * BR-3D2b1: authenticated portal completed-document download.
 *
 * Mirrors the established portal-route test convention (see
 * selfEnrollGroupClassAction.gc3_3.test.ts and the sibling
 * `[assignmentId]/sign/route.ts`): `createClient` is mocked for
 * auth/studio resolution, `resolvePortalRelationship` is mocked directly
 * (its own behavior is covered elsewhere), and `createAdminClient` is a
 * table-routed fake that throws on any unexpected table -- proving the
 * route's own scoping/require-completed logic, not the mock's leniency.
 */

const STUDIO_SLUG = "sunrise-dance";
const STUDIO_ID = "studio-1";
const USER_ID = "user-1";
const ASSIGNMENT_ID = "assignment-1";
const ENVELOPE_ID = "envelope-1";
const CLIENT_ID = "client-1";

let authUser: { id: string } | null = { id: USER_ID };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: authUser } }),
    },
    from: (table: string) => {
      if (table !== "studios") throw new Error(`unexpected supabase table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: STUDIO_ID, slug: STUDIO_SLUG }, error: null }),
          }),
        }),
      };
    },
  }),
}));

const resolvePortalRelationshipMock = vi.fn();
vi.mock("@/lib/student-identity/portal-context", () => ({
  resolvePortalRelationship: (...args: unknown[]) => resolvePortalRelationshipMock(...args),
}));

type Fixture = {
  assignment: Record<string, unknown> | null;
  envelope: Record<string, unknown> | null;
  download: { data: unknown; error: unknown };
};

function makeAdminClient(fixture: Fixture) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;

      if (table === "document_assignments") {
        chain.maybeSingle = () => Promise.resolve({ data: fixture.assignment, error: null });
      } else if (table === "document_sign_envelopes") {
        chain.maybeSingle = () => Promise.resolve({ data: fixture.envelope, error: null });
      } else {
        throw new Error(`unexpected admin table ${table}`);
      }

      return chain;
    },
    storage: {
      from: (bucket: string) => ({
        download: (path: string) => {
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

function request(query = `?client=${CLIENT_ID}`) {
  return new NextRequest(
    `https://example.test/portal/${STUDIO_SLUG}/documents/${ASSIGNMENT_ID}/signed${query}`,
  );
}

function callRoute() {
  return import("../route").then(({ GET }) =>
    GET(request(), { params: Promise.resolve({ studioSlug: STUDIO_SLUG, assignmentId: ASSIGNMENT_ID }) }),
  );
}

beforeEach(() => {
  vi.resetModules();
  resolvePortalRelationshipMock.mockReset();
  authUser = { id: USER_ID };
});

describe("GET /portal/[studioSlug]/documents/[assignmentId]/signed -- success", () => {
  it("returns the signed PDF for the authenticated, correctly-scoped client", async () => {
    resolvePortalRelationshipMock.mockResolvedValue({ clientId: CLIENT_ID });
    const fixture: Fixture = {
      assignment: { id: ASSIGNMENT_ID, client_id: CLIENT_ID, studio_id: STUDIO_ID, sign_envelope_id: ENVELOPE_ID },
      envelope: {
        title: "Studio Waiver!",
        status: "completed",
        signed_bucket: "documents",
        signed_path: `${STUDIO_ID}/${ENVELOPE_ID}.pdf`,
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
  });
});

describe("GET -- authentication / authorization", () => {
  it("redirects to /login with intent=public and next=original path when unauthenticated", async () => {
    authUser = null;
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => {
        throw new Error("admin client must not be created when unauthenticated");
      },
    }));

    const response = await callRoute();

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("intent")).toBe("public");
    expect(location.searchParams.get("next")).toBe(
      `/portal/${STUDIO_SLUG}/documents/${ASSIGNMENT_ID}/signed?client=${CLIENT_ID}`,
    );
  });

  it("404s when the requested client does not belong to this user's relationship", async () => {
    resolvePortalRelationshipMock.mockResolvedValue(null);
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => {
        throw new Error("admin client must not be queried when relationship resolution fails");
      },
    }));

    const response = await callRoute();

    expect(response.status).toBe(404);
  });

  it("404s when the assignment belongs to a different client (relationship narrowing failed to match)", async () => {
    resolvePortalRelationshipMock.mockResolvedValue({ clientId: CLIENT_ID });
    const fixture: Fixture = {
      assignment: null, // scoped query found nothing for this client
      envelope: null,
      download: { data: null, error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
  });

  it("404s when the assignment/envelope belongs to a different studio (no cross-studio leak)", async () => {
    resolvePortalRelationshipMock.mockResolvedValue({ clientId: CLIENT_ID });
    const fixture: Fixture = {
      assignment: null, // studio-scoped query found nothing
      envelope: null,
      download: { data: null, error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
  });

  it("404s when the envelope's client_id does not match the assignment's relationship-derived client", async () => {
    resolvePortalRelationshipMock.mockResolvedValue({ clientId: CLIENT_ID });
    const fixture: Fixture = {
      assignment: { id: ASSIGNMENT_ID, client_id: CLIENT_ID, studio_id: STUDIO_ID, sign_envelope_id: ENVELOPE_ID },
      envelope: null, // envelope query scoped by client_id found nothing (mismatch)
      download: { data: null, error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
  });
});

describe("GET -- record/state failures all fail closed as a uniform 404", () => {
  it("404s when the assignment does not exist", async () => {
    resolvePortalRelationshipMock.mockResolvedValue({ clientId: CLIENT_ID });
    const fixture: Fixture = { assignment: null, envelope: null, download: { data: null, error: null } };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    expect((await callRoute()).status).toBe(404);
  });

  it("404s when the assignment has no sign_envelope_id (legacy signature-only record)", async () => {
    resolvePortalRelationshipMock.mockResolvedValue({ clientId: CLIENT_ID });
    const fixture: Fixture = {
      assignment: { id: ASSIGNMENT_ID, client_id: CLIENT_ID, studio_id: STUDIO_ID, sign_envelope_id: null },
      envelope: null,
      download: { data: null, error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    expect((await callRoute()).status).toBe(404);
  });

  it("404s when the envelope does not exist", async () => {
    resolvePortalRelationshipMock.mockResolvedValue({ clientId: CLIENT_ID });
    const fixture: Fixture = {
      assignment: { id: ASSIGNMENT_ID, client_id: CLIENT_ID, studio_id: STUDIO_ID, sign_envelope_id: ENVELOPE_ID },
      envelope: null,
      download: { data: null, error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    expect((await callRoute()).status).toBe(404);
  });

  it("404s when the envelope is not yet completed", async () => {
    resolvePortalRelationshipMock.mockResolvedValue({ clientId: CLIENT_ID });
    const fixture: Fixture = {
      assignment: { id: ASSIGNMENT_ID, client_id: CLIENT_ID, studio_id: STUDIO_ID, sign_envelope_id: ENVELOPE_ID },
      envelope: { title: "Waiver", status: "sent", signed_bucket: null, signed_path: null },
      download: { data: null, error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    expect((await callRoute()).status).toBe(404);
  });

  it("404s when signed_bucket is missing on an otherwise-completed envelope", async () => {
    resolvePortalRelationshipMock.mockResolvedValue({ clientId: CLIENT_ID });
    const fixture: Fixture = {
      assignment: { id: ASSIGNMENT_ID, client_id: CLIENT_ID, studio_id: STUDIO_ID, sign_envelope_id: ENVELOPE_ID },
      envelope: { title: "Waiver", status: "completed", signed_bucket: null, signed_path: "path.pdf" },
      download: { data: null, error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    expect((await callRoute()).status).toBe(404);
  });

  it("404s when signed_path is missing on an otherwise-completed envelope", async () => {
    resolvePortalRelationshipMock.mockResolvedValue({ clientId: CLIENT_ID });
    const fixture: Fixture = {
      assignment: { id: ASSIGNMENT_ID, client_id: CLIENT_ID, studio_id: STUDIO_ID, sign_envelope_id: ENVELOPE_ID },
      envelope: { title: "Waiver", status: "completed", signed_bucket: "documents", signed_path: null },
      download: { data: null, error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    expect((await callRoute()).status).toBe(404);
  });
});

describe("GET -- storage failure", () => {
  it("404s without throwing when storage returns an error", async () => {
    resolvePortalRelationshipMock.mockResolvedValue({ clientId: CLIENT_ID });
    const fixture: Fixture = {
      assignment: { id: ASSIGNMENT_ID, client_id: CLIENT_ID, studio_id: STUDIO_ID, sign_envelope_id: ENVELOPE_ID },
      envelope: { title: "Waiver", status: "completed", signed_bucket: "documents", signed_path: "path.pdf" },
      download: { data: null, error: { message: "not found in bucket" } },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    const response = await callRoute();

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain("documents");
    expect(body).not.toContain("path.pdf");
  });

  it("404s without throwing when storage returns no data", async () => {
    resolvePortalRelationshipMock.mockResolvedValue({ clientId: CLIENT_ID });
    const fixture: Fixture = {
      assignment: { id: ASSIGNMENT_ID, client_id: CLIENT_ID, studio_id: STUDIO_ID, sign_envelope_id: ENVELOPE_ID },
      envelope: { title: "Waiver", status: "completed", signed_bucket: "documents", signed_path: "path.pdf" },
      download: { data: null, error: null },
    };
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeAdminClient(fixture) }));

    expect((await callRoute()).status).toBe(404);
  });
});
