/**
 * `appointments -> clients` embeds against a REAL PostgREST (the QA harness: Postgres + PostgREST behind Kong). `appointments` has two foreign keys to
 * `clients` (client_id, partner_client_id), so PostgREST rejects a bare `clients ( ... )` embed from `appointments` with PGRST201, on every request and
 * regardless of the row's data. This suite pins:
 *   - the appointments CSV export select (it returned 500 on every export);
 *   - the group-class legacy-fallback read (it threw for every group class with no attendee rows, which broke the staff and instructor roster reads);
 *   - that the other audited embeds start from single-FK tables and need no hint.
 * LOCAL / DISPOSABLE STACK ONLY (loopback URL, synthetic rows, a service JWT signed with the stack's own secret).
 *   node scripts/qa/iso-qa.mjs run baseline -- src/lib/supabase/__tests__/localStack.appointmentsClientsEmbed.test.ts
 */
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { APPOINTMENTS_EXPORT_SELECT } from "@/lib/reports/appointmentsExportSelect";
import { getClassRosterForInstructor, getClassRosterForStaff } from "@/lib/schedule/groupClassRoster";

const URL_ = process.env.TW4A_LOCAL_URL ?? "";
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET ?? "";
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const loopback = (u: string) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname);
  } catch {
    return false;
  }
};
const enabled = Boolean(URL_ && SECRET && PG) && loopback(URL_);

const b64 = (b: string) => Buffer.from(b).toString("base64url");
function serviceJwt(): string {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ role: "service_role", iss: "supabase-local", exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
function psql(sql: string): string {
  return execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const STUDIO = randomUUID();
const LEAD = randomUUID();
const PARTNER = randomUUID();
const LESSON = randomUUID();
const EMPTY_CLASS = randomUUID();
const LEGACY_CLASS = randomUUID();
const AMBIGUOUS = /more than one relationship was found for 'appointments' and 'clients'/;

describe.skipIf(!enabled)("appointments -> clients embeds through real PostgREST", () => {
  const client = () => createClient(URL_, serviceJwt(), { auth: { persistSession: false, autoRefreshToken: false } });

  beforeAll(() => {
    // Plan seat and booking triggers are not under test; PostgREST's relationship resolution is.
    psql(`begin;
      set local session_replication_role = replica;
      insert into public.studios (id, name, slug) values ('${STUDIO}', 'Embed Audit Studio', 'embed-${STUDIO.slice(0, 8)}');
      insert into public.clients (id, studio_id, first_name, last_name, email, phone) values
        ('${LEAD}', '${STUDIO}', 'Alma', 'Lead', 'alma@example.test', '555-0001'),
        ('${PARTNER}', '${STUDIO}', 'Boris', 'Partner', 'boris@example.test', '555-0002');
      insert into public.appointments (id, studio_id, client_id, partner_client_id, appointment_type, title, starts_at, ends_at, status) values
        ('${LESSON}', '${STUDIO}', '${LEAD}', '${PARTNER}', 'private_lesson', 'Lesson', now() + interval '1 day', now() + interval '1 day 1 hour', 'scheduled'),
        ('${EMPTY_CLASS}', '${STUDIO}', null, null, 'group_class', 'Empty class', now() + interval '2 days', now() + interval '2 days 1 hour', 'scheduled'),
        ('${LEGACY_CLASS}', '${STUDIO}', '${LEAD}', null, 'group_class', 'Legacy class', now() + interval '3 days', now() + interval '3 days 1 hour', 'scheduled');
      commit;`);
  });

  afterAll(() => {
    psql(`begin; set local session_replication_role = replica; delete from public.appointments where studio_id = '${STUDIO}'; delete from public.clients where studio_id = '${STUDIO}'; delete from public.studios where id = '${STUDIO}'; commit;`);
  });

  describe("appointments CSV export", () => {
    it("control: the previous bare embed is ambiguous (PGRST201), so every export failed", async () => {
      const bare = APPOINTMENTS_EXPORT_SELECT.replace("clients:clients!appointments_client_id_fkey", "clients");
      const { data, error } = await client().from("appointments").select(bare).eq("studio_id", STUDIO);
      expect(data).toBeNull();
      expect(error?.message ?? "").toMatch(AMBIGUOUS);
    });

    it("the shipped select resolves the lead client, keeps the result key `clients`, and never returns the partner", async () => {
      const { data, error } = await client().from("appointments").select(APPOINTMENTS_EXPORT_SELECT).eq("id", LESSON).single();
      expect(error).toBeNull();
      const row = data as unknown as { title: string; clients: { first_name: string; last_name: string } };
      expect(row.title).toBe("Lesson");
      expect(row.clients).toEqual({ first_name: "Alma", last_name: "Lead" });
    });
  });

  describe("group class roster legacy fallback", () => {
    it("an empty group class returns an empty roster instead of throwing, for staff and instructor reads", async () => {
      await expect(getClassRosterForStaff({ supabase: client() as never, appointmentId: EMPTY_CLASS, studioId: STUDIO })).resolves.toEqual([]);
      await expect(getClassRosterForInstructor({ supabase: client() as never, appointmentId: EMPTY_CLASS, studioId: STUDIO })).resolves.toEqual([]);
    });

    it("a legacy group class (client_id set, no attendee rows) still synthesizes its one attendee", async () => {
      const roster = await getClassRosterForStaff({ supabase: client() as never, appointmentId: LEGACY_CLASS, studioId: STUDIO });
      expect(roster).toEqual([
        expect.objectContaining({ clientId: LEAD, firstName: "Alma", lastName: "Lead", email: "alma@example.test", source: "legacy_fallback" }),
      ]);
    });
  });

  describe("audited embeds that start from a table with a single foreign key to clients", () => {
    it.each([
      "payments",
      "client_account_links",
      "lead_activities",
      "client_packages",
      "student_booking_action_requests",
      "appointment_attendees",
      "document_assignments",
    ])("%s -> clients needs no hint", async (table) => {
      const { error } = await client().from(table).select("clients ( first_name, last_name )").limit(1);
      expect(error).toBeNull();
    });
  });
});
