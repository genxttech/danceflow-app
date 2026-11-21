/**
 * KB-D3: offline retrieval evaluation for the public knowledgebase assistant.
 * Replicates the keyword scorer in src/app/knowledgebase/ai-actions.ts (copied; that file is a
 * "use server" module and cannot export it) and measures how often the expected article is retrieved.
 * Run: npx tsx scripts/kb/retrieval-eval.mts
 */
import path from "node:path";
import { loadKnowledgebaseArticlesOrThrow } from "../../src/lib/knowledgebase/loader";

const articles = loadKnowledgebaseArticlesOrThrow(
  path.join(process.cwd(), "src", "content", "knowledgebase", "articles"),
).filter((a) => a.status === "published" && a.visibility === "public");

function normalize(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const STOP = new Set(["a", "an", "and", "are", "as", "at", "be", "can", "do", "for", "from", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "the", "to", "use", "what", "when", "where", "with"]);
const terms = (q: string) => normalize(q).split(" ").filter((t) => t.length > 1 && !STOP.has(t));

function score(a: (typeof articles)[number], nq: string, ts: string[]) {
  const title = normalize(a.title);
  const slug = normalize(a.slug);
  const category = normalize(a.category);
  const description = normalize(a.summary);
  const content = normalize(a.content);
  let s = 0;
  if (title === nq) s += 2000;
  if (slug === nq) s += 1800;
  if (title.startsWith(nq)) s += 800;
  if (title.includes(nq)) s += 650;
  if (description.includes(nq)) s += 220;
  if (content.includes(nq)) s += 100;
  for (const t of ts) {
    if (title.includes(t)) s += 60;
    if (slug.includes(t)) s += 45;
    if (category.includes(t)) s += 25;
    if (description.includes(t)) s += 20;
    if (content.includes(t)) s += 5;
  }
  if (ts.length > 0 && ts.filter((t) => title.includes(t)).length === ts.length) s += 350;
  const all = `${title} ${slug} ${category} ${description} ${content}`;
  if (ts.length > 0 && ts.every((t) => all.includes(t))) s += 150;
  return s;
}

function retrieve(q: string) {
  const nq = normalize(q);
  const ts = terms(q);
  if (!nq) return [];
  return articles
    .map((a) => ({ a, s: score(a, nq, ts) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s)
    .slice(0, 8)
    .map((x) => x.a.slug);
}

// [question, acceptable slugs]. Written in a studio owner's or front desk's own words. Empty list = no article exists.
const SET: Array<[string, string[]]> = [
  ["How do I add my existing clients from a spreadsheet?", ["importing-client-data-from-a-csv", "moving-to-danceflow-with-the-migration-center"]],
  ["A student cannot log in to the portal, what do I do?", ["student-portal-access-and-sign-in-links", "client-portal-linking-invites-vs-existing-accounts", "troubleshooting-client-portal-invite-emails"]],
  ["How do I refund a ticket?", ["review-event-registration-payment-status", "managing-event-tickets-and-registrations"]],
  ["Can I take card payments at the front desk?", ["collecting-in-person-card-payments-in-danceflow", "in-person-payment-options-and-reader-requirements", "taking-in-person-payments-with-tap-to-pay"]],
  ["How do I connect a card reader?", ["registering-a-stripe-card-reader", "in-person-payment-options-and-reader-requirements"]],
  ["How do I send a waiver for someone to sign?", ["documents-and-e-signatures", "using-event-waivers-and-e-signatures"]],
  ["Where do I find signed waivers?", ["finding-signed-documents-and-waivers"]],
  ["How do I check people in at the door of my event?", ["checking-in-event-attendees", "using-event-qr-tickets-and-scan-check-in"]],
  ["How do I scan QR tickets?", ["using-event-qr-tickets-and-scan-check-in"]],
  ["What is the difference between a package and a membership?", ["packages-vs-memberships"]],
  ["How do I make my studio show up in search?", ["making-your-studio-visible-in-public-discovery", "why-my-studio-or-events-do-not-appear-in-public-discovery"]],
  ["Why is my event not listed publicly?", ["why-my-studio-or-events-do-not-appear-in-public-discovery"]],
  ["How do I reset my password?", ["resetting-your-password"]],
  ["I forgot my password", ["resetting-your-password"]],
  ["How do I pay my instructors?", ["preparing-instructor-payroll"]],
  ["How do I run payroll for teachers?", ["preparing-instructor-payroll"]],
  ["How do I send an email blast to my clients?", ["creating-a-marketing-campaign", "understanding-marketing-audiences"]],
  ["Can DanceFlow text my students?", ["sms-consent-and-message-history", "sms-opt-in-for-studios"]],
  ["What does ARIA do?", ["using-aria-revenue-insights", "aria-operations-quick-start", "aria-automation-center-and-operations"]],
  ["How do I let students request lessons online?", ["portal-schedule-requests", "managing-booking-requests", "booking-availability-rules"]],
  ["How do I invite a front desk person?", ["setting-up-team-members-and-front-desk-access"]],
  ["Can my accountant get reports automatically?", ["setting-up-accountant-report-delivery", "sending-secure-reports-to-your-accountant"]],
  ["How do I sync lessons to my phone calendar?", ["syncing-instructor-schedule-to-calendar", "connecting-google-calendar"]],
  ["How do I put my events on my own website?", ["using-danceflow-events-on-your-website-calendar"]],
  ["What is early bird pricing?", ["using-early-bird-ticket-pricing"]],
  ["How do I copy an event I ran last year?", ["duplicating-an-event"]],
  ["How do I find a dance partner?", ["using-partner-search"]],
  ["How do I give a student a credit?", ["using-client-account-credits-and-balances"]],
  ["How do I close out the lessons for the day?", ["managing-daily-closeout-and-lessons-that-need-review"]],
  ["Which plan do I need for ticketing?", ["selling-tickets-from-admin-side", "managing-event-tickets-and-registrations", "getting-started-with-organizer-workspace"]],
  ["How do I track expenses?", ["using-expenses-and-floor-fee-expense-tracking"]],
  ["How do I see profit for an event?", ["event-profitability-and-closeout-review", "understanding-basic-profit-and-loss-reports"]],
  ["Is my data secure?", ["how-danceflow-protects-your-data", "privacy-security-and-student-data-basics"]],
  ["Do you have a mobile app?", ["current-danceflow-capabilities", "what-is-danceflow"]],
  ["how to resend a ticket email", ["resend-event-ticket-confirmation"]],
  ["How do I book a private lesson?", []],
  ["How do I create a group class and take attendance?", []],
  ["How do I refund a package?", []],
  ["What is LUMI?", []],
  ["How do I set up cancellation policies?", []],
];

let covered = 0;
let top1 = 0;
let top3 = 0;
let top8 = 0;
let none = 0;
let gapAnswered = 0;
let gapTotal = 0;
const misses: string[] = [];
const gapRows: string[] = [];
for (const [q, ok] of SET) {
  const r = retrieve(q);
  if (ok.length === 0) {
    gapTotal += 1;
    if (r.length > 0) gapAnswered += 1;
    gapRows.push(`- "${q}" (no article exists) -> retrieved: ${r.slice(0, 3).join(", ") || "nothing"}`);
    continue;
  }
  covered += 1;
  if (r.length === 0) none += 1;
  if (ok.includes(r[0])) top1 += 1;
  else misses.push(`- top-1 wrong for "${q}": expected ${ok.join(" | ")}; got ${r.slice(0, 3).join(", ") || "nothing"}`);
  if (r.slice(0, 3).some((s) => ok.includes(s))) top3 += 1;
  if (r.some((s) => ok.includes(s))) top8 += 1;
}
const pct = (n: number, d: number) => `${n}/${d} (${Math.round((100 * n) / d)}%)`;
console.log(`articles indexed: ${articles.length}`);
console.log(`questions with a matching article: ${covered}`);
console.log(`top-1 hit: ${pct(top1, covered)}`);
console.log(`top-3 hit: ${pct(top3, covered)}`);
console.log(`expected article among the 8 sent to the model: ${pct(top8, covered)}`);
console.log(`returned nothing: ${none}`);
console.log(`\nquestions with NO matching article: ${gapTotal}; assistant still retrieved something for ${gapAnswered}`);
console.log(gapRows.join("\n"));
console.log(`\ntop-1 misses:\n${misses.join("\n")}`);
