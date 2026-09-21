import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TRANSACTIONAL_FROM,
  TRANSACTIONAL_FROM_ADDRESS,
  formatFrom,
  isSystemTemplateKey,
  normalizeReplyTo,
  resolveReplyTo,
} from "@/lib/email/sender";

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("target sender", () => {
  it("defines notify@idanceflow.com as the target transactional sender", () => {
    expect(TRANSACTIONAL_FROM_ADDRESS).toBe("notify@idanceflow.com");
    expect(TRANSACTIONAL_FROM).toBe("DanceFlow <notify@idanceflow.com>");
  });

  it("formats From values and strips characters that could break the header", () => {
    expect(formatFrom()).toBe("DanceFlow <notify@idanceflow.com>");
    expect(formatFrom('Evil <x@y.com>\r\nBcc: z@y.com "', "Notify@IDanceFlow.com")).toBe(
      "Evil x@y.com Bcc: z@y.com <notify@idanceflow.com>",
    );
    expect(formatFrom("   ", "a@b.co")).toBe("a@b.co");
    expect(() => formatFrom("DanceFlow", "not-an-email")).toThrow();
    expect(() => formatFrom("DanceFlow", "a@b.com\r\nBcc: c@d.com")).toThrow();
  });
});

describe("reply-to resolution", () => {
  it("normalizes addresses like the live outbound helper", () => {
    expect(normalizeReplyTo("  Studio@Example.COM ")).toBe("studio@example.com");
    expect(normalizeReplyTo("nope")).toBeNull();
    expect(normalizeReplyTo("")).toBeNull();
    expect(normalizeReplyTo(null)).toBeNull();
  });

  it("never sets a reply-to on DanceFlow system templates", () => {
    for (const key of ["platform_admin_invite", "welcome_to_danceflow", "platform_x", "danceflow_y"]) {
      expect(isSystemTemplateKey(key)).toBe(true);
      expect(resolveReplyTo({ templateKey: key, explicit: "a@b.com", studioEmail: "c@d.com" })).toBeNull();
    }
    expect(isSystemTemplateKey("appointment_confirmed")).toBe(false);
  });

  it("prefers an explicit address, then the studio address", () => {
    expect(
      resolveReplyTo({ templateKey: "appointment_confirmed", explicit: "Signer@X.com", studioEmail: "studio@x.com" }),
    ).toBe("signer@x.com");
    expect(
      resolveReplyTo({ templateKey: "appointment_confirmed", explicit: "bad", studioEmail: "Studio@X.com" }),
    ).toBe("studio@x.com");
    expect(resolveReplyTo({ templateKey: "appointment_confirmed" })).toBeNull();
  });

  it("stays in parity with the live outbound helper source", () => {
    const outbound = read("src", "lib", "notifications", "outbound.ts");
    expect(outbound).toContain('templateKey.startsWith("platform_")');
    expect(outbound).toContain('templateKey.startsWith("danceflow_")');
    expect(outbound).toContain('templateKey === "welcome_to_danceflow"');
    expect(outbound).toContain('templateKey === "platform_admin_invite"');
    expect(outbound).toContain("/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/");
  });
});

describe("BR-3A leaves live sender behavior unchanged", () => {
  it("is not imported by any live send path", () => {
    const importers = walk(join(ROOT, "src"))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => !f.includes("__tests__") && !f.endsWith(join("lib", "email", "sender.ts")))
      .filter((f) => readFileSync(f, "utf8").includes("@/lib/email/sender"));
    expect(importers).toEqual([]);
  }, 60_000);

  it("keeps the existing From defaults untouched", () => {
    expect(read("src", "lib", "notifications", "dispatch.ts")).toContain(
      '"DanceFlow <notify@idanceflow.com>"',
    );
    expect(read("src", "app", "api", "notifications", "send", "route.ts")).toContain(
      '"DanceFlow <notifications@danceflow.app>"',
    );
  });
});
