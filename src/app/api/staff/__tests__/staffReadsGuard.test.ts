import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/*
  Guard: staff views (src/lib/staff, src/app/api/staff) never read who owns or has claimed a dancer's registration or account.
  Event registrations are matched to accounts by email or by user_id on the dancer side (Student app, Wallet); a staff screen must not
  surface that, and no staff query may select a user_id column. If a staff feature truly needs one of these, change this test in the same PR and say why.
*/

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : walk(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const repo = path.resolve(__dirname, "../../../../..");
const sources = [...walk(path.join(repo, "src/lib/staff")), ...walk(path.join(repo, "src/app/api/staff"))].map((f) => ({
  rel: path.relative(repo, f).split(path.sep).join("/"),
  text: fs.readFileSync(f, "utf8"),
}));

describe("staff reads stay clear of registration and claim ownership", () => {
  it("found the staff sources", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it.each(["event_registrations", "client_account_links", "registration_claims", "claimed_by", "claimed_user"])("nothing in staff code touches %s", (name) => {
    expect(sources.filter((s) => s.text.includes(name)).map((s) => s.rel)).toEqual([]);
  });

  it("no staff query selects a user_id column", () => {
    expect(sources.filter((s) => /\.select\(\s*[`"'][^`"']*\buser_id\b/.test(s.text)).map((s) => s.rel)).toEqual([]);
  });
});
