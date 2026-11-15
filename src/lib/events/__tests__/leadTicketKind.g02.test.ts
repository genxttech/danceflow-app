import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/notifications/outbound", () => ({ queueOutboundDelivery: vi.fn() }));
vi.mock("@/lib/notifications/event-email-branding", () => ({ resolveEventEmailBranding: vi.fn() }));
vi.mock("@/lib/notifications/merchantIdentity", () => ({ resolveEventMerchantLine: vi.fn() }));
vi.mock("@/lib/notifications/templates", () => ({
  buildEventConfirmedEmailTemplate: vi.fn(),
  buildEventConfirmedSmsTemplate: vi.fn(),
}));

import {
  LEAD_ELIGIBLE_TICKET_KINDS,
  ticketKindCreatesLead,
} from "@/lib/events/leadEligibility";
import { safeCaptureStudioEventRegistrationLead } from "@/lib/events/settlementSideEffects";

const root = path.resolve(__dirname, "../../../..");
const migration = readFileSync(
  path.join(root, "src/lib/supabase/migrations/20270219090000_g02_event_lead_ticket_kind_gate.sql"),
  "utf8",
);

describe("G-02 ticket-kind policy", () => {
  it.each([
    ["general_admission", true],
    ["general", false],
    ["workshop", true],
    [" General_Admission ", true],
    ["spectator", false],
    ["vendor", false],
    ["staff", false],
    ["table", false],
    ["pass", false],
    ["vip", false],
    ["competitor", false],
    ["other", false],
    ["", false],
    ["something_new", false],
    [null, false],
    [undefined, false],
  ])("kind %j -> creates lead: %s", (kind, expected) => {
    expect(ticketKindCreatesLead(kind as string | null | undefined)).toBe(expected);
  });

  it("every ticket kind the product can create is classified (new kinds must be a deliberate policy decision)", () => {
    const form = readFileSync(
      path.join(root, "src/app/app/events/[id]/tickets/TicketTypeForm.tsx"),
      "utf8",
    );
    const kinds = [...form.matchAll(/<option value="([a-z_]+)">/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThanOrEqual(9);
    const eligible = kinds.filter((k) => ticketKindCreatesLead(k));
    expect(eligible).toEqual(["general_admission"]);
  });

  it("the SQL policy function lists exactly the TypeScript eligible kinds", () => {
    const match = migration.match(/event_ticket_kind_creates_lead[\s\S]*?in \(([^)]*)\)/);
    expect(match).not.toBeNull();
    const sqlKinds = [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect([...LEAD_ELIGIBLE_TICKET_KINDS].sort()).toEqual(sqlKinds);
  });

  it("the migration never writes or deletes existing data and leaves a Git-only rollback", () => {
    const body = migration.replace(/--.*$/gm, "");
    expect(body).not.toMatch(/\bdelete\s+from\b|\btruncate\b|\bdrop\s+table\b/i);
    expect(body).not.toMatch(/\bupdate\s+public\.clients\b[^;]*status/i);
    const rollback = readFileSync(
      path.join(root, "src/lib/supabase/migrations/rollback/20270219090000_g02_event_lead_ticket_kind_gate_rollback.sql"),
      "utf8",
    );
    expect(rollback).toContain("drop function if exists public.event_ticket_kind_creates_lead");
  });
});

type Op = { table: string; op: string; payload?: Record<string, unknown> };

/** Minimal chainable Supabase fake that records every write. */
function fakeSupabase(fixture: {
  registration: Record<string, unknown> | null;
  ticketKind?: string | null;
  existingClients?: Array<Record<string, unknown>>;
  noticeError?: { code: string; message: string } | null;
}) {
  const ops: Op[] = [];
  const builder = (table: string) => {
    const state: { op: string; payload?: Record<string, unknown> } = { op: "select" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      ilike: () => chain,
      order: () => chain,
      is: () => chain,
      limit: () => chain,
      insert: (payload: Record<string, unknown>) => {
        state.op = "insert";
        state.payload = payload;
        ops.push({ table, op: "insert", payload });
        return chain;
      },
      update: (payload: Record<string, unknown>) => {
        state.op = "update";
        state.payload = payload;
        ops.push({ table, op: "update", payload });
        return chain;
      },
      maybeSingle: async () => {
        if (table === "event_registrations") return { data: fixture.registration, error: null };
        if (table === "event_ticket_types")
          return { data: fixture.ticketKind === undefined ? null : { ticket_kind: fixture.ticketKind }, error: null };
        return { data: null, error: null };
      },
      single: async () => ({ data: { id: "new-client" }, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        if (table === "clients" && state.op === "select") return resolve({ data: fixture.existingClients ?? [], error: null });
        if (table === "notifications" && state.op === "insert") return resolve({ data: null, error: fixture.noticeError ?? null });
        return resolve({ data: null, error: null });
      },
    };
    return chain;
  };
  return { supabase: { from: builder } as never, ops };
}

const registration = (over: Record<string, unknown> = {}) => ({
  id: "reg-1",
  event_id: "evt-1",
  studio_id: "studio-1",
  client_id: null,
  ticket_type_id: "tt-1",
  attendee_first_name: "Pat",
  attendee_last_name: "Smith",
  attendee_email: "Pat@Example.com",
  attendee_phone: null,
  events: { id: "evt-1", name: "Spring Social", slug: "spring", studio_id: "studio-1", organizer_id: null },
  ...over,
});

const clientWrites = (ops: Op[]) => ops.filter((o) => o.table === "clients" && o.op !== "select");
const notices = (ops: Op[]) => ops.filter((o) => o.table === "notifications");

describe("safeCaptureStudioEventRegistrationLead (orderless registration path)", () => {
  it("general admission creates a lead and a registration notification", async () => {
    const { supabase, ops } = fakeSupabase({ registration: registration(), ticketKind: "general_admission" });
    await safeCaptureStudioEventRegistrationLead({ supabase, registrationId: "reg-1" });
    const inserted = clientWrites(ops).find((o) => o.op === "insert");
    expect(inserted?.payload).toMatchObject({ status: "lead", studio_id: "studio-1", email: "pat@example.com" });
    expect(notices(ops)[0]?.payload).toMatchObject({ title: "New event registration" });
  });

  it.each(["spectator", "vendor", "staff", "table", "pass", "vip", "competitor", "other", "unknown_kind"])(
    "%s creates NO lead, links no client, modifies no client and still notifies the studio",
    async (kind) => {
      const { supabase, ops } = fakeSupabase({
        registration: registration(),
        ticketKind: kind,
        existingClients: [{ id: "c-existing", referral_source: null, source_system: null, status: "lead" }],
      });
      await safeCaptureStudioEventRegistrationLead({ supabase, registrationId: "reg-1" });
      expect(clientWrites(ops)).toEqual([]);
      expect(ops.filter((o) => o.table === "event_registrations" && o.op === "update")).toEqual([]);
      expect(notices(ops)).toHaveLength(1);
      expect(notices(ops)[0].payload).toMatchObject({
        studio_id: "studio-1",
        type: "event_registration",
        dedupe_key: "event_registration_notice:reg-1",
      });
      expect(String(notices(ops)[0].payload?.title)).toContain("not added as a lead");
    },
  );

  it("a registration with no ticket type cannot be classified: no lead, studio still notified", async () => {
    const { supabase, ops } = fakeSupabase({ registration: registration({ ticket_type_id: null }) });
    await safeCaptureStudioEventRegistrationLead({ supabase, registrationId: "reg-1" });
    expect(clientWrites(ops)).toEqual([]);
    expect(notices(ops)).toHaveLength(1);
  });

  it("a ticket type that does not belong to the registration's event (tenant mismatch) is unclassified: no lead", async () => {
    // the lookup is constrained to event_id; a foreign ticket type returns no row
    const { supabase, ops } = fakeSupabase({ registration: registration(), ticketKind: undefined });
    await safeCaptureStudioEventRegistrationLead({ supabase, registrationId: "reg-1" });
    expect(clientWrites(ops)).toEqual([]);
    expect(notices(ops)).toHaveLength(1);
  });

  it("a replayed notice (unique violation) is an idempotent success, never an error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { supabase, ops } = fakeSupabase({
      registration: registration(),
      ticketKind: "spectator",
      noticeError: { code: "23505", message: "duplicate key" },
    });
    await safeCaptureStudioEventRegistrationLead({ supabase, registrationId: "reg-1" });
    expect(clientWrites(ops)).toEqual([]);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("organizer-hosted events never reach the studio CRM or the notice", async () => {
    const { supabase, ops } = fakeSupabase({
      registration: registration({ events: { id: "evt-1", name: "X", slug: null, studio_id: "studio-1", organizer_id: "org-1" } }),
      ticketKind: "general_admission",
    });
    await safeCaptureStudioEventRegistrationLead({ supabase, registrationId: "reg-1" });
    expect(ops.filter((o) => o.op !== "select")).toEqual([]);
  });
});
