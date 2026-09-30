import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createOwnershipFakeSupabase } from "@/lib/payments/__tests__/ownershipFakes";
import {
  buildMerchantSentence,
  resolveEmailMerchantIdentity,
  resolveEventMerchantLine,
  type EmailMerchantFacts,
} from "@/lib/notifications/merchantIdentity";

/** PAY-DC-3 (D3): merchant identity from persisted payment facts only. */

const ACCT_A = "acct_1StudioOwnerA";
const ACCT_B = "acct_1StudioOwnerB";

function facts(overrides: Partial<EmailMerchantFacts> = {}): EmailMerchantFacts {
  return {
    paymentStatus: "paid",
    totalAmount: 45,
    storedOwnerAccountIds: [ACCT_A],
    studioName: "Harbor Dance",
    organizerName: null,
    ...overrides,
  };
}

describe("resolveEmailMerchantIdentity", () => {
  it("studio Connect-paid → 'made to {Studio}'", () => {
    expect(resolveEmailMerchantIdentity(facts())).toEqual({
      kind: "studio",
      sentence:
        "Your payment was made to Harbor Dance. DanceFlow provides the software used to manage this transaction.",
    });
  });

  it("organizer Connect-paid → 'processed for {Organizer}', never 'made to'", () => {
    const identity = resolveEmailMerchantIdentity(facts({ organizerName: "Summer Swing Fest" }));
    expect(identity).toEqual({
      kind: "organizer",
      sentence: "This transaction was processed for Summer Swing Fest through DanceFlow.",
    });
    expect(identity?.sentence).not.toContain("made to");
  });

  it.each([
    ["free (zero total)", { totalAmount: 0 }],
    ["negative total", { totalAmount: -5 }],
    ["missing total", { totalAmount: null }],
    ["pending", { paymentStatus: "pending" }],
    ["unpaid / pay at door", { paymentStatus: "unpaid" }],
    ["manual payment without owner", { storedOwnerAccountIds: [] }],
    ["missing / legacy NULL owner", { storedOwnerAccountIds: [null, undefined, ""] }],
    ["conflicting owners", { storedOwnerAccountIds: [ACCT_A, ACCT_B] }],
    ["no name", { studioName: "  ", organizerName: null }],
  ] as Array<[string, Partial<EmailMerchantFacts>]>)("no line: %s", (_label, overrides) => {
    expect(resolveEmailMerchantIdentity(facts(overrides))).toBeNull();
  });

  it("accepts duplicate identical owners (e.g. payment + refund rows on one account)", () => {
    expect(resolveEmailMerchantIdentity(facts({ storedOwnerAccountIds: [ACCT_A, ACCT_A, null] }))?.kind).toBe(
      "studio",
    );
  });

  it("never exposes Stripe ids or the legal entity, even through a hostile name", () => {
    const sentence = resolveEmailMerchantIdentity(facts())?.sentence ?? "";
    expect(sentence).not.toMatch(/acct_|pi_|ch_|GenX/);
    expect(resolveEmailMerchantIdentity(facts({ studioName: "acct_1Evil" }))).toBeNull();
    expect(resolveEmailMerchantIdentity(facts({ studioName: "pi_3Abc Studio" }))).toBeNull();
    expect(resolveEmailMerchantIdentity(facts({ organizerName: "GenX TotalTech" }))).toBeNull();
  });

  it("strips control characters from names", () => {
    expect(resolveEmailMerchantIdentity(facts({ studioName: "Harbor\r\nDance" }))?.sentence).toBe(
      buildMerchantSentence("studio", "Harbor Dance"),
    );
  });

  it("has no input a caller could use to force a line (the facts type has no override flag)", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "lib", "notifications", "merchantIdentity.ts"),
      "utf8",
    );
    const factsType = source.slice(
      source.indexOf("export type EmailMerchantFacts"),
      source.indexOf("export type EmailMerchantIdentity"),
    );
    expect(factsType).not.toMatch(/force|override|merchantLine|metadata|organizerStripe/i);
    expect(source).not.toMatch(/organizers[\s\S]{0,40}stripe_/);
    expect(source).not.toContain("stripe_connected_account_id");
  });
});

describe("resolveEventMerchantLine (stored event_payments owners)", () => {
  const branding = { studioName: "Harbor Dance", organizerName: null };

  function supabaseWith(rows: Array<{ registration_id: string; stripe_account_id: string | null }>) {
    const fake = createOwnershipFakeSupabase({ event_payments: rows });
    return { fake, client: fake.adminClient as unknown as SupabaseClient };
  }

  it("uses the single stored owner for the registrations", async () => {
    const { client } = supabaseWith([{ registration_id: "reg-1", stripe_account_id: ACCT_A }]);
    await expect(
      resolveEventMerchantLine({
        supabase: client,
        registrationIds: ["reg-1"],
        paymentStatus: "paid",
        totalAmount: 30,
        branding,
      }),
    ).resolves.toContain("Your payment was made to Harbor Dance.");
  });

  it("ignores other registrations' owners and omits the line when this one has none", async () => {
    const { client } = supabaseWith([
      { registration_id: "reg-other", stripe_account_id: ACCT_A },
      { registration_id: "reg-1", stripe_account_id: null },
    ]);
    await expect(
      resolveEventMerchantLine({
        supabase: client,
        registrationIds: ["reg-1"],
        paymentStatus: "paid",
        totalAmount: 30,
        branding,
      }),
    ).resolves.toBeNull();
  });

  it("omits the line for conflicting owners across an order's registrations", async () => {
    const { client } = supabaseWith([
      { registration_id: "reg-1", stripe_account_id: ACCT_A },
      { registration_id: "reg-2", stripe_account_id: ACCT_B },
    ]);
    await expect(
      resolveEventMerchantLine({
        supabase: client,
        registrationIds: ["reg-1", "reg-2"],
        paymentStatus: "paid",
        totalAmount: 60,
        branding,
      }),
    ).resolves.toBeNull();
  });

  it("does not query payments at all for free or unpaid registrations", async () => {
    const { fake, client } = supabaseWith([{ registration_id: "reg-1", stripe_account_id: ACCT_A }]);
    await expect(
      resolveEventMerchantLine({
        supabase: client,
        registrationIds: ["reg-1"],
        paymentStatus: "paid",
        totalAmount: 0,
        branding,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveEventMerchantLine({
        supabase: client,
        registrationIds: ["reg-1"],
        paymentStatus: "pending",
        totalAmount: 30,
        branding,
      }),
    ).resolves.toBeNull();
    expect(fake.fromCalls).toEqual([]);
  });

  it("omits the line (never guesses) when the owner lookup fails", async () => {
    const failing = {
      from: () => ({
        select: () => ({
          in: async () => ({ data: null, error: { message: "boom" } }),
        }),
      }),
    } as unknown as SupabaseClient;
    await expect(
      resolveEventMerchantLine({
        supabase: failing,
        registrationIds: ["reg-1"],
        paymentStatus: "paid",
        totalAmount: 30,
        branding,
      }),
    ).resolves.toBeNull();
  });
});
