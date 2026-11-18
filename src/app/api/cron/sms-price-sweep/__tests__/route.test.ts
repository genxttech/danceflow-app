import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));

import { GET, POST } from "../route";

const req = (headers: Record<string, string> = {}) => new Request("http://x/api/cron/sms-price-sweep", { headers });

describe("sms-price-sweep route", () => {
  beforeEach(() => { rpc.mockReset(); process.env.CRON_SECRET = "s3cret-s3cret-s3cret"; });
  afterEach(() => { delete process.env.SMS_PRICE_SWEEP; delete process.env.CRON_SECRET; });

  it("is 404 unless SMS_PRICE_SWEEP=on and never calls the database", async () => {
    expect((await GET(req({ authorization: "Bearer s3cret-s3cret-s3cret" }))).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("requires the cron secret", async () => {
    process.env.SMS_PRICE_SWEEP = "on";
    expect((await GET(req())).status).not.toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("calls only tw4_price_sweep_expired and returns a count", async () => {
    process.env.SMS_PRICE_SWEEP = "on";
    rpc.mockResolvedValue({ data: { expired: 6, request_ids: ["a"] }, error: null });
    const r = await POST(req({ authorization: "Bearer s3cret-s3cret-s3cret" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, expired: 6 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("tw4_price_sweep_expired");
  });
  it("answers 500 with no detail when the function fails", async () => {
    process.env.SMS_PRICE_SWEEP = "on";
    rpc.mockResolvedValue({ data: null, error: { message: "boom secret detail" } });
    const r = await GET(req({ authorization: "Bearer s3cret-s3cret-s3cret" }));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("boom");
  });
});
