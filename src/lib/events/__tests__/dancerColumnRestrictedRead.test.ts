import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const strip = (s: string) => s.replace(/--[^\n]*/g, "").toLowerCase();
const M = "src/lib/supabase/migrations";

const BANNED = [
  "client_id", "organizer_contact_id", "stripe_checkout_session_id", "stripe_payment_intent_id", "terminal_hold_until", "portal_user_id",
  "registration_source", "notes", "order_id", "promoted_from_waitlist_at", "waitlist_notified_at", "checked_in_by", "ticket_token",
];

describe("dancer column-restricted read (views + cutover)", () => {
  const views = strip(read(`${M}/20270222092000_dancer_event_registration_views.sql`));

  it("views select an explicit column list without any studio-only or secret column", () => {
    expect(views).not.toMatch(/select\s+(er|a)\.\*/);
    expect(views).not.toMatch(/\bselect\s+\*/);
    for (const col of BANNED) {
      expect(views, col).not.toMatch(new RegExp(`\b(er|a)\.${col}\b`));
    }
    expect(views).toContain("er.user_id = auth.uid()");
    expect(views).toContain("security_barrier = true");
    expect(views).not.toMatch(/security_invoker/);
  });

  it("views are granted to authenticated select only, never anon/public", () => {
    expect(views).toMatch(/revoke all on public\.my_event_registrations from public, anon, authenticated/);
    expect(views).toMatch(/grant select on public\.my_event_registrations to authenticated/);
    expect(views).toMatch(/grant select on public\.my_event_registration_attendees to authenticated/);
    expect(views).not.toMatch(/grant[^;]*\bto\s+[^;]*\b(anon|public)\b/);
  });

  it("cutover drops exactly the three dancer-self policies and its rollback restores them", () => {
    const cut = strip(read(`${M}/20270222093000_dancer_direct_read_policies_cutover.sql`));
    expect(cut.match(/drop policy if exists/g)?.length).toBe(3);
    for (const name of ["event_registrations_self_select", "event_registration_attendees_self_select", "event_registration_attendees_self_insert"]) {
      expect(cut).toContain(name);
    }
    expect(cut).not.toMatch(/create policy|alter table|grant |revoke /);
    const rb = strip(read(`${M}/rollback/20270222093000_dancer_direct_read_policies_cutover_rollback.sql`));
    expect(rb.match(/create policy/g)?.length).toBe(3);
    expect(rb).toContain("using (user_id = auth.uid())");
  });

  it("migration order: function, exclusion, index, views, cutover", () => {
    const order = [
      "20270221090000_event_registration_claim_function",
      "20270222090000_event_registration_claim_buyer_sources_only",
      "20270222091000_event_registrations_unclaimed_email_index",
      "20270222092000_dancer_event_registration_views",
      "20270222093000_dancer_direct_read_policies_cutover",
    ];
    for (const f of order) expect(existsSync(path.join(root, `${M}/${f}.sql`)), f).toBe(true);
    expect([...order].sort()).toEqual(order);
  });

});
