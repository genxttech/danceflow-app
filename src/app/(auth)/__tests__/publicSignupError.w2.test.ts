import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPublicSignupErrorHref,
  publicSignupErrorCode,
  publicSignupErrorMessage,
} from "../signup/publicSignupError";

/** W-2 (D3): a failed public signup returns to the form with a visible message, not a silent reload. */
const read = (...p: string[]) =>
  readFileSync(join(process.cwd(), ...p), "utf8").replace(/\r\n/g, "\n");

describe("public signup error codes", () => {
  it("maps the action's rate-limit text and anything else to fixed codes", () => {
    expect(publicSignupErrorCode("Too many requests. Please wait 15 minutes and try again.")).toBe(
      "rate_limited",
    );
    expect(publicSignupErrorCode("Email rate limit exceeded")).toBe("send_failed");
    expect(publicSignupErrorCode("Full name and email are required.")).toBe("send_failed");
  });

  it("renders only known codes, never text from the URL", () => {
    expect(publicSignupErrorMessage("rate_limited")).toMatch(/wait/i);
    expect(publicSignupErrorMessage("send_failed")).toMatch(/could not send/i);
    expect(publicSignupErrorMessage("<script>alert(1)</script>")).toBeNull();
    expect(publicSignupErrorMessage(undefined)).toBeNull();
  });

  it("returns to the public form keeping next and email", () => {
    const href = buildPublicSignupErrorHref({
      code: "rate_limited",
      nextPath: "/events/spring-social",
      email: "dancer@example.com",
    });
    const url = new URL(href, "http://localhost");
    expect(url.pathname).toBe("/signup");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      intent: "public",
      next: "/events/spring-social",
      email: "dancer@example.com",
      error: "rate_limited",
    });
    expect(buildPublicSignupErrorHref({ code: "send_failed" })).toBe(
      "/signup?intent=public&error=send_failed",
    );
  });
});

describe("signup page wiring", () => {
  const page = read("src", "app", "(auth)", "signup", "page.tsx");
  const form = read("src", "app", "(auth)", "signup", "PublicSignup.tsx");

  it("the public action checks the signupAction result and redirects with a code", () => {
    expect(page).toContain("const result = await signupAction(formData);");
    expect(page).toContain("if (result?.error)");
    expect(page).toContain("buildPublicSignupErrorHref(");
    expect(page).toContain("action={submitPublicSignup}");
  });

  it("the business signup wrapper is unchanged", () => {
    expect(page).toContain("async function submitSignup(formData: FormData) {\n    \"use server\";\n    await signupAction(formData);\n  }");
    expect(page).toContain("<form action={submitSignup}");
  });

  it("the form shows the message in an alert above the form", () => {
    expect(form).toContain('role="alert"');
    expect(form.indexOf('role="alert"')).toBeLessThan(form.indexOf("<form action={action}"));
  });
});
