#!/usr/bin/env node
/**
 * P1 walkthrough: a DISPOSABLE local full stack (Postgres, PostgREST, Kong, GoTrue, Mailpit) with the composed P1 chain.
 * Database base = the local image `cf1host:found` (the same base the composed P1 database run uses: July 2026 production schema dump,
 * main's migrations and the Competition foundation). On top of it this applies every release-line migration the image does not hold,
 * then the corrections and the restriction named by a pins file of the composed run.
 * The container, gateway and sign-in settings are copied from the isolated QA harness (scripts/qa/iso-qa.mjs on main). The harness
 * itself is not driven: its own baseline skips migrations the Competition chain needs.
 * LOCAL ONLY: local images (never pulled), one loopback port, no hosted project, no provider.
 * Heavy (a docker stack): hold C:\dfr\heavy.lock (FIFO ticket) around `up` ... `down`; this script does not take it.
 *
 *   node p1-stack.mjs plan  --pins f [--no-restriction]                     print the composed migration list (git only)
 *   node p1-stack.mjs up    --pins f [--no-restriction] [--env-out dir] [--app-url url]
 *   node p1-stack.mjs check [--env-out dir]                                 probes: base objects, composed objects, sign-in, API, mail
 *   node p1-stack.mjs down                                                  removes only containers and the network this script labels
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = "src/lib/supabase/migrations";
/** origin/main when cf1host:base was built (2026-11-07): the image holds these migrations. `check` verifies their tables exist. */
const BASE_MAIN = "226131109bc94971822df04aa50fae31da2f68cd";
/** cf1host:found also holds the Competition foundation through this version, except the two files the composed run applies itself. */
const FOUNDATION_END = "20270119090000";
const NOT_IN_FOUNDATION = ["20270103090000", "20270103091000"];
const DUMP_DATE = "20260715000000";
/** Pins of the composed run, in the order that decides which pin owns a file two of them carry. */
const CORRECTION_PINS = ["P_844", "P_865", "P_864", "P_S5", "P_866", "P_S6", "P_899"];
const RESTRICTION_PIN = "P_P1";

const LABEL = "df.p1walk=1";
const NET = "df-p1walk-net";
const DB = "df-p1walk-db";
const NAMES = { db: DB, rest: "df-p1walk-rest", kong: "df-p1walk-kong", auth: "df-p1walk-auth", mail: "df-p1walk-mail" };
const IMAGES = {
  db: "cf1host:found",
  rest: "public.ecr.aws/supabase/postgrest:v14.8",
  kong: "public.ecr.aws/supabase/kong:2.8.1",
  auth: "public.ecr.aws/supabase/gotrue:v2.188.1",
  mail: "public.ecr.aws/supabase/mailpit:v1.22.3",
};
const LIMITS = { db: ["1500m", "2"], rest: ["256m", "0.5"], kong: ["1280m", "1"], auth: ["256m", "0.5"], mail: ["128m", "0.25"] };
const AUTH_REDIRECTS = "http://localhost:*/**,http://127.0.0.1:*/**,danceflow://**,danceflow-business://**";
const ERROR_RE = /(^|\n)(psql:[^\n]*?: )?(ERROR|FATAL|PANIC):/;

const die = (message) => {
  console.error(`[p1-stack] ${message}`);
  process.exit(2);
};
const log = (message) => console.log(`[p1-stack ${new Date().toISOString().slice(11, 19)}Z] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const [command, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i += 1) {
  if (!rest[i].startsWith("--")) die(`unexpected argument ${rest[i]}`);
  const key = rest[i].slice(2);
  flags[key] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
}
// In the repository this file lives at scripts/qa/p1/browser/; elsewhere pass --repo.
const REPO = path.resolve(flags.repo ?? path.resolve(here, "..", "..", "..", ".."));
const envOut = path.resolve(flags["env-out"] ?? "C:/dfr/p1-browser/stack");
const appUrl = flags["app-url"] ?? "http://localhost:3100";

const git = (args, input) => execFileSync("git", args, { cwd: REPO, input, maxBuffer: 256 * 1024 * 1024 });
const text = (args) => git(args).toString("utf8").replace(/\n$/, "");
const namesAt = (ref) => text(["ls-tree", "--name-only", `${ref}:${MIGRATIONS}`]).split("\n").filter((n) => /^[0-9]+.*\.sql$/.test(n));
const versionOf = (name) => name.split("_")[0].padEnd(14, "0");
const byVersion = (a, b) => (versionOf(a.name) < versionOf(b.name) ? -1 : versionOf(a.name) > versionOf(b.name) ? 1 : a.name < b.name ? -1 : 1);

/** Contents of many migration files with one git process. */
function readMany(items) {
  const out = git(["cat-file", "--batch"], items.map((i) => `${i.ref}:${MIGRATIONS}/${i.name}\n`).join(""));
  const result = [];
  let at = 0;
  for (const item of items) {
    const eol = out.indexOf(10, at);
    const [, type, size] = out.subarray(at, eol).toString("utf8").split(" ");
    if (type !== "blob") die(`cannot read ${item.name} at ${item.ref.slice(0, 9)}`);
    result.push({ ...item, sql: out.subarray(eol + 1, eol + 1 + Number(size)).toString("utf8") });
    at = eol + 2 + Number(size);
  }
  return result;
}

function readPins() {
  if (typeof flags.pins !== "string") die("--pins <file> is required: name the pins file of the composed run this stack stands for");
  const file = path.resolve(flags.pins);
  const pins = {};
  const extra = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^export (\w+)=([0-9a-f]{40})\s*$/.exec(line);
    if (match) pins[match[1]] = match[2];
    // files the composed run layered on its own, as "<commit>:<path>" pairs; only forward migrations are applied here
    const layered = /^export EXTRA_FILES="([^"]*)"\s*$/.exec(line);
    for (const item of layered ? layered[1].split(/\s+/).filter(Boolean) : []) {
      const at = item.indexOf(":");
      const target = item.slice(at + 1);
      if (path.posix.dirname(target) === MIGRATIONS && /^[0-9]{14}_.*\.sql$/.test(path.posix.basename(target))) extra.push({ name: path.posix.basename(target), ref: item.slice(0, at) });
    }
  }
  for (const key of ["LIVE_PIN", ...CORRECTION_PINS, RESTRICTION_PIN]) if (!pins[key]) die(`${file} has no ${key}`);
  return { file, pins, extra };
}

/** What the image already holds, what is applied on top of it from the release line, then every correction and the restriction. */
function compose() {
  const { file, pins, extra } = readPins();
  const live = pins.LIVE_PIN;
  const assumed = new Map(namesAt(BASE_MAIN).map((name) => [name, { name, ref: BASE_MAIN }]));
  const chosen = new Map();
  const notes = [];
  for (const name of namesAt(live)) {
    if (assumed.has(name)) continue;
    const version = versionOf(name);
    if (/competition/.test(name) && version <= FOUNDATION_END && !NOT_IN_FOUNDATION.includes(version)) assumed.set(name, { name, ref: live });
    else chosen.set(name, { ref: live, from: "LIVE" });
  }
  const releaseCount = chosen.size;
  const keys = flags["no-restriction"] ? CORRECTION_PINS : [...CORRECTION_PINS, RESTRICTION_PIN];
  for (const key of keys) {
    const ref = pins[key];
    const changed = text(["diff", "--name-only", "--diff-filter=AM", `${live}...${ref}`, "--", MIGRATIONS])
      .split("\n")
      .filter((f) => path.posix.dirname(f) === MIGRATIONS && /^[0-9]{14}_.*\.sql$/.test(path.posix.basename(f)))
      .map((f) => path.posix.basename(f));
    let added = 0;
    for (const name of changed) {
      const owner = chosen.get(name) ?? (assumed.has(name) ? { ref: assumed.get(name).ref, from: "BASE IMAGE" } : null);
      if (owner) {
        if (text(["rev-parse", `${ref}:${MIGRATIONS}/${name}`]) !== text(["rev-parse", `${owner.ref}:${MIGRATIONS}/${name}`])) notes.push(`${key} ${name} differs from the ${owner.from} copy; the ${owner.from} copy is used`);
        continue;
      }
      chosen.set(name, { ref, from: key });
      added += 1;
    }
    if (!added) notes.push(`${key} adds no migration`);
  }
  for (const { name, ref } of extra) {
    if (chosen.has(name) || assumed.has(name)) notes.push(`EXTRA ${name} is already composed`);
    else chosen.set(name, { ref, from: "EXTRA" });
  }
  const list = [...chosen].map(([name, source]) => ({ name, ...source })).sort(byVersion);
  return { pinsFile: file, pins, list, assumed: [...assumed.values()].sort(byVersion), releaseCount, notes };
}

/** Tables the migrations held by the image create (and never later drop): their absence means the image is not what compose() assumes. */
function expectedBaseTables(assumed) {
  const tables = new Map();
  for (const { name, sql } of readMany(assumed.filter((i) => versionOf(i.name) >= DUMP_DATE))) {
    const code = sql.replace(/--[^\n]*/g, "");
    for (const m of code.matchAll(/\b(create table(?: if not exists)?|drop table(?: if exists)?|rename to)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?(\s*\.)?/gi)) {
      if (m[3]) continue; // another schema
      if (/^create/i.test(m[1])) tables.set(m[2].toLowerCase(), name);
      else if (/^drop/i.test(m[1])) tables.delete(m[2].toLowerCase());
    }
    for (const m of code.matchAll(/alter table(?: if exists)?\s+(?:only\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+rename to/gi)) tables.delete(m[1].toLowerCase());
  }
  return [...tables].map(([table, from]) => ({ table, from }));
}

const docker = (args, input) => spawnSync("docker", args, { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const must = (args, input) => {
  const r = docker(args, input);
  if (r.status !== 0) die(`docker ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout).slice(0, 600)}`);
  return r.stdout.trim();
};
const psqlRaw = (sql, { single = false } = {}) => {
  const r = docker(["exec", "-i", "-e", "PGPASSWORD=postgres", DB, "psql", "-U", "supabase_admin", "-d", "postgres", "-X", "-At", "-q", "-v", "ON_ERROR_STOP=1", ...(single ? ["-1", "-f", "-"] : [])], sql);
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  return { ok: r.status === 0 && !ERROR_RE.test(r.stderr ?? ""), stdout: (r.stdout ?? "").trim(), out };
};
const psql = (sql, options) => {
  const r = psqlRaw(sql, options);
  if (!r.ok) die(`psql failed: ${r.out.trim().slice(0, 800)}`);
  return r.stdout;
};

/** From the harness: what the auth service provides on a real stack, so a signed-in request resolves to its user in the database. */
const IDENTITY_SQL = `
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
create or replace function auth.email() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'))::text
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt() to anon, authenticated, service_role;
`;
const identityOk = () => psql(`select set_config('request.jwt.claims', '{"sub":"11111111-2222-4333-8444-555555555555","role":"authenticated","email":"qa@example.test"}', false) is not null
  and auth.uid() = '11111111-2222-4333-8444-555555555555'::uuid and auth.role() = 'authenticated' and auth.email() = 'qa@example.test';`).split("\n").pop() === "t";
/** From the harness: columns the auth service adds, needed while migrations are applied ... */
const PRE_AUTH_COLUMNS_SQL = "alter table auth.users add column if not exists email_confirmed_at timestamptz, add column if not exists banned_until timestamptz, add column if not exists deleted_at timestamptz;";
/** ... and removed again so the real auth service can run its own migrations as the owner of the auth schema. */
const AUTH_PREP_SQL = `
alter table auth.users drop column if exists email_confirmed_at, drop column if exists banned_until, drop column if exists deleted_at;
do $p$ declare r record; begin
  for r in select p.oid::regprocedure as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'auth' loop
    execute format('alter function %s owner to supabase_auth_admin', r.f); end loop;
  for r in select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'auth' and c.relkind in ('r', 'v', 'S')
    and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i') and c.relkind = 'S') loop
    execute format('alter %s auth.%I owner to supabase_auth_admin', case r.relkind when 'r' then 'table' when 'v' then 'view' else 'sequence' end, r.relname); end loop;
  for r in select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'auth' and t.typtype = 'e' loop
    execute format('alter type auth.%I owner to supabase_auth_admin', r.typname); end loop;
end $p$;
alter schema auth owner to supabase_auth_admin;
alter role supabase_auth_admin with password 'postgres';
alter role authenticator with password 'postgres';
`;

const kongYml = () => `_format_version: "2.1"
services:
  - name: rest-v1
    url: http://${NAMES.rest}:3000/
    routes:
      - name: rest-v1
        strip_path: true
        paths: ["/rest/v1/"]
  - name: auth-v1
    url: http://${NAMES.auth}:9999/
    routes:
      - name: auth-v1
        strip_path: true
        paths: ["/auth/v1/"]
  - name: mail
    url: http://${NAMES.mail}:8025/mail/
    routes:
      - name: mail
        strip_path: true
        paths: ["/mail/"]
plugins:
  - name: cors
    config:
      origins: ["*"]
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
      headers: ["authorization", "apikey", "content-type", "x-client-info", "x-supabase-api-version", "accept", "accept-profile", "content-profile", "prefer", "range"]
      exposed_headers: ["content-range", "x-total-count"]
      credentials: false
`;

const portFree = (port) => new Promise((resolve) => {
  const server = createServer();
  server.once("error", () => resolve(false));
  server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
});

const run = (key, extra, tail = []) => ["run", "-d", "--pull=never", "--name", NAMES[key], "--label", LABEL, "--network", NET, "--memory", LIMITS[key][0], "--cpus", LIMITS[key][1], ...extra, IMAGES[key], ...tail];

function localKey(role, secret) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ role, iss: "supabase", exp: Math.floor(Date.now() / 1000) + 7 * 86400 })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

async function waitFor(what, probe, timeoutMs) {
  const start = Date.now();
  while (!(await probe())) {
    if (Date.now() - start > timeoutMs) {
      for (const c of Object.values(NAMES)) {
        const logs = docker(["logs", "--tail", "15", c]);
        console.error(`--- ${c}\n${`${logs.stdout}${logs.stderr}`.slice(-1500)}`);
      }
      die(`${what} did not come up within ${Math.round(timeoutMs / 1000)} s`);
    }
    await sleep(2000);
  }
}
const httpOk = async (url, accept = (s) => s === 200) => {
  try {
    return accept((await fetch(url, { headers: { apikey: "x" }, signal: AbortSignal.timeout(8000) })).status);
  } catch {
    return false;
  }
};

async function up() {
  const composed = compose();
  const migrations = readMany(composed.list);
  for (const name of Object.values(NAMES)) if (docker(["inspect", name]).status === 0) die(`${name} already exists: a stack is still up (use \`down\` if it is yours). Nothing was changed.`);
  for (const image of Object.values(IMAGES)) if (docker(["image", "inspect", image]).status !== 0) die(`local image ${image} is missing; images are never pulled`);
  let port = 0;
  for (let p = 56890; p < 56900 && !port; p += 1) if (await portFree(p)) port = p;
  if (!port) die("no free loopback port in 56890-56899");
  mkdirSync(envOut, { recursive: true });
  if (docker(["network", "inspect", NET]).status !== 0) must(["network", "create", "--label", LABEL, NET]);

  log(`starting the database from ${IMAGES.db}`);
  must(run("db", ["-e", "POSTGRES_PASSWORD=postgres"]));
  let ready = 0;
  await waitFor("the database", () => (ready = psqlRaw("select 1").ok ? ready + 1 : 0) >= 2, 240_000);
  psql(IDENTITY_SQL);
  if (!identityOk()) die("identity round trip failed before the migrations");
  psql(PRE_AUTH_COLUMNS_SQL);
  log(`applying ${migrations.length} migrations`);
  for (const m of migrations) {
    const r = psqlRaw(m.sql, { single: !/\bconcurrently\b/i.test(m.sql) });
    if (!r.ok) die(`migration ${m.name} (${m.from} ${m.ref.slice(0, 9)}) failed: ${r.out.split("\n").filter((l) => /ERROR|FATAL|DETAIL|HINT/.test(l)).slice(0, 4).join(" | ")}`);
  }
  psql(AUTH_PREP_SQL, { single: true });
  // The e2e helpers read evidence with `psql -U postgres`; on a hosted project postgres owns the tables, here supabase_admin does.
  psql("grant pg_read_all_data to postgres;");

  const secret = randomBytes(24).toString("hex");
  const url = `http://127.0.0.1:${port}`;
  log("starting mail, sign-in, API and gateway");
  must(run("mail", ["-e", "MP_WEBROOT=mail"]));
  const authEnv = {
    GOTRUE_API_HOST: "0.0.0.0", GOTRUE_API_PORT: "9999", API_EXTERNAL_URL: `${url}/auth/v1`,
    GOTRUE_DB_DRIVER: "postgres", GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin:postgres@${DB}:5432/postgres`,
    GOTRUE_SITE_URL: appUrl, GOTRUE_URI_ALLOW_LIST: AUTH_REDIRECTS, GOTRUE_DISABLE_SIGNUP: "false",
    GOTRUE_JWT_SECRET: secret, GOTRUE_JWT_EXP: "3600", GOTRUE_JWT_AUD: "authenticated", GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated", GOTRUE_JWT_ADMIN_ROLES: "service_role",
    GOTRUE_EXTERNAL_EMAIL_ENABLED: "true", GOTRUE_MAILER_AUTOCONFIRM: "false", GOTRUE_SMTP_HOST: NAMES.mail, GOTRUE_SMTP_PORT: "1025",
    GOTRUE_SMTP_ADMIN_EMAIL: "noreply@example.test", GOTRUE_SMTP_SENDER_NAME: "DanceFlow QA",
    GOTRUE_MAILER_URLPATHS_INVITE: "/auth/v1/verify", GOTRUE_MAILER_URLPATHS_CONFIRMATION: "/auth/v1/verify", GOTRUE_MAILER_URLPATHS_RECOVERY: "/auth/v1/verify", GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: "/auth/v1/verify",
    GOTRUE_RATE_LIMIT_EMAIL_SENT: "1000",
  };
  must(run("auth", Object.entries(authEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]), ["auth"]));
  must(run("rest", ["-e", `PGRST_DB_URI=postgres://authenticator:postgres@${DB}:5432/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${secret}`, "-e", "PGRST_DB_USE_LEGACY_GUCS=false"]));
  const yml = path.join(envOut, "kong.yml");
  writeFileSync(yml, kongYml());
  const kongArgs = ["-p", `127.0.0.1:${port}:8000`, "-e", "KONG_DATABASE=off", "-e", "KONG_NGINX_WORKER_PROCESSES=1", "-e", "KONG_NGINX_HTTP_KEEPALIVE_TIMEOUT=3600s", "-e", "KONG_NGINX_HTTP_KEEPALIVE_REQUESTS=100000",
    "-e", "KONG_DECLARATIVE_CONFIG=/home/kong/kong.yml", "-e", "KONG_PROXY_LISTEN=0.0.0.0:8000", "-e", "KONG_DNS_ORDER=LAST,A,CNAME"];
  must(["create", ...run("kong", kongArgs).slice(2)]);
  must(["cp", yml, `${NAMES.kong}:/home/kong/kong.yml`]);
  must(["start", NAMES.kong]);
  for (const [key, name] of Object.entries(NAMES)) {
    const got = must(["inspect", name, "--format", "{{json .HostConfig.PortBindings}}"]);
    const want = key === "kong" ? `{"8000/tcp":[{"HostIp":"127.0.0.1","HostPort":"${port}"}]}` : "{}";
    if (got !== want) die(`unexpected host port bindings on ${name}: ${got}`);
  }
  await waitFor("the API", () => httpOk(`${url}/rest/v1/`, (s) => s < 500), 240_000);
  await waitFor("the sign-in service", () => httpOk(`${url}/auth/v1/health`), 180_000);
  await waitFor("the mail catcher", () => httpOk(`${url}/mail/api/v1/messages`), 60_000);
  if (!identityOk()) {
    log("the sign-in service replaced the identity functions; restoring the harness versions");
    psql(IDENTITY_SQL);
    if (!identityOk()) die("identity round trip failed after the sign-in service started");
  }

  // Reference rows (plans, categories, templates) the app expects; the file itself refuses to run unless this marker is set.
  let seed = git(["show", "HEAD:e2e/setup/qa-reference-data.sql"]).toString("utf8");
  const storage = psql("select to_regclass('storage.buckets') is not null") === "t";
  if (!storage) {
    seed = seed.replace(/insert into storage\.buckets[^;]*;/gi, "");
    log("no storage schema in the base image: the document-files bucket row is left out");
  }
  psql(`set danceflow.qa_stack = 'local';\n${seed}`, { single: true });
  psql("notify pgrst, 'reload schema';");

  const anon = localKey("anon", secret);
  const service = localKey("service_role", secret);
  const values = {
    NEXT_PUBLIC_SUPABASE_URL: url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anon,
    SUPABASE_SERVICE_ROLE_KEY: service,
    E2E_BASE_URL: appUrl,
    E2E_SUPABASE_URL: url,
    E2E_SUPABASE_ANON_KEY: anon,
    E2E_SUPABASE_SERVICE_ROLE_KEY: service,
    E2E_LOCAL_DB_CONTAINER: DB,
    E2E_LOCAL_MAILBOX_URL: `${url}/mail`,
  };
  // Throwaway local keys only; these files live outside the repository.
  writeFileSync(path.join(envOut, "stack.ps1"), `${Object.entries(values).map(([k, v]) => `$env:${k}="${v}"`).join("\n")}\n`);
  writeFileSync(path.join(envOut, "stack.json"), JSON.stringify(values, null, 2));
  writeFileSync(
    path.join(envOut, "composition.json"),
    JSON.stringify({
      pinsFile: composed.pinsFile, pins: composed.pins, restriction: !flags["no-restriction"], image: must(["image", "inspect", IMAGES.db, "--format", "{{.Id}}"]),
      assumedInImage: composed.assumed.length, releaseCount: composed.releaseCount, storageSchema: storage,
      migrations: composed.list.map(({ name, from, ref }) => ({ name, from, ref: ref.slice(0, 9) })), notes: composed.notes,
    }, null, 2),
  );
  log(`up at ${url}: ${composed.list.length} migrations on ${IMAGES.db}; environment written to ${envOut}`);
}

async function check() {
  const env = JSON.parse(readFileSync(path.join(envOut, "stack.json"), "utf8"));
  const composition = JSON.parse(readFileSync(path.join(envOut, "composition.json"), "utf8"));
  const results = [];
  const record = (name, ok, detail = "") => results.push({ name, ok, detail });
  const expected = expectedBaseTables(compose().assumed);
  const missing = psql(`select t from unnest(array[${expected.map((e) => `'${e.table}'`).join(",")}]) as t where to_regclass('public.' || t) is null order by 1`).split("\n").filter(Boolean);
  record("base image holds the tables of the migrations it is assumed to hold", missing.length === 0, missing.length ? `missing ${missing.slice(0, 12).map((t) => `${t} (${expected.find((e) => e.table === t).from})`).join(", ")}${missing.length > 12 ? ` and ${missing.length - 12} more` : ""}` : `${expected.length} tables`);
  const parts = JSON.parse(
    psql(`select json_build_object(
      's6_lifecycle_definer', (select prosecdef from pg_proc where oid = to_regprocedure('public.change_competition_entry_lifecycle(uuid,text,text,text)')),
      's4_clearance_gate', to_regprocedure('public.r15_guard_heat_entry_clearance()') is not null,
      's5_age_guard', exists (select 1 from pg_trigger where tgname = 'event_competition_entry_participants_s5_age_guard'),
      'u18s_scratch_guard', exists (select 1 from pg_trigger where tgname = 'cf1_u18s_guard_heat_entry_scratch'),
      'od04_delete_guard', exists (select 1 from pg_trigger where tgname = 'a00_compod04_events_delete_guard'),
      'r10_panel_guard', exists (select 1 from pg_trigger where tgname = 'compr10_guard_round_panel_config'),
      'r11_approval_scope', exists (select 1 from pg_proc where prosrc like '%COMP_CORRECTION_APPROVER_REQUIRED%'),
      'od_published_order_guard', exists (select 1 from pg_trigger where tgname = 'zz_compd_guard_published_heat'),
      'p1_restriction', exists (select 1 from pg_class where relname like 'compp1\\_%') or exists (select 1 from pg_trigger where tgname like '%compp1%'))`),
  );
  if (composition.migrations.some((m) => m.name.startsWith("20270223150000_"))) parts.private_lesson_read_scope = psql("select to_regprocedure('public.can_view_event_private_lessons(uuid)') is not null") === "t";
  for (const [name, present] of Object.entries(parts)) if (name !== "p1_restriction" || composition.restriction) record(`database ${name}`, present === true);
  const call = async (pathname, { key, token, method = "GET", body } = {}) => {
    const response = await fetch(`${env.E2E_SUPABASE_URL}${pathname}`, {
      method,
      headers: { apikey: key ?? env.E2E_SUPABASE_ANON_KEY, Authorization: `Bearer ${token ?? key ?? env.E2E_SUPABASE_ANON_KEY}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  const email = `p1-stack-${randomBytes(4).toString("hex")}@e2e.test`;
  const password = randomBytes(18).toString("base64url");
  const created = await call("/auth/v1/admin/users", { key: env.E2E_SUPABASE_SERVICE_ROLE_KEY, method: "POST", body: { email, password, email_confirm: true } });
  record("sign-in service creates a user", created.status < 300, `HTTP ${created.status}`);
  const session = await call("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
  record("password sign-in returns a session", session.status === 200 && Boolean(session.data?.access_token), `HTTP ${session.status}`);
  const rows = await call("/rest/v1/events?select=id&limit=1", { token: session.data?.access_token });
  record("API answers the signed-in user", rows.status === 200, `HTTP ${rows.status}`);
  const admin = await call("/rest/v1/studios?select=id&limit=1", { key: env.E2E_SUPABASE_SERVICE_ROLE_KEY });
  record("API answers the local service key", admin.status === 200, `HTTP ${admin.status}`);
  const link = await call("/auth/v1/otp", { method: "POST", body: { email, create_user: false } });
  record("sign-in link requested", link.status < 300, `HTTP ${link.status}`);
  let mail = 0;
  for (let i = 0; i < 20 && !mail; i += 1) {
    const search = await fetch(`${env.E2E_LOCAL_MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`).then((r) => r.json()).catch(() => null);
    mail = search?.messages?.length ?? 0;
    if (!mail) await sleep(1000);
  }
  record("mail catcher received it", mail > 0, `${mail} message(s)`);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  writeFileSync(path.join(envOut, "check.json"), JSON.stringify(results, null, 2));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

function down() {
  const ids = () => must(["ps", "-aq", "--filter", `label=${LABEL}`]).split("\n").filter(Boolean);
  const found = ids();
  if (found.length) docker(["rm", "-f", "-v", ...found]);
  if (docker(["network", "inspect", NET, "--format", "{{index .Labels \"df.p1walk\"}}"]).stdout?.trim() === "1") docker(["network", "rm", NET]);
  const left = ids();
  const network = docker(["network", "inspect", NET]).status === 0;
  log(`removed ${found.length - left.length} container(s); left ${left.length}; network ${network ? "still present" : "gone"}`);
  if (left.length || network) process.exitCode = 1;
}

if (command === "plan") {
  const composed = compose();
  console.log(`pins ${composed.pinsFile}\nassumed in ${IMAGES.db}: ${composed.assumed.length}; applied from the release line: ${composed.releaseCount}; applied in total: ${composed.list.length}`);
  console.log(`tables verified by check: ${expectedBaseTables(composed.assumed).length}`);
  for (const item of composed.list) console.log(`${item.from.padEnd(8)} ${item.ref.slice(0, 9)} ${item.name}`);
  for (const note of composed.notes) console.log(`note: ${note}`);
} else if (command === "up") await up();
else if (command === "check") await check();
else if (command === "down") down();
else die("usage: p1-stack.mjs plan | up | check | down");
