import { afterEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function FakeResend() {
    return { emails: { send: (...args: unknown[]) => sendMock(...args) } };
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

async function runAction(formData: FormData) {
  const { sendSupportRequestAction } = await import("@/app/app/support/actions");
  try {
    await sendSupportRequestAction(formData);
    return { redirectedTo: null as string | null };
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    const match = digest.match(/NEXT_REDIRECT;replace;([^;]+);/);
    return { redirectedTo: match?.[1] ?? null };
  }
}

function buildForm(fields: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return formData;
}

describe("support request email (BR-3C)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    sendMock.mockReset();
    vi.resetModules();
  });

  it("sanitizes the subject (issueType is user-controlled)", async () => {
    process.env.RESEND_API_KEY = "test-key";
    sendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });

    const result = await runAction(
      buildForm({
        name: "Riley",
        email: "riley@example.test",
        issueType: "Billing question\r\nBcc: attacker@evil.test",
        message: "Help please.",
      }),
    );

    expect(result.redirectedTo).toBe("/app/support?sent=1");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const sentArgs = sendMock.mock.calls[0][0];
    expect(sentArgs.subject.includes("\n")).toBe(false);
    expect(sentArgs.subject.includes("\r")).toBe(false);
  });

  it("preserves Reply-To as the submitter's own email", async () => {
    process.env.RESEND_API_KEY = "test-key";
    sendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });

    await runAction(
      buildForm({
        name: "Riley",
        email: "riley@example.test",
        issueType: "Billing",
        message: "Help please.",
      }),
    );

    expect(sendMock.mock.calls[0][0].replyTo).toBe("riley@example.test");
  });

  it("preserves From precedence/output unchanged (OUTBOUND_EMAIL_FROM before NOTIFICATION_FROM_EMAIL)", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.OUTBOUND_EMAIL_FROM = "Outbound <outbound@example.test>";
    process.env.NOTIFICATION_FROM_EMAIL = "Notify <notify@example.test>";
    sendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });

    await runAction(
      buildForm({
        name: "Riley",
        email: "riley@example.test",
        issueType: "Billing",
        message: "Help please.",
      }),
    );

    expect(sendMock.mock.calls[0][0].from).toBe("Outbound <outbound@example.test>");
  });

  it("falls back to the default From when neither env var is set", async () => {
    process.env.RESEND_API_KEY = "test-key";
    delete process.env.OUTBOUND_EMAIL_FROM;
    delete process.env.NOTIFICATION_FROM_EMAIL;
    sendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });

    await runAction(
      buildForm({
        name: "Riley",
        email: "riley@example.test",
        issueType: "Billing",
        message: "Help please.",
      }),
    );

    expect(sendMock.mock.calls[0][0].from).toBe("DanceFlow <notify@idanceflow.com>");
  });

  it("a Resend error redirects to the send-failed error state", async () => {
    process.env.RESEND_API_KEY = "test-key";
    sendMock.mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await runAction(
      buildForm({
        name: "Riley",
        email: "riley@example.test",
        issueType: "Billing",
        message: "Help please.",
      }),
    );

    expect(result.redirectedTo).toBe("/app/support?error=send-failed");
  });
});
