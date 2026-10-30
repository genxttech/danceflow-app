import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getBillingPlan } from "@/lib/billing/plans";
import { PlanCard } from "../PlanCard";

/**
 * D7-2: what the billing page actually renders for a plan card. An existing
 * subscriber must never see a control that posts the clicked plan to checkout
 * (which only opens the generic Stripe portal and discards the choice).
 */

function render(props: { isCurrent: boolean; hasManagedSubscription: boolean; code?: string }) {
  const plan = getBillingPlan(props.code ?? "growth");
  if (!plan) throw new Error("plan");
  return renderToStaticMarkup(
    createElement(PlanCard, {
      plan,
      selectedAudience: plan.audience,
      isCurrent: props.isCurrent,
      isRecommended: false,
      entryMode: "default",
      hasManagedSubscription: props.hasManagedSubscription,
    }),
  );
}

describe("rendered plan card", () => {
  it("existing subscriber, other plan: support mailto, no checkout form, no 'Change Plan'", () => {
    const html = render({ isCurrent: false, hasManagedSubscription: true });
    expect(html).toContain("Contact support to change plan");
    expect(html).toContain('href="mailto:support@idanceflow.com?subject=');
    expect(html).toContain("Plan%20change%20request");
    expect(html).not.toContain("/api/billing/checkout");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Change Plan");
  });

  it("existing subscriber, current plan: disabled 'Current Plan', no support link, no checkout post enabled", () => {
    const html = render({ isCurrent: true, hasManagedSubscription: true });
    expect(html).toContain("Current Plan");
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).not.toContain("mailto:");
  });

  it("studio with no subscription: trial start posts the clicked plan to checkout", () => {
    const html = render({ isCurrent: false, hasManagedSubscription: false });
    expect(html).toContain('action="/api/billing/checkout"');
    expect(html).toContain('name="planCode" value="growth"');
    expect(html).toContain("Start Growth Trial");
    expect(html).not.toContain("mailto:");
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });

  it("the organizer plan card follows the same rule", () => {
    const managed = render({ isCurrent: false, hasManagedSubscription: true, code: "organizer" });
    expect(managed).toContain("mailto:support@idanceflow.com");
    expect(managed).not.toContain("/api/billing/checkout");
    const fresh = render({ isCurrent: false, hasManagedSubscription: false, code: "organizer" });
    expect(fresh).toContain('name="planCode" value="organizer"');
  });
});

describe("billing page wiring (source)", () => {
  const page = readFileSync("src/app/app/settings/billing/page.tsx", "utf8");

  it("Open Billing Portal is shown only to a managed subscriber with a Stripe customer, and posts to the portal route", () => {
    const forms = page.match(/hasManagedSubscription && studio\.stripe_customer_id \? \(\s*<form action="\/api\/billing\/portal" method="post">/g) ?? [];
    expect(forms).toHaveLength(2);
    expect((page.match(/action="\/api\/billing\/portal"/g) ?? []).length).toBe(2);
  });

  it("the page renders the extracted PlanCard and no longer defines it inline", () => {
    expect(page).toContain('from "./PlanCard"');
    expect(page).not.toMatch(/function PlanCard\(/);
  });

  it("the owner-only gate runs before any billing control is rendered", () => {
    expect(page.indexOf("if (!canAccessBilling)")).toBeGreaterThan(-1);
    expect(page.indexOf("if (!canAccessBilling)")).toBeLessThan(page.indexOf('action="/api/billing/portal"'));
  });
});
