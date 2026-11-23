import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../actions", () => ({
  setDefaultTemplateAction: vi.fn(),
  setIntakeEnabledAction: vi.fn(),
  setServiceTemplateAction: vi.fn(),
  saveTemplateDraftAction: vi.fn(),
  publishVersionAction: vi.fn(),
}));

import StudentIntakeWorkspace from "../StudentIntakeWorkspace";
import { shapeConfig } from "@/lib/intake/studioConfig";
import type { PreviewView } from "@/lib/intake/previewView";
import { starterDraft } from "@/lib/intake/templateSchema";

const A = "studio-a";
const noConfig = shapeConfig(A, { settings: null, templates: [], versions: [], assignments: [] });
const ready = (enabled: boolean) =>
  shapeConfig(A, {
    settings: { studio_id: A, enabled, enabled_at: enabled ? "2026-10-01T00:00:00Z" : null, default_template_id: "t" },
    templates: [{ id: "t", studio_id: A, name: "New student intake", status: "active" }],
    versions: [{ id: "v", studio_id: A, template_id: "t", version_number: 2, status: "published", published_at: "2026-10-01T00:00:00Z" }],
    assignments: [{ studio_id: A, appointment_type: "coaching", template_id: "t" }],
  });
const status = { enabled: true, enabledAt: "2026-10-01T00:00:00Z", gateAOpen: false, newObligationAllowed: true, defaultTemplateConfigured: true, assignmentCount: 0 };
const preview: PreviewView = {
  status,
  readOnly: true,
  truncated: false,
  counts: { would_create: 1, not_applicable: 1 },
  rows: [
    { appointmentId: "a1", outcome: "would_create", startsAt: "2026-10-20T15:00:00Z", appointmentType: "private_lesson", clientName: "Ada Lovelace", templateVersion: 2 },
    { appointmentId: "a2", outcome: "imported_source", startsAt: "2026-10-21T15:00:00Z", appointmentType: "private_lesson", clientName: "Grace Hopper", templateVersion: null },
  ],
};

const render = (props: Partial<Parameters<typeof StudentIntakeWorkspace>[0]>) =>
  renderToStaticMarkup(createElement(StudentIntakeWorkspace, { config: noConfig, preview: null, previewError: false, gateAOpen: false, seed: null, ...props }));

describe("Student Intake workspace", () => {
  it("shows one clear next step and the not-live notice when nothing is set up", () => {
    const html = render({});
    expect(html).toContain("Create your first intake form");
    expect(html).toContain("Student Intake is not live yet");
    expect(html).toMatch(/no invitation or email is sent/);
    expect(html).toContain("Turn Student Intake on to see which upcoming lessons would qualify");
  });
  it("disables turning on until a published default exists", () => {
    const html = render({});
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Turn on…<\/button>/);
    expect(html).toContain("Choose a default form with a published version to turn this on.");
  });
  it("offers only the supported lesson types, never group classes or unsupported controls", () => {
    const html = render({ config: ready(false) });
    for (const label of ["Private lessons", "Intro lessons", "Coaching"]) expect(html).toContain(label);
    expect(html).toContain("Group classes are not included");
    for (const unsupported of ["Re-intake", "floor", "Retention", "Surge", "Guardian assurance", "Conditional", "Send invitation"]) {
      expect(html.toLowerCase()).not.toContain(unsupported.toLowerCase());
    }
    expect(html).toContain("Turn on…");
  });
  it("renders a read-only preview with a plain-language reason for each lesson", () => {
    const html = render({ config: ready(true), preview, gateAOpen: true });
    expect(html).toContain("Preview only");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Would be asked to complete intake.");
    expect(html).toContain("Bookings that came from an import or another system never start intake on their own.");
    expect(html).toContain("Request intake manually");
    expect(html).not.toContain("not live yet");
    expect(html).toContain("Turn off");
  });
  it("says so when the preview cannot load, without hiding the settings", () => {
    const html = render({ config: ready(true), previewError: true });
    expect(html).toContain("The preview could not be loaded right now");
    expect(html).toContain("Intake forms");
  });
  it("opens the builder panel for a seeded form with accessible, bounded controls", () => {
    const html = render({ config: ready(false), seed: { templateId: "t", draft: starterDraft("New student intake"), basedOn: "published", versionNumber: 2 } });
    expect(html).toContain("Edit intake form");
    expect(html).toContain("Editing creates a new version. Version 2 stays as it is");
    expect(html).toContain("Publish…");
    expect(html).toContain("Save draft");
    expect(html).toContain("Short answer");
    expect(html).toContain("Acknowledgment (must be checked)");
  });
});
