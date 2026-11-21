import fs from "fs";
import path from "path";
import { lumiConfig } from "../lumiConfig";
import { descriptorForRoute } from "../lumiScreenReporter";
import { resolveLink } from "../shared/links";
import { sanitizeScreenContext } from "../shared/screenContext";
import { parseDancerFeatures } from "@/lib/dancerFeatures";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const appDir = path.resolve(__dirname, "../../../app");

describe("LUMI flag", () => {
  it("is OFF by default and only the named word turns it on", () => {
    expect(parseDancerFeatures(undefined).has("lumiAssistant")).toBe(false);
    expect(parseDancerFeatures("").size).toBe(0);
    expect(parseDancerFeatures("wat,lumiAssistants").size).toBe(0);
    expect(parseDancerFeatures("lumiAssistant").has("lumiAssistant")).toBe(true);
    expect(parseDancerFeatures("lumiAssistant,none").size).toBe(0);
    expect(parseDancerFeatures("lumiAssistant,-lumiAssistant").size).toBe(0);
  });

  it("no build config names the flag", () => {
    const root = path.resolve(__dirname, "../../..");
    for (const f of ["eas.json", "app.json", "app.config.js"]) {
      const text = fs.readFileSync(path.join(root, f), "utf8");
      expect(text).not.toContain("DANCER_FEATURES");
      expect(text).not.toContain("lumiAssistant");
    }
  });
});

describe("LUMI config", () => {
  it("is LUMI, not ARIA", () => {
    expect(lumiConfig.name).toBe("LUMI");
    expect(JSON.stringify(lumiConfig).toLowerCase()).not.toContain("aria");
    expect(lumiConfig.flagKey).toBe("lumiAssistant");
  });

  it("every link template names a real route file", () => {
    for (const f of ["(tabs)/home.tsx", "(tabs)/schedule.tsx", "(tabs)/wallet.tsx", "discover/events/index.tsx", "events/[id].tsx"]) {
      expect(fs.existsSync(path.join(appDir, f))).toBe(true);
    }
    expect(lumiConfig.deepLinks.map((d) => d.template).sort()).toEqual(["/discover/events", "/events/[id]", "/home", "/schedule", "/wallet"]);
  });

  it("resolves the event link and rejects a bad id, extra params and unknown targets", () => {
    expect(resolveLink(lumiConfig, { target: "event", params: { id: ID }, label: "Event" })?.href).toBe(`/events/${ID}`);
    expect(resolveLink(lumiConfig, { target: "event", params: { id: "register" }, label: "x" })).toBeNull();
    expect(resolveLink(lumiConfig, { target: "wallet", params: { id: ID }, label: "x" })).toBeNull();
    expect(resolveLink(lumiConfig, { target: "settings", label: "x" })).toBeNull();
  });
});

describe("route to screen context", () => {
  it("maps Today, schedule, wallet, events list and event detail", () => {
    expect(descriptorForRoute("/home", {})).toEqual({ screenId: "today" });
    expect(descriptorForRoute("/schedule", {})).toEqual({ screenId: "schedule" });
    expect(descriptorForRoute("/wallet", {})).toEqual({ screenId: "wallet" });
    expect(descriptorForRoute("/discover/events", {})).toEqual({ screenId: "events-list" });
    expect(descriptorForRoute("/discover/events/workshops", {})).toEqual({ screenId: "events-list" });
    expect(descriptorForRoute(`/events/${ID}`, { id: ID })).toEqual({ screenId: "event-detail", entityIds: { eventId: ID } });
  });
  it("reports nothing for registration, orders, settings or the LUMI screen", () => {
    expect(descriptorForRoute(`/events/${ID}/register`, { id: ID })).toBeNull();
    expect(descriptorForRoute("/events/orders/abc", {})).toBeNull();
    expect(descriptorForRoute("/settings", {})).toBeNull();
    expect(descriptorForRoute("/lumi", {})).toBeNull();
  });
  it("the sanitizer keeps only a uuid event id", () => {
    expect(sanitizeScreenContext(lumiConfig, descriptorForRoute("/events/x", { id: "x" }))).toEqual({ screenId: "event-detail" });
  });
});
