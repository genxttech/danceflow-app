#!/usr/bin/env node
// Creates the three FICTIONAL embed-QA auth users through GoTrue's admin API (email pre-confirmed, so nothing is sent), with one random password
// that is written ONLY to <creds-out.json> (keep it outside the repo; never printed). Targets:
//   node provision-accounts.mjs <stack.json> <creds-out.json>        disposable iso-qa --auth stack (loopback only)
//   node provision-accounts.mjs dev <creds-out.json>                   hosted DEV (epdrtzcydvnoidwrepqz); needs the owner's DEV authorization
// The DEV service key is read in this process from the supabase CLI (same login as sb.sh) and is never printed or written.
// Afterwards apply accounts.sql (sb.sh dev-apply, or psql on the stack) to link the users to the fictional studios.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStack } from "../../auth-profile/lib.mjs";

export const DEV_REF = "epdrtzcydvnoidwrepqz";
export const PROD_REF = "hvsujyfbftfffxpfmlpb";
export const ACCOUNTS = [
  { key: "ownerA", email: "embed-qa-owner-a@example.test", fullName: "Embed QA Owner A (fictional)" },
  { key: "instructorA", email: "embed-qa-instructor-a@example.test", fullName: "Embed QA Instructor A (fictional)" },
  { key: "ownerB", email: "embed-qa-owner-b@example.test", fullName: "Embed QA Owner B (fictional)" },
];

export function devKeys() {
  const ops = process.env.DANCEFLOW_OPS || "C:/Users/mcurt/danceflow-ops";
  const wd = resolve(ops, "wd-dev");
  const refFile = resolve(wd, "supabase/.temp/project-ref");
  const linked = existsSync(refFile) ? readFileSync(refFile, "utf8").trim() : "";
  if (linked !== DEV_REF) throw new Error(`the DEV working directory is linked to '${linked}', expected ${DEV_REF}: refusing`);
  const out = execFileSync("supabase", ["projects", "api-keys", "--project-ref", DEV_REF, "-o", "json"], { cwd: wd, stdio: ["ignore", "pipe", "ignore"], shell: process.platform === "win32" }).toString();
  const keys = JSON.parse(out);
  const anon = keys.find((k) => k.name === "anon")?.api_key;
  const service = keys.find((k) => k.name === "service_role")?.api_key;
  if (!anon || !service) throw new Error("could not read the DEV anon and service keys");
  return { url: `https://${DEV_REF}.supabase.co`, anon, service };
}

async function main() {
  const [target, out] = process.argv.slice(2);
  if (!target || !out) throw new Error("usage: provision-accounts.mjs <stack.json|dev> <creds-out.json>");
  const here = dirname(fileURLToPath(import.meta.url));
  if (resolve(out).toLowerCase().startsWith(resolve(here, "../../../..").toLowerCase())) throw new Error("write the credentials file OUTSIDE the repository");
  let authUrl, key, label;
  if (target === "dev") {
    const k = devKeys();
    authUrl = `${k.url}/auth/v1`; key = k.service; label = `DEV ${DEV_REF}`;
  } else {
    const env = loadStack(target);
    authUrl = env.ISO_QA_AUTH_URL; key = env.ISO_QA_SERVICE_ROLE_KEY; label = `stack ${target}`;
  }
  const password = `embqa-${randomUUID()}`;
  const ids = {};
  const doc = () => JSON.stringify({ target: target === "dev" ? "dev" : "stack", password, emails: Object.fromEntries(ACCOUNTS.map((a) => [a.key, a.email])), ids }, null, 2);
  writeFileSync(out, doc(), { flag: "wx", mode: 0o600 }); // saved BEFORE any user exists; refuses to overwrite an existing file
  for (const a of ACCOUNTS) {
    const res = await fetch(`${authUrl}/admin/users`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({ email: a.email, password, email_confirm: true, user_metadata: { full_name: a.fullName } }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`create ${a.email}: ${res.status} ${String(body?.msg ?? body?.message ?? "").slice(0, 120)}. Users created so far exist on ${label}: run accounts-cleanup.sql before retrying`);
    ids[a.key] = body.id;
    console.log(`created ${a.email} on ${label}`);
  }
  writeFileSync(out, doc(), { mode: 0o600 });
  console.log(`credentials written to ${out} (not printed)`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
