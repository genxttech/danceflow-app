import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Landmark 1A Slice 7: a DB trigger now rejects a live booking_requests row
 * naming an instructor who is no longer assignable. createPortalScheduleRequestAction
 * must surface that reason instead of the generic "Could not submit" message,
 * and must leave every other insert failure generic.
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

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/notifications/expoPush", () => ({
  sendMobilePushToUser: vi.fn().mockResolvedValue(undefined),
}));

const STUDIO = { id: "studio-1", name: "Studio", slug: "sunrise-dance" };
let insertErrorMessage = "";
let insertedRows: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      let inserting = false;
      const terminal = () => {
        if (table === "studios") return { data: STUDIO, error: null };
        if (table === "clients") {
          return { data: { id: "client-1", first_name: "A", last_name: "B", email: "a@b.test", phone: null }, error: null };
        }
        if (table === "studio_settings") {
          return {
            data: {
              timezone: "UTC",
              portal_self_scheduling_enabled: true,
              portal_self_scheduling_mode: "request_only",
              portal_self_scheduling_window_days: 90,
              portal_self_scheduling_min_notice_hours: 0,
              booking_request_allowed_weekdays: [0, 1, 2, 3, 4, 5, 6],
              booking_request_start_time: "00:00",
              booking_request_end_time: "23:59",
              portal_bookable_lesson_types: ["private_lesson"],
              portal_bookable_instructor_ids: [],
            },
            error: null,
          };
        }
        if (table === "booking_requests") {
          return inserting
            ? { data: null, error: { message: insertErrorMessage } }
            : { data: null, error: null }; // duplicate-request lookup: none
        }
        throw new Error(`unexpected table ${table}`);
      };
      const chain: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return undefined;
            if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(terminal());
            if (prop === "insert") {
              return (row: Record<string, unknown>) => {
                inserting = true;
                insertedRows.push(row);
                return chain;
              };
            }
            return () => chain;
          },
        },
      );
      return chain;
    },
  }),
}));

vi.mock("@/lib/student-identity/portal-context", () => ({
  resolvePortalRelationship: async () => ({ clientId: "client-1" }),
  portalClientPath: (slug: string, clientId: string) => `/portal/${slug}/${clientId}`,
}));

const { createPortalScheduleRequestAction } = await import("../actions");
const { INSTRUCTOR_NOT_ASSIGNABLE_MESSAGE } = await import("@/lib/instructors/assignability");

function form() {
  const fd = new FormData();
  fd.set("studioSlug", STUDIO.slug);
  fd.set("appointmentType", "private_lesson");
  fd.set("instructorId", "11111111-1111-4111-8111-111111111111");
  fd.set("requestedDate", new Date(Date.now() + 5 * 86400e3).toISOString().slice(0, 10));
  fd.set("requestedTime", "12:00");
  fd.set("durationMinutes", "60");
  return fd;
}

async function redirectedTo(promise: Promise<unknown>): Promise<string> {
  const error = (await promise.then(
    () => null,
    (e) => e,
  )) as { digest?: string } | null;
  expect(error?.digest).toBeTruthy();
  return decodeURIComponent(error!.digest!);
}

beforeEach(() => {
  insertedRows = [];
  insertErrorMessage = "";
});

describe("createPortalScheduleRequestAction -- Slice 7 friendly trigger rejection", () => {
  it("surfaces the assignability reason when the DB trigger rejects the instructor", async () => {
    insertErrorMessage = INSTRUCTOR_NOT_ASSIGNABLE_MESSAGE;

    const url = await redirectedTo(createPortalScheduleRequestAction(form()));

    expect(insertedRows).toHaveLength(1);
    expect(url).toContain(`error=${INSTRUCTOR_NOT_ASSIGNABLE_MESSAGE}`);
    expect(url).not.toContain("Could not submit your schedule request.");
  });

  it("keeps every other insert failure generic (no DB detail leaks)", async () => {
    insertErrorMessage = 'duplicate key value violates unique constraint "x"';

    const url = await redirectedTo(createPortalScheduleRequestAction(form()));

    expect(url).toContain("error=Could not submit your schedule request.");
    expect(url).not.toContain("duplicate key");
  });
});
