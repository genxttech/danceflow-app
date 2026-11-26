// Shared helpers for the staff-API write-gate evidence scripts (write-gate-matrix.mjs, web-actions-qa.mjs, v01-parity.mjs).
// LOCAL / DISPOSABLE STACKS ONLY: every helper refuses anything that is not a loopback iso-qa --auth stack. Access tokens live in this process's memory only:
// they are never put in a child's argv or environment, never written to a file, and the leak guard at the end of a run fails it if one shows up in the output folder.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createUser, loadStack, psql } from "../auth-profile/lib.mjs";

export { createUser, loadStack, psql, randomUUID };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const q = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);

export function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (!(key in spec)) throw new Error(`unknown option ${a}`);
    out[key] = spec[key] === "flag" ? true : argv[++i];
  }
  for (const [key, kind] of Object.entries(spec)) if (kind === "required" && !out[key]) throw new Error(`--${key} is required`);
  return out;
}

/** The commit a worktree is at and whether it is clean (tracked files and untracked, ignoring build output). */
export function treeState(dir) {
  const git = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  const head = git("rev-parse", "HEAD").stdout.trim();
  const dirty = git("status", "--porcelain").stdout.split("\n").filter((l) => l.trim() && !/^\?\? (node_modules|\.next|tsconfig\.tsbuildinfo)\/?$/.test(l.trim()));
  return { head, clean: dirty.length === 0, dirty };
}

/** Postgres snapshot of every table a staff write could touch: row count and an md5 over the rows' text, in a stable order. */
export const SNAPSHOT_TABLES = [
  "appointments", "appointment_attendees", "lesson_transactions", "client_package_items", "client_packages", "client_membership_usage", "client_activity_notes", "clients",
  "notifications", "notification_deliveries", "appointment_package_deduction_errors", "membership_usage_sync_errors", "mobile_notification_log", "sms_message_logs",
  "user_studio_roles", "instructors", "studios", "profiles",
];
export function snapshot(env, tables = SNAPSHOT_TABLES) {
  const sql = tables.map((t) => `select '${t}', count(*), coalesce(md5(string_agg(x::text, '|' order by x::text)), '-') from public.${t} x`).join(" union all ");
  const rows = {};
  for (const line of psql(env, sql).split("\n")) {
    const [t, n, h] = line.split("|");
    rows[t] = { rows: Number(n), md5: h };
  }
  return rows;
}
export function diffSnapshots(a, b) {
  return Object.keys(a).filter((t) => a[t].rows !== b[t].rows || a[t].md5 !== b[t].md5).map((t) => ({ table: t, before: a[t].rows, after: b[t].rows }));
}

// ------------------------------------------------------------------------------------------------ web server (production build, `next start`)
export function webEnv(env, policy) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^STAFF_API_/i.test(k) || /^(STRIPE|TWILIO|RESEND|SENTRY|VERCEL)/i.test(k)) delete base[k];
  return {
    ...base,
    NEXT_PUBLIC_SUPABASE_URL: env.TW4A_LOCAL_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.ISO_QA_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: env.ISO_QA_SERVICE_ROLE_KEY,
    NODE_OPTIONS: "--max-old-space-size=4096",
    ...(policy === undefined ? {} : { STAFF_API_WRITE_POLICY: policy }), // undefined = the variable is NOT SET (not an empty string)
  };
}
export class Web {
  constructor({ dir, port, stack, logFile }) {
    Object.assign(this, { dir, port, stack, logFile, proc: null });
  }
  get base() {
    return `http://127.0.0.1:${this.port}`;
  }
  async start(policy) {
    await this.stop();
    const log = fs.openSync(this.logFile, "a");
    fs.writeSync(log, `\n--- next start (policy: ${policy === undefined ? "UNSET" : JSON.stringify(policy)}) ---\n`);
    const nextBin = path.join(this.dir, "node_modules", "next", "dist", "bin", "next");
    this.proc = spawn(process.execPath, [nextBin, "start", "-p", String(this.port), "-H", "127.0.0.1"], { cwd: this.dir, env: webEnv(this.stack, policy), stdio: ["ignore", log, log] });
    for (let i = 0; i < 90; i++) {
      try {
        const r = await fetch(`${this.base}/api/staff/me`);
        if (r.status === 401) return;
      } catch {
        /* not up yet */
      }
      await sleep(1000);
    }
    throw new Error("the web app did not come up");
  }
  async stop() {
    if (!this.proc) return;
    spawnSync("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], { stdio: "ignore" });
    this.proc = null;
    await sleep(2500);
  }
}

// ------------------------------------------------------------------------------------------------ sign-in (token stays in memory)
export const secrets = new Set();
export const networkRetries = { count: 0 };
export async function signIn(env, email, password) {
  const res = await fetch(`${env.ISO_QA_AUTH_URL}/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: env.ISO_QA_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) throw new Error(`sign-in failed for ${email}: ${res.status}`);
  secrets.add(body.access_token);
  if (body.refresh_token) secrets.add(body.refresh_token);
  return body.access_token;
}

/** One HTTP call; returns only what is safe to save (status, code, a few body fields). */
export async function call(base, method, urlPath, { token, headers = {}, body, rawBody } = {}) {
  const h = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers };
  let payload;
  if (rawBody !== undefined) payload = rawBody;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    h["Content-Type"] = "application/json";
  }
  let res;
  let text;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(`${base}${urlPath}`, { method, headers: h, body: payload, redirect: "manual", signal: AbortSignal.timeout(60_000) });
      text = await res.text();
      break;
    } catch (e) {
      // a socket reset before any response is a transport condition, not an application answer: retried up to 3 times and counted in networkRetries
      networkRetries.count++;
      if (attempt >= 3) throw e;
      await sleep(1500);
    }
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, code: json?.code ?? null, json, text: json ? undefined : text.slice(0, 200) };
}

/** Same call, retried once only when the server's in-memory rate limiter answered (429): a pure harness condition, recorded. */
export async function callRetry(base, method, urlPath, opts) {
  const first = await call(base, method, urlPath, opts);
  if (first.status !== 429) return first;
  await sleep(62_000);
  const second = await call(base, method, urlPath, opts);
  second.retriedAfter429 = true;
  return second;
}

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** After a run: no access/refresh token, no JWT-shaped string and none of the stack's keys may appear in anything saved. Returns the problems. */
export function leakGuard(outDir, env) {
  const problems = [];
  const needles = [...secrets, env.ISO_QA_ANON_KEY, env.ISO_QA_SERVICE_ROLE_KEY, env.TW4A_LOCAL_JWT_SECRET].filter(Boolean);
  for (const f of fs.readdirSync(outDir, { recursive: true })) {
    const p = path.join(outDir, String(f));
    if (!fs.statSync(p).isFile()) continue;
    const text = fs.readFileSync(p, "utf8");
    for (const n of needles) if (text.includes(n)) problems.push(`${f}: contains a secret value`);
    if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(text)) problems.push(`${f}: contains a JWT-shaped string`);
    if (/Bearer\s+[A-Za-z0-9._-]{20,}/.test(text)) problems.push(`${f}: contains a bearer header`);
  }
  return problems;
}

export class Results {
  constructor() {
    this.cells = [];
  }
  add(group, name, expected, actual, ok, extra = {}) {
    this.cells.push({ group, name, expected, actual, ok, ...extra });
    if (!ok) console.error(`[FAIL] ${group} :: ${name} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
  summary() {
    const by = {};
    for (const c of this.cells) {
      by[c.group] ??= { pass: 0, fail: 0 };
      by[c.group][c.ok ? "pass" : "fail"]++;
    }
    const pass = this.cells.filter((c) => c.ok).length;
    return { total: this.cells.length, pass, fail: this.cells.length - pass, groups: by };
  }
}
