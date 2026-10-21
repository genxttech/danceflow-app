import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../senderActions", () => ({ recordSenderAction: async () => {}, revokeSenderAction: async () => {}, verifySenderAction: async () => {} }));

import { parseSenderHealth, type SenderOverviewRow } from "@/lib/sms/senderVerification";
import SenderIdentity, { SenderSchedulerLine } from "../SenderIdentity";

const STUDIO = "a6000000-0000-4000-8000-00000000000a";
const SENDER = "b6000000-0000-4000-8000-00000000000b";
const overview: SenderOverviewRow = {
  studioId: STUDIO, legalEntityId: "e", senderId: SENDER, status: "approved", accountSid: "AC1", messagingServiceSid: "MG1", campaignSid: "QE1", phoneNumberSid: "PN1",
  senderE164: "+15035550123", recordedAt: null, verificationOutcome: "verified", verificationCode: null, verifiedAt: "2026-10-20T01:00:00Z", verificationSource: "provider_read", ready: true,
};
const health = (over: Record<string, unknown>) => parseSenderHealth({
  senders: [{ studio_id: STUDIO, sender_id: SENDER, status: "approved", state: "ready", last_success_at: "2026-10-20T01:00:00Z", expires_at: "2026-10-21T01:00:00Z", next_check_at: "2026-10-20T21:00:00Z", retries_since_success: 0, ...over }],
}).senders[0];
const html = (h: ReturnType<typeof health> | null) => renderToStaticMarkup(createElement(SenderIdentity, { studioId: STUDIO, row: overview, health: h }));
const GREEN = "bg-emerald-50";

describe("SenderIdentity with health", () => {
  it("ready and expiring are green and show the trust window in UTC", () => {
    const ready = html(health({}));
    expect(ready).toContain(GREEN);
    expect(ready).toContain("2026-10-21 01:00 UTC");
    expect(ready).toContain("2026-10-20 21:00 UTC");
    expect(ready).toContain("Re-check now");
    expect(html(health({ state: "expiring" }))).toContain(GREEN);
  });

  it("expired, failed, pending and blocked are never green, and say what to do", () => {
    const expired = html(health({ state: "expired", retries_since_success: 2 }));
    expect(expired).not.toContain(GREEN);
    expect(expired).toContain("Blocked: verification expired");
    expect(expired).toContain("Re-check now");
    expect(expired).toContain("Retries since last success");
    const failed = html(health({ state: "failed", decisive_code: "campaign_not_verified" }));
    expect(failed).not.toContain(GREEN);
    expect(failed).toContain("Fix it in Twilio, then Verify");
    expect(failed).not.toContain("Re-check now");
    expect(html(health({ state: "failed", decisive_code: "service_not_on_account" }))).toContain("investigate before verifying");
    for (const state of ["pending", "blocked"]) expect(html(health({ state }))).not.toContain(GREEN);
  });

  it("missing health is never green and says the status is unavailable", () => {
    const out = html(null);
    expect(out).not.toContain(GREEN);
    expect(out).toContain("verification status unavailable");
    expect(out).toContain("Verify again");
  });
});

describe("SenderSchedulerLine", () => {
  it("alerts when stale and shows non-zero counts", () => {
    const stale = renderToStaticMarkup(createElement(SenderSchedulerLine, { scheduler: parseSenderHealth({ scheduler: { stale: true, expired: 2 } }).scheduler }));
    expect(stale).toContain("Sender re-checks are not running: approved senders will stop sending when their 24-hour verification lapses");
    expect(stale).toContain("2 expired");
    const fine = renderToStaticMarkup(createElement(SenderSchedulerLine, { scheduler: parseSenderHealth({ scheduler: { stale: false, last_completed_at: "2026-10-20T02:00:00Z" } }).scheduler }));
    expect(fine).not.toContain("not running");
    expect(fine).toContain("2026-10-20 02:00 UTC");
  });
});
