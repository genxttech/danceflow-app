import { describe, expect, it } from "vitest";
import nextConfig from "../../../../next.config";

type Rule = { source: string; headers: { key: string; value: string }[] };

async function rules(): Promise<Rule[]> {
  return (await nextConfig.headers!()) as Rule[];
}
const header = (r: Rule, key: string) => r.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

describe("Website Embeds framing headers", () => {
  it("keeps framing protection on every page except the two embed route families", async () => {
    const all = await rules();
    const global = all.find((r) => header(r, "X-Frame-Options") === "SAMEORIGIN");
    expect(global).toBeDefined();
    expect(header(global!, "Content-Security-Policy")).toContain("frame-ancestors 'self'");

    // Next's source is path-to-regexp; this negative lookahead form translates 1:1 to a RegExp for the assertion.
    const re = new RegExp(`^${global!.source}$`);
    for (const p of ["/", "/app/settings", "/studios/x/classes", "/studios/x/classes/abc/register", "/embed/events.js", "/discover", "/api/embed/studios/x/events"]) {
      expect(re.test(p), `${p} must keep X-Frame-Options`).toBe(true);
    }
    for (const p of ["/embed/class/abc", "/embed/calendar/some-studio"]) {
      expect(re.test(p), `${p} must be frameable`).toBe(false);
    }
  });

  it("allows framing only on /embed/class and /embed/calendar, with no X-Frame-Options and a locked-down CSP otherwise", async () => {
    const all = await rules();
    for (const source of ["/embed/class/:path*", "/embed/calendar/:path*"]) {
      const r = all.find((x) => x.source === source);
      expect(r, source).toBeDefined();
      expect(header(r!, "X-Frame-Options")).toBeUndefined();
      const csp = header(r!, "Content-Security-Policy")!;
      expect(csp).toContain("frame-ancestors *");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toContain("frame-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).not.toContain("stripe");
    }
  });

  it("does not make any other rule frameable", async () => {
    const all = await rules();
    const frameable = all.filter((r) => (header(r, "Content-Security-Policy") ?? "").includes("frame-ancestors *"));
    expect(frameable.map((r) => r.source).sort()).toEqual(["/embed/calendar/:path*", "/embed/class/:path*"]);
  });
});
