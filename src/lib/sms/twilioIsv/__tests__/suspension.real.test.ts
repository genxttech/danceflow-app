import { describe, expect, it, vi } from "vitest";
import { suspensionCallsAllowed } from "../suspension";
import { createRealSuspensionProvider } from "../suspensionReal";

/**
 * TW-4F slice E: the real subaccount status client is unreachable while either gate is off, and its request shapes when both are on. Every request goes to
 * an INJECTED fetch: nothing here (or anywhere in the tests) reaches Twilio. The global fetch is trapped to prove it.
 */

vi.mock("server-only", () => ({}));

const PARENT = `AC${"a".repeat(32)}`;
const SUB = `AC${"b".repeat(32)}`;
const CREDS = { accountSid: PARENT, authToken: "t".repeat(32) };
const ON = { VERCEL_ENV: "production", NODE_ENV: "production", TW4_SUBACCOUNT_SUSPENSION_CALLS: "on" };
const switchDb = (on: boolean | "error") => {
  const calls: string[] = [];
  return { calls, rpc: async (fn: string) => (calls.push(fn), on === "error" ? { data: null, error: { code: "XX000" } } : { data: on, error: null }) };
};
const fetchOk = (body: Record<string, unknown>) => vi.fn(async (_url: string, _init: { method: string; headers: Record<string, string>; body?: string }) => ({ status: 200, text: async () => JSON.stringify(body) }));

describe("gates: the real client cannot be reached while either is off", () => {
  it("the environment gate needs a production deployment, a production build and the explicit flag (unset by default)", () => {
    expect(suspensionCallsAllowed({}).allowed).toBe(false);
    expect(suspensionCallsAllowed({ ...ON, TW4_SUBACCOUNT_SUSPENSION_CALLS: undefined }).allowed).toBe(false);
    expect(suspensionCallsAllowed({ ...ON, TW4_SUBACCOUNT_SUSPENSION_CALLS: "true" }).allowed).toBe(false);
    expect(suspensionCallsAllowed({ ...ON, VERCEL_ENV: "preview" }).allowed).toBe(false);
    expect(suspensionCallsAllowed({ ...ON, NODE_ENV: "development" }).allowed).toBe(false);
    expect(suspensionCallsAllowed(ON).allowed).toBe(true);
    // the test process itself never has the gate on
    expect(suspensionCallsAllowed(process.env).allowed).toBe(false);
  });

  it("environment off: construction throws before the database or the network is touched", async () => {
    const db = switchDb(true);
    const f = fetchOk({});
    const g = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("NETWORK_TOUCHED"); });
    try {
      for (const env of [{}, process.env, { ...ON, TW4_SUBACCOUNT_SUSPENSION_CALLS: "off" }]) {
        await expect(createRealSuspensionProvider(db, CREDS, env as Record<string, string>, f)).rejects.toThrow();
      }
      expect(db.calls).toEqual([]);
      expect(f).not.toHaveBeenCalled();
      expect(g).not.toHaveBeenCalled();
    } finally {
      g.mockRestore();
    }
  });

  it("database switch off (or unreadable): construction throws, no request is made", async () => {
    for (const state of [false, "error"] as const) {
      const f = fetchOk({});
      await expect(createRealSuspensionProvider(switchDb(state), CREDS, ON, f)).rejects.toThrow(/switch is off/);
      expect(f).not.toHaveBeenCalled();
    }
  });

  it("missing parent credentials: refused", async () => {
    await expect(createRealSuspensionProvider(switchDb(true), { accountSid: "", authToken: "" }, ON, fetchOk({}))).rejects.toThrow(/credentials/);
  });
});

describe("request shapes with both gates on (injected fetch only)", () => {
  it("GET reads the account with the parent's Basic auth; POST sends only Status=suspended or Status=active", async () => {
    const f = fetchOk({ sid: SUB, owner_account_sid: PARENT, status: "active" });
    const p = await createRealSuspensionProvider(switchDb(true), CREDS, ON, f);
    expect(await p.getAccount(SUB)).toEqual({ sid: SUB, ownerAccountSid: PARENT, status: "active" });
    await p.setStatus(SUB, "suspended");
    await p.setStatus(SUB, "active");
    const [get, post1, post2] = f.mock.calls;
    expect(get[0]).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB}.json`);
    expect(get[1].method).toBe("GET");
    expect(get[1].headers.Authorization).toBe(`Basic ${Buffer.from(`${PARENT}:${CREDS.authToken}`).toString("base64")}`);
    expect([post1[1].method, post1[1].body, post2[1].body]).toEqual(["POST", "Status=suspended", "Status=active"]);
  });

  it("never sends Status=closed, and never targets the parent account itself", async () => {
    const f = fetchOk({});
    const p = await createRealSuspensionProvider(switchDb(true), CREDS, ON, f);
    await expect(p.setStatus(SUB, "closed" as never)).rejects.toThrow(/only suspended or active/);
    await expect(p.setStatus(PARENT, "suspended")).rejects.toThrow(/not a subaccount sid/);
    await expect(p.getAccount(PARENT)).rejects.toThrow(/not a subaccount sid/);
    expect(f).not.toHaveBeenCalled();
  });

  it("the status write re-checks the environment gate on every call", async () => {
    const env: Record<string, string> = { ...ON };
    const f = fetchOk({});
    const p = await createRealSuspensionProvider(switchDb(true), CREDS, env, f);
    env.TW4_SUBACCOUNT_SUSPENSION_CALLS = "off";
    await expect(p.setStatus(SUB, "suspended")).rejects.toThrow(/switched off/);
    expect(f).not.toHaveBeenCalled();
  });
});
