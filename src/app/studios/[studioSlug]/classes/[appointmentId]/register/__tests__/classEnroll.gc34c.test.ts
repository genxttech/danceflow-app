import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { FakeTable, createFakeEntitlementClient, type Row } from "@/lib/packages/__tests__/fakeEntitlementSupabase";

/**
 * GC-3.4C: public Group Class self-enrollment on /register.
 *
 * The real page, server action, data reads and shared error classifier run
 * end to end. Supabase is faked:
 *  - the USER session client serves the public read model, the user,
 *    my_verified_email, the canonical funding preview, and
 *    self_enroll_class_attendee -- whose behavior mirrors the DEV-validated
 *    RPC contract (proven against Postgres by
 *    sql-tests/test_T_gc34c_self_enroll_started_class_guard.sql) over the
 *    in-memory store;
 *  - the service-role client knows NO enrollment RPC (calling it there
 *    throws), so every enrollment provably runs under the user's auth context.
 * The two notification helpers are spied.
 */

const h = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; user_metadata: Record<string, unknown> },
  verifiedEmail: null as string | null,
  classRow: {} as Record<string, unknown>,
  db: {
    discoverable: true,
    selfAllowed: true,
    started: false,
    cancelled: false,
    capacity: null as number | null,
    revoked: false,
  },
  // Live funding candidates (what both the preview and the RPC see).
  candidates: [] as Array<{ funding_type: string; source_id: string; label: string }>,
  enrollCalls: [] as Array<Record<string, unknown>>,
  sessionRpcCalls: [] as string[],
  notifyDancer: vi.fn(),
  notifyStudio: vi.fn(),
  seq: 0,
}));

let linksTable: FakeTable;
let studiosTable: FakeTable;
let attendeesTable: FakeTable;

const ID = "11111111-1111-4111-8111-111111111111";
const STUDIO_A = "studio-a";
const STUDIO_B = "studio-b";
const USER = "user-1";
const SELF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_STUDIO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STRANGER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PKG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MEM = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const FOREIGN_PKG = "99999999-9999-4999-8999-999999999999";
const REGISTER = `/studios/salsa-house/classes/${ID}/register`;
const DANCER_PATH = (client: string) => `${REGISTER}?dancer=${client}`;

/** Mirrors self_enroll_class_attendee (gc3d + GC-3.4C) over the fake store. */
function simulateEnroll(args: Record<string, unknown>) {
  const client = String(args.p_client_id);
  const err = (message: string) => ({ data: null, error: { message } });
  const authorized = linksTable.rows.some(
    (r) => r.user_id === h.user?.id && r.studio_id === STUDIO_A && r.client_id === client && r.status === "linked" && r.can_manage_bookings === true,
  );
  if (!authorized || h.db.revoked) return err("Not authorized to enroll this client into this class.");
  if (!h.db.discoverable || !h.db.selfAllowed) return err("This class is not open for self-enrollment.");
  if (h.db.started) return err("GC34C_CLASS_STARTED: This class has already started.");

  const pkg = args.p_client_package_id as string | null;
  const mem = args.p_client_membership_id as string | null;
  if (h.candidates.length === 0) return err("No eligible package or membership found for this class.");
  let chosen = h.candidates[0];
  if (h.candidates.length > 1) {
    if ((pkg === null) === (mem === null)) return err("A single funding source choice is required.");
    const match = h.candidates.find((c) => (pkg ? c.funding_type === "package" && c.source_id === pkg : c.funding_type === "membership" && c.source_id === mem));
    if (!match) return err(`Selected ${pkg ? "package" : "membership"} is not an eligible funding source for this class.`);
    chosen = match;
  }

  if (h.db.cancelled) return err("GCSC3_CLASS_CANCELLED: This class has been cancelled and can't take new students.");
  const booked = attendeesTable.rows.filter((r) => r.status === "booked").length;
  if (h.db.capacity !== null && booked >= h.db.capacity) return err("This class has no available seats remaining.");
  if (attendeesTable.rows.some((r) => r.client_id === client && r.status !== "cancelled")) {
    return err("You are already enrolled in this class.");
  }
  h.seq += 1;
  const id = `0000000${h.seq}-0000-4000-8000-000000000000`.slice(-36);
  attendeesTable.rows.push({
    id,
    studio_id: STUDIO_A,
    appointment_id: ID,
    client_id: client,
    status: "booked",
    source: "self_service",
    billing_type: chosen.funding_type === "package" ? "package_credit" : "membership",
  });
  return { data: id, error: null };
}

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/components/public/PublicShell", () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getServerActionRateLimitKey: async () => "key",
}));
vi.mock("@/lib/notifications/groupClassNotices", () => ({
  notifyGroupClassEnrolled: (...args: unknown[]) => h.notifyDancer(...args),
  notifyStudioOfExternalGroupClassEnrollment: (...args: unknown[]) => h.notifyStudio(...args),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }), signOut: async () => ({ error: null }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.sessionRpcCalls.push(name);
      if (name === "public_group_class_occurrences") {
        return { data: args.p_appointment_id === ID ? [h.classRow] : [], error: null };
      }
      if (name === "my_verified_email") return { data: h.verifiedEmail, error: null };
      if (name === "email_binding_status") return { data: "unproven", error: null };
      if (name === "preview_self_enrollment_funding_candidates") return { data: h.candidates, error: null };
      if (name === "self_enroll_class_attendee") {
        h.enrollCalls.push(args);
        return simulateEnroll(args);
      }
      throw new Error(`Unexpected session RPC: ${name}`);
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () =>
    // No RPC handlers: any service-role RPC (including the enrollment write) throws.
    createFakeEntitlementClient({
      get client_account_links() {
        return linksTable;
      },
      get studios() {
        return studiosTable;
      },
      get appointment_attendees() {
        return attendeesTable;
      },
    }),
}));

const RegisterPage = (await import("../page")).default;
const { enrollInClassAction } = await import("../actions");

const classRow = (over: Record<string, unknown> = {}) => ({
  appointment_id: ID, series_id: null, series_root_id: null, studio_slug: "salsa-house", studio_name: "Salsa House",
  studio_logo_url: null, studio_city: "Austin", studio_state: "TX", time_zone: "America/New_York", title: "Salsa Level 1",
  starts_at: "2030-11-02T22:00:00+00:00", ends_at: "2030-11-02T23:00:00+00:00", instructor_name: null, location_label: null,
  capacity: 10, spots_remaining: 4, availability: "available", enrollment_state: "open", public_state: "upcoming", ...over,
});

function link(over: Partial<Row> & { client_id: string }): Row {
  const studioId = (over.studio_id as string) ?? STUDIO_A;
  return {
    id: `link-${over.client_id}`,
    studio_id: studioId,
    user_id: USER,
    status: "linked",
    relationship_type: "self",
    is_primary: false,
    can_manage_bookings: true,
    created_at: "2026-01-01T00:00:00Z",
    clients: { id: over.client_id, studio_id: studioId, first_name: "Pat", last_name: "Dancer" },
    ...over,
  };
}

const pkgCandidate = { funding_type: "package", source_id: PKG, label: "10-Lesson Package" };
const memCandidate = { funding_type: "membership", source_id: MEM, label: "Monthly Membership" };

async function outcome(run: () => Promise<unknown>) {
  try {
    const value = await run();
    return { html: typeof value === "string" ? value : renderToStaticMarkup(value as never) };
  } catch (error) {
    return { thrown: (error as Error).message };
  }
}

const page = (search: Record<string, string> = {}) =>
  outcome(async () =>
    renderToStaticMarkup(
      await RegisterPage({
        params: Promise.resolve({ studioSlug: "salsa-house", appointmentId: ID }),
        searchParams: Promise.resolve(search),
      }),
    ),
  );

function enrollForm(fields: Record<string, string>) {
  const data = new FormData();
  data.set("appointmentId", ID);
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const enroll = (fields: Record<string, string>) => outcome(() => enrollInClassAction(enrollForm(fields)));

const RAW_DB = /GC34C_|GCSC3_|unique|violat|P0001|23505|Not authorized to enroll|No eligible package or membership found|Selected (package|membership)/;

beforeEach(() => {
  h.user = { id: USER, email: "parent@example.com", user_metadata: {} };
  h.verifiedEmail = "parent@example.com";
  h.classRow = classRow();
  h.db = { discoverable: true, selfAllowed: true, started: false, cancelled: false, capacity: null, revoked: false };
  h.candidates = [pkgCandidate];
  h.enrollCalls.length = 0;
  h.sessionRpcCalls.length = 0;
  h.notifyDancer.mockReset();
  h.notifyStudio.mockReset();
  h.notifyDancer.mockResolvedValue({ emailsQueued: 1, pushedAccounts: 0 });
  h.notifyStudio.mockResolvedValue({ emailsQueued: 1, pushedAccounts: 0 });
  h.seq = 0;
  linksTable = new FakeTable();
  studiosTable = new FakeTable();
  attendeesTable = new FakeTable();
  studiosTable.rows = [
    { id: STUDIO_A, slug: "salsa-house" },
    { id: STUDIO_B, slug: "other-studio" },
  ];
  linksTable.rows = [link({ client_id: SELF, is_primary: true })];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("identity and authorization", () => {
  it("1. an unverified account cannot enroll (no RPC call)", async () => {
    h.verifiedEmail = null;
    expect(await enroll({ dancer: SELF })).toEqual({ thrown: `NEXT_REDIRECT:${REGISTER}` });
    expect(h.enrollCalls).toHaveLength(0);
  });

  it("2/3. a revoked or view-only relationship never reaches the RPC", async () => {
    linksTable.rows = [link({ client_id: SELF, status: "disconnected" })];
    expect(await enroll({ dancer: SELF })).toEqual({ thrown: `NEXT_REDIRECT:${REGISTER}` });
    linksTable.rows = [link({ client_id: SELF, can_manage_bookings: false })];
    expect(await enroll({ dancer: SELF })).toEqual({ thrown: `NEXT_REDIRECT:${REGISTER}` });
    expect(h.enrollCalls).toHaveLength(0);
    expect(attendeesTable.rows).toHaveLength(0);
  });

  it("4/5/20. another studio's dancer, an arbitrary id or garbage selects nothing", async () => {
    linksTable.rows.push(link({ client_id: OTHER_STUDIO, studio_id: STUDIO_B }));
    for (const dancer of [OTHER_STUDIO, STRANGER, "not-a-uuid", ""]) {
      expect(await enroll({ dancer })).toEqual({ thrown: `NEXT_REDIRECT:${REGISTER}` });
    }
    expect(h.enrollCalls).toHaveLength(0);
  });

  it("revoked between render and submit: the database refusal is translated generically and nothing is created", async () => {
    expect((await page()).html).toContain("Join this class");
    // The app-side read still sees the link, but the authoritative write refuses.
    h.db.revoked = true;
    expect(await enroll({ dancer: SELF })).toEqual({ thrown: `NEXT_REDIRECT:${DANCER_PATH(SELF)}&error=not_authorized` });
    expect(attendeesTable.rows).toHaveLength(0);
    expect(h.notifyDancer).not.toHaveBeenCalled();
    const { html } = await page({ dancer: SELF, error: "not_authorized" });
    expect(html).not.toMatch(RAW_DB);
  });

  it("the dancer must be named explicitly (never inferred from a sole dancer)", async () => {
    expect(await enroll({})).toEqual({ thrown: `NEXT_REDIRECT:${REGISTER}` });
    expect(h.enrollCalls).toHaveLength(0);
  });
});

describe("funding", () => {
  it("6/36. zero candidates: no-payment boundary state with useful next actions, no join form", async () => {
    h.candidates = [];
    const { html } = await page();
    expect(html).toContain("No class credit available");
    expect(html).toContain("No eligible class credit is available for online registration");
    expect(html).toContain('href="/studios/salsa-house"');
    expect(html).toContain(`href="/portal/salsa-house?client=${SELF}"`);
    expect(html).not.toContain("Join this class");
    expect(html).not.toMatch(/checkout|buy|purchase|pay now|card/i);
  });

  it("7. one package is auto-selected with a human summary and no selector", async () => {
    const { html } = await page();
    expect(html).toContain("Join this class");
    expect(html).toContain("Using your 10-Lesson Package");
    expect(html).not.toContain('name="fundingChoice"');
    expect(html).not.toContain(PKG);
    expect(await enroll({ dancer: SELF })).toEqual({ thrown: `NEXT_REDIRECT:${DANCER_PATH(SELF)}` });
    expect(h.enrollCalls[0]).toEqual({ p_appointment_id: ID, p_client_id: SELF, p_client_package_id: null, p_client_membership_id: null });
    expect(attendeesTable.rows[0]).toMatchObject({ billing_type: "package_credit" });
  });

  it("8. one membership is auto-selected", async () => {
    h.candidates = [memCandidate];
    const { html } = await page();
    expect(html).toContain("Covered by your Monthly Membership");
    expect(html).not.toContain('name="fundingChoice"');
    await enroll({ dancer: SELF });
    expect(attendeesTable.rows[0]).toMatchObject({ billing_type: "membership" });
  });

  it("9/35. several candidates require a deliberate choice (nothing pre-checked)", async () => {
    h.candidates = [pkgCandidate, memCandidate];
    const { html } = await page();
    expect(html).toContain("How should this class be covered?");
    expect(html).toContain(`value="package:${PKG}"`);
    expect(html).toContain(`value="membership:${MEM}"`);
    expect(html).not.toContain("checked");

    expect(await enroll({ dancer: SELF })).toEqual({ thrown: `NEXT_REDIRECT:${DANCER_PATH(SELF)}&error=choose_funding` });
    expect(attendeesTable.rows).toHaveLength(0);
    expect(await enroll({ dancer: SELF, fundingChoice: `membership:${MEM}` })).toEqual({ thrown: `NEXT_REDIRECT:${DANCER_PATH(SELF)}` });
    expect(h.enrollCalls.at(-1)).toMatchObject({ p_client_package_id: null, p_client_membership_id: MEM });
  });

  it("10/11/12/13. forged, other-studio or stale funding is refused by the RPC and translated safely", async () => {
    h.candidates = [pkgCandidate, memCandidate];
    for (const choice of [`package:${FOREIGN_PKG}`, `membership:${FOREIGN_PKG}`]) {
      const result = await enroll({ dancer: SELF, fundingChoice: choice });
      expect(result).toEqual({ thrown: `NEXT_REDIRECT:${DANCER_PATH(SELF)}&error=funding_changed` });
    }
    // Malformed choices are never passed through.
    for (const choice of ["package:not-a-uuid", `package:${PKG}:extra`, `stripe:${PKG}`]) {
      await enroll({ dancer: SELF, fundingChoice: choice });
      expect(h.enrollCalls.at(-1)).toMatchObject({ p_client_package_id: null, p_client_membership_id: null });
    }
    // Stale: the package was exhausted after render -> no funding.
    h.candidates = [];
    expect(await enroll({ dancer: SELF })).toEqual({ thrown: `NEXT_REDIRECT:${DANCER_PATH(SELF)}&error=no_funding` });
    expect(attendeesTable.rows).toHaveLength(0);

    const { html } = await page({ dancer: SELF, error: "funding_changed" });
    expect(html).not.toMatch(RAW_DB);
  });

  it("14. there is no no-entitlement path: with zero candidates the canonical RPC refuses and nothing is created", async () => {
    h.candidates = [];
    await enroll({ dancer: SELF });
    expect(attendeesTable.rows).toHaveLength(0);
    expect(h.notifyDancer).not.toHaveBeenCalled();
  });
});

describe("class state", () => {
  it("a class that has started (still 'upcoming' in the public model) shows the started state, never Join", async () => {
    // Started ten minutes ago, ends in fifty: the read model still says upcoming/open.
    const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const endsAt = new Date(Date.now() + 50 * 60 * 1000).toISOString();
    h.classRow = classRow({ starts_at: startedAt, ends_at: endsAt });

    const { html } = await page({ dancer: SELF });
    expect(html).toContain("Registration isn&#x27;t available");
    expect(html).toContain("This class has already started and can no longer be joined online.");
    expect(html).not.toContain("Join this class");
    expect(html).toContain(`href="/studios/salsa-house/classes/${ID}"`);

    // A stale submit is sent back to that state without calling the RPC.
    expect(await enroll({ dancer: SELF })).toEqual({ thrown: `NEXT_REDIRECT:${REGISTER}` });
    expect(h.enrollCalls).toHaveLength(0);
  });

  it("15/21/33/34. a future open class enrolls: one attendee, registered state, Open Student Portal", async () => {
    expect(await enroll({ dancer: SELF })).toEqual({ thrown: `NEXT_REDIRECT:${DANCER_PATH(SELF)}` });
    expect(attendeesTable.rows).toHaveLength(1);

    const { html } = await page({ dancer: SELF });
    expect(html).toContain("You&#x27;re registered");
    expect(html).toContain("Salsa Level 1");
    expect(html).toContain("Sat, Nov 2");
    expect(html).toContain("Salsa House");
    expect(html).toContain(`href="/portal/salsa-house?client=${SELF}"`);
    expect(html).toContain("Open Student Portal");
    expect(html).not.toContain("Join this class");
  });

  it.each([
    ["16. full (seat taken after render)", () => { h.db.capacity = 0; }, "full", "This class is full."],
    ["17. started (GC34C_CLASS_STARTED)", () => { h.db.started = true; }, "started", "This class has already started and can no longer be joined online."],
    ["18. cancelled", () => { h.db.cancelled = true; }, "cancelled", "This class has been cancelled."],
    ["19. no longer public", () => { h.db.discoverable = false; }, "unavailable", "Online enrollment isn&#x27;t available for this class."],
  ])("%s is translated to a clean message and creates nothing", async (_label, setup, kind, message) => {
    setup();
    expect(await enroll({ dancer: SELF })).toEqual({ thrown: `NEXT_REDIRECT:${DANCER_PATH(SELF)}&error=${kind}` });
    expect(attendeesTable.rows).toHaveLength(0);
    expect(h.notifyDancer).not.toHaveBeenCalled();
    expect(h.notifyStudio).not.toHaveBeenCalled();

    const { html } = await page({ dancer: SELF, error: kind });
    expect(html).toContain(message);
    expect(html).not.toMatch(RAW_DB);
  });

  it("a class the public model no longer offers sends a stale submit back to its public status", async () => {
    h.classRow = classRow({ public_state: "cancelled", enrollment_state: "closed" });
    expect(await enroll({ dancer: SELF })).toEqual({ thrown: `NEXT_REDIRECT:${REGISTER}` });
    expect(h.enrollCalls).toHaveLength(0);
  });

  it("a wrong or hidden class id never reaches the RPC", async () => {
    const data = enrollForm({ dancer: SELF });
    data.set("appointmentId", STRANGER);
    expect(await outcome(() => enrollInClassAction(data))).toEqual({ thrown: "NEXT_REDIRECT:/discover/classes" });
    data.set("appointmentId", "garbage");
    expect(await outcome(() => enrollInClassAction(data))).toEqual({ thrown: "NEXT_REDIRECT:/discover/classes" });
    expect(h.enrollCalls).toHaveLength(0);
  });

  it("an unknown error code in the URL never renders raw text", async () => {
    const { html } = await page({ dancer: SELF, error: "GC34C_CLASS_STARTED: raw" });
    expect(html).not.toMatch(RAW_DB);
    expect(html).not.toContain('role="alert"');
  });
});

describe("idempotency and notifications", () => {
  it("21/25/26. a new enrollment notifies the dancer and the studio exactly once, keyed by the new attendee id", async () => {
    await enroll({ dancer: SELF });
    const attendeeId = attendeesTable.rows[0].id;
    expect(h.notifyDancer).toHaveBeenCalledTimes(1);
    expect(h.notifyDancer).toHaveBeenCalledWith({
      studioId: STUDIO_A,
      clientId: SELF,
      appointmentIds: [ID],
      eventId: attendeeId,
      series: false,
      selfEnrolled: true,
    });
    expect(h.notifyStudio).toHaveBeenCalledTimes(1);
    expect(h.notifyStudio).toHaveBeenCalledWith({ studioId: STUDIO_A, attendeeId });
    // Dancer confirmation first, studio notice second, both after the commit.
    expect(h.notifyDancer.mock.invocationCallOrder[0]).toBeLessThan(h.notifyStudio.mock.invocationCallOrder[0]);
  });

  it("22/23/24/28. double submit / retry: one attendee, already-enrolled is success, no second notification", async () => {
    await enroll({ dancer: SELF });
    const second = await enroll({ dancer: SELF });
    expect(second).toEqual({ thrown: `NEXT_REDIRECT:${DANCER_PATH(SELF)}` });
    expect(attendeesTable.rows).toHaveLength(1);
    expect(h.notifyDancer).toHaveBeenCalledTimes(1);
    expect(h.notifyStudio).toHaveBeenCalledTimes(1);

    const { html } = await page({ dancer: SELF });
    expect(html).toContain("You&#x27;re registered");
    expect(html).not.toContain('role="alert"');
  });

  it("27. a failed enrollment sends neither notification", async () => {
    h.db.capacity = 0;
    await enroll({ dancer: SELF });
    expect(h.notifyDancer).not.toHaveBeenCalled();
    expect(h.notifyStudio).not.toHaveBeenCalled();
  });

  it("29. a notification failure never undoes or misreports the committed enrollment", async () => {
    h.notifyDancer.mockRejectedValue(new Error("provider down"));
    h.notifyStudio.mockRejectedValue(new Error("provider down"));
    expect(await enroll({ dancer: SELF })).toEqual({ thrown: `NEXT_REDIRECT:${DANCER_PATH(SELF)}` });
    expect(attendeesTable.rows).toHaveLength(1);
    expect(h.notifyStudio).toHaveBeenCalledTimes(1);
    expect((await page({ dancer: SELF })).html).toContain("You&#x27;re registered");
  });
});

describe("security", () => {
  it("31. the enrollment RPC runs on the user session (the service-role client has no such RPC)", async () => {
    await enroll({ dancer: SELF });
    expect(h.sessionRpcCalls).toContain("self_enroll_class_attendee");
    expect(h.enrollCalls).toHaveLength(1);
  });

  it("32. browser-supplied studio, capacity, price, eligibility or relationship fields are ignored", async () => {
    await enroll({
      dancer: SELF,
      studioId: STUDIO_B,
      capacity: "999",
      price: "0",
      eligible: "true",
      relationshipType: "guardian",
      p_client_id: STRANGER,
    });
    expect(h.enrollCalls).toEqual([{ p_appointment_id: ID, p_client_id: SELF, p_client_package_id: null, p_client_membership_id: null }]);
  });

  it("30. no raw database text reaches the URL or the page for any failure", async () => {
    for (const setup of [() => { h.db.started = true; }, () => { h.db.cancelled = true; }, () => { h.db.capacity = 0; }, () => { h.candidates = []; }]) {
      h.db = { discoverable: true, selfAllowed: true, started: false, cancelled: false, capacity: null, revoked: false };
      h.candidates = [pkgCandidate];
      setup();
      const result = await enroll({ dancer: SELF });
      expect(result.thrown).not.toMatch(RAW_DB);
    }
  });

  it("a guardian enrolls a managed dependent; the dependent's own id is the one written", async () => {
    linksTable.rows.push(link({ client_id: KID, relationship_type: "guardian", clients: { id: KID, studio_id: STUDIO_A, first_name: "Sam", last_name: "Kid" } }));
    expect(await enroll({ dancer: KID })).toEqual({ thrown: `NEXT_REDIRECT:${DANCER_PATH(KID)}` });
    expect(attendeesTable.rows[0]).toMatchObject({ client_id: KID });
    const { html } = await page({ dancer: KID });
    expect(html).toContain("Sam Kid is registered");
  });
});
