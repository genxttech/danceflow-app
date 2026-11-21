import fs from "fs";
import path from "path";
import { render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { ariaConfig } from "../ariaConfig";
import { descriptorForRoute } from "../ariaScreenReporter";
import { resolveLink } from "../shared/links";
import { sanitizeScreenContext } from "../shared/screenContext";
import { parseStaffFeatures } from "@/lib/features";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const appDir = path.resolve(__dirname, "../../../app");

describe("ARIA flag", () => {
  it("is OFF by default, and is not one of the write words", () => {
    expect(parseStaffFeatures(undefined).has("ariaAssistant")).toBe(false);
    expect(parseStaffFeatures("none").has("ariaAssistant")).toBe(false);
    expect(parseStaffFeatures("ariaAssistant").has("ariaAssistant")).toBe(true);
    expect(parseStaffFeatures("ariaAssistant,-ariaAssistant").has("ariaAssistant")).toBe(false);
  });

  it("with the flag off, the root passes children through and never loads the assistant implementation", () => {
    jest.isolateModules(() => {
      jest.doMock("../AriaAssistantImpl", () => {
        throw new Error("AriaAssistantImpl must not load with the flag off");
      });
      const AriaAssistantRoot = jest.requireActual("../AriaAssistantRoot").makeAriaAssistantRoot(false);
      render(
        <AriaAssistantRoot>
          <Text>child</Text>
        </AriaAssistantRoot>,
      );
    });
    expect(screen.getByText("child")).toBeTruthy();
    expect(screen.toJSON()).toMatchObject({ type: "Text" });
  });
});

describe("ARIA config", () => {
  it("is ARIA, not LUMI", () => {
    expect(ariaConfig.name).toBe("ARIA");
    expect(JSON.stringify(ariaConfig).toLowerCase()).not.toContain("lumi");
    expect(ariaConfig.flagKey).toBe("ariaAssistant");
  });

  it("every link template names a real route file, and none is a write route", () => {
    const routeFiles = ["(tabs)/today.tsx", "(tabs)/pulse.tsx", "(tabs)/clients.tsx", "clients/[id].tsx", "appointments/[id].tsx"];
    for (const f of routeFiles) expect(fs.existsSync(path.join(appDir, f))).toBe(true);
    const templates = ariaConfig.deepLinks.map((d) => d.template.split("?")[0]).sort();
    expect(templates).toEqual(["/appointments/[id]", "/clients", "/clients/[id]", "/pulse", "/today"]);
    expect(ariaConfig.deepLinks.some((d) => /new|note|attend|roster/.test(d.template))).toBe(false);
  });

  it("resolves detail links with both ids and rejects a missing or malformed studioId", () => {
    expect(resolveLink(ariaConfig, { target: "client", params: { id: ID, studioId: ID }, label: "Client" })?.href).toBe(`/clients/${ID}?studioId=${ID}`);
    expect(resolveLink(ariaConfig, { target: "client", params: { id: ID }, label: "Client" })).toBeNull();
    expect(resolveLink(ariaConfig, { target: "client", params: { id: ID, studioId: "x&y=1" }, label: "Client" })).toBeNull();
    expect(resolveLink(ariaConfig, { target: "pulse", label: "Pulse" })?.href).toBe("/pulse");
  });
});

describe("route to screen context", () => {
  it("maps the five initial screens", () => {
    expect(descriptorForRoute("/today", {})).toEqual({ screenId: "today" });
    expect(descriptorForRoute("/pulse", {})).toEqual({ screenId: "pulse" });
    expect(descriptorForRoute("/clients", {})).toEqual({ screenId: "clients" });
    expect(descriptorForRoute(`/clients/${ID}`, { id: ID, studioId: ID })).toEqual({ screenId: "client-detail", entityIds: { clientId: ID, studioId: ID } });
    expect(descriptorForRoute(`/appointments/${ID}`, { id: ID, studioId: ID })).toEqual({ screenId: "appointment-detail", entityIds: { appointmentId: ID, studioId: ID } });
  });
  it("reports nothing for other routes (More, new client, sign-in)", () => {
    expect(descriptorForRoute("/more", {})).toBeNull();
    expect(descriptorForRoute("/clients/new", {})).toBeNull();
    expect(descriptorForRoute("/sign-in", {})).toBeNull();
  });
  it("the sanitizer keeps only uuid ids and drops anything else a route could carry", () => {
    const raw = descriptorForRoute("/clients/not-a-uuid", { id: "not-a-uuid", studioId: ID, name: "Pat" } as never);
    expect(sanitizeScreenContext(ariaConfig, raw)).toEqual({ screenId: "client-detail", entityIds: { studioId: ID } });
  });
});
