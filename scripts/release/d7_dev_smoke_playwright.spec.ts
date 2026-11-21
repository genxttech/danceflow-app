import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * D7 core release: smoke against the STAGED candidate (production build on localhost:3100) pointed at hosted DEV, using the
 * disposable fixture from scripts/release/d7_dev_smoke_fixture.cjs. NOT part of the repository CI suite.
 *
 * The public cart refuses $0 totals (cart_invalid_total), so FREE registrations only exist on the authenticated student API
 * (POST /api/student/events/[eventId]/checkout). That route is driven here with the synthetic student's access token. No paid
 * Checkout or Terminal flow is exercised, so the staged app makes NO Stripe call: every case below ends before Stripe.
 */
const FIXTURE = process.env.D7_SMOKE_FIXTURE!;
const FIXTURE_SCRIPT = process.env.D7_SMOKE_FIXTURE_SCRIPT!;
const BASE = process.env.E2E_BASE_URL!;
const f = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

function envValue(name: string) {
  const line = fs.readFileSync("C:/Dev/studioapp/.env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith(name + "="));
  return (line ?? "").slice(name.length + 1).replace(/^["']|["']$/g, "").trim();
}
const url = envValue("NEXT_PUBLIC_SUPABASE_URL");
if (!url.includes("epdrtzcydvnoidwrepqz")) throw new Error("REFUSED: not the DEV project");
const admin = createClient(url, envValue("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

function fixtureCommand(command: "lapse" | "restore") {
  execFileSync("node", [FIXTURE_SCRIPT, command, FIXTURE], { stdio: "inherit", env: { ...process.env, NODE_PATH: process.env.D7_NODE_PATH } });
}
async function registrations(eventId: string) {
  const { data, error } = await admin.from("event_registrations").select("id, status, payment_status, order_id").eq("event_id", eventId);
  if (error) throw new Error(error.message);
  return data ?? [];
}
async function orders(eventId: string) {
  const { data, error } = await admin.from("event_orders").select("id, status, payment_status").eq("event_id", eventId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

let token = "";
let calls = 0;
async function studentCheckout(eventId: string, ticketTypeId: string) {
  calls += 1;
  const response = await fetch(`${BASE}/api/student/events/${eventId}/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-forwarded-for": `10.77.${calls}.${Math.floor(Math.random() * 200) + 1}` },
    body: JSON.stringify({
      ticketSelections: [{ ticketTypeId, quantity: 1 }],
      buyerFirstName: "Smoke",
      buyerLastName: "Student",
      clientRequestId: randomUUID(),
      paymentMode: "checkout",
    }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { /* keep text */ }
  console.log(`  -> HTTP ${response.status} ${JSON.stringify(body).slice(0, 260)}`);
  return { status: response.status, body, text };
}

test.describe.configure({ mode: "serial" });

test.describe("D7 core release smoke (staged candidate -> DEV, no Stripe calls)", () => {
  test.beforeAll(async () => {
    const client = createClient(url, envValue("NEXT_PUBLIC_SUPABASE_ANON_KEY"), { auth: { persistSession: false } });
    const login = await client.auth.signInWithPassword({ email: f.student.email, password: f.student.password });
    if (login.error || !login.data.session) throw new Error("student sign-in failed: " + login.error?.message);
    token = login.data.session.access_token;
  });

  test("S2: grant lapsed -> a NEW free registration for an ORGANIZER event is refused before anything is created", async () => {
    fixtureCommand("lapse");
    const result = await studentCheckout(f.events.orgFree, f.tickets.orgFree);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
    expect(JSON.stringify(result.body)).toMatch(/not accepting|organizer/i);
    expect(await registrations(f.events.orgFree)).toHaveLength(0);
    expect(await orders(f.events.orgFree)).toHaveLength(0);
  });

  test("S2: grant lapsed -> the PAID organizer event is refused before any order or Stripe call", async () => {
    const result = await studentCheckout(f.events.orgPaid, f.tickets.orgPaid);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
    expect(JSON.stringify(result.body)).toMatch(/not accepting|organizer/i);
    expect(await registrations(f.events.orgPaid)).toHaveLength(0);
    expect(await orders(f.events.orgPaid)).toHaveLength(0);
  });

  test("S8: grant lapsed -> an ordinary studio event (no organizer) still registers", async () => {
    const result = await studentCheckout(f.events.studioFree, f.tickets.studioFree);
    expect(result.status).toBeLessThan(300);
    const rows = await registrations(f.events.studioFree);
    expect(rows).toHaveLength(1);
    console.log("  S8 registration:", JSON.stringify(rows.map((r) => ({ status: r.status, payment: r.payment_status }))));
  });

  test("S1: grant current -> the free ORGANIZER registration succeeds and is confirmed", async () => {
    fixtureCommand("restore");
    const result = await studentCheckout(f.events.orgFree, f.tickets.orgFree);
    expect(result.status).toBeLessThan(300);
    const rows = await registrations(f.events.orgFree);
    expect(rows).toHaveLength(1);
    console.log("  S1 registration:", JSON.stringify(rows.map((r) => ({ status: r.status, payment: r.payment_status }))));
    expect(rows[0].status).toBe("confirmed");
  });

  test("S3: after the grant lapses again, the completed registration stays valid and a replay creates nothing new", async () => {
    const before = await registrations(f.events.orgFree);
    fixtureCommand("lapse");
    const replay = await studentCheckout(f.events.orgFree, f.tickets.orgFree);
    console.log("  S3 repeat attempt status:", replay.status);
    const after = await registrations(f.events.orgFree);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe(before[0].status);
    expect(after[0].id).toBe(before[0].id);
    expect((await orders(f.events.orgFree)).length).toBe(1);
  });

  test.afterAll(() => fixtureCommand("restore"));
});
