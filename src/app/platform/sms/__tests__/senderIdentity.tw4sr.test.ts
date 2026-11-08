import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

vi.mock("@/lib/auth/platform-assurance", async () => (await import("@/lib/auth/__tests__/stepUpDouble")).stepUpDouble());

/** TW-4F sender readiness: platform-admin actions (authorization, actor from the session, evidence never from the form) and the rendered block. */

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (name: string, value: string) => cookieJar.set(name, value) }) }));
let platformAdmin = true;
const ADMIN = "a6000000-0000-4000-8000-000000000401";
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => {
    if (!platformAdmin) throw new Error("NOT_PLATFORM_ADMIN");
    return { id: ADMIN };
  },
}));
const rpc: { fn: string; args: Record<string, unknown> }[] = [];
let rpcAnswer: (fn: string) => { data: unknown; error: unknown } = () => ({ data: {}, error: null });
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpc.push({ fn, args });
      return rpcAnswer(fn);
    },
  }),
}));

import { FakeSenderReadProvider, sharedFakeSenderReadProvider, type SenderOverviewRow } from "@/lib/sms/senderVerification";
import * as actions from "../senderActions";
import SenderIdentity from "../SenderIdentity";

const STUDIO = "a6000000-0000-4000-8000-00000000000a";
const SENDER = "b6000000-0000-4000-8000-00000000000b";
const AC = `AC${"a1".repeat(16)}`;
const MG = `MG${"b2".repeat(16)}`;
const QE = `QE${"c3".repeat(16)}`;
const PN = `PN${"d4".repeat(16)}`;

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
};
const go = async (action: (f: FormData) => Promise<unknown>, values: Record<string, string>) => {
  try {
    await action(form(values));
  } catch (error) {
    if ((error as Error).message !== "NEXT_REDIRECT") throw error;
  }
  const flash = cookieJar.get("tw4_panel_flash");
  return { url: decodeURIComponent(redirects.at(-1) ?? ""), message: flash ? (JSON.parse(flash) as { message: string }).message : "" };
};

beforeEach(() => {
  rpc.length = 0;
  redirects.length = 0;
  cookieJar.clear();
  platformAdmin = true;
  rpcAnswer = () => ({ data: {}, error: null });
  // local QA environment: the fake adapter is allowed, so verification uses the scripted fake (no network)
  vi.stubEnv("TW4_ISV_FAKE", "on");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.idanceflow.com");
  vi.stubEnv("NODE_ENV", "test");
  (sharedFakeSenderReadProvider() as FakeSenderReadProvider).calls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const row: SenderOverviewRow = {
  studioId: STUDIO, legalEntityId: "e", senderId: SENDER, status: "pending", accountSid: AC, messagingServiceSid: MG, campaignSid: QE, phoneNumberSid: PN,
  senderE164: "+15035550123", recordedAt: "2026-10-20T10:00:00Z", verificationOutcome: "failed", verificationCode: "campaign_not_verified",
  verifiedAt: "2026-10-20T11:00:00Z", verificationSource: "provider_read", ready: false,
};

describe("sender actions", () => {
  it("a non-admin is refused before any database call", async () => {
    platformAdmin = false;
    for (const [action, values] of [
      [actions.recordSenderAction, { studioId: STUDIO }], [actions.verifySenderAction, { studioId: STUDIO, senderId: SENDER }], [actions.revokeSenderAction, { studioId: STUDIO }],
    ] as const) {
      await expect(action(form(values))).rejects.toThrow("NOT_PLATFORM_ADMIN");
    }
    expect(rpc).toHaveLength(0);
  });

  it("record: the actor is the session admin, never the form; inputs are validated", async () => {
    const good = { studioId: STUDIO, messagingServiceSid: MG, campaignSid: QE, phoneNumberSid: PN, senderE164: "(503) 555-0123", reason: "Verified in the Twilio Console", actor: "evil", p_actor: "evil" };
    const result = await go(actions.recordSenderAction, good);
    expect(result.url).toContain("panel=1");
    expect(rpc).toHaveLength(1);
    expect(rpc[0]).toEqual({
      fn: "tw4_sender_record",
      args: { p_studio_id: STUDIO, p_actor: ADMIN, p_messaging_service_sid: MG, p_campaign_sid: QE, p_phone_number_sid: PN, p_sender_e164: "+15035550123", p_reason: "Verified in the Twilio Console" },
    });
    rpc.length = 0;
    expect((await go(actions.recordSenderAction, { ...good, campaignSid: "QEbad" })).url).toContain("panel_error=1");
    expect((await go(actions.recordSenderAction, { ...good, reason: "short" })).url).toContain("panel_error=1");
    expect(rpc).toHaveLength(0);
  });

  it("record: a conflict is explained in plain words without naming another business's identifiers", async () => {
    rpcAnswer = () => ({ data: null, error: { code: "23505", message: `already used ${AC}` } });
    const r = await go(actions.recordSenderAction, { studioId: STUDIO, messagingServiceSid: MG, campaignSid: QE, phoneNumberSid: PN, senderE164: "+15035550123", reason: "Verified in the Twilio Console" });
    expect(r.url).toContain("panel_error=1");
    expect(r.message).toMatch(/already in use by another/);
    expect(r.message).not.toContain(AC);
  });

  it("verify: evidence is read on the server and the form's evidence is ignored; only the checkbox is taken", async () => {
    rpcAnswer = (fn) => (fn === "tw4_sender_overview" ? { data: [{ studio_id: STUDIO, sender_id: SENDER, account_sid: AC, messaging_service_sid: MG, campaign_sid: QE, phone_number_sid: PN, sender_e164: "+15035550123" }], error: null } : { data: { outcome: "failed", code: "read_not_found:account" }, error: null });
    const r = await go(actions.verifySenderAction, {
      studioId: STUDIO, senderId: SENDER, attestedOptOut: "on", evidence: JSON.stringify({ account: { sid: AC, status: "active" } }), p_evidence: "{}", actor: "evil", outcome: "verified",
    });
    expect(r.url).toContain("panel_error=1");
    expect(r.message).toContain("read_not_found:account");
    const verify = rpc.find((c) => c.fn === "tw4_sender_verify")!;
    expect(verify.args.p_actor).toBe(ADMIN);
    expect(verify.args.p_attested_opt_out).toBe(true);
    expect(verify.args.p_source).toBe("fake");
    const evidence = verify.args.p_evidence as { account: unknown; read_errors: Array<{ resource: string; kind: string }> };
    expect(evidence.account).toBeNull(); // the unscripted fake knows nothing; the form's account claim was not used
    expect(evidence.read_errors.map((e) => e.resource)).toContain("account");
    expect(JSON.stringify(verify.args)).not.toContain("evil");
  });

  it("verify: without the checkbox the attestation is false; with reads off nothing is checked", async () => {
    rpcAnswer = (fn) => (fn === "tw4_sender_overview" ? { data: [{ studio_id: STUDIO, sender_id: SENDER, account_sid: AC, messaging_service_sid: MG, campaign_sid: QE, phone_number_sid: PN }], error: null } : { data: { outcome: "failed", code: "x" }, error: null });
    await go(actions.verifySenderAction, { studioId: STUDIO, senderId: SENDER });
    expect(rpc.find((c) => c.fn === "tw4_sender_verify")!.args.p_attested_opt_out).toBe(false);
    rpc.length = 0;
    delete process.env.TW4_ISV_FAKE;
    const off = await go(actions.verifySenderAction, { studioId: STUDIO, senderId: SENDER, attestedOptOut: "on" });
    expect(off.message).toMatch(/not enabled/);
    expect(rpc).toHaveLength(0);
  });

  it("verify is rate limited per admin and studio", async () => {
    const studio = "c6000000-0000-4000-8000-0000000000c1";
    rpcAnswer = (fn) => (fn === "tw4_sender_overview" ? { data: [{ studio_id: studio, sender_id: SENDER, account_sid: AC, messaging_service_sid: MG, campaign_sid: QE, phone_number_sid: PN }], error: null } : { data: { outcome: "failed", code: "x" }, error: null });
    let last = { url: "", message: "" };
    for (let i = 0; i < 8; i++) last = await go(actions.verifySenderAction, { studioId: studio, senderId: SENDER });
    expect(last.message).toMatch(/Too many/);
  });

  it("revoke: actor from the session, release only with the checkbox", async () => {
    await go(actions.revokeSenderAction, { studioId: STUDIO, reason: "Number left the Messaging Service", actor: "evil" });
    expect(rpc[0]).toEqual({ fn: "tw4_sender_revoke", args: { p_studio_id: STUDIO, p_actor: ADMIN, p_reason: "Number left the Messaging Service", p_release: false } });
    rpc.length = 0;
    await go(actions.revokeSenderAction, { studioId: STUDIO, reason: "Number left the Messaging Service", release: "on" });
    expect(rpc[0].args.p_release).toBe(true);
    rpc.length = 0;
    expect((await go(actions.revokeSenderAction, { studioId: STUDIO, reason: "x" })).url).toContain("panel_error=1");
    expect(rpc).toHaveLength(0);
  });
});

describe("SenderIdentity block", () => {
  const html = (r: SenderOverviewRow | null) => renderToStaticMarkup(createElement(SenderIdentity, { studioId: STUDIO, row: r }));
  it("shows identifiers, status, the last verification and not-ready", () => {
    const out = html(row);
    expect(out).toContain("Sending identity");
    expect(out).toContain("Ready: no");
    expect(out).toContain("Pending verification");
    expect(out).toContain(MG);
    expect(out).toContain(QE);
    expect(out).toContain("+15035550123");
    expect(out).toContain("failed (campaign_not_verified)");
    expect(out).toContain("Twilio reads");
    expect(out).toContain("Verify sender");
    expect(out).toContain("Revoke sender");
    expect(out).not.toContain("Record sender");
  });
  it("shows ready for an approved sender and offers re-verification", () => {
    const out = html({ ...row, status: "approved", ready: true, verificationOutcome: "verified", verificationCode: null });
    expect(out).toContain("Ready: yes");
    expect(out).toContain("Verify again");
  });
  it("offers recording when none exists or the last was revoked, and release for a revoked one", () => {
    expect(html(null)).toContain("Record sender");
    expect(html(null)).toContain("Ready: no");
    const revoked = html({ ...row, status: "revoked" });
    expect(revoked).toContain("Revoked");
    expect(revoked).toContain("Record sender");
    expect(revoked).toContain("Release identifiers");
    expect(revoked).not.toContain("Verify sender");
  });
  it("never renders form-controlled evidence fields", () => {
    expect(html(row)).not.toMatch(/name="(evidence|outcome|actor)"/);
  });
});
