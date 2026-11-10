// Shared helpers for scripts that use an iso-qa stack started with --auth. LOCAL / DISPOSABLE STACKS ONLY.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The JSON that `node scripts/qa/iso-qa.mjs up <scenario> --auth` prints, saved to a file. Refuses anything that is not a loopback --auth stack. */
export function loadStack(file) {
  if (!file) throw new Error("usage: <script> <stack.json> ...   (stack.json = the output of `iso-qa.mjs up <scenario> --auth`)");
  const env = JSON.parse(readFileSync(file, "utf8"));
  for (const key of ["TW4A_LOCAL_URL", "TW4A_LOCAL_DB_CONTAINER", "ISO_QA_AUTH_URL", "ISO_QA_MAIL_URL", "ISO_QA_ANON_KEY", "ISO_QA_SERVICE_ROLE_KEY"]) {
    if (!env[key]) throw new Error(`${file} has no ${key}: start the stack with --auth`);
  }
  for (const key of ["TW4A_LOCAL_URL", "ISO_QA_AUTH_URL", "ISO_QA_MAIL_URL"]) {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(env[key]).hostname)) throw new Error(`${key} is not a loopback URL: refusing`);
  }
  if (!env.TW4A_LOCAL_DB_CONTAINER.startsWith("df-isoqa-")) throw new Error("the database container is not an iso-qa container: refusing");
  return env;
}

export function psql(env, sql) {
  return execFileSync("docker", ["exec", "-i", env.TW4A_LOCAL_DB_CONTAINER, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
  }).trim();
}

/** Creates a confirmed user through GoTrue's admin API, so auth.users / identities rows are exactly what GoTrue writes. Returns the user id. */
export async function createUser(env, { email, password, fullName }) {
  const res = await fetch(`${env.ISO_QA_AUTH_URL}/admin/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ISO_QA_SERVICE_ROLE_KEY}`, apikey: env.ISO_QA_SERVICE_ROLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: fullName ? { full_name: fullName } : {} }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`create ${email}: ${res.status} ${JSON.stringify(body)}`);
  return body.id;
}

/** The newest email Mailpit caught for `email` since `afterMs`, with the first GoTrue /verify link in it. Polls for up to 20 s. */
export async function latestAuthLink(env, email, afterMs) {
  for (let i = 0; i < 40; i += 1) {
    const list = await (await fetch(`${env.ISO_QA_MAIL_URL}/api/v1/messages`)).json();
    const msg = (list.messages ?? []).find((m) => m.To?.some((t) => t.Address === email) && new Date(m.Created).getTime() >= afterMs);
    if (msg) {
      const full = await (await fetch(`${env.ISO_QA_MAIL_URL}/api/v1/message/${msg.ID}`)).json();
      const text = `${full.Text ?? ""} ${full.HTML ?? ""}`.replace(/&amp;/g, "&");
      const link = text.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/);
      if (link) return { subject: msg.Subject, link: link[0] };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no auth email for ${email}`);
}
