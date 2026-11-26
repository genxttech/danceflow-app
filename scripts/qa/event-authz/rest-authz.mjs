// LOCAL / DISPOSABLE ONLY. PostgREST authorization checks for the private-lesson read scope (20270223150000) and the event
// creator guard (20270223160000). Expects both applied, the fixtures from rest-fixtures.sql, and PostgREST on REST_URL signed
// with REST_JWT_SECRET. Refuses any non-loopback URL.
import { createHmac } from "node:crypto";

const base = process.env.REST_URL ?? "";
const secret = process.env.REST_JWT_SECRET ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base) || secret.length < 32) {
  console.error("refused: set REST_URL to a loopback PostgREST and REST_JWT_SECRET to its test secret");
  process.exit(2);
}
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function jwt(role, sub) {
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role, ...(sub ? { sub } : {}), exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
const user = (i) => `a8000000-0000-4000-8000-00000000000${i}`;
const E1 = "a8300000-0000-4000-8000-000000000001";
const OWNER = jwt("authenticated", user(1));
const INSTRUCTOR = jwt("authenticated", user(3));
const OTHER = jwt("authenticated", user(6));
const SERVICE = jwt("service_role");

async function call(method, path, token, body) {
  const headers = { "Content-Type": "application/json", Prefer: "return=representation" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}
let failed = 0;
let total = 0;
function check(name, ok, detail) {
  total += 1;
  if (!ok) { failed += 1; console.log(`FAIL ${name}: ${JSON.stringify(detail).slice(0, 240)}`); }
}
const emptyList = (r) => r.status === 200 && Array.isArray(r.data) && r.data.length === 0;
const refused = (r) => (r.status === 401 || r.status === 403) && r.data?.code === "42501";
const creator = async () => (await call("GET", `/events?id=eq.${E1}&select=created_by`, SERVICE)).data?.[0]?.created_by;

check("control: service role sees the fixture slot", (await call("GET", "/event_private_lesson_slots?select=id", SERVICE)).data?.length >= 1, null);
check("anon reads no slots", emptyList(await call("GET", "/event_private_lesson_slots?select=*", null)), await call("GET", "/event_private_lesson_slots?select=*", null));
check("anon reads no coach links", emptyList(await call("GET", "/event_guest_coaches?select=schedule_token", null)), null);
check("anon embed through events reads nothing", (await call("GET", `/events?id=eq.${E1}&select=id,event_private_lesson_slots(buyer_name),event_guest_coaches(schedule_token)`, null)).data?.every?.((e) => e.event_private_lesson_slots.length === 0 && e.event_guest_coaches.length === 0) !== false, null);
check("instructor reads no slots", emptyList(await call("GET", "/event_private_lesson_slots?select=*", INSTRUCTOR)), null);
check("other studio owner reads no slots", emptyList(await call("GET", "/event_private_lesson_slots?select=*", OTHER)), null);
check("owner reads slots", (await call("GET", "/event_private_lesson_slots?select=id", OWNER)).data?.length >= 1, null);

const take = await call("PATCH", `/events?id=eq.${E1}`, INSTRUCTOR, { created_by: user(3) });
check("instructor cannot take creator", refused(take), take);
check("creator unchanged", (await creator()) === user(1), null);
check("instructor still reads no slots afterwards", emptyList(await call("GET", "/event_private_lesson_slots?select=*", INSTRUCTOR)), null);
const otherTake = await call("PATCH", `/events?id=eq.${E1}`, OTHER, { created_by: user(6) });
check("other studio cannot take creator", emptyList(otherTake) || refused(otherTake), otherTake);
const upsert = await fetch(`${base}/events?on_conflict=id`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${INSTRUCTOR}`, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ id: E1, studio_id: "a8100000-0000-4000-8000-00000000000a", name: "E1", slug: "rest-e1", status: "published", visibility: "public", start_date: "2027-03-01", end_date: "2027-03-01", created_by: user(3) }) });
check("upsert cannot take creator", upsert.status >= 400 && (await creator()) === user(1), upsert.status);
const forged = await call("POST", "/events", INSTRUCTOR, { studio_id: "a8100000-0000-4000-8000-00000000000a", name: "F", slug: "rest-forged", status: "draft", visibility: "public", start_date: "2027-03-01", end_date: "2027-03-01", created_by: user(1) });
check("insert naming someone else is refused", refused(forged), forged);
const service = await call("PATCH", `/events?id=eq.${E1}`, SERVICE, { created_by: user(3) });
check("service role cannot change creator", refused(service), service);
const edit = await call("PATCH", `/events?id=eq.${E1}`, INSTRUCTOR, { name: "E1" });
check("ordinary edit still works", edit.status === 200 && edit.data?.length === 1, edit);
check("creator still unchanged at the end", (await creator()) === user(1), null);

console.log(failed ? `REST AUTHZ FAIL (${failed} of ${total})` : `REST AUTHZ PASS (${total} checks)`);
process.exit(failed ? 1 : 0);
