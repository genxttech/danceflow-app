/**
 * P2: the Pulse leads card against REAL RLS (real supabase-js -> Kong -> PostgREST -> Postgres as the caller's own JWT). LOCAL / DISPOSABLE STACK ONLY;
 * skipped unless the isolated QA harness provides a loopback stack:
 *   node scripts/qa/iso-qa.mjs run baseline -- src/lib/staff/__tests__/localStack.pulseLeads.p2.test.ts
 */
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { loadPulseCards } from "@/lib/staff/pulseCards";

const URL_ = process.env.TW4A_LOCAL_URL ?? "";
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET ?? "";
const PG = process.env.TW4A_LOCAL_DB_CONTAINER ?? "";
const isLoopback = (value: string) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
};
const enabled = Boolean(URL_ && SECRET && PG) && isLoopback(URL_);

function psql(sql: string) {
  return execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const b64u = (value: string) => Buffer.from(value).toString("base64url");
function sign(payload: Record<string, unknown>) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
const exp = () => Math.floor(Date.now() / 1000) + 3600;

const STUDIO = randomUUID();
const OTHER = randomUUID();
const OWNER = randomUUID();
const C = {
  plain: randomUUID(),
  stampedWebsite: randomUUID(),
  eventOnly: randomUUID(),
  eventWithPackage: randomUUID(),
  eventWithAppointment: randomUUID(),
  eventCancelledOnly: randomUUID(),
  eventForeignEvidence: randomUUID(),
  indie: randomUUID(),
  otherStudio: randomUUID(),
};

describe.skipIf(!enabled)("P2 Pulse leads against real RLS", () => {
  beforeAll(() => {
    const client = (rowId: string, studio: string, name: string, referral: string | null, system: string | null, indie = false) =>
      `('${rowId}', '${studio}', '${name}', 'Lead', 'lead', ${referral ? `'${referral}'` : "null"}, ${system ? `'${system}'` : "null"}, ${indie})`;
    const event = ["Event Registration", "event_registration"] as const;
    psql(`begin;
      set local session_replication_role = replica;
      insert into auth.users (id, email) values ('${OWNER}', '${OWNER}@example.test');
      insert into public.profiles (id, full_name) values ('${OWNER}', 'QA');
      insert into public.studios (id, name, slug, subscription_status, timezone) values
        ('${STUDIO}', 'P2 Pulse', 'p2p-${STUDIO.slice(0, 8)}', 'active', 'America/Chicago'),
        ('${OTHER}', 'P2 Other', 'p2o-${OTHER.slice(0, 8)}', 'active', 'America/Chicago');
      insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${OWNER}', '${STUDIO}', 'studio_owner', true);
      insert into public.clients (id, studio_id, first_name, last_name, status, referral_source, source_system, is_independent_instructor) values
        ${[
          client(C.plain, STUDIO, "Plain", null, null),
          client(C.stampedWebsite, STUDIO, "Stamped", "Website", "event_registration"),
          client(C.eventOnly, STUDIO, "Only", ...event),
          client(C.eventWithPackage, STUDIO, "Package", ...event),
          client(C.eventWithAppointment, STUDIO, "Booked", ...event),
          client(C.eventCancelledOnly, STUDIO, "Cancelled", ...event),
          client(C.eventForeignEvidence, STUDIO, "Foreign", null, "event_registration"),
          client(C.indie, STUDIO, "Indie", null, null, true),
          client(C.otherStudio, OTHER, "Elsewhere", null, null),
        ].join(",\n")};
      insert into public.client_packages (id, studio_id, client_id, name_snapshot, active) values
        ('${randomUUID()}', '${STUDIO}', '${C.eventWithPackage}', 'Five lessons', true),
        ('${randomUUID()}', '${OTHER}', '${C.eventForeignEvidence}', 'Other studio package', true);
      insert into public.appointments (id, studio_id, appointment_type, client_id, starts_at, ends_at, title, status, payment_status) values
        ('${randomUUID()}', '${STUDIO}', 'private_lesson', '${C.eventWithAppointment}', now() + interval '1 day', now() + interval '1 day 45 minutes', 'L', 'scheduled', 'unpaid'),
        ('${randomUUID()}', '${STUDIO}', 'private_lesson', '${C.eventCancelledOnly}', now() + interval '2 day', now() + interval '2 day 45 minutes', 'X', 'cancelled', 'unpaid');
      commit;`);
  });

  it("lists exactly the real leads: stamped and related event buyers count, event-only buyers do not", async () => {
    const supabase = createClient(URL_, sign({ role: "anon", exp: exp() }), {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${sign({ sub: OWNER, role: "authenticated", aud: "authenticated", exp: exp() })}` } },
    });
    const cards = await loadPulseCards({
      supabase,
      studioId: STUDIO,
      userId: OWNER,
      studioRole: "studio_owner",
      now: new Date(),
      today: { total: 0, upcoming: 0, cancelled: 0, truncated: false },
    });
    expect(cards.leads).toMatchObject({ state: "ok", truncated: false });
    const leads = cards.leads as { recent: { id: string }[]; newLast7Days: number };
    expect(new Set(leads.recent.map((row) => row.id))).toEqual(new Set([C.plain, C.stampedWebsite, C.eventWithPackage, C.eventWithAppointment]));
    expect(leads.newLast7Days).toBe(4);
  });
});
