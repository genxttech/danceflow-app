import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TW-4A boundary: this slice never calls Twilio, never sends SMS or email, and never reads provider credentials.
 * These source scans cover every file the slice adds or changes on the application side.
 */

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

const SLICE_FILES = [
  ...walk(join(SRC, "lib", "sms", "onboarding")),
  ...walk(join(SRC, "app", "app", "settings", "sms")),
  ...walk(join(SRC, "app", "api", "cron", "sms-onboarding-purge")),
  join(SRC, "app", "studios", "[studioSlug]", "SmsLegalPage.tsx"),
  join(SRC, "app", "studios", "[studioSlug]", "sms-terms", "page.tsx"),
  join(SRC, "app", "studios", "[studioSlug]", "sms-privacy", "page.tsx"),
  join(SRC, "app", "platform", "sms", "SmsOnboardingPilot.tsx"),
];

describe("TW-4A makes no provider calls", () => {
  it("covers the files it should", () => {
    expect(SLICE_FILES.length).toBeGreaterThan(12);
  });
  it.each(SLICE_FILES.map((file) => [file.replace(SRC, "src"), file]))("%s has no network, SMS, email or credential access", (_name, file) => {
    const code = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/api\.twilio\.com|trusthub|messaging\.twilio|events\.twilio/i);
    expect(code).not.toMatch(/sendTwilioSms|messages\.create|\/Messages\.json/);
    expect(code).not.toMatch(/TWILIO_(ACCOUNT_SID|AUTH_TOKEN|API_KEY)/);
    expect(code).not.toMatch(/from "twilio"|require\("twilio"\)/);
    expect(code).not.toMatch(/resend|sendEmail|sendTransactional|outbound_deliveries/i);
  });
  it("the platform action only edits the pilot switch (no registration write)", () => {
    const actions = read(join(SRC, "app", "platform", "sms", "actions.ts"));
    const added = actions.slice(actions.indexOf("export async function setSmsOnboardingAccessAction"));
    expect(added).toContain("setPilotAccess");
    expect(added).not.toMatch(/studio_sms_registrations|\.from\(/);
  });
  it("the sending, consent, inbound and status code paths are untouched by this slice", () => {
    for (const file of [
      join(SRC, "lib", "sms", "twilio.ts"),
      join(SRC, "lib", "sms", "studioSender.ts"),
      join(SRC, "lib", "sms", "twilioWebhook.ts"),
      join(SRC, "lib", "sms", "inboundKeywords.ts"),
      join(SRC, "lib", "sms", "publicConsent.ts"),
      join(SRC, "app", "api", "sms", "twilio", "inbound", "route.ts"),
      join(SRC, "app", "api", "sms", "twilio", "status", "route.ts"),
      join(SRC, "app", "api", "sms", "send", "route.ts"),
    ]) {
      expect(read(file)).not.toMatch(/studio_sms_onboarding|sms\/onboarding/);
    }
  });
});
