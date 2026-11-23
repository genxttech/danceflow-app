import { describe, expect, it } from "vitest";
import { canTurnOn, nextAction, shapeConfig, type TemplateRow, type VersionRow } from "@/lib/intake/studioConfig";

const A = "studio-a";
const B = "studio-b";
const tpl = (id: string, studio: string, name = id, status: "active" | "archived" = "active"): TemplateRow => ({ id, studio_id: studio, name, status });
const ver = (id: string, studio: string, template: string, n: number, status: VersionRow["status"]): VersionRow => ({
  id,
  studio_id: studio,
  template_id: template,
  version_number: n,
  status,
  published_at: status === "published" ? "2026-10-01T00:00:00Z" : null,
});
const settings = (studio: string, enabled: boolean, def: string | null) => ({
  studio_id: studio,
  enabled,
  enabled_at: enabled ? "2026-10-01T00:00:00Z" : null,
  default_template_id: def,
});

describe("shapeConfig", () => {
  it("never mixes another studio's rows into the view", () => {
    const view = shapeConfig(A, {
      settings: settings(B, true, "tb"),
      templates: [tpl("ta", A), tpl("tb", B)],
      versions: [ver("va", A, "ta", 1, "published"), ver("vb", B, "tb", 1, "published")],
      assignments: [{ studio_id: B, appointment_type: "coaching", template_id: "tb" }],
    });
    expect(view.enabled).toBe(false);
    expect(view.defaultTemplateId).toBeNull();
    expect(view.templates.map((t) => t.id)).toEqual(["ta"]);
    expect(view.assignments.coaching).toBeNull();
  });
  it("tracks the highest published version, the open draft, defaults and lesson-type use", () => {
    const view = shapeConfig(A, {
      settings: settings(A, true, "t1"),
      templates: [tpl("t1", A, "Main")],
      versions: [ver("v1", A, "t1", 1, "published"), ver("v2", A, "t1", 2, "published"), ver("v3", A, "t1", 3, "draft")],
      assignments: [
        { studio_id: A, appointment_type: "coaching", template_id: "t1" },
        { studio_id: A, appointment_type: "event", template_id: "t1" },
      ],
    });
    const t = view.templates[0];
    expect(t.publishedVersion?.number).toBe(2);
    expect(t.draftVersion?.number).toBe(3);
    expect(t.isDefault).toBe(true);
    expect(t.assignedTypes).toEqual(["coaching"]);
  });
});

describe("nextAction / canTurnOn (one obvious next step)", () => {
  const empty = () => shapeConfig(A, { settings: null, templates: [], versions: [], assignments: [] });
  it("walks create, publish, choose default, turn on, review", () => {
    expect(nextAction(empty()).kind).toBe("create_template");
    const draftOnly = shapeConfig(A, { settings: null, templates: [tpl("t", A)], versions: [ver("v", A, "t", 1, "draft")], assignments: [] });
    expect(nextAction(draftOnly).kind).toBe("publish_template");
    const published = shapeConfig(A, { settings: null, templates: [tpl("t", A)], versions: [ver("v", A, "t", 1, "published")], assignments: [] });
    expect(nextAction(published).kind).toBe("choose_default");
    const defaulted = shapeConfig(A, { settings: settings(A, false, "t"), templates: [tpl("t", A)], versions: [ver("v", A, "t", 1, "published")], assignments: [] });
    expect(nextAction(defaulted).kind).toBe("turn_on");
    const on = shapeConfig(A, { settings: settings(A, true, "t"), templates: [tpl("t", A)], versions: [ver("v", A, "t", 1, "published")], assignments: [] });
    expect(nextAction(on).kind).toBe("review_preview");
  });
  it("cannot be turned on without a published default; archived templates do not count", () => {
    expect(canTurnOn(empty())).toBe(false);
    const draftDefault = shapeConfig(A, { settings: settings(A, false, "t"), templates: [tpl("t", A)], versions: [ver("v", A, "t", 1, "draft")], assignments: [] });
    expect(canTurnOn(draftDefault)).toBe(false);
    const archived = shapeConfig(A, { settings: settings(A, false, "t"), templates: [tpl("t", A, "t", "archived")], versions: [ver("v", A, "t", 1, "published")], assignments: [] });
    expect(canTurnOn(archived)).toBe(false);
  });
});
