import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

/**
 * GC-3.4B-1: the public class identity step (/studios/{slug}/classes/{id}/register)
 * and its "Check again" action, end to end over the REAL portal-linking claim
 * helper and the REAL relationship reads. Only Supabase is faked:
 *  - the session client serves the public class read model, the user and
 *    my_verified_email();
 *  - the service-role client is an in-memory store whose claim RPC mirrors the
 *    released contract (staff-issued, unexpired invitations for the exact
 *    verified email, optionally scoped to one studio).
 * Any table or RPC outside the identity surface throws, so a test passing
 * proves no enrollment, attendee, payment or package path was touched.
 */

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  user: null as null | { id: string; email: string; user_metadata: Record<string, unknown> },
  verifiedEmail: null as string | null,
  sessionRpcCalls: [] as string[],
  adminRpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  claimError: null as null | { code: string; message: string },
  rateAllowed: true,
  bindingStatus: "unproven" as string,
  // GC-3.4C: canonical funding preview rows for the resolved dancer (one package by default).
  previewRows: [{ funding_type: "package", source_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", label: "10-Lesson Package" }] as Array<Record<string, unknown>>,
  signOutCalls: [] as unknown[],
  clientsReads: 0,
}));

let linksTable: FakeTable;
let studiosTable: FakeTable;
let clientsTable: FakeTable;
let profilesTable: FakeTable;
let dancerProfilesTable: FakeTable;
let attendeesTable: FakeTable;

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
vi.mock("@/lib/student-identity/account-security", () => ({ reactivateDanceFlowAccount: async () => undefined }));
vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: h.rateAllowed }),
  getServerActionRateLimitKey: async (scope: string, parts: unknown[]) => [scope, ...parts].join(":"),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: h.user } }),
      signOut: async (options: unknown) => {
        h.signOutCalls.push(options);
        return { error: null };
      },
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.sessionRpcCalls.push(name);
      if (name === "public_group_class_occurrences") {
        const id = args.p_appointment_id as string | null;
        return { data: h.rows.filter((r) => r.appointment_id === id), error: null };
      }
      if (name === "my_verified_email") return { data: h.verifiedEmail, error: null };
      if (name === "email_binding_status") return { data: h.bindingStatus, error: null };
      if (name === "preview_self_enrollment_funding_candidates") return { data: h.previewRows, error: null };
      throw new Error(`Unexpected session RPC: ${name}`);
    },
  }),
}));

function withUpsert(table: FakeTable) {
  return {
    upsert: async (payload: Row) => {
      table.rows.push(payload);
      return { error: null };
    },
  };
}

/** Mirrors claim_client_account_invitation's released contract over the fake store. */
function simulateClaim(args: Record<string, unknown>) {
  if (h.claimError) return { error: h.claimError };
  const email = String(args.p_email ?? "").trim().toLowerCase();
  if (h.verifiedEmail !== email) return { data: [] };
  const claimed = linksTable.rows
    .filter(
      (row) =>
        ["invited", "claim_pending"].includes(String(row.status)) &&
        String(row.invited_email ?? "").toLowerCase() === email &&
        (!args.p_studio_id || row.studio_id === args.p_studio_id) &&
        (!row.invite_expires_at || String(row.invite_expires_at) > new Date().toISOString()),
    )
    .map((row) => {
      Object.assign(row, { status: "linked", user_id: args.p_user_id });
      return { client_id: row.client_id, studio_id: row.studio_id, link_id: row.id };
    });
  return { data: claimed };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const base = createFakeEntitlementClient(
      {
        get client_account_links() {
          return linksTable;
        },
        get studios() {
          return studiosTable;
        },
        get clients() {
          h.clientsReads += 1;
          return clientsTable;
        },
        get profiles() {
          return profilesTable;
        },
        get appointment_attendees() {
          return attendeesTable;
        },
        get dancer_profiles() {
          return dancerProfilesTable;
        },
      },
      {
        claim_client_account_invitation: (args) => {
          h.adminRpcCalls.push({ fn: "claim_client_account_invitation", args });
          return simulateClaim(args);
        },
      },
    );
    return {
      ...base,
      from: (table: string) => ({
        ...base.from(table),
        ...(table === "profiles" ? withUpsert(profilesTable) : {}),
        ...(table === "dancer_profiles" ? withUpsert(dancerProfilesTable) : {}),
      }),
      auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id } }, error: null }) } },
    };
  },
}));

const RegisterPage = (await import("../page")).default;
const { checkClassRegistrationLinkAction, signInAgainForClassAction } = await import("../actions");

const ID = "11111111-1111-4111-8111-111111111111";
const STUDIO_A = "studio-a";
const STUDIO_B = "studio-b";
const USER = "user-1";
const EMAIL = "parent@example.com";
const SELF_CLIENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KID_CLIENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_STUDIO_CLIENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STRANGER_CLIENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REGISTER = `/studios/salsa-house/classes/${ID}/register`;

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

const page = async (search: Record<string, string> = {}, slug = "salsa-house") =>
  renderToStaticMarkup(
    await RegisterPage({
      params: Promise.resolve({ studioSlug: slug, appointmentId: ID }),
      searchParams: Promise.resolve(search),
    }),
  );

async function outcome(run: () => Promise<unknown>) {
  try {
    const value = await run();
    return { html: typeof value === "string" ? value : renderToStaticMarkup(value as never) };
  } catch (error) {
    return { thrown: (error as Error).message };
  }
}

function checkAgainForm(appointmentId = ID) {
  const data = new FormData();
  data.set("appointmentId", appointmentId);
  return data;
}

const SENSITIVE = /parent@example\.com|invit(ed|ation) email|relationship|guardian|conflict|duplicate|23505|claim/i;

beforeEach(() => {
  h.rows = [classRow()];
  h.user = { id: USER, email: EMAIL, user_metadata: {} };
  h.verifiedEmail = EMAIL;
  h.sessionRpcCalls.length = 0;
  h.adminRpcCalls.length = 0;
  h.claimError = null;
  h.rateAllowed = true;
  h.bindingStatus = "unproven";
  h.previewRows = [{ funding_type: "package", source_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", label: "10-Lesson Package" }];
  h.signOutCalls.length = 0;
  h.clientsReads = 0;
  linksTable = new FakeTable();
  studiosTable = new FakeTable();
  clientsTable = new FakeTable();
  profilesTable = new FakeTable();
  dancerProfilesTable = new FakeTable();
  attendeesTable = new FakeTable();
  studiosTable.rows = [
    { id: STUDIO_A, slug: "salsa-house" },
    { id: STUDIO_B, slug: "other-studio" },
  ];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("signed out", () => {
  it("1. sends a signed-out visitor to login with the canonical register path as next", async () => {
    h.user = null;
    expect(await outcome(() => page())).toEqual({
      thrown: `NEXT_REDIRECT:/login?intent=public&next=${encodeURIComponent(REGISTER)}`,
    });
  });

  it("ignores any next-like query on /register (the route itself is the intent)", async () => {
    h.user = null;
    const result = await outcome(() => page({ next: "https://evil.example/phish", dancer: SELF_CLIENT }));
    expect(result.thrown).toBe(`NEXT_REDIRECT:/login?intent=public&next=${encodeURIComponent(REGISTER)}`);
  });
});

describe("unverified", () => {
  it("4. an account without a canonical verified email is sent through verify-email with next preserved", async () => {
    h.verifiedEmail = null;
    linksTable.rows = [link({ client_id: SELF_CLIENT })];
    const { html } = await outcome(() => page());
    expect(html).toContain("Confirm your email to continue");
    expect(html).toContain(`/account/verify-email?next=${encodeURIComponent(REGISTER)}`);
    // Even an existing link is not shown before verified identity.
    expect(html).not.toContain("Open Student Portal");
    expect(html).not.toContain("Pat Dancer");
  });

  it("an already-bound email on a session that predates binding gets Sign in again, not a verify-email bounce", async () => {
    h.verifiedEmail = null;
    h.bindingStatus = "bound";
    linksTable.rows = [link({ client_id: SELF_CLIENT })];
    const { html } = await outcome(() => page());
    expect(html).toContain("Sign in again to continue");
    expect(html).toContain("Sign in again");
    expect(html).not.toContain("/account/verify-email");
    expect(html).not.toContain("Pat Dancer");
    expect(html).not.toContain("Open Student Portal");
  });

  it("Sign in again signs out only this session and returns through login to the canonical register path", async () => {
    expect(await outcome(() => signInAgainForClassAction(checkAgainForm()))).toEqual({
      thrown: `NEXT_REDIRECT:/login?intent=public&next=${encodeURIComponent(REGISTER)}`,
    });
    expect(h.signOutCalls).toEqual([{ scope: "local" }]);

    // Garbage input never signs anyone out or builds a return path from browser data.
    h.signOutCalls.length = 0;
    expect((await outcome(() => signInAgainForClassAction(checkAgainForm("https://evil.example")))).thrown).toBe(
      "NEXT_REDIRECT:/discover/classes",
    );
    expect(h.signOutCalls).toHaveLength(0);
  });
});

describe("linking via the existing invitation claim only", () => {
  it("neither /register nor Check again ever reads the clients table (no clients.email matching path)", async () => {
    clientsTable.rows = [{ id: STRANGER_CLIENT, studio_id: STUDIO_A, email: EMAIL, first_name: "Kid", last_name: "X" }];
    await outcome(() => page());
    await outcome(() => checkClassRegistrationLinkAction(checkAgainForm()));
    await outcome(() => page({ check: "done" }));
    expect(h.clientsReads).toBe(0);
  });

  it("5. a verified account with a staff-issued invitation is linked by Check again and reaches the join step", async () => {
    linksTable.rows = [
      link({ client_id: SELF_CLIENT, user_id: null, status: "invited", invited_email: EMAIL, invite_expires_at: "2099-01-01T00:00:00Z" }),
    ];

    expect((await outcome(() => page())).html).toContain("You&#x27;re not set up with Salsa House yet");
    expect(await outcome(() => checkClassRegistrationLinkAction(checkAgainForm()))).toEqual({
      thrown: `NEXT_REDIRECT:${REGISTER}?check=done`,
    });

    const { html } = await outcome(() => page({ check: "done" }));
    // GC-3.4C: the identity step now ends at the join step for the linked dancer.
    expect(html).toContain("Join this class");
    expect(html).toContain(`name="dancer" value="${SELF_CLIENT}"`);
  });

  it("6. a client record with the same email but no invitation is NOT linked", async () => {
    clientsTable.rows = [{ id: STRANGER_CLIENT, studio_id: STUDIO_A, email: EMAIL, first_name: "Kid", last_name: "Same-Email" }];

    await outcome(() => checkClassRegistrationLinkAction(checkAgainForm()));
    const { html } = await outcome(() => page({ check: "done" }));

    expect(linksTable.rows).toHaveLength(0);
    expect(html).toContain("You&#x27;re not set up with Salsa House yet");
    expect(html).not.toContain("Same-Email");
  });

  it("11. Check again calls only the canonical claim, scoped to this class's studio, for the verified email", async () => {
    await outcome(() => checkClassRegistrationLinkAction(checkAgainForm()));
    expect(h.adminRpcCalls).toEqual([
      {
        fn: "claim_client_account_invitation",
        args: { p_user_id: USER, p_email: EMAIL, p_studio_id: STUDIO_A },
      },
    ]);
  });

  it("an invitation for another studio is not claimed by this class's Check again", async () => {
    linksTable.rows = [
      link({ client_id: OTHER_STUDIO_CLIENT, studio_id: STUDIO_B, user_id: null, status: "invited", invited_email: EMAIL }),
    ];
    await outcome(() => checkClassRegistrationLinkAction(checkAgainForm()));
    expect(linksTable.rows[0].status).toBe("invited");
  });

  it("Check again is bounded by the existing rate limiter and then claims nothing", async () => {
    h.rateAllowed = false;
    expect(await outcome(() => checkClassRegistrationLinkAction(checkAgainForm()))).toEqual({
      thrown: `NEXT_REDIRECT:${REGISTER}?check=wait`,
    });
    expect(h.adminRpcCalls).toHaveLength(0);
  });

  it("Check again requires sign-in and a verified email, and re-derives the class (browser input is only the id)", async () => {
    h.verifiedEmail = null;
    expect((await outcome(() => checkClassRegistrationLinkAction(checkAgainForm()))).thrown).toBe(`NEXT_REDIRECT:${REGISTER}`);
    h.user = null;
    expect((await outcome(() => checkClassRegistrationLinkAction(checkAgainForm()))).thrown).toBe(
      `NEXT_REDIRECT:/login?intent=public&next=${encodeURIComponent(REGISTER)}`,
    );
    expect((await outcome(() => checkClassRegistrationLinkAction(checkAgainForm("not-a-uuid")))).thrown).toBe(
      "NEXT_REDIRECT:/discover/classes",
    );
    expect(h.adminRpcCalls).toHaveLength(0);
  });
});

describe("one generic unlinked state (no existence oracle)", () => {
  async function unlinkedHtml() {
    await outcome(() => checkClassRegistrationLinkAction(checkAgainForm()));
    return (await outcome(() => page({ check: "done" }))).html;
  }

  it("7-10. no record, a same-email record, an expired invitation and a failing (ambiguous) claim render identically", async () => {
    const variants: Array<() => void> = [
      () => {},
      () => {
        clientsTable.rows = [{ id: STRANGER_CLIENT, studio_id: STUDIO_A, email: EMAIL, first_name: "Kid", last_name: "X" }];
      },
      () => {
        linksTable.rows = [
          link({ client_id: SELF_CLIENT, user_id: null, status: "invited", invited_email: EMAIL, invite_expires_at: "2020-01-01T00:00:00Z" }),
        ];
      },
      () => {
        linksTable.rows = [
          link({ id: "dup-1", client_id: SELF_CLIENT, user_id: null, status: "invited", invited_email: EMAIL }),
          link({ id: "dup-2", client_id: KID_CLIENT, user_id: null, status: "invited", invited_email: EMAIL }),
        ];
        h.claimError = { code: "23505", message: 'duplicate key value violates unique constraint "client_account_links_one_primary_per_user_studio"' };
      },
      () => {
        // A link that exists but grants no booking authority is not "connected" for this step either.
        linksTable.rows = [link({ client_id: SELF_CLIENT, can_manage_bookings: false })];
      },
    ];

    const outputs: string[] = [];
    for (const setup of variants) {
      linksTable.rows = [];
      clientsTable.rows = [];
      h.claimError = null;
      setup();
      outputs.push((await unlinkedHtml()) ?? "<no html rendered>");
    }

    for (const html of outputs) {
      expect(html).toBe(outputs[0]);
      expect(html).toContain("Your DanceFlow account isn&#x27;t connected to a student you can book for at this studio yet.");
      expect(html).toContain('href="/studios/salsa-house"');
      expect(html).toContain("Check again");
      expect(html).not.toMatch(SENSITIVE);
      expect(html).not.toContain("Open Student Portal");
    }
  });

  it("9. a failing claim never grants anything and authentication-side state is untouched", async () => {
    linksTable.rows = [link({ client_id: SELF_CLIENT, user_id: null, status: "invited", invited_email: EMAIL })];
    h.claimError = { code: "23505", message: "boom" };

    await outcome(() => checkClassRegistrationLinkAction(checkAgainForm()));

    expect(linksTable.rows[0]).toMatchObject({ status: "invited", user_id: null });
    expect((await outcome(() => page())).html).not.toContain("Open Student Portal");
  });
});

describe("dancer resolution", () => {
  it("12. one manageable dancer is selected automatically (no chooser)", async () => {
    linksTable.rows = [link({ client_id: SELF_CLIENT, is_primary: true })];
    const { html } = await outcome(() => page());
    expect(html).toContain("Join this class");
    expect(html).toContain(`name="dancer" value="${SELF_CLIENT}"`);
    expect(html).not.toContain("Who is this class for?");
    expect(html).not.toContain("Choose a different dancer");
  });

  it("13. several manageable dancers get a chooser of only those dancers", async () => {
    linksTable.rows = [
      link({ client_id: SELF_CLIENT, is_primary: true, clients: { id: SELF_CLIENT, studio_id: STUDIO_A, first_name: "Pat", last_name: "Parent" } }),
      link({ client_id: KID_CLIENT, relationship_type: "guardian", clients: { id: KID_CLIENT, studio_id: STUDIO_A, first_name: "Sam", last_name: "Kid" } }),
    ];
    const { html } = await outcome(() => page());
    expect(html).toContain("Who is this class for?");
    expect(html).toContain("Pat Parent");
    expect(html).toContain("Sam Kid");
    expect(html).toContain(`${REGISTER}?dancer=${KID_CLIENT}`);
    expect(html).not.toContain("Open Student Portal");
  });

  it("14/15. view-only, unlinked and other-studio relationships are omitted", async () => {
    linksTable.rows = [
      link({ client_id: SELF_CLIENT, clients: { id: SELF_CLIENT, studio_id: STUDIO_A, first_name: "Pat", last_name: "Parent" } }),
      link({ client_id: KID_CLIENT, can_manage_bookings: false, clients: { id: KID_CLIENT, studio_id: STUDIO_A, first_name: "View", last_name: "Only" } }),
      link({ client_id: STRANGER_CLIENT, status: "disconnected", clients: { id: STRANGER_CLIENT, studio_id: STUDIO_A, first_name: "Former", last_name: "Link" } }),
      link({ client_id: OTHER_STUDIO_CLIENT, studio_id: STUDIO_B, clients: { id: OTHER_STUDIO_CLIENT, studio_id: STUDIO_B, first_name: "Other", last_name: "Studio" } }),
    ];
    const { html } = await outcome(() => page());
    expect(html).toContain("Join this class");
    for (const name of ["View Only", "Former Link", "Other Studio"]) expect(html).not.toContain(name);
  });

  it("a link row whose client belongs to another studio is omitted (studio isolation on both sides)", async () => {
    linksTable.rows = [link({ client_id: OTHER_STUDIO_CLIENT, clients: { id: OTHER_STUDIO_CLIENT, studio_id: STUDIO_B, first_name: "Cross", last_name: "Tenant" } })];
    const { html } = await outcome(() => page());
    expect(html).toContain("You&#x27;re not set up with Salsa House yet");
    expect(html).not.toContain("Cross Tenant");
  });

  it("16. a valid ?dancer= is re-resolved from the account's own relationships on every request", async () => {
    linksTable.rows = [
      link({ client_id: SELF_CLIENT, is_primary: true }),
      link({ client_id: KID_CLIENT, relationship_type: "guardian", clients: { id: KID_CLIENT, studio_id: STUDIO_A, first_name: "Sam", last_name: "Kid" } }),
    ];
    const first = await outcome(() => page({ dancer: KID_CLIENT }));
    expect(first.html).toContain("For Sam Kid");
    expect(first.html).toContain(`name="dancer" value="${KID_CLIENT}"`);
    expect(first.html).toContain("Choose a different dancer");

    // The relationship is revoked: the same URL no longer selects anyone.
    linksTable.rows[1].status = "disconnected";
    expect(await outcome(() => page({ dancer: KID_CLIENT }))).toEqual({ thrown: `NEXT_REDIRECT:${REGISTER}` });
  });

  it("17. a substituted client id (other studio, stranger, garbage) selects nothing and fails closed", async () => {
    linksTable.rows = [
      link({ client_id: SELF_CLIENT }),
      // Deliberately unsafe fixture: this user IS linked to OTHER_STUDIO_CLIENT, in another studio.
      // A resolver that ignored the class's studio would accept it.
      link({ client_id: OTHER_STUDIO_CLIENT, studio_id: STUDIO_B, clients: { id: OTHER_STUDIO_CLIENT, studio_id: STUDIO_B, first_name: "Other", last_name: "Studio" } }),
    ];
    for (const dancer of [OTHER_STUDIO_CLIENT, STRANGER_CLIENT, "not-a-uuid", "../../admin"]) {
      expect(await outcome(() => page({ dancer }))).toEqual({ thrown: `NEXT_REDIRECT:${REGISTER}` });
    }
  });
});

describe("class truth", () => {
  it.each([
    ["18. cancelled", { public_state: "cancelled", enrollment_state: "closed" }, "This class has been cancelled."],
    ["19. past", { public_state: "past", enrollment_state: "closed" }, "This class has already taken place."],
    ["full", { availability: "full", spots_remaining: 0, enrollment_state: "full" }, "This class is full."],
    ["staff-only", { enrollment_state: "unavailable" }, "Contact the studio to join."],
  ])("%s class cannot proceed and shows public status with a way back", async (_label, over, message) => {
    h.rows = [classRow(over)];
    linksTable.rows = [link({ client_id: SELF_CLIENT })];
    const { html } = await outcome(() => page());
    expect(html).toContain("Registration isn&#x27;t available");
    expect(html).toContain(message);
    expect(html).toContain(`href="/studios/salsa-house/classes/${ID}"`);
    expect(html).not.toContain("Open Student Portal");
    expect(h.sessionRpcCalls).toEqual(["public_group_class_occurrences"]);
  });

  it("a signed-out visitor on a closed class sees the public status without a login prompt", async () => {
    h.user = null;
    h.rows = [classRow({ public_state: "cancelled", enrollment_state: "closed" })];
    expect((await outcome(() => page())).html).toContain("This class has been cancelled.");
  });

  it("20. a no-longer-public or nonexistent class is not found (never a private lookup)", async () => {
    h.rows = [];
    expect(await outcome(() => page())).toEqual({ thrown: "NEXT_NOT_FOUND" });
  });

  it("21. a wrong studio slug redirects to the canonical register path (dropping the dancer)", async () => {
    linksTable.rows = [link({ client_id: SELF_CLIENT })];
    expect(await outcome(() => page({ dancer: SELF_CLIENT }, "old-name"))).toEqual({ thrown: `NEXT_REDIRECT:${REGISTER}` });
  });
});

describe("ready state and scope", () => {
  it("22-24 (updated for GC-3.4C). the resolved dancer gets the join step, no payment language, and rendering writes nothing", async () => {
    linksTable.rows = [link({ client_id: SELF_CLIENT, is_primary: true })];
    const before = JSON.stringify(linksTable.rows);

    const { html } = await outcome(() => page());

    expect(html).toContain("Join this class");
    expect(html).not.toMatch(/register now|buy|pay\b|payment|checkout|purchase|price|\$\d/i);
    expect(JSON.stringify(linksTable.rows)).toBe(before);
    expect(attendeesTable.rows).toHaveLength(0);
    expect(h.adminRpcCalls).toHaveLength(0);
    expect(h.sessionRpcCalls).toEqual([
      "public_group_class_occurrences",
      "my_verified_email",
      "preview_self_enrollment_funding_candidates",
    ]);
  });
});
