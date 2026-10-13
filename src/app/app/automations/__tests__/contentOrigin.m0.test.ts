import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Marketing M-0 (D1): every producer that queues an ARIA execution or automation email stamps where its content came from,
 * so the dispatcher can tell unmodified system content of an operational template from studio-authored content (which is
 * treated as commercial). Unstamped rows fail closed to commercial, so a missing stamp can only make sending stricter.
 */
const source = readFileSync(join(process.cwd(), "src/app/app/automations/actions.ts"), "utf8");

describe("automation email queue producers stamp content origin", () => {
  it("every ARIA execution insert and draft-to-queued update stamps system content", () => {
    const ariaInserts = source.split("template_key: `aria_execution_${action.rule_key}`").length - 1;
    expect(ariaInserts).toBe(2);
    expect(source.split("payload: { content_origin: CONTENT_ORIGIN_SYSTEM },").length - 1).toBe(4);
  });

  it("legacy automation drafts and auto-sends stamp customized content when a studio template is used", () => {
    expect(source).toContain("payload: { content_origin: template ? CONTENT_ORIGIN_CUSTOMIZED : CONTENT_ORIGIN_SYSTEM },");
    expect(source).toContain("payload: { content_origin: typedTemplate ? CONTENT_ORIGIN_CUSTOMIZED : CONTENT_ORIGIN_SYSTEM },");
  });

  it("staff edits of a draft mark it customized", () => {
    expect(source).toContain("payload: { content_origin: CONTENT_ORIGIN_CUSTOMIZED },");
    expect(source).toContain("updatePayload.payload = { content_origin: CONTENT_ORIGIN_CUSTOMIZED };");
  });

  it("every outbound_deliveries insert of an automation family email carries a payload stamp", () => {
    const inserts = [...source.matchAll(/template_key: `(aria_execution|automation)_\$\{[^}]+\}`,[\s\S]{0,900}?payload: \{ content_origin/g)];
    expect(inserts.length).toBe(4);
  });
});
