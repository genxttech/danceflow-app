#!/usr/bin/env node
// Seeds an iso-qa --auth stack for the DanceFlow Business walkthrough: three users created through GoTrue's admin API, two studios, an instructor with
// today's lessons and a group class, an owner with no instructor profile, and an instructor at another studio. Fictional data only.
// Rows are shaped like src/app/api/staff/__tests__/localStack.staffApi.test.ts (on the staff API branch). Writes <out.json> for walk.cjs (it holds a password:
// keep it out of the repo).
//   node scripts/qa/auth-profile/business-shell/seed-staff.mjs stack.json seed.json
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createUser, loadStack, psql } from "../lib.mjs";

const env = loadStack(process.argv[2]);
const outFile = process.argv[3];
if (!outFile) throw new Error("usage: seed-staff.mjs <stack.json> <seed-out.json>");

const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const offset = (() => {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" }).formatToParts(new Date(`${DAY}T12:00:00Z`)).find((p) => p.type === "timeZoneName")?.value;
  return (name ?? "GMT-05:00").replace("GMT", "") || "+00:00";
})();
const at = (hhmm) => new Date(`${DAY}T${hhmm}:00${offset}`).toISOString();

const PASSWORD = `qa-${randomUUID()}`;
const users = {
  ida: await createUser(env, { email: "ida.instructor@example.test", password: PASSWORD, fullName: "Ida Instructor" }),
  owen: await createUser(env, { email: "owen.owner@example.test", password: PASSWORD, fullName: "Owen Owner" }),
  bo: await createUser(env, { email: "bo.otherstudio@example.test", password: PASSWORD, fullName: "Bo Other" }),
};
const fullNames = { ida: "Ida Instructor", owen: "Owen Owner", bo: "Bo Other" };

const S = { a: randomUUID(), b: randomUUID() };
const I = { ida: randomUUID(), bo: randomUUID() };
const C = { ana: randomUUID(), sam: randomUUID(), colin: randomUUID(), bea: randomUUID() };
const ROOM = { main: randomUUID(), b: randomUUID() };
const A = { lesson: randomUUID(), lesson2: randomUUID(), cancelled: randomUUID(), klass: randomUUID(), other: randomUUID() };

const q = (v) => (v === null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const appt = (id, studio, instr, type, client, start, end, title, status, room) =>
  `insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, room_id, starts_at, ends_at, title, notes, status, price_amount, roster_capacity)
   values (${q(id)}, ${q(studio)}, ${q(instr)}, ${q(type)}, ${q(client)}, ${q(room)}, ${q(at(start))}, ${q(at(end))}, ${q(title)}, ${q(type === "private_lesson" ? "Working toward the showcase routine. Keep the frame soft on turns." : null)}, ${q(status)}, 125, ${type === "group_class" ? 12 : "null"});`;

// Plan seat limits and booking triggers are not under test (same as the staff API local-stack suite); RLS still applies to every API read.
psql(env, `
begin;
set local session_replication_role = replica;
${Object.entries(users).map(([k, id]) => `insert into public.profiles (id, full_name) values (${q(id)}, ${q(fullNames[k])}) on conflict (id) do update set full_name = excluded.full_name;`).join("\n")}
insert into public.studios (id, name, slug, subscription_status, timezone) values (${q(S.a)}, 'Maple Street Dance', 'maple-${S.a.slice(0, 8)}', 'active', 'America/New_York');
insert into public.studios (id, name, slug, subscription_status, timezone) values (${q(S.b)}, 'Harbor Ballroom', 'harbor-${S.b.slice(0, 8)}', 'active', 'America/New_York');
insert into public.user_studio_roles (user_id, studio_id, role, active) values (${q(users.ida)}, ${q(S.a)}, 'instructor', true), (${q(users.owen)}, ${q(S.a)}, 'studio_owner', true), (${q(users.bo)}, ${q(S.b)}, 'instructor', true);
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values (${q(I.ida)}, ${q(S.a)}, ${q(users.ida)}, 'Ida', 'Instructor', true, true), (${q(I.bo)}, ${q(S.b)}, ${q(users.bo)}, 'Bo', 'Other', true, true);
insert into public.clients (id, studio_id, first_name, last_name) values (${q(C.ana)}, ${q(S.a)}, 'Ana', 'Rivera'), (${q(C.sam)}, ${q(S.a)}, 'Sam', 'Okafor'), (${q(C.colin)}, ${q(S.a)}, 'Colin', 'Marsh'), (${q(C.bea)}, ${q(S.b)}, 'Bea', 'North');
insert into public.rooms (id, studio_id, name) values (${q(ROOM.main)}, ${q(S.a)}, 'Main Floor'), (${q(ROOM.b)}, ${q(S.b)}, 'Studio 1');
${appt(A.lesson, S.a, I.ida, "private_lesson", C.ana, "10:00", "10:45", null, "scheduled", ROOM.main)}
${appt(A.lesson2, S.a, I.ida, "private_lesson", C.sam, "11:00", "11:45", null, "confirmed", ROOM.main)}
${appt(A.cancelled, S.a, I.ida, "intro_lesson", C.colin, "13:00", "13:30", null, "cancelled", null)}
${appt(A.klass, S.a, I.ida, "group_class", null, "19:00", "20:00", "Beginner Salsa", "scheduled", ROOM.main)}
${appt(A.other, S.b, I.bo, "private_lesson", C.bea, "10:00", "10:45", null, "scheduled", ROOM.b)}
insert into public.lesson_recaps (studio_id, appointment_id, client_id, summary, homework, next_focus, visible_to_client)
  values (${q(S.a)}, ${q(A.lesson)}, ${q(C.ana)}, 'Cleaned up the cross-body lead.', 'Practice the basic with a count, 10 minutes a day.', 'Timing on the turn', true);
insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, status)
  values (${q(S.a)}, ${q(A.klass)}, ${q(C.ana)}, 'staff', 'booked'), (${q(S.a)}, ${q(A.klass)}, ${q(C.colin)}, 'staff', 'booked');
commit;
`);

writeFileSync(outFile, JSON.stringify({ DAY, PASSWORD, users, S, I, A }, null, 2));
console.log(JSON.stringify({ DAY, users, studios: S, appointments: A }, null, 2));
