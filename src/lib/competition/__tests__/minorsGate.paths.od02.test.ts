import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/*
  OD-02 path inventory. Competition entries and entry participants can only be created by the database function
  start_competition_registration, which is only called from registrationCheckout.ts, which is only used by the public
  checkout route (the single entry point for individual, studio-side and team registrations). If someone adds another
  path, these tests fail until that path is added to the age gate on purpose.
*/

const ROOT = join(__dirname, "..", "..", "..");

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (name === "node_modules" || name === "migrations" || name === "__tests__") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const files = walk(ROOT).map((full) => ({ rel: relative(ROOT, full).split(sep).join("/"), text: readFileSync(full, "utf8") }));

describe("OD-02 every entry-creating path is behind the age gate", () => {
  it("no application code writes competition entries or entry participants directly", () => {
    const offenders = files.filter(({ text }) =>
      /from\(\s*["'`]event_competition_entr(?:y|ies)(?:_participants)?["'`]\s*\)\s*\.\s*(insert|upsert)\s*\(/.test(text)
      || /from\(\s*["'`]event_competition_entry_participants["'`]\s*\)\s*\.\s*(insert|upsert|update|delete)\s*\(/.test(text));
    expect(offenders.map((file) => file.rel)).toEqual([]);
  });

  it("the only direct updates of entries are the two known staff workflows (eligibility/entry number, check-in verification); none touches participants", () => {
    const writers = files.filter(({ text }) => /from\(\s*["'`]event_competition_entries["'`]\s*\)\s*\.\s*update\s*\(/.test(text)).map((file) => file.rel).sort();
    expect(writers).toEqual([
      "app/app/events/[id]/competition/checkin/actions.ts",
      "app/app/events/[id]/competition/registrations/actions.ts",
    ]);
  });

  it("start_competition_registration is called only from registrationCheckout.ts", () => {
    const callers = files.filter(({ text }) => /\.rpc\(\s*"start_competition_registration"/.test(text)).map((file) => file.rel);
    expect(callers).toEqual(["lib/competition/registrationCheckout.ts"]);
  });

  it("startCompetitionRegistration / quoteCompetitionRegistration are used only by the checkout route", () => {
    const callers = files
      .filter(({ rel, text }) => rel !== "lib/competition/registrationCheckout.ts" && /\b(startCompetitionRegistration|quoteCompetitionRegistration)\b/.test(text))
      .map((file) => file.rel);
    expect(callers).toEqual(["app/api/events/[slug]/competition/checkout/route.ts"]);
  });

  it("the checkout route evaluates the age gate before its first database call (quote, then start)", () => {
    const route = files.find((file) => file.rel === "app/api/events/[slug]/competition/checkout/route.ts")!.text;
    const gate = route.indexOf("evaluateCompetitionAdultGate(body.draft)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(route.indexOf("createAdminClient()"));
    expect(gate).toBeLessThan(route.indexOf("await quoteCompetitionRegistration("));
    expect(gate).toBeLessThan(route.indexOf("await startCompetitionRegistration("));
  });

  it("the gate lives outside generic DanceFlow student / NSI / studio-scheduling code", () => {
    const users = files.filter(({ text }) => text.includes("competition/minorsGate")).map((file) => file.rel).sort();
    expect(users).toEqual([
      "app/api/events/[slug]/competition/checkout/route.ts",
      "app/events/[slug]/competition/register/CompetitionRegistrationBuilder.tsx",
    ]);
  });
});
