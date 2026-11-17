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
  LEAD_FLAGGABLE_TICKET_KINDS,
  ticketCreatesLead,
  ticketKindMayCreateLeads,
} from "@/lib/events/leadEligibility";
import { safeCaptureStudioEventRegistrationLead } from "@/lib/events/settlementSideEffects";

const root = path.resolve(__dirname, "../../../..");
const migration = readFileSync(
  path.join(root, "src/lib/supabase/migrations/20270219100000_g02_event_lead_ticket_kind_gate.sql"),
  "utf8",
);

const ALL_KINDS = ["general_admission", "vip", "competitor", "spectator", "staff", "vendor", "table", "pass", "other"];

describe("G-02 Rule 1: explicit per-ticket-type flag", () => {
  it.each(ALL_KINDS)("kind %s: flag OFF never creates a lead; flag ON only for flaggable kinds", (kind) => {
    expect(ticketCreatesLead({ ticket_kind: kind, creates_prospect_lead: false })).toBe(false);
    expect(ticketCreatesLead({ ticket_kind: kind, creates_prospect_lead: null })).toBe(false);
    expect(ticketCreatesLead({ ticket_kind: kind, creates_prospect_lead: true })).toBe(kind === "general_admission");
    expect(ticketKindMayCreateLeads(kind)).toBe(kind === "general_admission");
  });

  it("unknown kind, no ticket and missing flag fail closed", () => {
    expect(ticketCreatesLead({ ticket_kind: "something_new", creates_prospect_lead: true })).toBe(false);
    expect(ticketCreatesLead(null)).toBe(false);
    expect(ticketCreatesLead(undefined)).toBe(false);
    expect(ticketCreatesLead({ ticket_kind: "general_admission" })).toBe(false);
  });

  it("every kind the product can create is classified (a new kind must be a deliberate decision)", () => {
    const form = readFileSync(path.join(root, "src/app/app/events/[id]/tickets/TicketTypeForm.tsx"), "utf8");
    const kinds = [...form.matchAll(/<option value="([a-z_]+)">/g)].map((m) => m[1]);
    expect(kinds.sort()).toEqual([...ALL_KINDS].sort());
    expect(kinds.filter((k) => ticketKindMayCreateLeads(k))).toEqual([...LEAD_FLAGGABLE_TICKET_KINDS]);
  });

  it("SQL and TypeScript agree: column default false, CHECK allows only the flaggable kinds, function reads the flag", () => {
    const sql = migration.replace(/--.*$/gm, "");
    expect(sql).toMatch(/add column if not exists creates_prospect_lead boolean not null default false/);
    const check = sql.match(/check \(not creates_prospect_lead or ticket_kind = '([a-z_]+)'\)/);
    expect(check?.[1]).toBe("general_admission");
    expect([...LEAD_FLAGGABLE_TICKET_KINDS]).toEqual([check?.[1]]);
    expect(sql).toMatch(/coalesce\(v_flag, false\) and v_kind = 'general_admission'/);
    expect(sql).not.toMatch(/update\s+public\.event_ticket_types/i); // no backfill: existing ticket types stay OFF
  });

  it("the migration never deletes or modifies existing data and ships a Git-only rollback", () => {
    const body = migration.replace(/--.*$/gm, "");
    expect(body).not.toMatch(/\bdelete\s+from\b|\btruncate\b|\bdrop\s+table\b/i);
    expect(body).not.toMatch(/\bupdate\s+public\.clients\b[^;]*\bstatus\b/i);
    const rollback = readFileSync(
      path.join(root, "src/lib/supabase/migrations/rollback/20270219100000_g02_event_lead_ticket_kind_gate_rollback.sql"),
      "utf8",
    );
    expect(rollback).toContain("drop column if exists creates_prospect_lead");
  });
});

type Op = { table: string; op: string; payload?: Record<string, unknown> };

/** Minimal chainable Supabase fake that records every write. */
function fakeSupabase(fixture: {
  registration: Record<string, unknown> | null;
  ticketKind?: string | null;
  flag?: boolean | null;
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
          return { data: fixture.ticketKind === undefined ? null : { ticket_kind: fixture.ticketKind, creates_prospect_lead: fixture.flag ?? false }, error: null };
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
  it("a FLAGGED general admission ticket creates a lead and a registration notification", async () => {
    const { supabase, ops } = fakeSupabase({ registration: registration(), ticketKind: "general_admission", flag: true });
    await safeCaptureStudioEventRegistrationLead({ supabase, registrationId: "reg-1" });
    const inserted = clientWrites(ops).find((o) => o.op === "insert");
    expect(inserted?.payload).toMatchObject({ status: "lead", studio_id: "studio-1", email: "pat@example.com" });
    expect(notices(ops)[0]?.payload).toMatchObject({ title: "New event registration" });
  });

  it("an UNFLAGGED general admission ticket (the default) creates NO lead and still notifies the studio", async () => {
    const { supabase, ops } = fakeSupabase({ registration: registration(), ticketKind: "general_admission", flag: false });
    await safeCaptureStudioEventRegistrationLead({ supabase, registrationId: "reg-1" });
    expect(clientWrites(ops)).toEqual([]);
    expect(notices(ops)).toHaveLength(1);
    expect(String(notices(ops)[0].payload?.body)).toContain("not set to add buyers as prospective students");
  });

  it.each(["spectator", "vendor", "staff", "table", "pass", "vip", "competitor", "other", "unknown_kind"])(
    "%s creates NO lead even if a stale flag were true, links no client, modifies no client and still notifies the studio",
    async (kind) => {
      const { supabase, ops } = fakeSupabase({
        registration: registration(),
        ticketKind: kind,
        flag: true,
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
