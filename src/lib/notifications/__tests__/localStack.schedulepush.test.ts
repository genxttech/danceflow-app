/**
 * Schedule push appointment read against a REAL PostgREST (the QA harness: Postgres + PostgREST behind Kong), because the defect lives in PostgREST's relationship resolution:
 * `appointments` has two foreign keys to `clients` (client_id, partner_client_id), so a bare `clients ( ... )` embed fails with PGRST201 and the push is silently dropped.
 * LOCAL / DISPOSABLE STACK ONLY (loopback URL, synthetic rows, a service JWT signed with the stack's own secret).
 */
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/notifications/expoPush", () => ({ sendMobilePushToUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { sendAppointmentSchedulePush } from "@/lib/notifications/schedulePush";

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

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function serviceJwt(): string {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ role: "service_role", iss: "supabase-local", exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
function psql(sql: string): string {
  return execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

const STUDIO = randomUUID();
const C1 = randomUUID();
const C2 = randomUUID();
const APPT = randomUUID();

describe.skipIf(!enabled)("schedule push appointment read through real PostgREST", () => {
  const client = () => createClient(URL_, serviceJwt(), { auth: { persistSession: false, autoRefreshToken: false } });

  beforeAll(() => {
    // the appointment has BOTH client foreign keys set, exactly the shape that makes a bare embed ambiguous
    psql(`
      insert into public.studios (id, name, slug) values ('${STUDIO}', 'Schedule Push Test Studio', 'sp-${STUDIO.slice(0, 8)}');
      insert into public.clients (id, studio_id, first_name, last_name) values ('${C1}', '${STUDIO}', 'Alma', 'Lead'), ('${C2}', '${STUDIO}', 'Boris', 'Partner');
      insert into public.appointments (id, studio_id, client_id, partner_client_id, appointment_type, starts_at, ends_at)
        values ('${APPT}', '${STUDIO}', '${C1}', '${C2}', 'private_lesson', now() + interval '3 days', now() + interval '3 days 1 hour');`);
  });

  afterAll(() => {
    psql(`delete from public.studios where id = '${STUDIO}';`);
  });

  it("the old bare embed is ambiguous (PGRST201): this is the production failure being fixed", async () => {
    const { data, error } = await client().from("appointments").select("id, clients ( first_name, last_name ), partner_client:clients!appointments_partner_client_id_fkey ( first_name )").eq("id", APPT).maybeSingle();
    expect(data).toBeNull();
    expect(error?.message ?? "").toMatch(/more than one relationship was found for 'appointments' and 'clients'/);
  });

  it("the explicit relationship loads the lead and the partner, with the result key still `clients`", async () => {
    const { data, error } = await client()
      .from("appointments")
      .select("id, clients:clients!appointments_client_id_fkey ( first_name, last_name ), partner_client:clients!appointments_partner_client_id_fkey ( first_name, last_name )")
      .eq("id", APPT)
      .maybeSingle();
    expect(error).toBeNull();
    const row = data as unknown as { clients: { first_name: string }; partner_client: { first_name: string } };
    expect(row.clients.first_name).toBe("Alma");
    expect(row.partner_client.first_name).toBe("Boris");
  });

  it("sendAppointmentSchedulePush no longer drops the appointment: it loads the row and proceeds past the read (no 'Could not load appointment' error)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await sendAppointmentSchedulePush({ supabase: client(), studioId: STUDIO, appointmentId: APPT, reason: "confirmed" });
    const loadFailures = errors.mock.calls.filter((c) => String(c[0]).includes("Could not load appointment for schedule push"));
    expect(loadFailures).toHaveLength(0);
    errors.mockRestore();
  });
});
