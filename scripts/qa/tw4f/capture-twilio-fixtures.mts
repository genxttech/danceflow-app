/**
 * TW-4F real-Twilio fixture capture (docs/twilio/TW-4F_Real_Fixture_Validation_Proposal.md). READ-ONLY: GET requests only, to the ONE test subaccount
 * whose credentials the OWNER sets in their own terminal. Raw responses stay in memory: they are redacted (src/lib/sms/twilioFixtureRedaction.ts)
 * before anything is written, nothing raw is printed, and the file is refused if anything identifying is left.
 *
 *   TWILIO_CAPTURE_ACCOUNT_SID=AC... TWILIO_CAPTURE_AUTH_TOKEN=... npx tsx scripts/qa/tw4f/capture-twilio-fixtures.mts \
 *     --message create_accepted=SM... --message fetch_delivered=SM... ... \
 *     --list-to +1XXXXXXXXXX --since 2026-11-20T15:00:00Z --until 2026-11-20T16:00:00Z \
 *     [--webhooks pasted-webhooks.json]   (Request Inspector parameter sets, keyed like documentedShapes.json "webhooks")
 *     --out src/lib/sms/__tests__/fixtures/twilio/capturedShapes.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRedactor, residualIdentifiers } from "../../../src/lib/sms/twilioFixtureRedaction";

const API = "https://api.twilio.com";
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const all = (name: string) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

function fail(message: string): never {
  console.error(`capture: ${message}`);
  process.exit(2);
}

const account = String(process.env.TWILIO_CAPTURE_ACCOUNT_SID ?? "");
const token = String(process.env.TWILIO_CAPTURE_AUTH_TOKEN ?? "");
if (!/^AC[0-9a-f]{32}$/.test(account) || token.length < 16) fail("set TWILIO_CAPTURE_ACCOUNT_SID and TWILIO_CAPTURE_AUTH_TOKEN for the TEST subaccount");
const out = opt("--out");
if (!out || !out.endsWith("capturedShapes.json")) fail("--out must name capturedShapes.json");
if (existsSync(out)) fail(`${out} exists: move it away first (never overwritten)`);

const messages = all("--message").map((m) => {
  const [key, sid] = String(m).split("=");
  if (!/^[a-z0-9_]+$/.test(key ?? "") || !/^(SM|MM)[0-9a-f]{32}$/.test(sid ?? "")) fail("--message must be key=SM…");
  return { key, sid };
});
const listTo = opt("--list-to");
const since = opt("--since");
const until = opt("--until");
if (listTo && (!/^\+1[2-9][0-9]{9}$/.test(listTo) || !since || !until || !Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(until)))) {
  fail("--list-to needs an E.164 US number and ISO --since / --until");
}

const auth = `Basic ${Buffer.from(`${account}:${token}`).toString("base64")}`;
async function get(path: string): Promise<unknown> {
  if (!path.startsWith(`/2010-04-01/Accounts/${account}/`)) fail("refusing a path outside the test subaccount");
  const response = await fetch(`${API}${path}`, { method: "GET", headers: { Authorization: auth, Accept: "application/json" } });
  if (response.status !== 200) fail(`GET returned ${response.status} (nothing written)`);
  return response.json();
}

const second = (iso: string) => `${new Date(iso).toISOString().slice(0, 19)}Z`;
const redactor = createRedactor();
const result: Record<string, unknown> = {
  _provenance: {
    kind: "CAPTURED, REDACTED",
    captured_at: new Date().toISOString().slice(0, 10),
    method: "scripts/qa/tw4f/capture-twilio-fixtures.mts: read-only GETs on one test subaccount; redacted in memory before writing (identifiers, numbers, bodies, geo, media).",
  },
};

const fetched: Record<string, unknown> = {};
for (const { key, sid } of messages) fetched[key] = await get(`/2010-04-01/Accounts/${account}/Messages/${sid}.json`);
const raw: Record<string, unknown> = { account, messages: fetched };
if (listTo) {
  const query = new URLSearchParams({ To: listTo, "DateSent>": second(since!), "DateSent<": second(until!), PageSize: "2" });
  const page0 = (await get(`/2010-04-01/Accounts/${account}/Messages.json?${query.toString()}`)) as { next_page_uri?: string | null };
  const page1 = page0.next_page_uri ? await get(page0.next_page_uri) : null;
  raw.list_inbound = { page0, ...(page1 ? { page1 } : {}) };
  raw.sender = listTo;
}
const webhooksFile = opt("--webhooks");
if (webhooksFile) raw.webhooks = JSON.parse(readFileSync(webhooksFile, "utf8"));

Object.assign(result, redactor.redact(raw) as Record<string, unknown>);
const left = residualIdentifiers(result as never);
if (left.length > 0) fail(`redaction left ${left.length} identifying value(s); nothing written`);
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(`capture: wrote ${out} (${messages.length} messages${listTo ? ", 1 list window" : ""}${webhooksFile ? ", webhooks" : ""}; ${redactor.sids()} SIDs and ${redactor.phones()} numbers replaced)`);
