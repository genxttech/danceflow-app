/* eslint-disable */
/**
 * D7 core release: PAID-flow smoke against the STAGED candidate (localhost:3100, hosted DEV, Stripe TEST). Needs the fixture studio to be
 * linked to a real Stripe TEST connected account (d7_dev_smoke_fixture.cjs connect <out.json> acct_...).
 *
 *   NODE_PATH=<node_modules> D7_BASE=http://localhost:3100 node scripts/release/d7_dev_paid_smoke.cjs <fixture.json> <fixture-script.cjs>
 *
 * What it does (Stripe TEST only; refuses a non-test key): current grant -> the student API creates a payment_sheet PaymentIntent
 * (direct charge on the connected account, application fee) -> the PaymentIntent is confirmed with the Stripe test token pm_card_visa
 * -> a SYNTHETIC webhook event (built from the real PaymentIntent, signed with a throwaway secret that the staged app was started with)
 * settles the order -> the grant is lapsed -> the same payment is replayed as a NEW event id and must still be accepted without
 * creating anything (webhooks never consult the entitlement) -> a NEW paid purchase is refused before any Stripe call.
 * The staged app must be started with STRIPE_WEBHOOK_SECRET=whsec_d7smoke_platform_synthetic and
 * STRIPE_CONNECT_WEBHOOK_SECRET=whsec_d7smoke_connect_synthetic. No credentials are printed.
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const [fixtureFile, fixtureScript] = process.argv.slice(2);
const BASE = process.env.D7_BASE || "http://localhost:3100";
const CONNECT_SECRET = "whsec_d7smoke_connect_synthetic";
const f = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
const envText = fs.readFileSync("C:/Dev/studioapp/.env.local", "utf8").split(/\r?\n/);
const env = (n) => { const l = envText.find((x) => x.startsWith(n + "=")); return l ? l.slice(n.length + 1).replace(/^["']|["']$/g, "").trim() : ""; };
if (!env("STRIPE_SECRET_KEY").startsWith("sk_test_")) throw new Error("REFUSED: not a Stripe TEST key");
if (!env("NEXT_PUBLIC_SUPABASE_URL").includes("epdrtzcydvnoidwrepqz")) throw new Error("REFUSED: not the DEV project");
const stripe = new Stripe(env("STRIPE_SECRET_KEY"));
const admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`); };
const fixtureCommand = (c) => execFileSync("node", [fixtureScript, c, fixtureFile], { stdio: "inherit", env: process.env });
let n = 0;
async function studentCheckout(token, eventId, ticketTypeId) {
  n += 1;
  const r = await fetch(`${BASE}/api/student/events/${eventId}/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-forwarded-for": `10.88.${n}.${Math.floor(Math.random() * 200) + 1}` },
    body: JSON.stringify({ ticketSelections: [{ ticketTypeId, quantity: 1 }], buyerFirstName: "Smoke", buyerLastName: "Student", clientRequestId: crypto.randomUUID(), paymentMode: "payment_sheet" }),
  });
  const text = await r.text();
  let body = {}; try { body = JSON.parse(text); } catch {}
  return { status: r.status, body };
}
async function webhook(pi, account) {
  const event = { id: `evt_d7smoke_${crypto.randomBytes(6).toString("hex")}`, object: "event", type: "payment_intent.succeeded", api_version: "2026-03-25.dahlia", created: Math.floor(Date.now() / 1000), account, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object: pi } };
  const payload = JSON.stringify(event);
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: CONNECT_SECRET });
  const r = await fetch(`${BASE}/api/payments/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: payload });
  return { status: r.status, text: (await r.text()).slice(0, 160), eventId: event.id };
}
const rows = async (table, col, val, cols = "*") => (await admin.from(table).select(cols).eq(col, val)).data || [];

(async () => {
  const { data: studio } = await admin.from("studios").select("stripe_connected_account_id").eq("id", f.studioId).single();
  const account = studio.stripe_connected_account_id;
  if (!/^acct_[A-Za-z0-9]+$/.test(account) || account.startsWith("acct_d7smoke")) throw new Error("the fixture studio is not linked to a real Stripe TEST connected account (run: connect <out.json> acct_...)");
  const acctObj = await stripe.accounts.retrieve(account);
  if (!acctObj.charges_enabled) throw new Error("the connected account cannot take charges");

  const client = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), { auth: { persistSession: false } });
  const login = await client.auth.signInWithPassword({ email: f.student.email, password: f.student.password });
  if (login.error) throw new Error("student sign-in failed");
  const token = login.data.session.access_token;

  fixtureCommand("restore");
  console.log("\n## S1 paid: grant current -> PaymentIntent created on the connected account with the Pro add-on fee");
  // A previous interrupted run may have left ONE pending order behind (the app will not start a second): resume it via D7_EXISTING_PI.
  const existing = await rows("event_orders", "event_id", f.events.orgPaid, "id,status,payment_status");
  let orderId, piId;
  if (process.env.D7_EXISTING_PI && existing.some((o) => o.payment_status === "pending")) {
    piId = process.env.D7_EXISTING_PI;
    orderId = existing.find((o) => o.payment_status === "pending").id;
    console.log("  resuming the pending order", orderId, "with", piId);
    check("resumed an existing pending order", true);
  } else {
    const co = await studentCheckout(token, f.events.orgPaid, f.tickets.orgPaid);
    console.log("  checkout:", co.status, JSON.stringify(co.body).replace(/pk_test_[A-Za-z0-9]+/g, "pk_test_…").slice(0, 300));
    check("student API accepted the paid organizer purchase", co.status === 200, `status ${co.status}`);
    orderId = co.body.orderId;
    piId = co.body.paymentIntentId || (typeof co.body.clientSecret === "string" ? co.body.clientSecret.split("_secret_")[0] : null);
    check("a PaymentIntent was created", Boolean(piId), piId);
    if (!piId) throw new Error("no PaymentIntent; stopping");
  }
  const orders = await rows("event_orders", "event_id", f.events.orgPaid, "id,status,payment_status,total_amount");
  check("a pending order exists", orders.some((o) => o.id === orderId && o.payment_status !== "paid"), JSON.stringify(orders.map((o) => ({ s: o.status, p: o.payment_status, t: o.total_amount }))));
  let pi = await stripe.paymentIntents.retrieve(piId, {}, { stripeAccount: account });
  check("amount is $25.00 and the DanceFlow application fee is 3% ($0.75: Pro + current Suite grant)", pi.amount === 2500 && pi.application_fee_amount === 75, `amount ${pi.amount} fee ${pi.application_fee_amount}`);

  console.log("\n## settle: confirm with the Stripe test token, then deliver a synthetic signed webhook built from the real PaymentIntent");
  pi = await stripe.paymentIntents.confirm(piId, { payment_method: "pm_card_visa", return_url: "https://example.com/return" }, { stripeAccount: account });
  check("the test card payment succeeded at Stripe", pi.status === "succeeded", pi.status);
  const w1 = await webhook(pi, account);
  console.log("  webhook:", w1.status, w1.text);
  check("the webhook was accepted", w1.status === 200, `${w1.status}`);
  const afterPay = await rows("event_orders", "event_id", f.events.orgPaid, "id,status,payment_status");
  const regs = await rows("event_registrations", "event_id", f.events.orgPaid, "id,status,payment_status");
  const pays = await rows("event_payments", "event_id", f.events.orgPaid, "id,amount,status");
  console.log("  after settle:", JSON.stringify({ orders: afterPay, regs: regs.map((r) => [r.status, r.payment_status]), payments: pays.map((p) => [p.amount, p.status]) }));
  check("the order is paid and the registration confirmed", afterPay[0]?.payment_status === "paid" && regs.length === 1 && regs[0].status === "confirmed");

  console.log("\n## S9: grant lapses -> the SAME completed payment replayed as a NEW event id changes nothing (webhooks never consult the entitlement)");
  fixtureCommand("lapse");
  const before = JSON.stringify({ o: await rows("event_orders", "event_id", f.events.orgPaid, "id,status,payment_status"), r: await rows("event_registrations", "event_id", f.events.orgPaid, "id,status,payment_status"), p: (await rows("event_payments", "event_id", f.events.orgPaid, "id")).length });
  const w2 = await webhook(pi, account);
  console.log("  replay:", w2.status, w2.text);
  check("the replayed payment event is accepted after expiry", w2.status === 200);
  const after = JSON.stringify({ o: await rows("event_orders", "event_id", f.events.orgPaid, "id,status,payment_status"), r: await rows("event_registrations", "event_id", f.events.orgPaid, "id,status,payment_status"), p: (await rows("event_payments", "event_id", f.events.orgPaid, "id")).length });
  check("orders, registrations and payment rows are unchanged by the replay (no duplicate payment)", before === after);

  console.log("\n## S2 paid: grant lapsed -> a NEW paid purchase is refused before any PaymentIntent exists");
  const latestBefore = (await stripe.paymentIntents.list({ limit: 1 }, { stripeAccount: account })).data[0]?.id;
  const refused = await studentCheckout(token, f.events.orgPaid, f.tickets.orgPaid);
  console.log("  checkout:", refused.status, JSON.stringify(refused.body).slice(0, 200));
  check("the new purchase is refused (4xx)", refused.status >= 400 && refused.status < 500);
  const latestAfter = (await stripe.paymentIntents.list({ limit: 1 }, { stripeAccount: account })).data[0]?.id;
  check("no new PaymentIntent was created at Stripe (the newest PaymentIntent on the account is unchanged)", latestAfter === latestBefore, `${latestBefore} -> ${latestAfter}`);
  const orderCount = (await rows("event_orders", "event_id", f.events.orgPaid, "id")).length;
  console.log("  orders on the event after the refusal:", orderCount);

  fixtureCommand("restore");
  const failed = results.filter((x) => !x).length;
  console.log(`\nRESULT: ${results.length - failed} passed, ${failed} failed of ${results.length}`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { try { fixtureCommand("restore"); } catch {} console.error("FAILED:", e.message); process.exit(1); });
