import { beforeEach, describe, expect, it, vi } from "vitest";

const STUDIO = "a5200000-0000-0000-0000-00000000000a";
const OTHER = "a5200000-0000-0000-0000-00000000000b";
const T1 = "a5200000-0000-0000-0000-000000000c01";
const V1 = "a5200000-0000-0000-0000-000000000d01";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let rpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let ctx: { supabase: unknown; user: { id: string }; studioId: string; studioRole: string | null; isPlatformAdmin: boolean };

// Tables the user client may read: the config view for the signed-in studio only.
const tables: Record<string, unknown[]> = {};
function makeSupabase() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
    from(table: string) {
      const rows = tables[table] ?? [];
      const filtered = (filters: Record<string, string>) => rows.filter((r) => Object.entries(filters).every(([k, v]) => (r as Record<string, unknown>)[k] === v));
      const chain = (filters: Record<string, string>) => ({
        eq: (column: string, value: string) => chain({ ...filters, [column]: value }),
        maybeSingle: async () => ({ data: filtered(filters)[0] ?? null, error: null }),
        then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => resolve({ data: filtered(filters), error: null }),
      });
      return { select: () => chain({}) };
    },
  };
}

vi.mock("@/lib/auth/serverRoleGuard", () => ({ getCurrentUserStudioContext: async () => ctx }));

import {
  publishVersionAction,
  saveTemplateDraftAction,
  setDefaultTemplateAction,
  setIntakeEnabledAction,
  setServiceTemplateAction,
} from "../actions";
import { draftToSchema, starterDraft } from "@/lib/intake/templateSchema";

function configRows(studio = STUDIO, published = true) {
  tables.intake_settings = [{ studio_id: studio, enabled: false, enabled_at: null, default_template_id: published ? T1 : null }];
  tables.intake_templates = [{ id: T1, studio_id: studio, name: "Main", status: "active" }];
  tables.intake_template_versions = [{ id: V1, studio_id: studio, template_id: T1, version_number: 1, status: published ? "published" : "draft", published_at: null }];
  tables.intake_service_assignments = [];
}

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResult = { data: null, error: null };
  for (const key of Object.keys(tables)) delete tables[key];
  process.env.STUDENT_INTAKE_CONFIG_STUDIO_IDS = STUDIO;
  ctx = { supabase: makeSupabase(), user: { id: "u1" }, studioId: STUDIO, studioRole: "studio_owner", isPlatformAdmin: false };
  configRows();
});

describe("configuration permissions", () => {
  it.each(["front_desk", "instructor", "client", "organizer_owner", "platform_admin", null])("%s cannot change anything", async (role) => {
    ctx.studioRole = role;
    ctx.isPlatformAdmin = role === "platform_admin";
    const results = [
      await setIntakeEnabledAction(true),
      await setDefaultTemplateAction(T1),
      await setServiceTemplateAction("coaching", T1),
      await saveTemplateDraftAction("", "x", JSON.stringify(draftToSchema(starterDraft()))),
      await publishVersionAction(V1),
    ];
    for (const r of results) expect(r.ok).toBe(false);
    expect(rpcCalls).toEqual([]);
  });
  it.each(["studio_owner", "studio_admin"])("%s may configure", async (role) => {
    ctx.studioRole = role;
    expect((await setDefaultTemplateAction(T1)).ok).toBe(true);
    expect(rpcCalls[0].fn).toBe("intake_update_settings");
  });
  it("is unavailable for a studio that has not been made available, even for its owner", async () => {
    process.env.STUDENT_INTAKE_CONFIG_STUDIO_IDS = OTHER;
    const result = await setIntakeEnabledAction(false);
    expect(result).toEqual({ ok: false, error: "Student Intake is not available for this studio." });
    expect(rpcCalls).toEqual([]);
  });
  it("is unavailable when no studio has been made available (default)", async () => {
    delete process.env.STUDENT_INTAKE_CONFIG_STUDIO_IDS;
    expect((await publishVersionAction(V1)).ok).toBe(false);
    expect(rpcCalls).toEqual([]);
  });
});

describe("studio isolation", () => {
  it("always sends the signed-in user's studio, never one supplied by the caller", async () => {
    await setIntakeEnabledAction(false);
    await setServiceTemplateAction("coaching", "");
    await publishVersionAction(V1);
    expect(rpcCalls.length).toBe(3);
    for (const call of rpcCalls) expect(call.args.p_studio_id).toBe(STUDIO);
  });
  it("refuses a template that is not in the user's studio before any write", async () => {
    tables.intake_templates = [{ id: T1, studio_id: OTHER, name: "Foreign", status: "active" }];
    tables.intake_template_versions = [{ id: V1, studio_id: OTHER, template_id: T1, version_number: 1, status: "published", published_at: null }];
    expect((await setDefaultTemplateAction(T1)).ok).toBe(false);
    expect((await setServiceTemplateAction("coaching", T1)).ok).toBe(false);
    expect(rpcCalls).toEqual([]);
  });
  it("uses only the five configuration RPCs and never creates requests, responses or deliveries", async () => {
    await setIntakeEnabledAction(false);
    await setDefaultTemplateAction(T1);
    await setServiceTemplateAction("private_lesson", T1);
    rpcResult = { data: V1, error: null };
    await saveTemplateDraftAction(T1, "Main", JSON.stringify(draftToSchema(starterDraft())));
    rpcResult = { data: 2, error: null };
    await publishVersionAction(V1);
    const names = new Set(rpcCalls.map((c) => c.fn));
    expect([...names].sort()).toEqual(["intake_publish_template_version", "intake_save_template_draft", "intake_set_service_assignment", "intake_update_settings"]);
    for (const forbidden of ["intake_ensure_request", "intake_save_draft", "intake_submit_response", "intake_erase_client"]) expect(names.has(forbidden)).toBe(false);
  });
});

describe("settings behavior", () => {
  it("will not turn intake on without a default form that has a published version", async () => {
    configRows(STUDIO, false);
    const result = await setIntakeEnabledAction(true);
    expect(result.ok).toBe(false);
    expect(rpcCalls).toEqual([]);
  });
  it("turns intake on with a published default and can always turn it off", async () => {
    expect((await setIntakeEnabledAction(true)).ok).toBe(true);
    expect(rpcCalls[0]).toEqual({ fn: "intake_update_settings", args: { p_studio_id: STUDIO, p_changes: { enabled: true } } });
    configRows(STUDIO, false);
    expect((await setIntakeEnabledAction(false)).ok).toBe(true);
  });
  it("only an already-published form can become the default or be assigned to a lesson type", async () => {
    configRows(STUDIO, false);
    expect((await setDefaultTemplateAction(T1)).ok).toBe(false);
    expect((await setServiceTemplateAction("coaching", T1)).ok).toBe(false);
    expect(rpcCalls).toEqual([]);
  });
  it("accepts only the supported lesson types, and an empty form means use the default", async () => {
    expect((await setServiceTemplateAction("group_class", T1)).ok).toBe(false);
    expect((await setServiceTemplateAction("coaching", "not-a-uuid")).ok).toBe(false);
    expect(rpcCalls).toEqual([]);
    expect((await setServiceTemplateAction("coaching", "")).ok).toBe(true);
    expect(rpcCalls[0].args).toEqual({ p_studio_id: STUDIO, p_appointment_type: "coaching", p_template_id: null });
  });
});

describe("template versions", () => {
  it("saving never publishes, and invalid forms never reach the database", async () => {
    const bad = starterDraft();
    bad.sections[0].fields[0].label = "";
    const refused = await saveTemplateDraftAction("", bad.name, JSON.stringify(draftToSchema(bad)));
    expect(refused.ok).toBe(false);
    expect(rpcCalls).toEqual([]);
    expect((await saveTemplateDraftAction("", "x", "{not json")).ok).toBe(false);
    expect(rpcCalls).toEqual([]);

    rpcResult = { data: V1, error: null };
    const saved = await saveTemplateDraftAction(T1, "Main", JSON.stringify(draftToSchema(starterDraft())));
    expect(saved).toEqual({ ok: true, templateId: T1, versionId: V1 });
    expect(rpcCalls.map((c) => c.fn)).toEqual(["intake_save_template_draft"]);
    expect(rpcCalls[0].args.p_template_id).toBe(T1);
    expect(rpcCalls[0].args.p_studio_id).toBe(STUDIO);
  });
  it("creating a form passes no template id so the database allocates one", async () => {
    tables.intake_template_versions = [{ id: V1, studio_id: STUDIO, template_id: T1, version_number: 1, status: "draft", published_at: null }];
    rpcResult = { data: V1, error: null };
    const saved = await saveTemplateDraftAction("", "Fresh", JSON.stringify(draftToSchema(starterDraft())));
    expect(saved.ok).toBe(true);
    expect(rpcCalls[0].args.p_template_id).toBeNull();
  });
  it("publish passes the version id and returns the new version number", async () => {
    rpcResult = { data: 3, error: null };
    expect(await publishVersionAction(V1)).toEqual({ ok: true, versionNumber: 3 });
    expect(rpcCalls[0]).toEqual({ fn: "intake_publish_template_version", args: { p_studio_id: STUDIO, p_version_id: V1 } });
    expect((await publishVersionAction("nope")).ok).toBe(false);
  });
  it("shows database refusals written for staff and hides everything else", async () => {
    rpcResult = { data: null, error: { message: "nsi: only a draft version of this studio can be published" } };
    expect(await publishVersionAction(V1)).toEqual({ ok: false, error: "Only a draft version of this studio can be published" });
    rpcResult = { data: null, error: { message: 'relation "x" does not exist' } };
    expect(await publishVersionAction(V1)).toEqual({ ok: false, error: "Something went wrong. Nothing was changed." });
  });
});
