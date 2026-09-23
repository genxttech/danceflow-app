import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function FakeResend() {
    return {
      emails: { send: (...args: unknown[]) => sendMock(...args) },
    };
  }),
}));

vi.mock("@/lib/security/cron", () => ({
  getCronAuthFailure: () => null,
}));

function chainable(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {
    is: () => builder,
    order: () => builder,
    limit: () => builder,
    eq: () => builder,
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function tableStub(result: { data: unknown; error: unknown } = { data: [], error: null }) {
  return { select: () => chainable(result) };
}

const fakeSupabase = {
  from: (table: string) => {
    switch (table) {
      case "studios":
      case "studio_subscriptions":
      case "organizers":
      case "event_registrations":
      case "studio_invoices":
      case "platform_error_logs":
      case "appointment_package_deduction_errors":
      case "event_payments":
      case "sms_message_logs":
        return tableStub();
      default:
        throw new Error(`Unexpected table: ${table}`);
    }
  },
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => fakeSupabase,
}));

const source = readFileSync(
  join(process.cwd(), "src/app/api/platform/daily-digest/route.ts"),
  "utf8",
);

describe("platform daily digest branding (BR-3C, source-level)", () => {
  it("no longer contains the retired #4b2e83 / #9d174d gradient", () => {
    expect(source).not.toContain("4b2e83");
    expect(source).not.toContain("9d174d");
  });

  it("uses the current EMAIL_TOKENS palette import for its own content colors", () => {
    expect(source).toContain("EMAIL_TOKENS");
    expect(source).toContain("EMAIL_TOKENS.primary");
  });

  it("subject is sanitized via the shared sanitizeEmailSubject helper", () => {
    expect(source).toMatch(/const subject = sanitizeEmailSubject\(/);
  });

  it("no longer builds internal URLs via raw NEXT_PUBLIC_SITE_URL concatenation", () => {
    expect(source).not.toContain("process.env.NEXT_PUBLIC_SITE_URL");
    expect(source).toContain('buildAppUrl("/platform")');
  });

  it("From behavior is intentionally left unchanged (sandbox fallback preserved as recorded debt)", () => {
    expect(source).toContain('process.env.PLATFORM_DIGEST_FROM ?? "DanceFlow <onboarding@resend.dev>"');
  });
});

describe("platform daily digest send-result correctness (BR-3C)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    sendMock.mockReset();
    vi.resetModules();
  });

  function setRequiredEnv() {
    process.env.RESEND_API_KEY = "test-resend-key";
    process.env.PLATFORM_ADMIN_DIGEST_EMAIL = "admin@example.test";
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example-project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  }

  it("a resolved Resend error is treated as a failure, not recorded as success", async () => {
    setRequiredEnv();
    sendMock.mockResolvedValue({ data: null, error: { message: "Simulated Resend rejection" } });

    const { GET } = await import("@/app/api/platform/daily-digest/route");
    const response = await GET(new Request("https://example.test/api/platform/daily-digest") as never);

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.ok).not.toBe(true);
    expect(body.error).toContain("Simulated Resend rejection");
  });

  it("a successful Resend send is recorded as success", async () => {
    setRequiredEnv();
    sendMock.mockResolvedValue({ data: { id: "email-123" }, error: null });

    const { GET } = await import("@/app/api/platform/daily-digest/route");
    const response = await GET(new Request("https://example.test/api/platform/daily-digest") as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  it("the sanitized subject and canonical dashboard URL are what actually get sent", async () => {
    setRequiredEnv();
    sendMock.mockResolvedValue({ data: { id: "email-123" }, error: null });

    const { GET } = await import("@/app/api/platform/daily-digest/route");
    await GET(new Request("https://example.test/api/platform/daily-digest") as never);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const sentArgs = sendMock.mock.calls[0][0];
    expect(sentArgs.subject).toContain("DanceFlow Daily Platform Digest");
    expect(sentArgs.subject.includes("\n")).toBe(false);
    expect(sentArgs.html).toContain("https://www.idanceflow.com/platform");
    expect(sentArgs.text).toContain("https://www.idanceflow.com/platform");
  });
});
