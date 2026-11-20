#!/usr/bin/env node
/*
  Authenticated, READ-ONLY smoke of the production staff API (https://www.idanceflow.com/api/staff) for the owner.

    node docs/mobile/tools/staff-api-prod-smoke.mjs [--public-env <business.env>] [--otp] [--out <summary.txt>]
    (normally run through Invoke-StaffApiSmoke.ps1, one command)

  What it does
    1. Reads the PUBLIC EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY from the local env file (never printed).
    2. Asks, with hidden input, for the email and password (or, with --otp, the email and the emailed code) of an existing
       owner/admin/front-desk staff account. The prompts are answered in THIS process only.
    3. Signs in with Supabase GoTrue (password grant, or the OTP flow). The access token lives in one variable in memory:
       never written to a file, an environment variable, argv, the clipboard or the output; the refresh token is dropped at once.
    4. Makes ONLY GET requests to /api/staff: /me, then for the first suitable workspace /today, /schedule, /pulse, /clients,
       one /clients/<id>, one /appointments/<id>. No POST/PUT/PATCH/DELETE exists in this file; the request function pins GET.
    5. Checks status and SHAPE (key names and types per docs/mobile/Staff_API_Contract.md) and prints PASS / FAIL / EXPECT / SKIP per call.
       The output and the summary file carry no names, emails, ids or tokens: every line passes a leak guard that aborts if it
       contains any value learned in this run (email, password, code, tokens, ids).

  Exit: 0 every required call PASS, 1 any FAIL, 2 usage or sign-in failure.
  Rate limits: about 8 requests with 300 ms spacing (the server allows 240/min per user); a 429 is waited out once (Retry-After, max 30 s).
*/
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const PROD_HOST = "www.idanceflow.com";
const DEFAULT_ENV = "C:\\Users\\mcurt\\df-credentials\\release\\business.env";
const DEFAULT_OUT = "C:\\dfr-out\\release\\checks\\business-staff-smoke.txt";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const envFile = opt("--public-env", DEFAULT_ENV);
const outFile = opt("--out", DEFAULT_OUT);
const useOtp = flag("--otp");
const baseArg = opt("--base-url", `https://${PROD_HOST}`);

// ---- leak guard: every value learned in this run is registered; nothing containing one may be printed or saved.
const secrets = new Set();
const learn = (v) => {
  if (typeof v === "string" && v.length >= 4) secrets.add(v);
};
export function leaks(text, known = secrets) {
  const lower = String(text).toLowerCase();
  for (const s of known) if (lower.includes(String(s).toLowerCase())) return true;
  return /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(String(text)); // any JWT-shaped string
}
const lines = [];
function emit(line) {
  if (leaks(line)) {
    console.error("REDACTION FAILURE: an output line contained a value learned in this run. Nothing was printed or saved.");
    process.exit(3);
  }
  lines.push(line);
  console.log(line);
}

// ---- environment (public values only)
function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(EXPO_PUBLIC_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

// ---- hidden prompts (TTY: raw mode, no echo; piped stdin: one line per prompt, used by the offline self-test)
let pipedLines = null;
async function pipedLine() {
  if (!pipedLines) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    pipedLines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  }
  return pipedLines.shift() ?? "";
}
function ttyHidden(promptText) {
  return new Promise((resolve) => {
    process.stdout.write(promptText);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = "";
    const onKey = (str, key) => {
      if (key?.ctrl && key.name === "c") {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(2);
      }
      if (key?.name === "return" || key?.name === "enter") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off("keypress", onKey);
        process.stdout.write("\n");
        resolve(value);
      } else if (key?.name === "backspace") value = value.slice(0, -1);
      else if (str && !key?.ctrl && !key?.meta) value += str;
    };
    process.stdin.on("keypress", onKey);
  });
}
const askHidden = (promptText) => (process.stdin.isTTY ? ttyHidden(promptText) : pipedLine());

// ---- sign-in: the token is returned to the caller and kept only in `session.token`
async function gotrue(supabaseUrl, anonKey, route, body) {
  let res;
  try {
    res = await fetch(`${supabaseUrl}/auth/v1/${route}`, {
      method: "POST",
      redirect: "manual",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    fail(2, "Sign-in failed: could not reach the authentication service.");
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}
const safeCode = (json) => (json && typeof json.error_code === "string" && /^[a-z_]{3,40}$/.test(json.error_code) ? json.error_code : "unknown");

async function signIn(supabaseUrl, anonKey) {
  const email = (await askHidden("Staff email (hidden): ")).trim();
  learn(email);
  if (!email) fail(2, "No email entered.");
  let result;
  if (!useOtp) {
    const password = await askHidden("Password (hidden): ");
    learn(password);
    result = await gotrue(supabaseUrl, anonKey, "token?grant_type=password", { email, password });
  } else {
    const sent = await gotrue(supabaseUrl, anonKey, "otp", { email, create_user: false });
    if (sent.status >= 300) fail(2, `Sign-in failed: the code request was refused (HTTP ${sent.status}, ${safeCode(sent.json)}).`);
    const code = (await askHidden("Code from the email (hidden): ")).trim();
    learn(code);
    result = await gotrue(supabaseUrl, anonKey, "verify", { type: "email", email, token: code });
  }
  if (result.status !== 200 || typeof result.json?.access_token !== "string") {
    fail(2, `Sign-in failed (HTTP ${result.status}, ${safeCode(result.json)}). Nothing was called. Use --otp if this account has no password.`);
  }
  learn(result.json.access_token);
  learn(result.json.user?.id);
  learn(result.json.user?.email);
  return { token: result.json.access_token }; // refresh_token is deliberately not read or kept
}

// ---- shape checking: key names and types only
const T = {
  str: (v) => typeof v === "string",
  strN: (v) => v === null || typeof v === "string",
  num: (v) => typeof v === "number",
  numN: (v) => v === null || typeof v === "number",
  bool: (v) => typeof v === "boolean",
  obj: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  arr: Array.isArray,
  any: () => true,
};
function shape(value, spec, where = "") {
  const problems = [];
  if (!T.obj(value)) return [`${where || "body"}: not an object`];
  for (const [key, check] of Object.entries(spec)) {
    const optional = key.endsWith("?");
    const k = optional ? key.slice(0, -1) : key;
    if (!(k in value)) {
      if (!optional) problems.push(`${where}${k}: missing`);
      continue;
    }
    if (!check(value[k])) problems.push(`${where}${k}: wrong type`);
  }
  return problems;
}
const APPT_ROW = { id: T.str, title: T.strN, appointmentType: T.str, status: T.str, startsAt: T.str, endsAt: T.strN, room: (v) => v === null || T.obj(v), locationName: T.strN, client: (v) => v === null || T.obj(v), partner: (v) => v === null || T.obj(v) };
const rowsProblems = (rows, extra = {}) => {
  if (!T.arr(rows)) return ["appointments: not an array"];
  const bad = rows.slice(0, 50).flatMap((r, i) => shape(r, { ...APPT_ROW, ...extra }, `appointments[${i}].`));
  return [...new Set(bad.map((p) => p.replace(/\[\d+\]/, "[]")))];
};
const SPEC = {
  me: (b) => [
    ...shape(b, { user: T.obj, workspaces: T.arr }),
    ...(T.arr(b?.workspaces) ? b.workspaces.slice(0, 20).flatMap((w) => shape(w, { studioId: T.str, name: T.str, role: T.str, timeZone: T.str, accessAllowed: T.bool, subscriptionStatus: T.strN, capabilities: T.obj }, "workspaces[].")) : []),
    ...(T.obj(b?.user) ? shape(b.user, { id: T.str, email: T.strN, fullName: T.strN }, "user.") : []),
  ],
  today: (b) => [...shape(b, { studioId: T.str, date: T.str, timeZone: T.str, instructorId: T.strN, appointments: T.arr }), ...rowsProblems(b?.appointments)],
  schedule: (b) => [...shape(b, { studioId: T.str, date: T.str, timeZone: T.str, truncated: T.bool, appointments: T.arr }), ...rowsProblems(b?.appointments, { instructor: (v) => v === null || T.obj(v) })],
  pulse: (b) => [
    ...shape(b, { studioId: T.str, timeZone: T.str, date: T.str, asOf: T.str, scope: T.str, instructorId: T.strN, today: T.obj, next: (v) => v === null || T.obj(v), newClientsLast7Days: T.numN }),
    ...(T.obj(b?.today) ? shape(b.today, { total: T.num, upcoming: T.num, cancelled: T.num, truncated: T.bool }, "today.") : []),
  ],
  clients: (b) => [
    ...shape(b, { clients: T.arr, nextCursor: T.strN }),
    ...(T.arr(b?.clients) ? [...new Set(b.clients.slice(0, 50).flatMap((c) => shape(c, { id: T.str, firstName: T.strN, lastName: T.strN, status: T.strN }, "clients[].")))] : []),
  ],
  client: (b) => [
    ...shape(b, { client: T.obj, timeZone: T.str, activePackages: (v) => v === null || T.arr(v), nextAppointment: (v) => v === null || T.obj(v) }),
    ...(T.obj(b?.client) ? shape(b.client, { id: T.str, firstName: T.strN, lastName: T.strN, status: T.strN }, "client.") : []),
  ],
  appointment: (b) => [...shape(b, { ...APPT_ROW, studioId: T.str, timeZone: T.str, accessScope: T.str, notes: T.strN, instructor: (v) => v === null || T.obj(v) })],
};

// ---- the only request function: GET, no redirects (a redirect could carry the token to another host)
async function get(base, session, route, headersSeen) {
  const once = async () => {
    let res;
    try {
      res = await fetch(`${base}/api/staff${route}`, {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "application/json", Authorization: `Bearer ${session.token}` },
      });
    } catch {
      return { status: 0, body: null, retryAfter: null };
    }
    for (const name of res.headers.keys()) if (/^(cache-control|x-ratelimit-.*|retry-after)$/i.test(name)) headersSeen.add(name.toLowerCase());
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const cc = res.headers.get("cache-control");
    return { status: res.status, body, retryAfter: res.headers.get("retry-after"), noStore: /no-store/i.test(cc || ""), hasCacheControl: cc !== null };
  };
  let r = await once();
  if (r.status === 429) {
    const wait = Math.min(30, Math.max(1, Number.parseInt(r.retryAfter ?? "", 10) || 5));
    emit(`NOTE  429 received; waiting ${wait}s (Retry-After) and retrying once`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    r = await once();
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  return r;
}

const ROLES_BROAD = new Set(["studio_owner", "studio_admin", "front_desk"]);

async function main() {
  if (!fs.existsSync(envFile)) fail(2, `Env file not found: ${envFile}`);
  const env = readEnv(envFile);
  const supabaseUrl = (env.EXPO_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY || "";
  if (!supabaseUrl || !anonKey) fail(2, "The env file lacks EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY.");
  learn(anonKey);

  const base = baseArg.replace(/\/+$/, "");
  const baseUrl = new URL(base);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname);
  if (!loopback && !(baseUrl.protocol === "https:" && baseUrl.hostname === PROD_HOST)) fail(2, `Refusing to send credentials to ${baseUrl.hostname}: only https://${PROD_HOST} (or a loopback test server).`);
  if (env.EXPO_PUBLIC_DANCEFLOW_WEB_URL && new URL(env.EXPO_PUBLIC_DANCEFLOW_WEB_URL).hostname !== baseUrl.hostname && !loopback) {
    console.error(`Warning: the env file's web URL host differs from ${baseUrl.hostname}.`);
  }

  const session = await signIn(supabaseUrl, anonKey);
  const headersSeen = new Set();
  const results = [];
  const record = (status, tmpl, http, note = "") => {
    results.push({ status, tmpl });
    emit(`${status.padEnd(7)}GET ${tmpl}  ${http}${note ? "  " + note : ""}`);
  };
  const run = async (tmpl, route, kind, { expect403 = false } = {}) => {
    const r = await get(base, session, route, headersSeen);
    if (r.status === 0) {
      record("FAIL", tmpl, "no response");
      return { ok: false };
    }
    if (r.status === 403 && expect403 && r.body?.code === "role_not_permitted") {
      record("EXPECT", tmpl, "403", "role_not_permitted (expected for this role)");
      return { ok: false };
    }
    if (r.status !== 200) {
      const code = typeof r.body?.code === "string" && /^[a-z_]{3,40}$/.test(r.body.code) ? r.body.code : "no-code";
      record("FAIL", tmpl, String(r.status), `code=${code}`);
      return { ok: false };
    }
    const problems = SPEC[kind](r.body);
    const cache = r.hasCacheControl ? (r.noStore ? "cache=no-store" : "cache=NOT-no-store") : "cache=absent";
    if (problems.length || !r.noStore) {
      record("FAIL", tmpl, "200", `${problems.slice(0, 6).join("; ")}${r.noStore ? "" : " ; Cache-Control lacks no-store"}`.trim());
      return { ok: false, usable: problems.length === 0, body: r.body };
    }
    return { ok: true, usable: true, body: r.body, cache };
  };
  const pass = (tmpl, cache, note) => record("PASS", tmpl, `200  ${cache}`, note);

  emit(`SMOKE  host=${baseUrl.hostname}  auth=${useOtp ? "otp" : "password"}  methods=GET-only`);

  // /me
  const me = await run("/me", "/me", "me");
  let ws = null;
  if (me.usable) {
    const list = me.body.workspaces;
    learn(me.body.user?.id);
    learn(me.body.user?.email);
    learn(me.body.user?.fullName);
    const roles = {};
    for (const w of list) roles[w.role] = (roles[w.role] || 0) + 1;
    if (me.ok) pass("/me", me.cache, `workspaces=${list.length} roles=${Object.entries(roles).map(([k, v]) => `${k}:${v}`).join(",") || "none"}`);
    ws = list.find((w) => w.accessAllowed && ROLES_BROAD.has(w.role)) || list.find((w) => w.accessAllowed) || null;
    if (!ws) record("FAIL", "/workspaces/:studioId/*", "-", "no workspace with accessAllowed=true");
    else learn(ws.studioId);
  }
  let role = null;
  const detailIds = { client: null, appointment: null };
  if (ws) {
    role = ws.role;
    learn(ws.studioId);
    emit(`ROLE  ${role}  broad=${ROLES_BROAD.has(role)}  (first accessible workspace)`);
    const sid = encodeURIComponent(ws.studioId);
    const broad = ROLES_BROAD.has(role);

    const today = await run("/workspaces/:studioId/today", `/workspaces/${sid}/today`, "today");
    if (today.usable) {
      if (today.ok) pass("/workspaces/:studioId/today", today.cache, `appointments=${today.body.appointments.length}`);
      detailIds.appointment = today.body.appointments[0]?.id ?? null;
    }
    const sched = await run("/workspaces/:studioId/schedule", `/workspaces/${sid}/schedule`, "schedule", { expect403: !broad });
    if (sched.usable) {
      if (sched.ok) pass("/workspaces/:studioId/schedule", sched.cache, `appointments=${sched.body.appointments.length} truncated=${sched.body.truncated}`);
      detailIds.appointment ??= sched.body.appointments[0]?.id ?? null;
    }
    const pulse = await run("/workspaces/:studioId/pulse", `/workspaces/${sid}/pulse`, "pulse");
    if (pulse.ok) pass("/workspaces/:studioId/pulse", pulse.cache, `scope=${pulse.body.scope} today.total=${pulse.body.today.total} newClients7d=${pulse.body.newClientsLast7Days === null ? "null" : "number"}`);
    const cl = await run("/workspaces/:studioId/clients", `/workspaces/${sid}/clients?q=&limit=5`, "clients", { expect403: !broad });
    if (cl.usable) {
      if (cl.ok) pass("/workspaces/:studioId/clients?q=", cl.cache, `clients=${cl.body.clients.length} nextCursor=${cl.body.nextCursor === null ? "null" : "set"}`);
      detailIds.client = cl.body.clients[0]?.id ?? null;
    }
    if (detailIds.client) {
      learn(detailIds.client);
      const cd = await run("/workspaces/:studioId/clients/:clientId", `/workspaces/${sid}/clients/${encodeURIComponent(detailIds.client)}`, "client");
      if (cd.ok) pass("/workspaces/:studioId/clients/:clientId", cd.cache, `activePackages=${cd.body.activePackages === null ? "null" : cd.body.activePackages.length} nextAppointment=${cd.body.nextAppointment === null ? "none" : "set"}`);
    } else record("SKIP", "/workspaces/:studioId/clients/:clientId", "-", "no client returned");
    if (detailIds.appointment) {
      learn(detailIds.appointment);
      const ad = await run("/workspaces/:studioId/appointments/:appointmentId", `/workspaces/${sid}/appointments/${encodeURIComponent(detailIds.appointment)}`, "appointment");
      if (ad.ok) pass("/workspaces/:studioId/appointments/:appointmentId", ad.cache, `accessScope=${ad.body.accessScope} roster=${ad.body.roster ? "yes" : "no"}`);
    } else record("SKIP", "/workspaces/:studioId/appointments/:appointmentId", "-", "no appointment on today or the studio day");
  }

  // wipe the in-memory credential before reporting
  session.token = null;

  const failed = results.filter((r) => r.status === "FAIL").length;
  const overall = failed === 0 && me.ok && ws ? "PASS" : "FAIL";
  emit(`HEADERS seen (names only): ${[...headersSeen].sort().join(", ") || "none"}`);
  emit(`RESULT: ${overall}  pass=${results.filter((r) => r.status === "PASS").length} fail=${failed} expect=${results.filter((r) => r.status === "EXPECT").length} skip=${results.filter((r) => r.status === "SKIP").length}`);
  const header = [`Business staff API production smoke (read-only, GET only)`, `Date: ${new Date().toISOString()}`, `Redacted summary: no names, emails, ids or tokens.`];
  const text = [...header, ...lines].join("\n") + "\n";
  if (leaks(text)) fail(3, "REDACTION FAILURE: the summary was not saved.");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, text);
  console.log(`Summary saved: ${outFile}`);
  process.exit(overall === "PASS" ? 0 : 1);
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("staff-api-prod-smoke.mjs")) await main();
