import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ProviderFeeLifecycleStore } from "../providerFeeLifecycle";

/**
 * TW-4F F5, review P2-4 (owner decision): tw4_rfl_cancel_begin answering `execute` CLAIMS the operation (it is in_flight from then on). A reply that says execute
 * but carries no usable provider SID / resource kind must therefore read as an UNKNOWN claim, never as "nothing to do" (skip): the caller records it unknown
 * and an operator resolves it. App mapping only; no SQL changes.
 */

const store = (data: unknown) => new ProviderFeeLifecycleStore({ rpc: (async () => ({ data, error: null })) as never });
const OP = "f0000001-0000-4000-8000-000000000001";
const ACTOR = "f0000002-0000-4000-8000-000000000002";
const PN = `PN${"1".repeat(32)}`;

describe("ProviderFeeLifecycleStore.beginCancel: a malformed execute is an unknown claim", () => {
  it("a well-formed execute is passed through", async () => {
    expect(await store({ action: "execute", provider_sid: PN, resource_kind: "number" }).beginCancel(OP, ACTOR)).toEqual({ action: "execute", providerSid: PN, resourceKind: "number" });
  });

  it.each([
    ["no provider sid", { action: "execute", resource_kind: "number" }],
    ["no resource kind", { action: "execute", provider_sid: PN }],
    ["unknown resource kind", { action: "execute", provider_sid: PN, resource_kind: "shortcode" }],
    ["malformed provider sid", { action: "execute", provider_sid: "PN123", resource_kind: "number" }],
    ["sid of another kind", { action: "execute", provider_sid: `MG${"2".repeat(32)}`, resource_kind: "number" }],
    ["non-string sid", { action: "execute", provider_sid: 42, resource_kind: "number" }],
  ])("%s -> unknown_claim (never skip)", async (_name, reply) => {
    expect(await store(reply).beginCancel(OP, ACTOR)).toEqual({ action: "unknown_claim" });
  });

  it("the other answers are unchanged", async () => {
    expect(await store({ action: "in_progress" }).beginCancel(OP, ACTOR)).toEqual({ action: "in_progress" });
    expect(await store({ action: "reconcile" }).beginCancel(OP, ACTOR)).toEqual({ action: "reconcile" });
    expect(await store({ action: "skip", status: "withdrawn" }).beginCancel(OP, ACTOR)).toEqual({ action: "skip", status: "withdrawn" });
  });
});
