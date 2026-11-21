// Fixtures for the staff-API write-gate evidence (disposable iso-qa --auth stack only). Fictional data, reserved test domain.
// Every user is created through GoTrue's admin API; rows are shaped like scripts/qa/auth-profile/business-shell/seed-staff.mjs.
import { createUser, psql, q, randomUUID } from "./r3-gate-lib.mjs";

export const ROLES = ["owner", "admin", "frontdesk", "instructor", "indie"];

export async function seed(env, tag = `g${Math.random().toString(36).slice(2, 7)}`) {
  const password = `qa-${randomUUID()}`; // disposable stack only; never saved
  const mk = (key, name) => createUser(env, { email: `${key}.${tag}@example.test`, password, fullName: name });
  const users = {
    owner: await mk("owner", "Owen Owner"),
    admin: await mk("admin", "Ada Admin"),
    frontdesk: await mk("frontdesk", "Fran Frontdesk"),
    instructor: await mk("instructor", "Ida Instructor"),
    indie: await mk("indie", "Indy Independent"),
    studioB: await mk("studiob", "Bo Other"),
    platform: await mk("platform", "Pat Platform"),
  };
  const emails = Object.fromEntries(Object.keys(users).map((k) => [k, `${k === "studioB" ? "studiob" : k}.${tag}@example.test`]));
  const names = { owner: "Owen Owner", admin: "Ada Admin", frontdesk: "Fran Frontdesk", instructor: "Ida Instructor", indie: "Indy Independent", studioB: "Bo Other", platform: "Pat Platform" };
  const S = { a: randomUUID(), b: randomUUID() };
  const I = { ida: randomUUID(), bo: randomUUID() };
  const C = { ana: randomUUID(), sam: randomUUID(), colin: randomUUID(), dee: randomUUID(), lena: randomUUID(), arch: randomUUID(), inactive: randomUUID(), bea: randomUUID() };
  const R = { a: randomUUID(), b: randomUUID() };
  const A = { lesson: randomUUID(), lesson2: randomUUID(), klass: randomUUID(), other: randomUUID() };

  const appt = (id, studio, instr, type, client, startExpr, endExpr, title, status, room, billing) =>
    `insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, room_id, starts_at, ends_at, title, status, price_amount, roster_capacity, billing_type)
     values (${q(id)}, ${q(studio)}, ${q(instr)}, ${q(type)}, ${q(client)}, ${q(room)}, ${startExpr}, ${endExpr}, ${q(title)}, ${q(status)}, 125, ${type === "group_class" ? 12 : "null"}, ${q(billing)});`;

  psql(env, `
begin;
set local session_replication_role = replica;
${Object.keys(users).map((k) => `insert into public.profiles (id, full_name, email, platform_role) values (${q(users[k])}, ${q(names[k])}, ${q(emails[k])}, ${k === "platform" ? q("platform_admin") : "null"}) on conflict (id) do update set full_name = excluded.full_name, platform_role = excluded.platform_role;`).join("\n")}
insert into public.studios (id, name, slug, subscription_status, timezone) values (${q(S.a)}, 'Maple Street Dance', 'maple-${S.a.slice(0, 8)}', 'active', 'America/New_York'), (${q(S.b)}, 'Harbor Ballroom', 'harbor-${S.b.slice(0, 8)}', 'active', 'America/New_York');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (${q(users.owner)}, ${q(S.a)}, 'studio_owner', true), (${q(users.admin)}, ${q(S.a)}, 'studio_admin', true), (${q(users.frontdesk)}, ${q(S.a)}, 'front_desk', true),
  (${q(users.instructor)}, ${q(S.a)}, 'instructor', true), (${q(users.indie)}, ${q(S.a)}, 'independent_instructor', true),
  (${q(users.platform)}, ${q(S.a)}, 'studio_owner', true), (${q(users.studioB)}, ${q(S.b)}, 'studio_owner', true);
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values (${q(I.ida)}, ${q(S.a)}, ${q(users.instructor)}, 'Ida', 'Instructor', true, true), (${q(I.bo)}, ${q(S.b)}, ${q(users.studioB)}, 'Bo', 'Other', true, true);
insert into public.clients (id, studio_id, first_name, last_name, status, phone, email) values
  (${q(C.ana)}, ${q(S.a)}, 'Ana', 'Rivera', 'active', '5550100001', 'ana.${tag}@example.test'),
  (${q(C.sam)}, ${q(S.a)}, 'Sam', 'Okafor', 'active', '5550100002', 'sam.${tag}@example.test'),
  (${q(C.colin)}, ${q(S.a)}, 'Colin', 'Marsh', 'active', '5550100003', 'colin.${tag}@example.test'),
  (${q(C.dee)}, ${q(S.a)}, 'Dee', 'Walker', 'active', '5550100004', 'dee.${tag}@example.test'),
  (${q(C.lena)}, ${q(S.a)}, 'Lena', 'Lead', 'lead', '5550100005', 'lena.${tag}@example.test'),
  (${q(C.arch)}, ${q(S.a)}, 'Arch', 'Ived', 'archived', '5550100006', 'arch.${tag}@example.test'),
  (${q(C.inactive)}, ${q(S.a)}, 'Ina', 'Ctive', 'inactive', '5550100007', 'ina.${tag}@example.test'),
  (${q(C.bea)}, ${q(S.b)}, 'Bea', 'North', 'active', '5550100008', 'bea.${tag}@example.test');
insert into public.rooms (id, studio_id, name) values (${q(R.a)}, ${q(S.a)}, 'Main Floor'), (${q(R.b)}, ${q(S.b)}, 'Studio 1');
${appt(A.lesson, S.a, I.ida, "private_lesson", C.ana, "now() - interval '3 hours'", "now() - interval '2 hours 15 minutes'", null, "scheduled", R.a, "free_comped")}
${appt(A.lesson2, S.a, I.ida, "private_lesson", C.sam, "now() - interval '5 hours'", "now() - interval '4 hours 15 minutes'", null, "scheduled", R.a, "free_comped")}
${appt(A.klass, S.a, I.ida, "group_class", null, "now() + interval '1 day'", "now() + interval '1 day 1 hour'", "Beginner Salsa", "scheduled", R.a, "free_comped")}
${appt(A.other, S.b, I.bo, "private_lesson", C.bea, "now() - interval '3 hours'", "now() - interval '2 hours 15 minutes'", null, "scheduled", R.b, "free_comped")}
insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, status) values (${q(S.a)}, ${q(A.klass)}, ${q(C.ana)}, 'staff', 'booked');
commit;
`);
  return { users, emails, password, S, I, C, A, R };
}
