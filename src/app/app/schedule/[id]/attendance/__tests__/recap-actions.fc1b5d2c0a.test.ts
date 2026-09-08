import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FC-1B5D2c-0A: action-level authorization tests for group lesson recap
 * create/publish/unpublish. Before this change, requireStudioAccess()
 * authorized on "any active user_studio_roles row at this studio" -- no
 * role list at all, so ANY active studio member (including an unassigned
 * instructor, or front_desk) could author recap content for a class they
 * don't teach.
 *
 * The new requireStudioAccess() reuses requireAppointmentRelationshipAccess
 * (unit-tested in isolation at
 * src/lib/auth/__tests__/appointmentAccess.fc1b5d2.test.ts, mocked here),
 * then layers a recap-specific narrowing on top: unlike attendance,
 * front_desk is explicitly EXCLUDED from recap-write authority even though
 * it is in the shared primitive's "broad" scope -- that narrowing is real
 * business logic added in recap-actions.ts itself, not something the mocked
 * primitive can prove, so it is exercised directly here.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/notifications/expoPush", () => ({
  sendMobilePushToUser: vi.fn().mockResolvedValue(undefined),
}));

const getCurrentStudioContextMock = vi.fn();
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...args: unknown[]) => getCurrentStudioContextMock(...args),
}));

const requireAppointmentRelationshipAccessMock = vi.fn();
vi.mock("@/lib/auth/appointmentAccess", () => ({
  requireAppointmentRelationshipAccess: (...args: unknown[]) =>
    requireAppointmentRelationshipAccessMock(...args),
}));

const fromCalls: string[] = [];

function benignChain() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.eq = self;
  chain.in = self;
  chain.delete = self;
  chain.upsert = () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: "recap-1" }, error: null }) }) });
  chain.update = self;
  chain.single = () => Promise.resolve({ data: { id: "recap-1" }, error: null });
  chain.maybeSingle = () => Promise.resolve({ data: { id: "recap-1" }, error: null });
  chain.then = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (r: unknown) => unknown,
  ) => Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
  return chain;
}

function createFakeSupabase() {
  return {
    from(table: string) {
      fromCalls.push(table);
      return benignChain();
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => createFakeSupabase(),
}));

const STUDIO_ID = "studio-1";
const USER_ID = "user-1";
const APPOINTMENT_ID = "appt-1";

function studioContext(studioRole: string, isPlatformAdmin = false) {
  return { studioId: STUDIO_ID, studioRole, isPlatformAdmin, userId: USER_ID, email: "x@y.com" };
}

function relationshipResult(
  scope: "broad" | "own-instructor" | "own-floor-rental",
  appointmentType = "group_class",
) {
  return {
    ok: true,
    scope,
    appointment: {
      id: APPOINTMENT_ID,
      studio_id: STUDIO_ID,
      appointment_type: appointmentType,
      title: "Beginner Salsa",
    },
  };
}

const deny = {
  ok: false,
  reason: "You can only manage your own assigned appointments or your own floor space rental bookings.",
};

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function run(promise: Promise<unknown>) {
  return promise.catch((e) => e);
}

function redirectUrl(error: unknown): string {
  const digest = (error as { digest?: string }).digest ?? "";
  return digest.split(";")[2] ?? "";
}

const recapActions = await import("../recap-actions");

beforeEach(() => {
  fromCalls.length = 0;
  getCurrentStudioContextMock.mockReset();
  requireAppointmentRelationshipAccessMock.mockReset();
});

const CASES: Array<{
  name: string;
  action: (formData: FormData) => Promise<void>;
  fields: Record<string, string>;
  successParam: string;
  errorParam: string;
}> = [
  {
    name: "saveGroupLessonRecapAction",
    action: recapActions.saveGroupLessonRecapAction,
    fields: { appointmentId: APPOINTMENT_ID, title: "Class Recap" },
    successParam: "recap_saved",
    errorParam: "recap_save_failed",
  },
  {
    name: "publishGroupLessonRecapAction",
    action: recapActions.publishGroupLessonRecapAction,
    fields: { appointmentId: APPOINTMENT_ID },
    successParam: "recap_published",
    errorParam: "recap_publish_failed",
  },
  {
    name: "unpublishGroupLessonRecapAction",
    action: recapActions.unpublishGroupLessonRecapAction,
    fields: { appointmentId: APPOINTMENT_ID },
    successParam: "recap_unpublished",
    errorParam: "recap_unpublish_failed",
  },
];

describe.each(CASES)("$name -- FC-1B5D2c-0A", ({ action, fields, successParam, errorParam }) => {
  it("owner/admin (broad + narrowed role) is allowed", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("studio_owner"));
    requireAppointmentRelationshipAccessMock.mockResolvedValue(relationshipResult("broad"));

    const error = await run(action(formDataFor(fields)));

    expect(redirectUrl(error)).toContain(`success=${successParam}`);
  });

  it("platform_admin is allowed", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("platform_admin", true));
    requireAppointmentRelationshipAccessMock.mockResolvedValue(relationshipResult("broad"));

    const error = await run(action(formDataFor(fields)));

    expect(redirectUrl(error)).toContain(`success=${successParam}`);
  });

  it("front_desk is DENIED even though the shared primitive reports scope 'broad' -- recap authorship excludes front_desk", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("front_desk"));
    requireAppointmentRelationshipAccessMock.mockResolvedValue(relationshipResult("broad"));

    const error = await run(action(formDataFor(fields)));

    expect(redirectUrl(error)).toContain(`error=${errorParam}`);
    expect(fromCalls).not.toContain("group_lesson_recaps");
  });

  it("assigned instructor (own-instructor scope) is allowed for their own class", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("instructor"));
    requireAppointmentRelationshipAccessMock.mockResolvedValue(relationshipResult("own-instructor"));

    const error = await run(action(formDataFor(fields)));

    expect(redirectUrl(error)).toContain(`success=${successParam}`);
  });

  it("unassigned instructor (colleague's class) is denied", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("instructor"));
    requireAppointmentRelationshipAccessMock.mockResolvedValue(deny);

    const error = await run(action(formDataFor(fields)));

    expect(redirectUrl(error)).toContain(`error=${errorParam}`);
    expect(fromCalls).not.toContain("group_lesson_recaps");
  });

  it("cross-studio appointment (relationship primitive returns not-found) is denied", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("instructor"));
    requireAppointmentRelationshipAccessMock.mockResolvedValue({
      ok: false,
      reason: "Appointment not found.",
    });

    const error = await run(action(formDataFor(fields)));

    expect(redirectUrl(error)).toContain(`error=${errorParam}`);
  });

  it("own-floor-rental scope alone is denied -- floor-rental relationship never grants host class recap authority", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("independent_instructor"));
    requireAppointmentRelationshipAccessMock.mockResolvedValue(
      relationshipResult("own-floor-rental"),
    );

    const error = await run(action(formDataFor(fields)));

    expect(redirectUrl(error)).toContain(`error=${errorParam}`);
    expect(fromCalls).not.toContain("group_lesson_recaps");
  });

  it("non-group_class appointment is denied even for a broad role (preserves existing type restriction)", async () => {
    getCurrentStudioContextMock.mockResolvedValue(studioContext("studio_owner"));
    requireAppointmentRelationshipAccessMock.mockResolvedValue(
      relationshipResult("broad", "private_lesson"),
    );

    const error = await run(action(formDataFor(fields)));

    expect(redirectUrl(error)).toContain(`error=${errorParam}`);
    expect(fromCalls).not.toContain("group_lesson_recaps");
  });
});
