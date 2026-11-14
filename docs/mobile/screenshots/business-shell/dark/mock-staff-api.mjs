import http from "node:http";
const S = "7fc84054-4fb6-4a71-8ae0-465776118e89";
const day = "2026-11-14";
const iso = (h, m = 0) => new Date(Date.UTC(2026, 10, 14, h + 5, m)).toISOString();
const me = { user: { id: "u1", email: "ida.instructor@example.test", fullName: "Ida Instructor" }, workspaces: [{ studioId: S, name: "Maple Street Dance", publicName: "Maple Street Dance", slug: "maple", role: "instructor", accessAllowed: true, subscriptionStatus: "active", timeZone: "America/New_York", capabilities: { viewStudioSchedule: true, viewClients: false, markAttendance: true } }] };
const appts = [
  { id: "a1", title: null, appointmentType: "private_lesson", status: "scheduled", startsAt: iso(10), endsAt: iso(10, 45), room: { id: "r", name: "Main Floor" }, locationName: null, client: { id: "c1", firstName: "Ana", lastName: "Rivera" }, partner: null },
  { id: "a2", title: null, appointmentType: "private_lesson", status: "confirmed", startsAt: iso(11), endsAt: iso(11, 45), room: { id: "r", name: "Main Floor" }, locationName: null, client: { id: "c2", firstName: "Sam", lastName: "Okafor" }, partner: null },
  { id: "a3", title: "Intro lesson", appointmentType: "private_lesson", status: "cancelled", startsAt: iso(13), endsAt: iso(13, 30), room: null, locationName: null, client: null, partner: null },
  { id: "a4", title: "Beginner Salsa", appointmentType: "group_class", status: "scheduled", startsAt: iso(19), endsAt: iso(20), room: { id: "r", name: "Main Floor" }, locationName: null, client: null, partner: null },
];
const attendance = { c1: null, c2: "attended", c3: "cancelled" };
const detail = (id) => {
  const a = appts.find((x) => x.id === id);
  if (!a) return null;
  const base = { ...a, studioId: S, timeZone: "America/New_York", accessScope: "own-instructor", notes: id === "a1" ? "Work on frame and timing." : null, instructor: { id: "i1", firstName: "Ida", lastName: "Instructor" } };
  if (a.appointmentType === "group_class")
    return { ...base, roster: { bookedCount: 3, capacity: 3, attendees: [{ clientId: "c1", name: "Ana Rivera", attendanceStatus: attendance.c1 }, { clientId: "c2", name: "Colin Marsh", attendanceStatus: attendance.c2 }, { clientId: "c3", name: "Dee Park", attendanceStatus: attendance.c3 }] } };
  return { ...base, recap: { summary: "Worked on frame", homework: "Practice box step", nextFocus: "Timing", visibleToClient: true, updatedAt: null } };
};
const clients = [{ id: "c2", firstName: "Sam", lastName: "Okafor", status: null }, { id: "c1", firstName: "Ana", lastName: "Rivera", status: null }];
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (!req.headers.authorization) return send(401, { error: "Sign in", code: "unauthenticated" });
  const p = u.pathname.replace("/api/staff", "");
  if (p === "/me") return send(200, me);
  if (p.endsWith("/today")) return send(200, { studioId: S, date: day, timeZone: "America/New_York", instructorId: "i1", appointments: appts });
  let m;
  if ((m = p.match(/\/appointments\/([^/]+)\/attendance\/([^/]+)$/)) && req.method === "PUT") { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { const st = JSON.parse(b).status; attendance[m[2]] = st; send(200, { attendee: { clientId: m[2], displayName: null, status: st, updatedAt: null } }); }); return; }
  if ((m = p.match(/\/appointments\/([^/]+)$/))) { const d = detail(m[1]); return d ? send(200, d) : send(404, { error: "Not found", code: "not_found" }); }
  if (p.endsWith("/clients")) return send(200, { clients, nextCursor: null });
  if ((m = p.match(/\/clients\/([^/]+)$/))) return send(200, { client: clients.find((c) => c.id === m[1]) ?? clients[0], timeZone: "America/New_York", activePackages: null, nextAppointment: { id: "a1", appointmentType: "private_lesson", title: null, startsAt: iso(10), endsAt: iso(10, 45) } });
  send(404, { error: "Not found", code: "not_found" });
}).listen(3100, "127.0.0.1");
