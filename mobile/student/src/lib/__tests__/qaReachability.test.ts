// The Student smoke harness waits for the emulator's network before it signs in (RC4: one sign-in failed on the post-boot Wi-Fi flap and passed
// on retry), and refuses an APK that does not carry this run's stack. These cover the pure logic; the adb/docker calls live in run.mjs.
/* eslint-disable @typescript-eslint/no-require-imports */
const reach = require("../../../scripts/qa-smoke/reachability.js") as {
  waitForWifiAddress: (o: { probe: () => string | Promise<string>; sleep: (ms: number) => Promise<void>; tries?: number; everyMs?: number }) => Promise<{ ok: boolean; tries: number }>;
  waitForSteadyAnswer: (o: { probe: () => string | Promise<string>; sleep: (ms: number) => Promise<void>; now?: () => number; timeoutMs?: number; retryMs?: number; confirmMs?: number }) => Promise<{ ok: boolean; last: string }>;
  studentBakedConfigProblems: (strings: string[], o: { stackPort: number; mockPort: number; anonKey: string }) => string[];
  oneLine: (t: unknown, max?: number) => string;
  reachProbeCommand: (port: number, path?: string) => string;
  probeAnswered: (out: string) => boolean;
  hasWifiAddress: (out: string) => boolean;
  hermesStrings: (buf: Buffer) => string[];
};

const WLAN_UP = "27: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP\n    inet 10.0.2.16/24 brd 10.0.2.255 scope global wlan0";
const WLAN_DOWN = "27: wlan0: <BROADCAST,MULTICAST> mtu 1500 state DOWN";
const HTTP_OK = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nok";
const NO_ROUTE = "nc: connect: Network is unreachable";

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
};

describe("helpers shared with the Business smoke are present", () => {
  it("exposes the reach probe, Wi-Fi test and Hermes reader", () => {
    expect(reach.reachProbeCommand(56600, "/auth/v1/health")).toContain("nc -w 4 10.0.2.2 56600");
    expect(reach.reachProbeCommand(8791)).toContain("GET /");
    expect(reach.probeAnswered(HTTP_OK)).toBe(true);
    expect(reach.probeAnswered(NO_ROUTE)).toBe(false);
    expect(reach.hasWifiAddress(WLAN_UP)).toBe(true);
    expect(reach.hasWifiAddress(WLAN_DOWN)).toBe(false);
    expect(typeof reach.hermesStrings).toBe("function");
  });
});

describe("waitForWifiAddress", () => {
  it("waits until wlan0 has an address", async () => {
    const c = clock();
    const outputs = [WLAN_DOWN, WLAN_DOWN, WLAN_UP];
    let calls = 0;
    const r = await reach.waitForWifiAddress({ probe: () => outputs[Math.min(calls++, outputs.length - 1)], sleep: c.sleep });
    expect(r).toEqual({ ok: true, tries: 3 });
    expect(c.now()).toBe(6000); // two waits of 3 s
  });

  it("gives up with ok false after the allowed tries (named failure, not a silent hang)", async () => {
    const c = clock();
    const r = await reach.waitForWifiAddress({ probe: () => WLAN_DOWN, sleep: c.sleep, tries: 5, everyMs: 1000 });
    expect(r).toEqual({ ok: false, tries: 5 });
    expect(c.now()).toBe(4000);
  });
});

describe("waitForSteadyAnswer", () => {
  it("needs two answers apart: a flap that answers once is not steady", async () => {
    const c = clock();
    const outputs = [HTTP_OK, NO_ROUTE, NO_ROUTE, HTTP_OK, HTTP_OK]; // answers, drops during the confirm, then steady
    let calls = 0;
    const r = await reach.waitForSteadyAnswer({ probe: () => outputs[Math.min(calls++, outputs.length - 1)], sleep: c.sleep, now: c.now });
    expect(r.ok).toBe(true);
    expect(calls).toBe(5);
  });

  it("an immediately steady network passes after one confirm wait", async () => {
    const c = clock();
    const r = await reach.waitForSteadyAnswer({ probe: () => HTTP_OK, sleep: c.sleep, now: c.now, confirmMs: 15000 });
    expect(r.ok).toBe(true);
    expect(c.now()).toBe(15000);
  });

  it("never answering fails after the timeout, carrying the last output for the failure message", async () => {
    const c = clock();
    const r = await reach.waitForSteadyAnswer({ probe: () => NO_ROUTE, sleep: c.sleep, now: c.now, timeoutMs: 60_000, retryMs: 4000 });
    expect(r.ok).toBe(false);
    expect(r.last).toBe(NO_ROUTE);
    expect(c.now()).toBeGreaterThanOrEqual(60_000);
  });
});

describe("studentBakedConfigProblems", () => {
  const key = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig";
  const good = ["http://10.0.2.2:56600", "http://10.0.2.2:8791", key, "unrelated"];

  it("accepts an APK that carries this run's stack URL, mock web URL and anon key", () => {
    expect(reach.studentBakedConfigProblems(good, { stackPort: 56600, mockPort: 8791, anonKey: key })).toEqual([]);
  });

  it("names a stale stack port, a missing web URL and a foreign key", () => {
    const problems = reach.studentBakedConfigProblems(["http://10.0.2.2:56601", "eyJother.key.x"], { stackPort: 56600, mockPort: 8791, anonKey: key });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/56600/);
    expect(problems[0]).toMatch(/56601/);
    expect(problems[1]).toMatch(/8791/);
    expect(problems[2]).toMatch(/anon key/);
  });
});

describe("oneLine", () => {
  it("collapses whitespace, truncates and never returns an empty detail", () => {
    expect(reach.oneLine("a\n  b\r\n c")).toBe("a b c");
    expect(reach.oneLine("x".repeat(500), 10)).toBe("xxxxxxxxxx");
    expect(reach.oneLine("   ")).toBe("none");
    expect(reach.oneLine(undefined)).toBe("none");
  });
});
