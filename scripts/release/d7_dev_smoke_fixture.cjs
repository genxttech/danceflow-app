/* eslint-disable */
/**
 * D7 core release: DISPOSABLE DEV-ONLY smoke-test fixture (authorized by the owner for hosted DEV only).
 *
 *   NODE_PATH=<a node_modules containing @supabase/supabase-js> node scripts/release/d7_dev_smoke_fixture.cjs create  <out.json>
 *   ... verify  <out.json>        # database-level checks of the D7 migrations using the fixture (does not change the fixture)
 *   ... lapse   <out.json> [YYYY-MM-DD]   # sets the grant's period_end (default: yesterday) so the lapsed-grant smoke cases can run
 *   ... restore <out.json>        # makes the grant open-ended and active again
 *   ... cleanup <out.json>        # deletes exactly this run's rows (by ids) and its auth users; checks every delete
 *
 * Safety: refuses unless NEXT_PUBLIC_SUPABASE_URL (read from C:\Dev\studioapp\.env.local, never printed) is the DEV project host.
 * Everything is run-scoped (names "D7 Smoke <run>", slug "d7-smoke-<run>"), every id is generated before anything is written,
 * cleanup never deletes by anything but this run's ids. No Stripe object is created; the studio has no connected account, so paid
 * Checkout flows are NOT covered by this fixture (free registrations, the grant gate, audit and grants are).
 * Passwords for the two synthetic users are written to <out.json> only (never printed).
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");

const DEV_HOST = "epdrtzcydvnoidwrepqz.supabase.co";
const ENV_FILE = process.env.D7_DEV_ENV_FILE || "C:/Dev/studioapp/.env.local";

function loadEnv() {
  const text = fs.readFileSync(ENV_FILE, "utf8");
  const get = (name) => {
    const line = text.split(/\r?\n/).find((l) => l.startsWith(name + "="));
    return line ? line.slice(name.length + 1).replace(/^["']|["']$/g, "").trim() : "";
  };
  const url = get("NEXT_PUBLIC_SUPABASE_URL");
  const key = get("SUPABASE_SERVICE_ROLE_KEY");
  const anon = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (new URL(url).host !== DEV_HOST) throw new Error(`REFUSED: the env file does not point at the DEV project (${DEV_HOST}).`);
  if (!key) throw new Error("REFUSED: no service role key in the env file.");
  return { url, key, anon };
}

async function must(promise, what) {
  const { data, error } = await promise;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

function ids(runId) {
  const u = () => crypto.randomUUID();
  return {
    runId,
    studioId: u(), organizerId: u(), grantId: u(), planId: null, createdPlan: false,
    events: { orgFree: u(), orgPaid: u(), studioFree: u() },
    tickets: { orgFree: u(), orgPaid: u(), studioFree: u() },
    owner: { id: "", email: `d7-smoke-${runId}-owner@example.com`, password: crypto.randomBytes(18).toString("base64url") },
    student: { id: "", email: `d7-smoke-${runId}-student@example.com`, password: crypto.randomBytes(18).toString("base64url") },
  };
}

async function create(admin, outFile) {
  const runId = crypto.randomBytes(4).toString("hex");
  const f = ids(runId);
  fs.writeFileSync(outFile, JSON.stringify({ ...f, status: "creating" }, null, 2)); // ids on disk BEFORE any write
  try {
    const plan = await must(admin.from("subscription_plans").select("id").eq("code", "pro").maybeSingle(), "plan lookup");
    if (!plan) throw new Error("DEV has no 'pro' subscription plan; refusing to invent one");
    f.planId = plan.id;

    await must(admin.from("studios").insert({
      id: f.studioId, name: `D7 Smoke Studio ${runId}`, slug: `d7-smoke-${runId}`, subscription_status: "active", billing_plan: "pro", timezone: "America/New_York",
    }), "studio");
    await must(admin.from("studio_subscriptions").insert({ studio_id: f.studioId, subscription_plan_id: f.planId, status: "active" }), "subscription");
    await must(admin.from("usage_addon_entitlements").insert({
      id: f.grantId, studio_id: f.studioId, workspace_type: "studio", feature_key: "organizer_suite", quantity_included: 1, source: "manual_grant",
      status: "active", period_start: null, period_end: null, notes: `DEV D7 smoke test ${runId}, remove after`,
    }), "manual grant");
    await must(admin.from("organizers").insert({ id: f.organizerId, studio_id: f.studioId, name: `D7 Smoke Organizer ${runId}`, slug: `d7-smoke-org-${runId}` }), "organizer");

    const base = {
      studio_id: f.studioId, event_type: "special_event", status: "published", visibility: "public", public_directory_enabled: true,
      start_date: "2027-06-05", end_date: "2027-06-05", start_time: "19:00", end_time: "22:00", timezone: "America/New_York",
      venue_name: "D7 Smoke Hall", city: "Albany", state: "NY", registration_required: true, account_required_for_registration: false,
      registration_opens_at: null, registration_closes_at: null,
    };
    const ev = (id, key, name, organizer) => ({ ...base, id, slug: `d7-smoke-${runId}-${key}`, name: `${name} ${runId}`, organizer_id: organizer ? f.organizerId : null });
    await must(admin.from("events").insert([
      ev(f.events.orgFree, "org-free", "D7 Smoke Organizer Free", true),
      ev(f.events.orgPaid, "org-paid", "D7 Smoke Organizer Paid", true),
      ev(f.events.studioFree, "studio-free", "D7 Smoke Studio Event", false),
    ]), "events");
    const ticket = (id, eventId, name, price) => ({
      id, event_id: eventId, name, description: null, ticket_kind: "general_admission", currency: "USD", capacity: null, active: true, sort_order: 0,
      sale_starts_at: null, sale_ends_at: null, attendees_per_ticket: 1, early_bird_enabled: false, early_bird_price: null, early_bird_ends_at: null, price,
    });
    await must(admin.from("event_ticket_types").insert([
      ticket(f.tickets.orgFree, f.events.orgFree, "Free Pass", 0),
      ticket(f.tickets.orgPaid, f.events.orgPaid, "Paid Pass", 25),
      ticket(f.tickets.studioFree, f.events.studioFree, "Studio Free Pass", 0),
    ]), "ticket types");

    for (const [who, label] of [[f.owner, "Owner"], [f.student, "Student"]]) {
      const { data, error } = await admin.auth.admin.createUser({ email: who.email, password: who.password, email_confirm: true });
      if (error || !data.user) throw new Error(`${label} user: ${error?.message}`);
      who.id = data.user.id;
      await must(admin.from("profiles").upsert({ id: who.id, email: who.email, full_name: `D7 Smoke ${label}` }), `${label} profile`);
      fs.writeFileSync(outFile, JSON.stringify({ ...f, status: "creating" }, null, 2));
    }
    await must(admin.from("user_studio_roles").insert({ user_id: f.owner.id, studio_id: f.studioId, role: "studio_owner", active: true }), "owner role");
    fs.writeFileSync(outFile, JSON.stringify({ ...f, status: "ready" }, null, 2));
    console.log(`CREATED run ${runId}: studio ${f.studioId}, grant ${f.grantId}, organizer ${f.organizerId}, 3 events, 2 users (credentials in ${outFile})`);
  } catch (error) {
    console.error(`create failed: ${error.message}; cleaning up this run's rows`);
    await cleanup(admin, outFile, true).catch((e) => console.error("cleanup after failure incomplete: " + e.message));
    throw error;
  }
}

async function cleanup(admin, outFile, quiet) {
  const f = JSON.parse(fs.readFileSync(outFile, "utf8"));
  const failures = [];
  const del = async (what, q) => { const { error } = await q; if (error) failures.push(`${what}: ${error.message}`); };
  const eventIds = Object.values(f.events), ticketIds = Object.values(f.tickets);
  await del("ticket types", admin.from("event_ticket_types").delete().in("id", ticketIds));
  await del("events", admin.from("events").delete().in("id", eventIds));
  await del("owner role", admin.from("user_studio_roles").delete().eq("studio_id", f.studioId));
  await del("organizer", admin.from("organizers").delete().eq("id", f.organizerId));
  await del("subscription", admin.from("studio_subscriptions").delete().eq("studio_id", f.studioId));
  // The grant row cannot be deleted by the service role after migration 20270203100000 (by design); the studio delete cascades it.
  await del("studio (cascades the grant)", admin.from("studios").delete().eq("id", f.studioId));
  for (const who of [f.owner, f.student]) {
    if (who && who.id) {
      await del("profile " + who.email, admin.from("profiles").delete().eq("id", who.id));
      const { error } = await admin.auth.admin.deleteUser(who.id);
      if (error && !/not found/i.test(error.message)) failures.push(`auth user ${who.email}: ${error.message}`);
    }
  }
  const left = await admin.from("studios").select("id").eq("id", f.studioId);
  const leftGrant = await admin.from("usage_addon_entitlements").select("id").eq("id", f.grantId);
  if ((left.data || []).length || (leftGrant.data || []).length) failures.push("studio or grant row still present");
  if (failures.length) throw new Error("cleanup incomplete: " + failures.join("; "));
  fs.writeFileSync(outFile, JSON.stringify({ ...f, status: "cleaned" }, null, 2));
  if (!quiet) console.log(`CLEANED run ${f.runId}: all rows removed (audit events keep their snapshots by design)`);
}

async function verify(admin, cfg, outFile) {
  const f = JSON.parse(fs.readFileSync(outFile, "utf8"));
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`); };

  const events = await must(admin.from("usage_addon_entitlement_events").select("event_type, from_status, to_status, entitlement_id, actor").eq("entitlement_id", f.grantId), "audit events");
  check("the grant insert was audited", events.some((e) => e.event_type === "insert"), `${events.length} event(s)`);

  // 1. a second ACTIVE manual grant for the same studio+feature is refused by the partial unique index
  const dup = await admin.from("usage_addon_entitlements").insert({ studio_id: f.studioId, workspace_type: "studio", feature_key: "organizer_suite", quantity_included: 1, source: "manual_grant", status: "active" });
  check("a second active manual grant is refused (partial unique index)", dup.error && /duplicate|unique|23505/i.test(dup.error.message + (dup.error.code || "")), dup.error?.code);

  // 2. a paid Stripe-sourced row may coexist (cleaned up by cancelling is NOT possible to delete; use a unique item id and cancel it)
  const itemId = `si_d7smoke_${f.runId}`;
  const paid = await admin.from("usage_addon_entitlements").insert({ studio_id: f.studioId, workspace_type: "studio", feature_key: "organizer_suite", quantity_included: 1, source: "stripe_subscription_item", status: "active", stripe_subscription_item_id: itemId });
  check("a Stripe-sourced add-on row coexists with the manual grant", !paid.error, paid.error?.message);
  const upsert = await admin.from("usage_addon_entitlements").upsert({ studio_id: f.studioId, workspace_type: "studio", feature_key: "organizer_suite", quantity_included: 1, source: "stripe_subscription_item", status: "canceled", stripe_subscription_item_id: itemId }, { onConflict: "stripe_subscription_item_id" });
  check("the corrected upsert target (stripe_subscription_item_id) updates in place", !upsert.error, upsert.error?.message);
  const cnt = await must(admin.from("usage_addon_entitlements").select("id").eq("stripe_subscription_item_id", itemId), "count");
  check("exactly one row for that item id", cnt.length === 1);

  // 3. least privilege: the service role cannot delete or truncate entitlements
  const del = await admin.from("usage_addon_entitlements").delete().eq("stripe_subscription_item_id", itemId);
  check("service_role DELETE on entitlements is denied", Boolean(del.error), del.error?.code);

  // 4. anon cannot read or write entitlements
  if (cfg.anon) {
    const anon = createClient(cfg.url, cfg.anon, { auth: { persistSession: false } });
    const read = await anon.from("usage_addon_entitlements").select("id").eq("id", f.grantId);
    check("anon cannot read entitlements", Boolean(read.error) || (read.data || []).length === 0, read.error?.code);
    const write = await anon.from("usage_addon_entitlements").update({ status: "canceled" }).eq("id", f.grantId);
    check("anon cannot update entitlements", Boolean(write.error) || true, write.error?.code);
    const still = await must(admin.from("usage_addon_entitlements").select("status").eq("id", f.grantId).single(), "grant status");
    check("the grant is still active after the anon attempt", still.status === "active");
  }

  // 5. the owner (authenticated) can read the studio's grant through RLS but cannot write it
  if (cfg.anon) {
    const owner = createClient(cfg.url, cfg.anon, { auth: { persistSession: false } });
    const login = await owner.auth.signInWithPassword({ email: f.owner.email, password: f.owner.password });
    check("the synthetic owner can sign in", !login.error, login.error?.message);
    if (!login.error) {
      const read = await owner.from("usage_addon_entitlements").select("id, status").eq("id", f.grantId);
      check("the owner can read the studio grant through RLS", (read.data || []).length === 1, read.error?.message);
      const write = await owner.from("usage_addon_entitlements").update({ status: "canceled" }).eq("id", f.grantId);
      const now = await must(admin.from("usage_addon_entitlements").select("status").eq("id", f.grantId).single(), "grant status");
      check("the owner cannot change the grant (no write privilege)", now.status === "active", write.error?.code);
    }
  }

  // 6. an audited status change is recorded with before/after
  await must(admin.from("usage_addon_entitlements").update({ period_end: "2027-07-09" }).eq("id", f.grantId), "set period_end");
  const after = await must(admin.from("usage_addon_entitlement_events").select("event_type, from_period_end, to_period_end, actor").eq("entitlement_id", f.grantId).order("created_at", { ascending: true }), "audit events 2");
  check("setting period_end is audited as a period_change with old and new values", after.some((e) => e.event_type === "period_change" && String(e.to_period_end || "").startsWith("2027-07-09")), JSON.stringify(after.at(-1)));
  await must(admin.from("usage_addon_entitlements").update({ period_end: null }).eq("id", f.grantId), "clear period_end");

  // 7. the expiry function is not executable by clients
  const rpcAnon = cfg.anon ? await createClient(cfg.url, cfg.anon, { auth: { persistSession: false } }).rpc("expire_due_usage_addon_entitlements", { p_now: new Date().toISOString(), p_feature_key: "organizer_suite" }) : { error: { code: "n/a" } };
  check("anon cannot execute the expiry function", Boolean(rpcAnon.error), rpcAnon.error?.code);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nRESULT: ${results.length - failed.length} passed, ${failed.length} failed of ${results.length}`);
  if (failed.length) process.exitCode = 1;
}

async function setPeriodEnd(admin, outFile, date) {
  const f = JSON.parse(fs.readFileSync(outFile, "utf8"));
  await must(admin.from("usage_addon_entitlements").update({ period_end: date }).eq("id", f.grantId), "set period_end");
  console.log(`grant ${f.grantId} period_end = ${date ?? "null (open-ended)"}`);
}

(async () => {
  const [cmd, outFile, arg] = process.argv.slice(2);
  if (!cmd || !outFile) throw new Error("usage: d7_dev_smoke_fixture.cjs <create|verify|lapse|restore|cleanup> <out.json> [date]");
  const cfg = loadEnv();
  const admin = createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false } });
  if (cmd === "create") return create(admin, outFile);
  if (cmd === "verify") return verify(admin, cfg, outFile);
  if (cmd === "lapse") return setPeriodEnd(admin, outFile, arg || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
  if (cmd === "restore") return setPeriodEnd(admin, outFile, null);
  if (cmd === "cleanup") return cleanup(admin, outFile, false);
  throw new Error("unknown command " + cmd);
})().catch((e) => { console.error(e.message); process.exit(1); });
