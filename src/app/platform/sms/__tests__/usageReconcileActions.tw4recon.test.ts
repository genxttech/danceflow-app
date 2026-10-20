import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const ADMIN = "a6000000-0000-4000-8000-000000000501";
let platformAdmin = true;
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => {
    if (!platformAdmin) throw new Error("NOT_PLATFORM_ADMIN");
    return { id: ADMIN };
  },
}));
let allowed = true;
vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed }),
  rateLimitKey: (...parts: string[]) => parts.join(":"),
}));
const rpc: { fn: string; args: Record<string, unknown> }[] = [];
let rpcError: { code?: string; message?: string } | null = null;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpc.push({ fn, args });
      return { data: null, error: rpcError };
    },
  }),
}));

import { resolveUsageAttemptAction } from "../usageReconcileActions";

const ATTEMPT = "b1000000-0000-4000-8000-000000000001";
const REASON = "Checked the Twilio console: delivered.";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
async function run(fields: Record<string, string>): Promise<string> {
  await expect(resolveUsageAttemptAction(form(fields))).rejects.toThrow("NEXT_REDIRECT");
  return redirects[redirects.length - 1];
}

beforeEach(() => {
  redirects.length = 0;
  rpc.length = 0;
  rpcError = null;
  allowed = true;
  platformAdmin = true;
});

describe("resolveUsageAttemptAction", () => {
  it("takes the actor from the session, never from the form", async () => {
    const url = await run({ attemptId: ATTEMPT, outcome: "released", reason: REASON, actor: "evil", p_actor: "evil" });
    expect(url).toBe("/platform/sms?usage=resolved#usage-reconciliation");
    expect(rpc).toEqual([{ fn: "tw4_usage_resolve", args: { p_attempt_id: ATTEMPT, p_actor: ADMIN, p_outcome: "released", p_segments: null, p_reason: REASON } }]);
  });

  it("requires a platform admin", async () => {
    platformAdmin = false;
    await expect(resolveUsageAttemptAction(form({ attemptId: ATTEMPT, outcome: "released", reason: REASON }))).rejects.toThrow("NOT_PLATFORM_ADMIN");
    expect(rpc).toHaveLength(0);
  });

  it("never calls the rpc on invalid input", async () => {
    const bad: Record<string, string>[] = [
      { attemptId: "nope", outcome: "released", reason: REASON },
      { attemptId: ATTEMPT, outcome: "deleted", reason: REASON },
      { attemptId: ATTEMPT, outcome: "released", reason: "short" },
      { attemptId: ATTEMPT, outcome: "released", reason: "x".repeat(301) },
      { attemptId: ATTEMPT, outcome: "charged", reason: REASON },
      { attemptId: ATTEMPT, outcome: "charged", segments: "0", reason: REASON },
      { attemptId: ATTEMPT, outcome: "charged", segments: "11", reason: REASON },
      { attemptId: ATTEMPT, outcome: "charged", segments: "abc", reason: REASON },
    ];
    for (const fields of bad) expect(await run(fields)).toBe("/platform/sms?usage_error=invalid#usage-reconciliation");
    expect(rpc).toHaveLength(0);
  });

  it("sends segments only for a charge", async () => {
    await run({ attemptId: ATTEMPT, outcome: "charged", segments: "3", reason: REASON });
    await run({ attemptId: ATTEMPT, outcome: "not_charged", segments: "3", reason: REASON });
    expect(rpc.map((r) => r.args.p_segments)).toEqual([3, null]);
  });

  it("rate limits before the rpc", async () => {
    allowed = false;
    expect(await run({ attemptId: ATTEMPT, outcome: "released", reason: REASON })).toBe("/platform/sms?usage_error=rate_limited#usage-reconciliation");
    expect(rpc).toHaveLength(0);
  });

  it("maps errcodes to fixed codes and never echoes database text", async () => {
    const cases: [string, string][] = [["42501", "not_allowed"], ["22023", "not_resolvable"], ["XX000", "failed"]];
    for (const [code, expected] of cases) {
      rpcError = { code, message: "secret database detail" };
      const url = await run({ attemptId: ATTEMPT, outcome: "released", reason: REASON });
      expect(url).toBe(`/platform/sms?usage_error=${expected}#usage-reconciliation`);
      expect(url).not.toContain("secret");
    }
  });
});
