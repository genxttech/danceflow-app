import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENERIC_FEEDBACK_ERROR,
  MEMBERSHIP_ERROR_MESSAGES,
  resolveFeedbackMessage,
} from "@/lib/memberships/membershipMessages";
import { sellErrorMessage, sellSuccessMessage } from "@/app/app/sell/sellFeedback";

/** PAY-DC-2C: feedback pages render fixed copy only, never raw or crafted query text. */

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

describe("resolveFeedbackMessage", () => {
  it("maps membership codes to fixed copy", () => {
    expect(resolveFeedbackMessage("membership_stripe_setup_incomplete", "error")).toBe(
      MEMBERSHIP_ERROR_MESSAGES.membership_stripe_setup_incomplete,
    );
    expect(resolveFeedbackMessage("membership_renewals_reconciled", "success")).toBe("Membership renewals reconciled.");
  });

  it("unknown error -> generic copy; unknown success -> nothing", () => {
    expect(resolveFeedbackMessage("some_unknown_code", "error")).toBe(GENERIC_FEEDBACK_ERROR);
    expect(resolveFeedbackMessage("some_unknown_code", "success")).toBeNull();
    expect(resolveFeedbackMessage(undefined, "error")).toBeNull();
  });

  it("raw, crafted or malformed values never echo and never throw", () => {
    for (const value of ["%zz", "100%", "No such customer on account acct_1", "Call +1 555 0100 for help", "__proto__", "toString"]) {
      expect(() => resolveFeedbackMessage(value, "error")).not.toThrow();
      expect(resolveFeedbackMessage(value, "error")).toBe(GENERIC_FEEDBACK_ERROR);
      expect(resolveFeedbackMessage(value, "success")).toBeNull();
    }
  });
});

describe("/app/sell feedback", () => {
  it("keeps sale and membership codes mapped", () => {
    expect(sellErrorMessage("missing_client")).toBe("Choose a client before completing the sale.");
    expect(sellErrorMessage("membership_sale_failed")).toBe(MEMBERSHIP_ERROR_MESSAGES.membership_sale_failed);
    expect(sellErrorMessage("invalid_start")).toBe(MEMBERSHIP_ERROR_MESSAGES.invalid_start);
    expect(sellSuccessMessage("membership_assigned")).toBe("Membership assigned.");
  });

  it("keeps app-authored commerce sentences, rejects everything else", () => {
    expect(sellErrorMessage("Choose a valid client.")).toBe("Choose a valid client.");
    expect(sellErrorMessage("Too many requests. Please wait 3 minutes and try again.")).toBe(
      "Too many requests. Please wait 3 minutes and try again.",
    );
    expect(sellErrorMessage('duplicate key value violates unique constraint "orders_pkey"')).toBe(GENERIC_FEEDBACK_ERROR);
    expect(sellErrorMessage("%E0%A4%A")).toBe(GENERIC_FEEDBACK_ERROR);
    expect(sellSuccessMessage("anything_else")).toBeNull();
  });

  it("keeps DanceFlow-authored commerce RPC messages visible", () => {
    for (const sentence of [
      "That external payment reference is already recorded.",
      "This student already has access to this content.",
      "This client does not have a linked student account.",
      "This client does not have a linked student account for this studio.",
      "Physical product variant was not found.",
      "Published digital product was not found.",
      "Client was not found in this studio.",
      "Payment method is invalid.",
      "Quantity must be between 1 and 1000.",
      "Only 3 unit(s) are available.",
      "Only 12 unreserved unit(s) are available.",
    ]) {
      expect(sellErrorMessage(sentence)).toBe(sentence);
    }
  });

  it("allowlist is exact: variants, provider text and malformed input stay generic", () => {
    for (const value of [
      "Payment method is invalid. acct_123",
      "Error: Payment method is invalid.",
      "Only 3 unit(s) are available. Contact acct_1",
      "Only three unit(s) are available.",
      "Only -1 unit(s) are available.",
      "Only 3 units are available.",
      'new row for relation "commerce_orders" violates check constraint',
      "No such payment_intent: 'pi_123'",
      "%",
      "%zz",
      "%E0%A4%A",
    ]) {
      expect(() => sellErrorMessage(value)).not.toThrow();
      expect(sellErrorMessage(value)).toBe(GENERIC_FEEDBACK_ERROR);
      expect(sellSuccessMessage(value)).toBeNull();
    }
  });

  it("the sell page no longer double-decodes or echoes unknown codes", () => {
    const page = read("src", "app", "app", "sell", "page.tsx");
    expect(page).not.toContain("decodeURIComponent");
    expect(page).not.toContain('replaceAll("_", " ")');
    expect(page).toContain("sellErrorMessage(params.error)");
  });

  it("client and memberships pages use the shared fixed copy", () => {
    expect(read("src", "app", "app", "clients", "[id]", "page.tsx")).toContain("MEMBERSHIP_ERROR_MESSAGES");
    const memberships = read("src", "app", "app", "memberships", "page.tsx");
    expect(memberships).toContain('resolveFeedbackMessage(params.error, "error")');
  });
});
