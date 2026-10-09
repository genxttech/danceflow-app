import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  resolveEffectiveSmsConsent,
  type SmsPermissionRow,
  type SmsStudioPhoneConsentRow,
} from "@/lib/sms/compliance";

/**
 * TW-2: the client SMS cards show the SAME effective state the send paths enforce. A
 * studio+phone consumer STOP must never display as "SMS allowed", even when the client's own
 * row is opted in.
 */

vi.mock("@/app/app/clients/[id]/sms-actions", () => ({ updateClientSmsConsentAction: async () => undefined }));

import { ClientSmsConsentCard } from "@/app/app/clients/[id]/ClientSmsConsentCard";
import { ClientSendSmsCard } from "@/app/app/clients/[id]/ClientSendSmsCard";

const PHONE = "+15550100123";

function permission(overrides: Partial<SmsPermissionRow> = {}): SmsPermissionRow {
  return {
    id: "perm-1",
    studio_id: "11111111-1111-4111-8111-111111111111",
    organizer_id: null,
    client_id: "33333333-3333-4333-8333-333333333333",
    organizer_contact_id: null,
    phone_e164: PHONE,
    consent_status: "opted_in",
    consent_source: "studio_staff_manual",
    consent_note: null,
    consent_at: "2026-09-01T00:00:00.000Z",
    opted_out_at: null,
    opted_out_source: null,
    created_by: null,
    updated_by: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const CONSUMER_STOP: SmsStudioPhoneConsentRow = { consent_status: "opted_out", opted_out_source: "twilio_inbound_stop" };
const STAFF_OPT_OUT: SmsStudioPhoneConsentRow = { consent_status: "opted_out", opted_out_source: "studio_staff_manual" };

function text(markup: string) {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function consentCard(permissionRow: SmsPermissionRow | null, phoneOptOuts: SmsStudioPhoneConsentRow[] = []) {
  return text(
    renderToStaticMarkup(
      createElement(ClientSmsConsentCard, {
        clientId: "33333333-3333-4333-8333-333333333333",
        studioName: "Harbor Dance Studio",
        phone: PHONE,
        permission: permissionRow,
        phoneOptOuts,
        canManage: true,
      }),
    ),
  );
}

function sendCard(permissionRow: SmsPermissionRow | null, phoneOptOuts: SmsStudioPhoneConsentRow[] = []) {
  return text(
    renderToStaticMarkup(
      createElement(ClientSendSmsCard, {
        clientId: "33333333-3333-4333-8333-333333333333",
        phone: PHONE,
        permission: permissionRow,
        phoneOptOuts,
        canManage: true,
      }),
    ),
  );
}

describe("resolveEffectiveSmsConsent (shared send/display precedence)", () => {
  it.each([
    ["client opted in + studio+phone consumer STOP", permission(), [CONSUMER_STOP], "blocked_by_text_stop"],
    ["client opted in + no opt-out", permission(), [], "allowed"],
    ["client opted in + other staff opt-out on the phone", permission(), [STAFF_OPT_OUT], "opted_out"],
    ["consumer STOP beats a staff opt-out on the same phone", permission(), [STAFF_OPT_OUT, CONSUMER_STOP], "blocked_by_text_stop"],
    ["legacy client-level consumer STOP", permission({ consent_status: "opted_out", opted_out_source: "twilio_inbound_stop" }), [], "blocked_by_text_stop"],
    ["client unknown", permission({ consent_status: "unknown", consent_at: null }), [], "consent_needed"],
    ["no consent row", null, [], "consent_needed"],
    ["no consent row + consumer STOP", null, [CONSUMER_STOP], "blocked_by_text_stop"],
  ] as const)("%s -> %s", (_name, row, rows, expected) => {
    expect(resolveEffectiveSmsConsent(row, rows)).toBe(expected);
  });
});

describe("ClientSmsConsentCard", () => {
  it("client opted in + studio+phone STOP -> blocked, never 'SMS allowed'", () => {
    const shown = consentCard(permission(), [CONSUMER_STOP]);

    expect(shown).toContain("SMS blocked — opted out by text");
    expect(shown).toContain("SMS blocked — this number opted out by text. The client must text START to resubscribe.");
    expect(shown).not.toContain("SMS allowed");
  });

  it("client opted in + no studio+phone STOP -> SMS allowed", () => {
    const shown = consentCard(permission(), []);

    expect(shown).toContain("SMS allowed");
    expect(shown).not.toContain("SMS blocked");
  });

  it("unknown / no consent -> consent needed, not allowed", () => {
    for (const row of [permission({ consent_status: "unknown", consent_at: null }), null]) {
      const shown = consentCard(row, []);
      expect(shown).toContain("SMS consent needed");
      expect(shown).not.toContain("SMS allowed");
    }
  });

  it("another studio's STOP is never passed in, so Studio A stays allowed", () => {
    // The page loads opt-outs filtered by this studio and phone (see the source check below);
    // with no Studio A opt-out the card is allowed.
    expect(consentCard(permission(), [])).toContain("SMS allowed");
  });
});

describe("ClientSendSmsCard", () => {
  it("studio+phone STOP disables sending with the START instruction", () => {
    const shown = sendCard(permission(), [CONSUMER_STOP]);

    expect(shown).toContain("SMS blocked — opted out by text");
    expect(shown).toContain("The client must text START to resubscribe.");
    expect(shown).not.toContain("SMS allowed");
  });

  it("opted in with no opt-out shows allowed", () => {
    expect(sendCard(permission(), [])).toContain("SMS allowed");
  });
});

describe("client page loads studio-scoped opt-outs for the client's phone", () => {
  const ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
  const page = readFileSync(join(ROOT, "src/app/app/clients/[id]/page.tsx"), "utf8");
  const workspace = readFileSync(join(ROOT, "src/app/app/clients/[id]/ClientCommunicationWorkspace.tsx"), "utf8");

  it("filters by this studio and the normalized client phone, opted-out rows only", () => {
    const query = page.slice(page.indexOf("const clientSmsPhone"), page.indexOf("smsPhoneOptOuts = (optOutRows"));
    expect(query).toContain('.from("sms_contact_permissions")');
    expect(query).toContain('.eq("studio_id", studioId)');
    expect(query).toContain('.eq("phone_e164", clientSmsPhone)');
    expect(query).toContain('.eq("consent_status", "opted_out")');
    expect(page).toContain("smsPhoneOptOuts={smsPhoneOptOuts}");
  });

  it("both SMS cards receive the studio+phone opt-outs", () => {
    expect(workspace.match(/phoneOptOuts=\{smsPhoneOptOuts\}/g)).toHaveLength(2);
  });
});
