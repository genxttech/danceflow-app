import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 9C: the compensation rule is saved only through the studio-scoped,
 * atomic save_instructor_compensation_rule RPC (no direct table write),
 * invalid input never reaches the RPC, RPC errors map to friendly statuses,
 * and the URL-driven detail panel shows the current rule and its history.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
  useRouter: () => ({ push: () => {} }),
}));

const requirePayrollPrepareAccess = vi.fn();

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requirePayrollPrepareAccess: () => requirePayrollPrepareAccess(),
  requirePayrollDisbursementAccess: vi.fn(),
}));

vi.mock("@/lib/compensation/earnings", () => ({
  generateInstructorEarningsForCompletedAppointments: vi.fn(),
}));

const { saveInstructorCompensationRuleAction } = await import("../actions");
const { default: CompensationPanelBody } = await import("../CompensationPanelBody");

const STUDIO = "11111111-1111-4111-8111-111111111111";
const OTHER_STUDIO = "22222222-2222-4222-8222-222222222222";
const INSTRUCTOR = "33333333-3333-4333-8333-333333333333";

let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let tableCalls: string[] = [];
let rpcResult: { data: unknown; error: { message: string } | null } = {
  data: { changed: true, change_type: "updated" },
  error: null,
};

function grant() {
  requirePayrollPrepareAccess.mockResolvedValue({
    supabase: {
      from: (table: string) => {
        tableCalls.push(table);
        throw new Error(`unexpected direct table access: ${table}`);
      },
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return rpcResult;
      },
    },
    studioId: STUDIO,
    user: { id: "user-1" },
  });
}

beforeEach(() => {
  rpcCalls = [];
  tableCalls = [];
  rpcResult = { data: { changed: true, change_type: "updated" }, error: null };
  requirePayrollPrepareAccess.mockReset();
  grant();
});

async function redirectOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    return digest.split(";")[2] ?? "";
  }
  throw new Error("expected a redirect");
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const VALID = {
  instructorId: INSTRUCTOR,
  privateLessonPayMode: "percentage",
  privateLessonPercentage: "45",
  privateLessonFlatAmount: "0",
  groupClassPayMode: "per_attendee",
  groupClassPerAttendeeAmount: "4",
  notes: "Spring rate",
};

describe("saveInstructorCompensationRuleAction", () => {
  it("saves through the studio-scoped RPC and returns to the instructor's panel", async () => {
    const target = await redirectOf(() => saveInstructorCompensationRuleAction(form(VALID)));
    expect(target).toBe(`/app/instructor-pay?compensation=${INSTRUCTOR}&status=rule_saved`);
    expect(tableCalls).toEqual([]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("save_instructor_compensation_rule");
    expect(rpcCalls[0].args).toEqual({
      p_studio_id: STUDIO,
      p_instructor_id: INSTRUCTOR,
      p_private_lesson_pay_mode: "percentage",
      p_private_lesson_flat_amount: 0,
      p_private_lesson_percentage: 45,
      p_private_lesson_duration_rates_enabled: false,
      p_private_lesson_30_min_flat_amount: 0,
      p_private_lesson_45_min_flat_amount: 0,
      p_private_lesson_60_min_flat_amount: 0,
      p_group_class_pay_mode: "per_attendee",
      p_group_class_flat_amount: 0,
      p_group_class_percentage: 0,
      p_group_class_per_attendee_amount: 4,
      p_notes: "Spring rate",
    });
  });

  it("takes the studio from the access guard, never from the form", async () => {
    await redirectOf(() => saveInstructorCompensationRuleAction(form({ ...VALID, studioId: OTHER_STUDIO, studio_id: OTHER_STUDIO })));
    expect(rpcCalls[0].args.p_studio_id).toBe(STUDIO);
  });

  it("normalizes mode-irrelevant fields before calling the RPC", async () => {
    await redirectOf(() =>
      saveInstructorCompensationRuleAction(
        form({ ...VALID, privateLessonFlatAmount: "99", groupClassFlatAmount: "88", groupClassPercentage: "77", privateLesson30MinFlatAmount: "5" }),
      ),
    );
    const args = rpcCalls[0].args;
    expect(args.p_private_lesson_flat_amount).toBe(0);
    expect(args.p_private_lesson_30_min_flat_amount).toBe(0);
    expect(args.p_group_class_flat_amount).toBe(0);
    expect(args.p_group_class_percentage).toBe(0);
  });

  it("passes duration rates for flat private lessons", async () => {
    await redirectOf(() =>
      saveInstructorCompensationRuleAction(
        form({
          instructorId: INSTRUCTOR,
          privateLessonPayMode: "flat",
          privateLessonFlatAmount: "50",
          privateLessonDurationRatesEnabled: "on",
          privateLesson30MinFlatAmount: "25",
          privateLesson45MinFlatAmount: "35",
          privateLesson60MinFlatAmount: "50",
          groupClassPayMode: "none",
        }),
      ),
    );
    expect(rpcCalls[0].args).toMatchObject({
      p_private_lesson_pay_mode: "flat",
      p_private_lesson_duration_rates_enabled: true,
      p_private_lesson_30_min_flat_amount: 25,
      p_private_lesson_45_min_flat_amount: 35,
      p_private_lesson_60_min_flat_amount: 50,
      p_notes: null,
    });
  });

  it.each([
    ["percentage above 100", { privateLessonPercentage: "101" }, "rule_invalid_percentage"],
    ["negative percentage", { privateLessonPercentage: "-1" }, "rule_negative_amount"],
    ["negative per-attendee amount", { groupClassPerAttendeeAmount: "-1" }, "rule_negative_amount"],
    ["invalid private mode", { privateLessonPayMode: "per_attendee" }, "rule_invalid_mode"],
    ["invalid group mode", { groupClassPayMode: "hourly" }, "rule_invalid_mode"],
    ["blank mode", { privateLessonPayMode: "" }, "rule_invalid_mode"],
    ["non-numeric amount", { privateLessonPercentage: "abc" }, "rule_invalid_amount"],
    ["missing required amount", { groupClassPerAttendeeAmount: "" }, "rule_missing_amount"],
    ["notes too long", { notes: "x".repeat(1001) }, "rule_notes_too_long"],
  ])("rejects %s without calling the RPC", async (_label, overrides, status) => {
    const target = await redirectOf(() => saveInstructorCompensationRuleAction(form({ ...VALID, ...overrides })));
    expect(target).toBe(`/app/instructor-pay?compensation=${INSTRUCTOR}&mode=edit&status=${status}`);
    expect(rpcCalls).toEqual([]);
    expect(tableCalls).toEqual([]);
  });

  it("requires an instructor", async () => {
    const target = await redirectOf(() => saveInstructorCompensationRuleAction(form({ ...VALID, instructorId: "" })));
    expect(target).toBe("/app/instructor-pay?status=missing_instructor");
    expect(rpcCalls).toEqual([]);
  });

  it("never puts a non-UUID instructor id into the redirect", async () => {
    const target = await redirectOf(() => saveInstructorCompensationRuleAction(form({ ...VALID, instructorId: "../../evil?x=1", privateLessonPercentage: "500" })));
    expect(target).toBe("/app/instructor-pay?status=rule_invalid_percentage");
  });

  it("reports a no-op save as unchanged", async () => {
    rpcResult = { data: { changed: false, rule_id: "r1" }, error: null };
    const target = await redirectOf(() => saveInstructorCompensationRuleAction(form(VALID)));
    expect(target).toBe(`/app/instructor-pay?compensation=${INSTRUCTOR}&status=rule_unchanged`);
  });

  it.each([
    ["Payroll access denied.", "payroll_access_denied", false],
    ["Instructor not found for this studio.", "rule_instructor_not_found", false],
    ["Compensation rule percentages must be between 0 and 100.", "rule_invalid_percentage", true],
    ["Compensation rule amounts cannot be negative.", "rule_negative_amount", true],
    ["Unsupported group class pay mode.", "rule_invalid_mode", true],
    ["permission denied for table instructor_compensation_rule_history", "rule_save_failed", true],
  ])("maps the RPC error %s to %s", async (message, status, edit) => {
    rpcResult = { data: null, error: { message } };
    const target = await redirectOf(() => saveInstructorCompensationRuleAction(form(VALID)));
    expect(target).toBe(`/app/instructor-pay?compensation=${INSTRUCTOR}${edit ? "&mode=edit" : ""}&status=${status}`);
  });

  it("fails closed when access is refused", async () => {
    requirePayrollPrepareAccess.mockRejectedValue(new Error("You do not have permission to prepare payroll."));
    const target = await redirectOf(() => saveInstructorCompensationRuleAction(form(VALID)));
    expect(target).toBe("/app/instructor-pay?status=rule_save_failed");
    expect(rpcCalls).toEqual([]);
  });
});

describe("no direct rule write remains", () => {
  const root = path.resolve(__dirname, "..");
  const actions = readFileSync(path.join(root, "actions.ts"), "utf8");
  const page = readFileSync(path.join(root, "page.tsx"), "utf8");

  it("the action does not touch the rules or history tables", () => {
    expect(actions).not.toContain("instructor_compensation_rules");
    expect(actions).not.toContain("instructor_compensation_rule_history");
    expect(actions).toContain('rpc("save_instructor_compensation_rule"');
  });

  it("the page no longer renders an inline rule form", () => {
    expect(page).not.toContain("saveInstructorCompensationRuleAction");
    expect(page).not.toContain("name=\"privateLessonPayMode\"");
  });
});

describe("compensation rule migration", () => {
  const dir = path.resolve(__dirname, "../../../../lib/supabase/migrations");
  const migration = readFileSync(path.join(dir, "20261104090000_phase9c_compensation_history.sql"), "utf8");
  const rollback = readFileSync(path.join(dir, "rollback/20261104090000_phase9c_compensation_history_rollback.sql"), "utf8");

  it("records history in the same function that writes the rule", () => {
    const fn = migration.slice(migration.indexOf("create function public.save_instructor_compensation_rule"));
    expect(fn.indexOf("update public.instructor_compensation_rules")).toBeGreaterThan(-1);
    expect(fn.indexOf("insert into public.instructor_compensation_rule_history")).toBeGreaterThan(fn.indexOf("update public.instructor_compensation_rules"));
    expect(fn).toContain("security definer");
    expect(fn).toContain("Instructor not found for this studio.");
    expect(fn).toContain("Payroll access denied.");
  });

  it("makes history append-only and closes direct rule writes", () => {
    expect(migration).toContain("Compensation rule history is immutable.");
    expect(migration).toContain("before update or delete on public.instructor_compensation_rule_history");
    expect(migration).toContain("before truncate on public.instructor_compensation_rule_history");
    expect(migration).toContain("drop policy instructor_compensation_rules_insert");
    expect(migration).toContain("drop policy instructor_compensation_rules_update");
    expect(migration).not.toMatch(/create policy [^;]*instructor_compensation_rule_history[^;]*for (insert|update|delete|all)/i);
  });

  it("validates the range checks and fails closed on legacy violations", () => {
    expect(migration).toContain("validate constraint instructor_compensation_rules_percentages_check");
    expect(migration).toContain("validate constraint instructor_compensation_rules_amounts_check");
    expect(migration).toContain("Phase 9C preflight: legacy compensation rules violate");
    expect(migration).toContain("Phase 9C postflight: range checks are not validated.");
    expect(migration.indexOf("Phase 9C preflight: legacy compensation rules violate")).toBeLessThan(
      migration.indexOf("add constraint instructor_compensation_rules_percentages_check"),
    );
  });

  it("rolls back only when no history exists", () => {
    expect(rollback).toContain("Phase 9C rollback refused");
    expect(rollback.indexOf("exists (select 1 from public.instructor_compensation_rule_history)")).toBeLessThan(
      rollback.indexOf("drop table public.instructor_compensation_rule_history"),
    );
  });
});

describe("compensation detail panel", () => {
  const history = [
    {
      id: "h2",
      change_type: "updated",
      changed_at: "2026-10-09T15:30:00Z",
      changed_by_name: "Ada Admin",
      changed_by_email: "ada@example.test",
      changed_by_role: "studio_admin",
      changed_fields: ["private_lesson_percentage"],
      previous_values: { private_lesson_pay_mode: "percentage", private_lesson_percentage: 40, group_class_pay_mode: "none" },
      new_values: { private_lesson_pay_mode: "percentage", private_lesson_percentage: 45, group_class_pay_mode: "none" },
    },
    {
      id: "h1",
      change_type: "created",
      changed_at: "2026-10-01T15:30:00Z",
      changed_by_name: "Olive Owner",
      changed_by_email: "olive@example.test",
      changed_by_role: "studio_owner",
      changed_fields: [],
      previous_values: null,
      new_values: { private_lesson_pay_mode: "percentage", private_lesson_percentage: 40, group_class_pay_mode: "none" },
    },
  ];
  const rule = {
    private_lesson_pay_mode: "percentage",
    private_lesson_percentage: 45,
    group_class_pay_mode: "per_attendee",
    group_class_per_attendee_amount: 4,
    notes: "Spring rate",
  };
  const base = {
    instructorId: INSTRUCTOR,
    rule,
    workerClassification: "contractor",
    history,
    timeZone: "America/New_York",
    editHref: `/app/instructor-pay?compensation=${INSTRUCTOR}&mode=edit`,
    viewHref: `/app/instructor-pay?compensation=${INSTRUCTOR}`,
  };
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(React.createElement(CompensationPanelBody, { ...base, ...props } as never));

  it("shows the current compensation with one obvious Edit action", () => {
    const html = render({ mode: "view" });
    expect(html).toContain("Current compensation");
    expect(html).toContain("Private lessons");
    expect(html).toContain(">45%<");
    expect(html).toContain("$4 per attendee");
    expect(html).toContain("Contractor");
    expect(html).toContain("Spring rate");
    expect(html).toContain("Edit compensation");
    expect(html).toContain(`href="${base.editHref.replaceAll("&", "&amp;")}"`);
    expect(html).not.toContain("<form");
  });

  it("lists history newest first in readable sentences with expandable details", () => {
    const html = render({ mode: "view" });
    expect(html.indexOf("Private lesson pay changed from 40% to 45%")).toBeGreaterThan(-1);
    expect(html.indexOf("Private lesson pay changed from 40% to 45%")).toBeLessThan(html.indexOf("Private lesson pay set to 40%"));
    expect(html).toContain("By Ada Admin (Admin)");
    expect(html).toContain("By Olive Owner (Owner)");
    expect(html).toContain("Full details");
    expect(html).toContain("Rule created");
    expect(html).toContain("Rule updated");
    expect(html).not.toMatch(/&quot;|\{"/);
    expect(html).not.toContain("previous_values");
  });

  it("shows a useful empty state", () => {
    expect(render({ mode: "view", history: [] })).toContain("before change history began");
    const none = render({ mode: "view", history: [], rule: null });
    expect(none).toContain("No compensation has been set up for this instructor yet");
    expect(none).toContain("Set up compensation");
    expect(none).toContain("Not configured");
  });

  it("says when history cannot be loaded", () => {
    expect(render({ mode: "view", history: [], historyUnavailable: true })).toContain("History could not be loaded");
  });

  it("edit mode shows the prefilled form posting to the save action, with Cancel back to the view", () => {
    const html = render({ mode: "edit" });
    expect(html).toContain('data-testid="compensation-edit-form"');
    expect(html).toContain(`name="instructorId" value="${INSTRUCTOR}"`);
    expect(html).toContain('name="privateLessonPayMode"');
    expect(html).toContain('name="groupClassPayMode"');
    expect(html).toContain('name="notes"');
    expect(html).toContain('value="Spring rate"');
    expect(html).toContain("Save compensation");
    expect(html).toContain("Cancel");
    expect(html).toContain(`href="${base.viewHref.replaceAll("&", "&amp;")}"`);
    expect(html).toContain('max="100"');
    // History stays visible while editing.
    expect(html).toContain("History");
  });

  it("is driven by the URL and keeps page context on close", () => {
    const root = path.resolve(__dirname, "..");
    const page = readFileSync(path.join(root, "page.tsx"), "utf8");
    const panel = readFileSync(path.join(root, "CompensationDetailPanel.tsx"), "utf8");
    expect(page).toContain('stringParam(params, "compensation")');
    expect(page).toContain('stringParam(params, "mode") === "edit"');
    // The panel opens only for an instructor of this studio (loaded with studio_id filter).
    expect(page).toContain("instructors.find((instructor) => instructor.id === requestedCompensationId)");
    // Close keeps the page filters and drops the panel/status params.
    expect(page).toContain('pageFilterParams.set("statusFilter", statusFilter)');
    expect(page).toContain('pageFilterParams.set("instructorId", instructorFilter)');
    expect(page).toContain("closeHref={compensationHref()}");
    expect(panel).toContain("router.push(closeHref");
    expect(panel).toContain("ResponsiveDetailPanel");
    // History is studio-scoped and newest first.
    expect(page).toContain('.from("instructor_compensation_rule_history")');
    expect(page).toContain('.eq("studio_id", studioId)\n        .eq("instructor_id", panelInstructor.id)'.replaceAll("\n", page.includes("\r\n") ? "\r\n" : "\n"));
    expect(page).toContain('.order("changed_at", { ascending: false })');
  });
});
