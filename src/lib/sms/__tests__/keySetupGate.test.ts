import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import KeySetup from "@/app/platform/sms/key-setup/KeySetup";
import { signingToolEnabled } from "@/lib/sms/keySetup";

describe("key-setup challenge-signing tool is off unless deliberately switched on (issue 454)", () => {
  it("is enabled only by the exact string on", () => {
    expect(signingToolEnabled({})).toBe(false);
    expect(signingToolEnabled({ TW4_KEY_SETUP_SIGNING: "" })).toBe(false);
    expect(signingToolEnabled({ TW4_KEY_SETUP_SIGNING: "true" })).toBe(false);
    expect(signingToolEnabled({ TW4_KEY_SETUP_SIGNING: "ON" })).toBe(false);
    expect(signingToolEnabled({ TW4_KEY_SETUP_SIGNING: "1" })).toBe(false);
    expect(signingToolEnabled({ TW4_KEY_SETUP_SIGNING: "on" })).toBe(true);
  });
  it("renders no signing controls by default or when off, and keeps the key-creation tool", () => {
    for (const html of [renderToString(createElement(KeySetup)), renderToString(createElement(KeySetup, { signingEnabled: false }))]) {
      expect(html).not.toContain("Sign with the key");
      expect(html).not.toContain("Challenge (base64url");
      expect(html).toContain("Challenge signing is switched off");
      expect(html).toContain("Create key");
    }
  });
  it("renders the signing controls only when enabled", () => {
    const html = renderToString(createElement(KeySetup, { signingEnabled: true }));
    expect(html).toContain("Sign with the key");
    expect(html).not.toContain("Challenge signing is switched off");
  });
});
