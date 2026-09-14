import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * GC-3.3: portal student/guardian self-enrollment action.
 *
 * Drives the real selfEnrollGroupClassAction (not a stand-in) from
 * src/app/portal/[studioSlug]/schedule/actions.ts, with createClient/
 * createAdminClient/resolvePortalRelationship mocked -- mirroring the
 * established groupClassActions.gc1_4a.test.ts convention (mock the
 * guard/client entry points, exercise the action's own real RPC-call
 * selection and redirect-message mapping).
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
  isRedirectError: (error: unknown) =>
    typeof (error as { digest?: string })?.digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT"),
}));

vi.mock("next/dist/client/components/redirect-error", () => ({
  isRedirectError: (error: unknown) =>
    typeof (error as { digest?: string })?.digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT"),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/notifications/expoPush", () => ({
  sendMobilePushToUser: vi.fn().mockResolvedValue(undefined),
}));

const STUDIO_SLUG = "sunrise-dance";
const STUDIO_ID = "studio-1";
const USER_ID = "user-1";
const APPOINTMENT_ID = "appt-class-1";
const RELATIONSHIP_CLIENT_ID = "client-1";

let rpcResponse: { data?: unknown; error?: unknown } = { data: null, error: null };
const rpcCalls: Array<{ name: string; args: unknown }> = [];
let authUser: { id: string } | null = { id: USER_ID };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: authUser } }),
    },
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(rpcResponse);
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "studios") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: STUDIO_ID }, error: null }),
          }),
        }),
      };
    },
  }),
}));

const resolvePortalRelationshipMock = vi.fn();
vi.mock("@/lib/student-identity/portal-context", () => ({
  resolvePortalRelationship: (...args: unknown[]) => resolvePortalRelationshipMock(...args),
  portalClientPath: (slug: string, clientId: string) => `/portal/${slug}/${clientId}`,
}));

const { selfEnrollGroupClassAction } = await import("../actions");

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function run(promise: Promise<unknown>) {
  return promise.catch((error) => error);
}

function redirectUrl(error: unknown): string {
  const digest = (error as { digest?: string })?.digest ?? "";
  return digest.split(";")[2] ?? "";
}

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResponse = { data: null, error: null };
  authUser = { id: USER_ID };
  resolvePortalRelationshipMock.mockReset();
  resolvePortalRelationshipMock.mockResolvedValue({
    clientId: RELATIONSHIP_CLIENT_ID,
    studioId: STUDIO_ID,
  });
});

describe("selfEnrollGroupClassAction", () => {
  it("calls self_enroll_class_attendee under the session client (auth.uid()-bearing), with no funding choice for the auto-resolve (single-candidate) path", async () => {
    rpcResponse = { data: "attendee-1", error: null };

    const formData = formDataFor({
      studioSlug: STUDIO_SLUG,
      appointmentId: APPOINTMENT_ID,
      clientId: RELATIONSHIP_CLIENT_ID,
    });

    const error = await run(selfEnrollGroupClassAction(formData));

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({
      name: "self_enroll_class_attendee",
      args: {
        p_appointment_id: APPOINTMENT_ID,
        p_client_id: RELATIONSHIP_CLIENT_ID,
        p_client_package_id: null,
        p_client_membership_id: null,
      },
    });
    expect(redirectUrl(error)).toContain("success=class_joined");
  });

  it("parses a package fundingChoice into p_client_package_id, leaving p_client_membership_id null", async () => {
    rpcResponse = { data: "attendee-1", error: null };

    const formData = formDataFor({
      studioSlug: STUDIO_SLUG,
      appointmentId: APPOINTMENT_ID,
      clientId: RELATIONSHIP_CLIENT_ID,
      fundingChoice: "package:pkg-1",
    });

    await run(selfEnrollGroupClassAction(formData));

    expect(rpcCalls[0].args).toMatchObject({
      p_client_package_id: "pkg-1",
      p_client_membership_id: null,
    });
  });

  it("parses a membership fundingChoice into p_client_membership_id, leaving p_client_package_id null", async () => {
    rpcResponse = { data: "attendee-1", error: null };

    const formData = formDataFor({
      studioSlug: STUDIO_SLUG,
      appointmentId: APPOINTMENT_ID,
      clientId: RELATIONSHIP_CLIENT_ID,
      fundingChoice: "membership:mem-1",
    });

    await run(selfEnrollGroupClassAction(formData));

    expect(rpcCalls[0].args).toMatchObject({
      p_client_package_id: null,
      p_client_membership_id: "mem-1",
    });
  });

  it("rejects before calling the RPC when resolvePortalRelationship (can_manage_bookings gate) returns null", async () => {
    resolvePortalRelationshipMock.mockResolvedValue(null);

    const formData = formDataFor({
      studioSlug: STUDIO_SLUG,
      appointmentId: APPOINTMENT_ID,
      clientId: RELATIONSHIP_CLIENT_ID,
    });

    const error = await run(selfEnrollGroupClassAction(formData));

    expect(rpcCalls).toHaveLength(0);
    expect(redirectUrl(error)).toContain("error=");
    expect(redirectUrl(error)).not.toContain("success=");
  });

  // GC-3.3: each of self_enroll_class_attendee's distinct exception messages
  // must surface as a distinct, actionable message -- this page's own
  // established convention (unlike the staff-side code-lookup pattern)
  // passes plain human-readable text via the error query param directly.
  it.each([
    ["You are already enrolled in this class.", "already enrolled"],
    ["This class is not open for self-enrollment.", "isn't available"],
    ["No eligible package or membership found for this class.", "eligible package or membership"],
    ["A single funding source choice is required.", "Choose a funding source"],
    ["Selected package is not an eligible funding source for this class.", "no longer eligible"],
    ["This class has no available seats remaining.", "class is full"],
    ["Not authorized to enroll this client into this class.", "not authorized"],
    ["Group class not found.", "could not be found"],
  ])("maps RPC message %s to a distinct, non-generic error", async (rpcMessage, expectedFragment) => {
    rpcResponse = { data: null, error: { message: rpcMessage } };

    const formData = formDataFor({
      studioSlug: STUDIO_SLUG,
      appointmentId: APPOINTMENT_ID,
      clientId: RELATIONSHIP_CLIENT_ID,
    });

    const error = await run(selfEnrollGroupClassAction(formData));
    const url = decodeURIComponent(redirectUrl(error));

    expect(url).toContain(expectedFragment);
    expect(url).not.toContain("Could not join this class. Try again.");
  });

  it("an unrecognized RPC error message falls back to the generic message, not a raw exception", async () => {
    rpcResponse = { data: null, error: { message: "some brand new unexpected failure" } };

    const formData = formDataFor({
      studioSlug: STUDIO_SLUG,
      appointmentId: APPOINTMENT_ID,
      clientId: RELATIONSHIP_CLIENT_ID,
    });

    const error = await run(selfEnrollGroupClassAction(formData));

    expect(decodeURIComponent(redirectUrl(error))).toContain("Could not join this class. Try again.");
  });

  // B3 fix (second code review): the portal UI's radio group used to
  // pre-check the first eligible candidate (defaultChecked={index === 0}),
  // so a multi-source submission could silently pick one without the
  // student ever choosing. Now that the pre-check is removed, this proves
  // the server-side half of the guarantee: if fundingChoice is absent from
  // the submission for any reason (a bypassed/JS-disabled form, a direct
  // POST), the action never invents a default -- it always passes
  // null/null through to the RPC, which is the actual, independent
  // authority that rejects an ambiguous multi-source enrollment with "A
  // single funding source choice is required." (see the it.each mapping
  // above). The client-side `required` attribute is a UX convenience, not
  // the real guarantee -- this test proves the guarantee holds even without it.
  it("never substitutes a default funding choice when fundingChoice is absent -- always passes null/null through to the RPC", async () => {
    rpcResponse = {
      data: null,
      error: { message: "A single funding source choice is required." },
    };

    const formData = formDataFor({
      studioSlug: STUDIO_SLUG,
      appointmentId: APPOINTMENT_ID,
      clientId: RELATIONSHIP_CLIENT_ID,
      // fundingChoice intentionally omitted -- simulates a multi-source
      // class where nothing was selected.
    });

    const error = await run(selfEnrollGroupClassAction(formData));

    expect(rpcCalls[0].args).toMatchObject({
      p_client_package_id: null,
      p_client_membership_id: null,
    });
    expect(decodeURIComponent(redirectUrl(error))).toContain("Choose a funding source");
    expect(redirectUrl(error)).not.toContain("success=");
  });

  it("redirects to /login when there is no authenticated user", async () => {
    authUser = null;

    const formData = formDataFor({
      studioSlug: STUDIO_SLUG,
      appointmentId: APPOINTMENT_ID,
      clientId: RELATIONSHIP_CLIENT_ID,
    });

    const error = await run(selfEnrollGroupClassAction(formData));

    expect(rpcCalls).toHaveLength(0);
    expect(redirectUrl(error)).toContain("/login");
  });
});
