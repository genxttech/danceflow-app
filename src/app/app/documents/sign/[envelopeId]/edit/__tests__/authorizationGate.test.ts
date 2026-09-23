import { describe, expect, it, vi } from "vitest";

/**
 * BR-3D2a: `edit/page.tsx` scoped the envelope by `studio_id` but never
 * enforced `canManageDocumentsRole()`, unlike its sibling envelope detail
 * page and every action in `sign/actions.ts` -- any authenticated
 * same-studio user, regardless of role, could reach signer name/email and
 * revision-reason metadata. The embedded/linked source PDF was never
 * exposed here (it is served by `.../source/route.ts`, which already
 * enforces `canManageDocumentsRole` independently) -- this was a metadata
 * leak, not a document-content leak. Fixed by adding the same
 * `if (!canManageDocumentsRole(context.studioRole)) redirect("/app");`
 * gate used by the sibling detail page, immediately after
 * `getCurrentStudioContext()` and before any envelope query.
 *
 * Test technique follows the established precedent in
 * `src/app/app/clients/__tests__/independentInstructorClientsLockdown.test.ts`:
 * the mocked Supabase admin client throws a distinctive
 * `UnexpectedQueryError` the instant any query chain is invoked, so a
 * denied role provably never reaches the data layer at all (not just
 * "redirects eventually"), and an allowed role provably does reach it.
 */

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
}));

const getCurrentStudioContextMock = vi.fn();
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...args: unknown[]) => getCurrentStudioContextMock(...args),
}));

class UnexpectedQueryError extends Error {
  constructor(table: string) {
    super(`UNEXPECTED_QUERY:${table}`);
  }
}

const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: (...args: unknown[]) => createAdminClientMock(...args),
}));

vi.mock("./FieldPlacementEditor", () => ({
  default: () => null,
}));

const { default: EditSigningEnvelopePage } = await import("../page");

function mockStudioContext(studioRole: string) {
  getCurrentStudioContextMock.mockResolvedValue({
    studioId: "studio-1",
    studioRole,
    isPlatformAdmin: false,
    userId: "user-1",
    email: "user@example.test",
  });
}

/** Any query chain throws immediately -- proves the query layer was reached at all. */
function throwingAdminClient() {
  return {
    from(table: string) {
      const err = new UnexpectedQueryError(table);
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.order = self;
      chain.maybeSingle = () => Promise.reject(err);
      return chain;
    },
  };
}

/** The envelope lookup resolves to "not found" (simulating a cross-studio/missing envelope). */
function notFoundAdminClient() {
  return {
    from() {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      return chain;
    },
  };
}

function digestUrl(error: unknown) {
  const digest = (error as { digest?: string })?.digest ?? "";
  const match = digest.match(/^NEXT_REDIRECT;replace;([^;]*);/);
  return match?.[1] ?? "";
}

async function runPage() {
  try {
    await EditSigningEnvelopePage({
      params: Promise.resolve({ envelopeId: "envelope-1" }),
      searchParams: Promise.resolve({}),
    });
    return null;
  } catch (error) {
    return error;
  }
}

describe("documents/sign/[envelopeId]/edit/page.tsx -- BR-3D2a authorization gate", () => {
  describe("A. insufficient same-studio role", () => {
    it("is redirected to /app before any envelope/field query is reached", async () => {
      mockStudioContext("instructor");
      createAdminClientMock.mockImplementation(throwingAdminClient);

      const error = await runPage();

      expect(digestUrl(error)).toBe("/app");
      expect(error).not.toBeInstanceOf(UnexpectedQueryError);
      // The gate runs before `createAdminClient()` is ever called for a denied role.
      expect(createAdminClientMock).not.toHaveBeenCalled();
    });

    it("independent_instructor is also redirected to /app before any query", async () => {
      mockStudioContext("independent_instructor");
      createAdminClientMock.mockImplementation(throwingAdminClient);

      const error = await runPage();

      expect(digestUrl(error)).toBe("/app");
      expect(createAdminClientMock).not.toHaveBeenCalled();
    });
  });

  describe("B. authorized roles pass the gate and reach the query layer", () => {
    it("studio_owner is not blocked by the gate", async () => {
      mockStudioContext("studio_owner");
      createAdminClientMock.mockImplementation(throwingAdminClient);

      const error = await runPage();

      expect(error).toBeInstanceOf(UnexpectedQueryError);
    });

    it.each(["studio_admin", "front_desk", "platform_admin"])(
      "%s is not blocked by the gate",
      async (role) => {
        mockStudioContext(role);
        createAdminClientMock.mockImplementation(throwingAdminClient);

        const error = await runPage();

        expect(error).toBeInstanceOf(UnexpectedQueryError);
      },
    );
  });

  describe("C. cross-studio / missing envelope still not-founds (existing scoping unaffected)", () => {
    it("an authorized role hitting a non-existent/cross-studio envelope still gets notFound()", async () => {
      mockStudioContext("studio_owner");
      createAdminClientMock.mockImplementation(notFoundAdminClient);

      const error = await runPage();

      expect((error as { digest?: string })?.digest).toBe("NEXT_NOT_FOUND");
    });
  });
});
