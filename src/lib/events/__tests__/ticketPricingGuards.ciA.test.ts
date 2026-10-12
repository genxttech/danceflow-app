import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CI-A source guards: one effective-price rule. The former divergence (public cards applied early bird; the web form
 * and cart checkout charged the regular price; the native app had its own copy with an inclusive cutoff) must not
 * come back.
 */

const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) return [];
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("one early-bird rule", () => {
  it("no file outside the shared rule compares the early-bird cutoff itself", () => {
    const offenders = [...sourceFiles(join(ROOT, "src")), ...sourceFiles(join(ROOT, "mobile/student/src")), ...sourceFiles(join(ROOT, "mobile/student/app"))]
      .filter((file) => !/[\\/]lib[\\/]ticketPricing\.ts$|[\\/]lib[\\/]events[\\/]ticketPricing\.ts$/.test(file))
      .filter((file) => /early_bird_ends_at[^\n]*getTime\(\)|earlyBirdEndsAt\s*>=\s*Date\.now\(\)/.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => file.replace(ROOT, ""))).toEqual([]);
  });

  it("the web registration form shows and totals the server-computed effective price, never ticket.price", () => {
    const form = read("src/app/events/[slug]/register/RegistrationForm.tsx");
    expect(form).not.toMatch(/ticket\.price\b/);
    expect(form).toContain("effectiveUnitPriceCents");
    expect(form).toContain('name="expectedUnitPriceCents"');
  });

  it("both pages that render the form attach server-computed prices", () => {
    expect(read("src/app/events/[slug]/page.tsx")).toContain("ticketTypes={withEffectiveTicketPricing(visibleTicketTypes, pricingNowMs)}");
    expect(read("src/app/events/[slug]/page.tsx")).toContain("ticketTypes={withEffectiveTicketPricing(allActiveTicketTypes, pricingNowMs)}");
    expect(read("src/app/events/[slug]/register/page.tsx")).toContain("ticketTypes={pricedTicketTypes}");
  });

  it("the web cart and native checkouts price with the shared rule and refuse an unconfirmed higher price", () => {
    const cart = read("src/app/api/events/cart/checkout/route.ts");
    expect(cart).toContain("effectiveTicketPrice(ticket, pricingNowMs)");
    expect(cart).not.toMatch(/Number\((ticket|ticketType)\.price \?\? 0\)/);
    expect(cart).toContain("pricing.unitCents > expectedUnitCents");
    expect(cart).toContain('getPositionalTextList(formData, "ticketQuantities"');
    const native = read("src/app/api/student/events/[eventId]/checkout/route.ts");
    expect(native).toContain("priceNativeTicketSelections(selections");
    expect(native).not.toMatch(/function activeTicketPrice/);
  });

  it("the ticket editor validates early-bird input in the event's time zone", () => {
    const actions = read("src/app/app/events/[id]/tickets/actions.ts");
    expect(actions.split("eventTimeZone: getEventTimeZone(access.event),").length - 1).toBe(2);
    expect(actions.split("parseTicketPricingInput({").length - 1).toBe(2);
    expect(actions).not.toContain("early_bird_ends_at: earlyBirdEnabled ? earlyBirdEndsAt");
    const page = read("src/app/app/events/[id]/tickets/page.tsx");
    expect(page).toContain("instantToEventLocalInput(ticket.early_bird_ends_at, eventTimeZone)");
  });

  it("the Expo app uses its identical copy of the rule and sends the price it showed", () => {
    const discovery = read("mobile/student/src/lib/publicDiscovery.ts");
    expect(discovery).toContain('import { effectiveTicketPrice } from "./ticketPricing";');
    expect(read("mobile/student/app/events/[id]/register.tsx")).toContain("expectedUnitPriceCents: selection.ticket.priceCents");
  });
});
