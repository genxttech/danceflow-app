import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createWaveMoneyTransaction, getWaveAccounts, getWaveUserAndBusinesses, WavePostingUncertainError } from "../client";

const input = { businessId: "b", externalId: "e", date: "2026-11-01", description: "d", anchor: { accountId: "a", amount: "1.00", direction: "DEPOSIT" as const }, lineItems: [{ accountId: "c", amount: "1.00", balance: "CREDIT" as const }] };
const res = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); });
const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

describe("createWaveMoneyTransaction error handling (S0-f2)", () => {
  it("returns the transaction id on success and sends the external id", async () => {
    fetchMock().mockResolvedValue(res({ data: { moneyTransactionCreate: { didSucceed: true, transaction: { id: "t1" } } } }));
    await expect(createWaveMoneyTransaction("tok", input)).resolves.toBe("t1");
    const sent = JSON.parse(fetchMock().mock.calls[0][1].body);
    expect(sent.variables.input.externalId).toBe("e");
  });
  it("network failure is UNCERTAIN (the request may have been applied)", async () => {
    fetchMock().mockRejectedValue(new Error("socket hang up"));
    await expect(createWaveMoneyTransaction("tok", input)).rejects.toBeInstanceOf(WavePostingUncertainError);
  });
  it("a 5xx is UNCERTAIN", async () => {
    fetchMock().mockResolvedValue(res("bad gateway", 502));
    await expect(createWaveMoneyTransaction("tok", input)).rejects.toBeInstanceOf(WavePostingUncertainError);
  });
  it("an unreadable 200 body is UNCERTAIN", async () => {
    fetchMock().mockResolvedValue(res("<html>", 200));
    await expect(createWaveMoneyTransaction("tok", input)).rejects.toBeInstanceOf(WavePostingUncertainError);
  });
  it("GraphQL errors are a definite failure", async () => {
    fetchMock().mockResolvedValue(res({ errors: [{ message: "Not authorized" }] }));
    const e = await createWaveMoneyTransaction("tok", input).catch((x) => x);
    expect(e).not.toBeInstanceOf(WavePostingUncertainError);
    expect(e.message).toContain("Not authorized");
  });
  it("didSucceed=false surfaces the input errors as a definite failure", async () => {
    fetchMock().mockResolvedValue(res({ data: { moneyTransactionCreate: { didSucceed: false, inputErrors: [{ path: "anchor.amount", message: "too small" }] } } }));
    const e = await createWaveMoneyTransaction("tok", input).catch((x) => x);
    expect(e).not.toBeInstanceOf(WavePostingUncertainError);
    expect(e.message).toBe("anchor.amount: too small");
  });
  it("didSucceed=true without a transaction id is not treated as success", async () => {
    fetchMock().mockResolvedValue(res({ data: { moneyTransactionCreate: { didSucceed: true, transaction: null } } }));
    await expect(createWaveMoneyTransaction("tok", input)).rejects.toThrow(/rejected/);
  });
  it("a 4xx is a definite failure carrying the status", async () => {
    fetchMock().mockResolvedValue(res({}, 401));
    const e = await createWaveMoneyTransaction("tok", input).catch((x) => x);
    expect(e).not.toBeInstanceOf(WavePostingUncertainError);
    expect(e.message).toContain("401");
  });
});

describe("Wave read queries (S0-f2)", () => {
  it("surfaces GraphQL error messages", async () => {
    fetchMock().mockResolvedValue(res({ errors: [{ message: "a" }, { message: "b" }] }));
    await expect(getWaveUserAndBusinesses("tok")).rejects.toThrow("a; b");
  });
  it("throws when the business is unavailable", async () => {
    fetchMock().mockResolvedValue(res({ data: { business: null } }));
    await expect(getWaveAccounts("tok", "b")).rejects.toThrow(/unavailable/);
  });
  it("sends the bearer token", async () => {
    fetchMock().mockResolvedValue(res({ data: { business: { accounts: { edges: [{ node: { id: "x" } }] } } } }));
    await expect(getWaveAccounts("tok", "b")).resolves.toEqual([{ id: "x" }]);
    expect(fetchMock().mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
  });
});
