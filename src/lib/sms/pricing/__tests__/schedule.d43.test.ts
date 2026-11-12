import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runPriceMonitor } from "../monitor";
import { FakeTransport, loadMonitorConfig, type MonitorConfig } from "../transport";
import { FakeDb } from "./fakeDb";

type Cron = { path: string; schedule: string };
const crons = () => (JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons?: Cron[] }).crons ?? [];

const loaders: Array<() => Promise<{ GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> }>> = [
  () => import("@/app/api/cron/sms-price-monitor/route"),
  () => import("@/app/api/cron/sms-price-monitor-watchdog/route"),
];

afterEach(() => vi.unstubAllEnvs());

describe("TW-4F price monitor activation: schedule, dark default and event replay", () => {
  it("registers the monitor every 15 minutes and the watchdog hourly on the existing routes, each exactly once", () => {
    expect(crons().filter((c) => c.path === "/api/cron/sms-price-monitor")).toEqual([{ path: "/api/cron/sms-price-monitor", schedule: "*/15 * * * *" }]);
    expect(crons().filter((c) => c.path === "/api/cron/sms-price-monitor-watchdog")).toEqual([{ path: "/api/cron/sms-price-monitor-watchdog", schedule: "37 * * * *" }]);
  });

  it("both routes answer 404 and touch nothing unless SMS_PRICE_MONITOR=on", async () => {
    vi.stubEnv("SMS_PRICE_MONITOR", "");
    const created = vi.fn();
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => { created(); return { rpc: async () => ({ data: null, error: null }) }; } }));
    for (const load of loaders) {
      vi.resetModules();
      const route = await load();
      for (const call of [route.GET, route.POST]) {
        const res = await call(new Request("https://example.invalid/x", { headers: { authorization: "Bearer anything" } }));
        expect(res.status).toBe(404);
      }
    }
    expect(created).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/supabase/admin");
  });

  it("when switched on, a request without the cron secret is refused before any database client is created", async () => {
    vi.stubEnv("SMS_PRICE_MONITOR", "on");
    vi.stubEnv("CRON_SECRET", "s3cret-value-for-test");
    const created = vi.fn();
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => { created(); return { rpc: async () => ({ data: null, error: null }) }; } }));
    for (const load of loaders) {
      vi.resetModules();
      const route = await load();
      const none = await route.GET(new Request("https://example.invalid/x"));
      const wrong = await route.GET(new Request("https://example.invalid/x", { headers: { authorization: "Bearer not-the-secret" } }));
      expect([none.status, wrong.status].every((s) => s === 401 || s === 403)).toBe(true);
    }
    expect(created).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/supabase/admin");
  });

  it("uses only the dedicated PRICE_MONITOR_* email variables: the application's own Resend variables configure nothing", () => {
    expect(loadMonitorConfig({ RESEND_API_KEY: "re_app", RESEND_FROM_EMAIL: "app@example.invalid" }).transports).toEqual([]);
    const cfg = loadMonitorConfig({ PRICE_MONITOR_RESEND_API_KEY: "re_dedicated", PRICE_MONITOR_EMAIL_FROM: "alerts@example.invalid", PRICE_MONITOR_EMAIL_TO: "owner@example.invalid" });
    expect(cfg.transports.map((t) => t.name)).toEqual(["resend_email"]);
  });

  it("a first run (no previous evidence) replays the retained approver registration events from sequence 0 and alerts on them", async () => {
    let t = Date.parse("2026-11-12T19:30:00Z");
    const clock = () => new Date(t);
    const db = new FakeDb(clock);
    const transport = new FakeTransport();
    const config: MonitorConfig = { transports: [transport], chainKey: null, since: null, repeatMs: 6 * 3600_000, maxAgeMs: 45 * 60_000, trustedFromSeq: 0, expectHead: null };
    const uid = "eb8357d3-0add-4345-8ac3-f5bedf9d3924";
    db.eventRows = [
      { seq: 1, kind: "approver_added", occurred_at: "2026-11-12T19:22:44.012Z", subject_user_id: uid, detail: { note_length: 113 } },
      { seq: 2, kind: "approver_registry_changed", occurred_at: "2026-11-12T19:22:44.013Z", subject_user_id: uid, detail: { change: "added" } },
    ];
    const out = await runPriceMonitor({ db, config, now: clock, sleep: async () => undefined });
    expect(out.alertRequired).toBe(true);
    expect(out.findings.some((f) => f.code === "approver_registry_changed")).toBe(true);
    expect(transport.sent.length).toBeGreaterThan(0);
    expect(db.calls).toContain("events");
    t += 15 * 60_000;
    db.verifyResult = { ok: true, anomalies: [], checked_at: clock().toISOString() };
    const again = await runPriceMonitor({ db, config, now: clock, sleep: async () => undefined });
    expect(again.findings.filter((f) => f.code === "approver_registry_changed")).toEqual([]); // the cursor moved on: the same events are not re-reported
  });
});
