import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/platform-assurance", async () => (await import("@/lib/auth/__tests__/stepUpDouble")).stepUpDouble());

vi.mock("server-only", () => ({}));

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const cookieWrites: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (name: string, value: string) => cookieWrites.push({ name, value }), get: vi.fn() }) }));

const ADMIN = "a6000000-0000-4000-8000-000000000501";
let platformAdmin = true;
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => {
    if (!platformAdmin) throw new Error("NOT_PLATFORM_ADMIN");
    return { id: ADMIN };
  },
}));
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let rpcReplies: Record<string, { data?: unknown; error?: { code: string } }> = {};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      const r = rpcReplies[fn];
      return r ? { data: r.data ?? null, error: r.error ?? null } : { data: null, error: { code: "42883" } };
    },
  }),
}));

type Outcome = Record<string, unknown>;
const runs: { operationId: string; actorId: string }[] = [];
let runtime: { ok: true; mode: "fake" | "real"; outcome: Outcome } | { ok: false; reason: string } = { ok: false, reason: "Provider release is switched off (TW4_CANCEL_RELEASE)." };
vi.mock("@/lib/sms/twilioIsv/cancelRuntime", () => ({
  cancelReleaseAvailable: () => runtime.ok,
  cancelReleaseRuntime: () =>
    runtime.ok
      ? { ok: true, mode: runtime.mode, runner: { run: async (operationId: string, actorId: string) => (runs.push({ operationId, actorId }), (runtime as { outcome: Outcome }).outcome) } }
      : runtime,
}));

import { parseOverview } from "@/lib/sms/providerFeeOps";
import RecurringFeesCancel from "../RecurringFeesCancel";
import { rflCancelBeginAction, rflCancelReleaseAction } from "../recurringFeeActions";

const OP = "b0000004-0000-4000-8000-000000000001";
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
async function submit(fields: Record<string, string>) {
  await expect(rflCancelReleaseAction(form(fields))).rejects.toThrow("NEXT_REDIRECT");
  const flash = JSON.parse(cookieWrites[cookieWrites.length - 1].value) as { ok: boolean; message: string };
  return { url: redirects[redirects.length - 1], ...flash };
}

beforeEach(() => {
  runs.length = 0;
  platformAdmin = true;
  runtime = { ok: false, reason: "Provider release is switched off (TW4_CANCEL_RELEASE)." };
});

describe("F5 rflCancelReleaseAction", () => {
  it("refuses without the administrator, a valid operation id or the irreversibility acknowledgement; nothing runs", async () => {
    platformAdmin = false;
    await expect(rflCancelReleaseAction(form({ operationId: OP, releaseAck: "yes" }))).rejects.toThrow("NOT_PLATFORM_ADMIN");
    platformAdmin = true;
    runtime = { ok: true, mode: "fake", outcome: { result: "confirmed", status: "confirmed" } };
    expect(await submit({ operationId: "x", releaseAck: "yes" })).toMatchObject({ ok: false });
    expect(await submit({ operationId: OP })).toMatchObject({ ok: false, message: expect.stringContaining("cannot be undone") });
    expect(runs).toHaveLength(0);
  });

  it("when the runtime is not available it says so and points to the manual path; nothing runs", async () => {
    const out = await submit({ operationId: OP, releaseAck: "yes" });
    expect(out.ok).toBe(false);
    expect(out.message).toContain("switched off");
    expect(out.message).toContain("use Begin and the console step");
    expect(runs).toHaveLength(0);
  });

  it("runs the runner as the SESSION administrator and maps every outcome to a fixed sentence", async () => {
    const expectations: [Outcome, boolean, string][] = [
      [{ result: "confirmed", status: "confirmed", release: "released", evidenceDigest: "a".repeat(64) }, true, "(local fake provider) and confirmed by a provider read"],
      [{ result: "refused", status: "refused" }, false, "Twilio refused the release"],
      [{ result: "unknown", status: "unknown_outcome", errorCode: "release_transient_503" }, false, "UNKNOWN (release_transient_503). It will not be repeated"],
      [{ result: "record_failed", outcome: "confirmed", evidenceDigest: "b".repeat(64), errorCode: null }, false, `evidence digest ${"b".repeat(64)}`],
      [{ result: "record_failed", outcome: "unknown", evidenceDigest: null, errorCode: "no_call_recheck_failed" }, false, "Nothing was sent to Twilio"],
      [{ result: "precondition_refused", reason: "A number is released only with a consumed dual-control approval by two different platform administrators." }, false, "Nothing was claimed or released"],
      [{ result: "in_progress" }, true, "already claimed"],
      [{ result: "reconcile" }, true, "look the resource up"],
      [{ result: "skip", status: "withdrawn" }, true, "this operation is withdrawn"],
    ];
    for (const [outcome, ok, text] of expectations) {
      runtime = { ok: true, mode: "fake", outcome };
      const out = await submit({ operationId: OP, releaseAck: "yes", actorId: "c0000000-0000-4000-8000-000000000999" });
      expect(out.ok, String(outcome.result)).toBe(ok);
      expect(out.message).toContain(text);
      expect(out.url).toContain(ok ? "rfl=1" : "rfl_error=1");
    }
    expect(runs.every((r) => r.operationId === OP && r.actorId === ADMIN)).toBe(true);
  });
});

describe("F5 RecurringFeesCancel", () => {
  const overview = (kind: string, op: string | null) =>
    parseOverview({
      resources: [{
        resource_id: "c0000020-0000-4000-8000-000000000001", legal_entity_id: "c0000010-0000-4000-8000-000000000001", studio_id: "c0000011-0000-4000-8000-000000000001", kind, fee_kind: "monthly",
        provider_state: "active", df_sending: false, current_period: "covered:charge", next_period: "covered:charge", open_cancel_operation: op, open_cancel_operation_id: op ? OP : null,
      }],
      alerts_waiting: 0, cancel_operations_open: op ? 1 : 0,
    });
  const render = (props: Parameters<typeof RecurringFeesCancel>[0]) => renderToStaticMarkup(createElement(RecurringFeesCancel, props));

  it("offers Release at Twilio now only for an authorized operation and only when the runtime is available; the manual path stays", () => {
    const on = render({ overview: overview("campaign", "authorized"), dual: [], releaseAvailable: true });
    expect(on).toContain("Release at Twilio now</button>");
    expect(on).toContain("Begin cancellation claim");
    expect(on).toContain(`value="${OP}"`);
    expect(on).toContain("DanceFlow can release an authorized resource at Twilio from here");
    const off = render({ overview: overview("campaign", "authorized"), dual: [], releaseAvailable: false });
    expect(off).not.toContain("Release at Twilio now");
    expect(off).toContain("DanceFlow never cancels anything at Twilio");
    for (const op of ["in_flight", "unknown_outcome", null]) expect(render({ overview: overview("campaign", op), dual: [], releaseAvailable: true })).not.toContain("Release at Twilio now</button>");
  });

  it("never renders a provider SID, and the suspension form stays offered beside release (it never waits on provider release)", () => {
    const html = render({ overview: overview("number", "authorized"), dual: [], releaseAvailable: true });
    expect(html).not.toMatch(/(PN|QE|MG|AC)[0-9a-fA-F]{32}/);
    expect(html).toContain("Suspend DanceFlow sending now</button>");
  });

  it("a number's release form says it needs two different administrators", () => {
    expect(render({ overview: overview("number", "authorized"), dual: [], releaseAvailable: true })).toContain("consumed approval of two different administrators");
  });

  it("without a prop the component asks the runtime (unavailable here: nothing offered)", () => {
    expect(render({ overview: overview("campaign", "authorized"), dual: [] })).not.toContain("Release at Twilio now");
    runtime = { ok: true, mode: "fake", outcome: {} };
    expect(render({ overview: overview("campaign", "authorized"), dual: [] })).toContain("Release at Twilio now</button>");
  });
});

describe("F5 review P2-4: the manual Begin with a malformed execute reply", () => {
  const begin = async () => {
    await expect(rflCancelBeginAction(form({ operationId: OP }))).rejects.toThrow("NEXT_REDIRECT");
    return JSON.parse(cookieWrites[cookieWrites.length - 1].value) as { ok: boolean; message: string };
  };

  it("records the claimed operation as UNKNOWN (never skip, never a provider step) and says nothing was cancelled", async () => {
    rpcCalls.length = 0;
    rpcReplies = { tw4_rfl_cancel_begin: { data: { action: "execute", provider_sid: `PN${"9".repeat(32)}` } }, tw4_rfl_cancel_finish: { data: { status: "unknown_outcome", replayed: false } } };
    const out = await begin();
    expect(out.ok).toBe(false);
    expect(out.message).toContain("UNKNOWN");
    expect(out.message).toContain("DanceFlow has NOT cancelled anything");
    expect(out.message).not.toMatch(/(PN|QE|MG)[0-9a-fA-F]{32}/);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["tw4_rfl_cancel_begin", "tw4_rfl_cancel_finish"]);
    expect(rpcCalls[1].args).toEqual({ p_operation_id: OP, p_actor: ADMIN, p_outcome: "unknown", p_evidence_digest: null, p_error_code: "no_call_malformed_claim" });
  });

  it("if recording it fails, it says so and does not claim again", async () => {
    rpcCalls.length = 0;
    rpcReplies = { tw4_rfl_cancel_begin: { data: { action: "execute" } }, tw4_rfl_cancel_finish: { error: { code: "TW041" } } };
    const out = await begin();
    expect(out.ok).toBe(false);
    expect(out.message).toContain("recording it as unknown failed");
    expect(out.message).toContain("DanceFlow has NOT cancelled anything");
    expect(rpcCalls.filter((c) => c.fn === "tw4_rfl_cancel_begin")).toHaveLength(1);
  });

  it("a genuine skip stays 'nothing to do'", async () => {
    rpcReplies = { tw4_rfl_cancel_begin: { data: { action: "skip", status: "withdrawn" } } };
    const out = await begin();
    expect(out).toMatchObject({ ok: true, message: expect.stringContaining("Nothing to do: this operation is withdrawn") });
  });
});
