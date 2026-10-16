import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let rpcResult: { data: unknown; error: { code: string } | null } = { data: null, error: null };
let adminThrows = false;

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never) }));
vi.mock("@/components/public/PublicShell", () => ({ default: ({ children }: { children: unknown }) => createElement("div", null, children as never) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminThrows) throw new Error("no admin client");
    return { rpc: async (fn: string, args: Record<string, unknown>) => { rpcCalls.push({ fn, args }); return rpcResult; } };
  },
}));

import SmsLegalPage, { loadSmsLegalDocument } from "../SmsLegalPage";

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResult = { data: { display_name: "Harbor Dance", legal_name: "Harbor Dance Studio LLC" }, error: null };
  adminThrows = false;
});

describe("studio SMS legal pages", () => {
  it("renders only for a studio the database returns a context for (the pilot switch is on)", async () => {
    const loaded = await loadSmsLegalDocument("harbor-dance", "terms");
    expect(rpcCalls).toEqual([{ fn: "get_sms_legal_context", args: { p_studio_slug: "harbor-dance" } }]);
    expect(loaded.document.title).toBe("Harbor Dance SMS Terms");
    expect(loaded.displayName).toBe("Harbor Dance");
  });
  it("is a 404 when the studio is unknown, switched off, the lookup fails, or the admin client is unavailable", async () => {
    rpcResult = { data: null, error: null };
    await expect(loadSmsLegalDocument("nope", "terms")).rejects.toThrow("NEXT_NOT_FOUND");
    rpcResult = { data: null, error: { code: "42883" } }; // function missing: migration not applied
    await expect(loadSmsLegalDocument("harbor-dance", "privacy")).rejects.toThrow("NEXT_NOT_FOUND");
    adminThrows = true;
    await expect(loadSmsLegalDocument("harbor-dance", "privacy")).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("terms and privacy pages render the required statements and link to each other, with no identifiers", async () => {
    for (const kind of ["terms", "privacy"] as const) {
      const loaded = await loadSmsLegalDocument("harbor-dance", kind);
      const html = renderToStaticMarkup(createElement(SmsLegalPage, { studioSlug: "harbor-dance", kind, document: loaded.document, version: loaded.version, effectiveDate: loaded.effectiveDate }));
      expect(html).toContain("Harbor Dance");
      expect(html).toContain("GenX TotalTech LLC");
      expect(html).toContain("Reply STOP");
      expect(html).toContain(kind === "terms" ? "/studios/harbor-dance/sms-privacy" : "/studios/harbor-dance/sms-terms");
      expect(html).toContain("/sms-consent");
      expect(html).not.toMatch(/\b(?:BU|BN|MG|QE|PN)[0-9a-f]{32}\b|\bEIN\b/i);
    }
  });
});
