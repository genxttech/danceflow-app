import { describe, expect, it } from "vitest";
import { capturedAmount, checkinBalanceDue } from "../checkinBalance";

const pay = (amount: number, refund = 0, status = "paid") => ({ amount, refund_amount: refund, status });

describe("CI-B desk balance: refunds never become a debt", () => {
  it("partial refund of 1 of 3 entries leaves nothing due", () => {
    expect(checkinBalanceDue(300, [pay(300, 100)])).toBe(0);
  });
  it("full refund (payment marked refunded) leaves nothing due", () => {
    expect(checkinBalanceDue(300, [pay(300, 300, "refunded")])).toBe(0);
  });
  it("a genuine unpaid remainder stays due and a refund does not add to it", () => {
    expect(checkinBalanceDue(300, [pay(200)])).toBe(100);
    expect(checkinBalanceDue(300, [pay(200, 50)])).toBe(100);
  });
  it("sums stripe and desk payments, ignoring refund_amount", () => {
    expect(checkinBalanceDue(300, [pay(200, 80), pay(100, 0)])).toBe(0);
  });
  it("only collected payments count (pending/failed rows and pending refunds do not)", () => {
    expect(capturedAmount([pay(100, 0, "pending"), pay(100, 0, "failed"), pay(100)])).toBe(100);
    expect(checkinBalanceDue(300, [pay(300, 0)])).toBe(0);
  });
  it("is cent-exact and never negative", () => {
    expect(checkinBalanceDue(0.3, [pay(0.1), pay(0.2)])).toBe(0);
    expect(checkinBalanceDue("100.10", [pay("100.00")])).toBe(0.1);
    expect(checkinBalanceDue(100, [pay(150)])).toBe(0);
    expect(checkinBalanceDue(null, [])).toBe(0);
  });
});
