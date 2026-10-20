import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";

vi.mock("server-only", () => ({}));

import { SubaccountTokenProvider } from "@/lib/sms/twilioIsv/account";
import {
  parseWebhookAccountRecord,
  verifyTwilioWebhookAccount,
  webhookMayActForStudio,
  webhookReceiptKey,
  type WebhookAccountDeps,
  type WebhookAccountRecord,
} from "@/lib/sms/twilioWebhookAccount";

/** TW-4F provider integration: account-aware webhook verification. Synthetic tokens and SIDs only. */

const URL = "https://www.idanceflow.com/api/sms/twilio/status?secret=fake-callback-secret";
const PARENT = `AC${"1".repeat(32)}`;
const PARENT_TOKEN = "fake-parent-token";
const SUB_A = `AC${"a".repeat(32)}`;
const SUB_B = `AC${"b".repeat(32)}`;
const ENTITY_A = "e0000000-0000-4000-8000-0000000000a1";
const ENTITY_B = "e0000000-0000-4000-8000-0000000000b1";
const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const STUDIO_A2 = "11111111-1111-4111-8111-111111111112";
const STUDIO_B = "22222222-2222-4222-8222-222222222222";
const MSG = `SM${"c".repeat(32)}`;

let savedToken: string | undefined;
beforeEach(() => {
  savedToken = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_AUTH_TOKEN = PARENT_TOKEN;
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
  else process.env.TWILIO_AUTH_TOKEN = savedToken;
});

/** "Twilio": the current token of each subaccount, read by the parent on demand. */
function world() {
  const tokens: Record<string, string> = { [SUB_A]: "sub-a-token-1", [SUB_B]: "sub-b-token-1" };
  const records: Record<string, WebhookAccountRecord> = {
    [SUB_A]: { found: true, legalEntityId: ENTITY_A, status: "active", studioIds: [STUDIO_A, STUDIO_A2] },
    [SUB_B]: { found: true, legalEntityId: ENTITY_B, status: "active", studioIds: [STUDIO_B] },
  };
  const clock = { t: 0 };
  let tokenReads = 0;
  let lookups = 0;
  const provider = new SubaccountTokenProvider(
    { getSubaccountToken: async (sid: string) => { tokenReads += 1; if (!tokens[sid]) throw new Error("no such account"); return tokens[sid]; } },
    { now: () => clock.t },
  );
  const deps: WebhookAccountDeps = {
    parentAccountSid: PARENT,
    lookupAccount: async (sid) => { lookups += 1; return records[sid] ?? { found: false }; },
    tokens: provider,
  };
  return { tokens, records, clock, deps, provider, tokenReads: () => tokenReads, lookups: () => lookups };
}

function signed(token: string, params: Record<string, string>, url = URL) {
  return new Request(url, { method: "POST", headers: { "x-twilio-signature": getExpectedTwilioSignature(token, url, params) } });
}

describe("verifyTwilioWebhookAccount", () => {
  it("a subaccount webhook verifies ONLY with that subaccount's own token", async () => {
    const w = world();
    const params = { AccountSid: SUB_A, MessageSid: MSG, MessageStatus: "delivered" };
    expect(await verifyTwilioWebhookAccount(signed("sub-a-token-1", params), params, w.deps)).toEqual({
      ok: true, account: { kind: "subaccount", accountSid: SUB_A, legalEntityId: ENTITY_A, studioIds: [STUDIO_A, STUDIO_A2] },
    });
    // signed with the parent token, or with another subaccount's token: forged
    for (const token of [PARENT_TOKEN, "sub-b-token-1", "not-a-token"]) {
      expect(await verifyTwilioWebhookAccount(signed(token, params), params, w.deps)).toMatchObject({ ok: false, status: 403, reason: "twilio_signature_invalid" });
    }
  });

  it("a request re-labelled with another AccountSid fails (the AccountSid is part of the signed parameters)", async () => {
    const w = world();
    const original = { AccountSid: SUB_B, MessageSid: MSG, MessageStatus: "delivered" };
    const request = signed("sub-b-token-1", original);
    const relabelled = { ...original, AccountSid: SUB_A };
    expect(await verifyTwilioWebhookAccount(request, relabelled, w.deps)).toMatchObject({ ok: false, reason: "twilio_signature_invalid" });
  });

  it("parent-account webhooks (own AccountSid, or none) keep the existing parent-token verification", async () => {
    const w = world();
    for (const params of [{ AccountSid: PARENT, MessageSid: MSG }, { MessageSid: MSG }] as Record<string, string>[]) {
      expect(await verifyTwilioWebhookAccount(signed(PARENT_TOKEN, params), params, w.deps)).toEqual({ ok: true, account: { kind: "parent" } });
      expect(await verifyTwilioWebhookAccount(signed("sub-a-token-1", params), params, w.deps)).toMatchObject({ ok: false, reason: "twilio_signature_invalid" });
    }
    expect(w.lookups()).toBe(0);
    expect(w.tokenReads()).toBe(0);
  });

  it("no signature: rejected before any lookup or token read", async () => {
    const w = world();
    const params = { AccountSid: SUB_A, MessageSid: MSG };
    expect(await verifyTwilioWebhookAccount(new Request(URL, { method: "POST" }), params, w.deps)).toMatchObject({ ok: false, status: 403, reason: "twilio_signature_missing" });
    expect(w.lookups()).toBe(0);
    expect(w.tokenReads()).toBe(0);
  });

  it("a malformed or unknown AccountSid is rejected without reading any token", async () => {
    const w = world();
    for (const sid of ["AC123", "XX" + "a".repeat(32), " ", `AC${"a".repeat(31)}g`]) {
      const params = { AccountSid: sid, MessageSid: MSG };
      const result = await verifyTwilioWebhookAccount(signed("x", params), params, w.deps);
      expect(result.ok).toBe(false);
    }
    const unknown = { AccountSid: `AC${"d".repeat(32)}`, MessageSid: MSG };
    expect(await verifyTwilioWebhookAccount(signed("x", unknown), unknown, w.deps)).toMatchObject({ ok: false, status: 403, reason: "twilio_account_unknown" });
    expect(w.tokenReads()).toBe(0);
  });

  it("a known subaccount with verification switched off, a failed lookup or an unreadable token is 503 (never accepted)", async () => {
    const w = world();
    const params = { AccountSid: SUB_A, MessageSid: MSG };
    const request = () => signed("sub-a-token-1", params);
    expect(await verifyTwilioWebhookAccount(request(), params, { ...w.deps, tokens: null })).toMatchObject({ ok: false, status: 503, reason: "twilio_subaccount_verification_disabled" });
    expect(await verifyTwilioWebhookAccount(request(), params, { ...w.deps, lookupAccount: async () => { throw new Error("db down"); } })).toMatchObject({ ok: false, status: 503, reason: "twilio_account_lookup_failed" });
    delete w.tokens[SUB_A];
    expect(await verifyTwilioWebhookAccount(request(), params, w.deps)).toMatchObject({ ok: false, status: 503, reason: "twilio_subaccount_token_unavailable" });
  });

  it("after a token rotation the first webhook signed with the NEW token verifies (one re-read); the OLD token is refused from then on", async () => {
    const w = world();
    const params = { AccountSid: SUB_A, MessageSid: MSG, MessageStatus: "sent" };
    expect((await verifyTwilioWebhookAccount(signed("sub-a-token-1", params), params, w.deps)).ok).toBe(true);
    expect(w.tokenReads()).toBe(1);
    w.tokens[SUB_A] = "sub-a-token-2"; // rotated, no overlap
    w.clock.t = 60_000;
    expect((await verifyTwilioWebhookAccount(signed("sub-a-token-2", params), params, w.deps)).ok).toBe(true);
    expect(w.tokenReads()).toBe(2);
    // old-token requests (a replay, or a callback signed just before the rotation) are refused
    expect(await verifyTwilioWebhookAccount(signed("sub-a-token-1", params), params, w.deps)).toMatchObject({ ok: false, reason: "twilio_signature_invalid" });
  });

  it("a flood of forged webhooks naming a real subaccount causes at most one parent token re-read per interval", async () => {
    const w = world();
    const params = { AccountSid: SUB_A, MessageSid: MSG };
    for (let i = 0; i < 50; i += 1) {
      expect((await verifyTwilioWebhookAccount(signed(`forged-${i}`, params), params, w.deps)).ok).toBe(false);
    }
    // the first lookup reads the token; the first failure forces one re-read; everything after is answered from cache
    expect(w.tokenReads()).toBe(2);
    w.clock.t = 31_000;
    await verifyTwilioWebhookAccount(signed("forged-late", params), params, w.deps);
    expect(w.tokenReads()).toBe(3);
  });

  it("never echoes a token in its result", async () => {
    const w = world();
    const params = { AccountSid: SUB_A, MessageSid: MSG };
    const results = [
      await verifyTwilioWebhookAccount(signed("sub-a-token-1", params), params, w.deps),
      await verifyTwilioWebhookAccount(signed("bad", params), params, w.deps),
    ];
    for (const result of results) expect(JSON.stringify(result)).not.toMatch(/sub-a-token|fake-parent-token/);
  });
});

describe("tenant isolation and parsing", () => {
  it("a subaccount acts only for the studios of its own legal business; the parent acts for any studio", () => {
    const sub = { kind: "subaccount" as const, accountSid: SUB_A, legalEntityId: ENTITY_A, studioIds: [STUDIO_A, STUDIO_A2] };
    expect(webhookMayActForStudio(sub, STUDIO_A)).toBe(true);
    expect(webhookMayActForStudio(sub, STUDIO_A2)).toBe(true);
    expect(webhookMayActForStudio(sub, STUDIO_B)).toBe(false);
    expect(webhookMayActForStudio(sub, null)).toBe(false);
    expect(webhookMayActForStudio({ kind: "parent" }, STUDIO_B)).toBe(true);
    expect(webhookMayActForStudio({ kind: "parent" }, null)).toBe(true);
  });

  it("parses the database reply defensively", () => {
    expect(parseWebhookAccountRecord({ found: true, legal_entity_id: ENTITY_A, status: "active", studio_ids: [STUDIO_A, "junk", 5] })).toEqual({
      found: true, legalEntityId: ENTITY_A, status: "active", studioIds: [STUDIO_A],
    });
    for (const raw of [null, "x", {}, { found: "true" }, { found: true, legal_entity_id: ENTITY_A, status: "closed" }, { found: true, legal_entity_id: "nope", status: "active" }]) {
      expect(parseWebhookAccountRecord(raw)).toEqual({ found: false });
    }
  });

  it("replay keys use the message SID (and the status) only", () => {
    expect(webhookReceiptKey("inbound", { MessageSid: MSG, Body: "STOP" })).toBe(MSG);
    expect(webhookReceiptKey("status", { MessageSid: MSG, MessageStatus: "Delivered" })).toBe(`${MSG}:delivered`);
    expect(webhookReceiptKey("status", { MessageSid: MSG })).toBeNull();
    expect(webhookReceiptKey("inbound", { MessageSid: "SMshort" })).toBeNull();
    expect(webhookReceiptKey("inbound", { MessageSid: `${MSG}' or 1=1` })).toBeNull();
  });
});
