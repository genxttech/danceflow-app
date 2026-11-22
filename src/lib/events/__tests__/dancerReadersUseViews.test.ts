import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

// Dancer-facing readers use the column-restricted views (migration 20270222092000), never the base tables, so the later cutover
// (20270222093000, which removes the direct dancer policies) cannot break them.
describe("dancer readers use the column-restricted views", () => {
  it("web /account, /app/account, the client portal and the event retry lookup read my_event_registrations / my_event_registration_attendees", () => {
    const account = read("src/app/account/page.tsx");
    expect(account).toContain('.from("my_event_registrations")');
    expect(account).not.toMatch(/\.from\("event_registrations"\)/);
    const portal = read("src/app/portal/[studioSlug]/page.tsx");
    expect(portal).toContain('.from("my_event_registrations")');
    expect(portal).toContain("my_event_registration_attendees");
    // The base tables are read ONLY on the staff branch: exactly one occurrence each, directly after the isActiveStudioStaff switch.
    expect(portal.match(/"event_registrations"/g)).toHaveLength(1);
    expect(portal).toMatch(/isActiveStudioStaff\s*\?\s*supabase\s*\.from\("event_registrations"\)/);
    expect(portal.match(/"event_registration_attendees"/g)).toHaveLength(1);
    expect(portal).toMatch(/isActiveStudioStaff\s*\?\s*"event_registration_attendees"\s*:\s*"my_event_registration_attendees"/);
    const appAccount = read("src/app/app/account/page.tsx");
    expect(appAccount).toContain('.from("my_event_registrations")');
    expect(appAccount.match(/"event_registrations"/g)).toHaveLength(1);
    expect(appAccount).toMatch(/isActiveStudioStaff\s*\?\s*supabase\s*\.from\("event_registrations"\)/);
    expect(read("src/app/events/[slug]/page.tsx")).toContain('.from("my_event_registrations")\n      .select("id, payment_status, attendee_email")');
  });

});
