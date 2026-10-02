import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTokenHashCallbackUrl,
  CALLBACK_VERIFICATION_TYPES,
} from "../verificationLink";

vi.mock("server-only", () => ({}));

const sendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

const { sendEmailVerificationLink } = await import("../verifiedEmail");

const base = { baseUrl: "https://app.example", tokenHash: "hash-1", nextPath: "/account/verify-email?next=%2Fapp" };

function typeOf(url: string | null) {
  return url ? new URL(url).searchParams.get("type") : null;
}

describe("LAUNCH-SEC-1C-A1 callback link builder", () => {
  it("allowlists exactly the two types these flows issue", () => {
    expect([...CALLBACK_VERIFICATION_TYPES]).toEqual(["signup", "magiclink"]);
  });

  it("A: a brand-new address (generator issued signup) produces type=signup", () => {
    expect(typeOf(buildTokenHashCallbackUrl({ ...base, verificationType: "signup" }))).toBe("signup");
  });

  it("B/C: existing users (generator issued magiclink) keep type=magiclink", () => {
    expect(typeOf(buildTokenHashCallbackUrl({ ...base, verificationType: "magiclink" }))).toBe("magiclink");
  });

  it.each(["recovery", "invite", "email_change_current", "email_change_new", "email", "", null, undefined, "signup&type=recovery"])(
    "F: unsupported generator type %s produces no link",
    (verificationType) => {
      expect(buildTokenHashCallbackUrl({ ...base, verificationType })).toBeNull();
    },
  );

  it("never builds a link without a token hash", () => {
    expect(buildTokenHashCallbackUrl({ ...base, tokenHash: "", verificationType: "signup" })).toBeNull();
  });

  it("H: token hash and next stay encoded; the path is the DanceFlow callback", () => {
    const url = new URL(
      buildTokenHashCallbackUrl({ ...base, tokenHash: "a+b/c=", verificationType: "signup" })!,
    );
    expect(url.origin + url.pathname).toBe("https://app.example/callback");
    expect(url.searchParams.get("token_hash")).toBe("a+b/c=");
    expect(url.searchParams.get("next")).toBe("/account/verify-email?next=%2Fapp");
    expect([...url.searchParams.keys()]).toEqual(["token_hash", "type", "next"]);
  });
});

describe("LAUNCH-SEC-1C-A1 verification email uses the generator-issued type", () => {
  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue({ data: { id: "m1" }, error: null });
    process.env.RESEND_API_KEY = "test-resend-key";
  });

  async function send(properties: Record<string, unknown>) {
    const generateLink = vi.fn(async () => ({ data: { properties }, error: null }));
    const ok = await sendEmailVerificationLink({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminClient: { auth: { admin: { generateLink } } } as any,
      email: "new-owner@example.com",
      baseUrl: "https://app.example",
      nextPath: "/get-started/complete?intent=studio",
      purpose: "signup",
    });
    return { ok, generateLink };
  }

  it("A: a brand-new owner's first email carries type=signup", async () => {
    const { ok } = await send({ hashed_token: "h", verification_type: "signup" });
    expect(ok).toBe(true);
    expect(sendMock.mock.calls[0][0].text).toContain("/callback?token_hash=h&type=signup&next=");
  });

  it("B: an existing account's email carries type=magiclink", async () => {
    await send({ hashed_token: "h", verification_type: "magiclink" });
    expect(sendMock.mock.calls[0][0].text).toContain("&type=magiclink&");
  });

  it("F: an unsupported generator type sends nothing", async () => {
    const { ok } = await send({ hashed_token: "h", verification_type: "recovery" });
    expect(ok).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("G: callers cannot choose the type; the generator is always asked for a magic link", async () => {
    const { generateLink } = await send({ hashed_token: "h", verification_type: "signup" });
    expect(generateLink).toHaveBeenCalledWith(expect.objectContaining({ type: "magiclink" }));
    const source = readFileSync(join(process.cwd(), "src/lib/auth/verifiedEmail.ts"), "utf8");
    expect(source).toContain("verificationType: data?.properties?.verification_type");
    expect(source).not.toContain("type=magiclink");
  });
});

describe("LAUNCH-SEC-1C-A1 portal invite (same root cause)", () => {
  it("a brand-new invitee's link uses the generator-issued type via the shared builder", () => {
    const source = readFileSync(join(process.cwd(), "src/app/app/clients/[id]/actions.ts"), "utf8");
    expect(source).toContain("verificationType: magicLinkData.properties?.verification_type");
    expect(source).not.toContain("type=magiclink");
  });
});
