import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * GC-S1D-3: "This and following classes" enrollment settings (application layer). The authoritative rules (broad-staff
 * authority, lineage-aware targets, cancelled / ended skips, atomic refusal, stale-count refusal, overwrite-by-design with no
 * customization preservation) live in the two database RPCs; here we prove the result parsing, the fixed-copy wording and the
 * preview summaries, the server actions (RPC routing, broad-staff gate, input hygiene, no raw database text, revalidation), the
 * apply-outcome interpretation the UI uses, and what the settings footer renders by scope.
 *
 * There is no DOM testing library, so the click sequence (choose a scope, review, confirm) cannot be simulated. The decisions
 * that control it live in pure helpers (seriesSettingsSummary, interpretSeriesSettingsApply, seriesSettingsFooterState, ...)
 * which are tested directly, and the footer is server-rendered for each scope (the scope is a controlled prop).
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  redirect: vi.fn(),
}));
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePathMock(...a) }));

const requireEditAccessMock = vi.fn();
vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireFloorRentalAppointmentAccess: vi.fn(),
  requireAppointmentEditAccess: (...a: unknown[]) => requireEditAccessMock(...a),
  requireAppointmentDeleteAccess: vi.fn(),
  requireAppointmentPaymentAccess: vi.fn(),
  requireAppointmentCreateAccess: vi.fn(),
  requireAttendanceAccess: vi.fn(),
}));

const lib = await import("@/lib/schedule/groupClassSeriesSettings");
const actions = await import("../groupClassSeriesSettingsActions");
const { default: SeriesSettingsFooter } = await import("@/components/schedule/SeriesSettingsFooter");

const APPT = "11111111-1111-4111-8111-111111111111";
const TZ = "America/New_York";

type RawClass = { idx: number; state: string };
const rawResult = (outcome: string, classes: RawClass[], updated = 0, mode = "preview") => ({
  mode,
  outcome,
  series_id: "series-1",
  anchor_index: classes[0]?.idx ?? 1,
  updated_count: updated,
  counts: {},
  classes: classes.map((c) => ({
    appointment_id: `00000000-0000-4000-8000-0000000000${String(c.idx).padStart(2, "0")}`,
    occurrence_index: c.idx,
    starts_at: `2026-11-${String(c.idx + 9).padStart(2, "0")}T23:00:00Z`,
    state: c.state,
  })),
});
const parse = (outcome: string, classes: RawClass[], updated = 0, mode = "preview") => {
  const parsed = lib.parseSeriesSettingsResult(rawResult(outcome, classes, updated, mode));
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
};
const states = (...s: string[]): RawClass[] => s.map((state, i) => ({ idx: i + 1, state }));

describe("S1D-3 result parsing", () => {
  it("parses a result and derives the counts from the classes", () => {
    const r = parse("ready", states("will_change", "will_change", "matches", "skipped_cancelled"));
    expect(r.counts).toEqual({ will_change: 2, matches: 1, skipped_cancelled: 1 });
    expect(r.classes.map((c) => c.occurrenceIndex)).toEqual([1, 2, 3, 4]);
    expect(r.updatedCount).toBe(0);
    expect(parse("updated", states("will_change"), 1, "apply").updatedCount).toBe(1);
  });

  it("an unknown class state is treated as blocking; malformed results are rejected", () => {
    const r = parse("blocked", states("will_change", "mystery"));
    expect(r.classes[1].state).toBe("blocked_other");
    expect(lib.seriesSettingsBlockers(r)).toHaveLength(1);
    const base = rawResult("ready", states("will_change"));
    for (const bad of [null, "x", { ...base, mode: "other" }, { ...base, outcome: "weird" }, { ...base, anchor_index: -1 }, { ...base, updated_count: "many" }, { ...base, classes: "no" }, { ...base, classes: [null] }]) {
      expect(lib.parseSeriesSettingsResult(bad)).toBeNull();
    }
  });
});

describe("S1D-3 error mapping and copy", () => {
  it("maps the stable database codes and nothing else; messages are fixed copy", () => {
    const m = (message: string) => lib.classifySeriesSettingsError({ message });
    expect(m("GCSD3_UNAUTHORIZED: Not authorized")).toBe("not_authorized");
    expect(m("GCSD3_NOT_FOUND: Group class not found.")).toBe("not_found");
    expect(m("GCSD3_NOT_A_SERIES_OCCURRENCE: This class is not part of a series.")).toBe("not_a_series");
    expect(m('relation "group_class_enrollment_policies" secret detail')).toBe("unknown");
    for (const failure of ["not_authorized", "not_found", "not_a_series", "unknown"] as const) {
      expect(lib.seriesSettingsFailureMessage(failure)).not.toMatch(/GCSD|relation|sql|postgres|exception/i);
    }
    expect(lib.seriesSettingsFailureMessage("not_authorized")).toContain("single class");
  });
});

describe("S1D-3 preview summaries", () => {
  it("ready: how many classes will be updated and how many already match, with the overwrite consequence stated", () => {
    const r = parse("ready", states("will_change", "will_change", "will_change", "matches", "matches", "skipped_cancelled", "skipped_ended"));
    const s = lib.seriesSettingsSummary(r);
    expect(s.tone).toBe("ready");
    expect(s.canApply).toBe(true);
    expect(s.headline).toBe("Update 3 classes");
    const text = s.details.join(" ");
    expect(text).toContain("3 classes will be updated, starting with this one.");
    expect(text).toContain("A later class with different settings will be changed to match.");
    expect(text).toContain("2 classes already match and are left as they are.");
    expect(text).toContain("1 cancelled class and 1 class that has ended will be skipped.");
    expect(text).toContain("Earlier classes are not changed.");
  });

  it("singular wording, no preserve-customization option and no override language", () => {
    const s = lib.seriesSettingsSummary(parse("ready", states("will_change", "matches")));
    expect(s.headline).toBe("Update 1 class");
    const text = [s.headline, ...s.details].join(" ");
    expect(text).toContain("1 class already matches and is left as it is.");
    expect(text).not.toMatch(/preserve|keep (the )?custom|customi[sz]|override/i);
  });

  it("no-op: everything already matches, nothing to apply", () => {
    const s = lib.seriesSettingsSummary(parse("noop", states("matches", "matches", "matches")));
    expect(s.tone).toBe("info");
    expect(s.canApply).toBe(false);
    expect(s.headline).toBe("All 3 classes from here already match these settings.");
    expect(s.details).toContain("There is nothing to change.");
  });

  it("blocked: names the unfit classes, says nothing changes, never offers apply", () => {
    const r = parse("blocked", states("will_change", "blocked_requires_funding", "skipped_cancelled"));
    const s = lib.seriesSettingsSummary(r);
    expect(s.tone).toBe("blocked");
    expect(s.canApply).toBe(false);
    const text = [s.headline, ...s.details].join(" ");
    expect(text).toContain("1 class needs attention");
    expect(text).toMatch(/nothing will be changed/i);
    expect(lib.seriesSettingsBlockers(r).map((c) => c.occurrenceIndex)).toEqual([2]);
  });

  it("nothing eligible and a stale preview are explained and cannot be applied", () => {
    const none = lib.seriesSettingsSummary(parse("no_eligible_targets", states("skipped_cancelled", "skipped_ended")));
    expect(none.headline).toBe("No following class can take these settings.");
    expect(none.canApply).toBe(false);
    const changed = lib.seriesSettingsSummary(parse("changed", states("will_change")));
    expect(changed.headline).toContain("changed since you reviewed");
    expect(changed.canApply).toBe(false);
  });

  it("per-class labels: a refused operation never labels passing classes as pending updates; skipped is never blocked", () => {
    expect(lib.seriesSettingsClassStateLabel("will_change", "ready")).toBe("Will be updated");
    expect(lib.seriesSettingsClassStateLabel("will_change", "blocked")).toContain("not updated while another class is blocked");
    expect(lib.seriesSettingsClassStateLabel("will_change", "changed")).toContain("not updated");
    expect(lib.seriesSettingsClassStateLabel("skipped_cancelled", "blocked")).toBe("Cancelled class (skipped)");
    expect(lib.isSkippedSettingsState("skipped_ended")).toBe(true);
    expect(lib.isBlockedSettingsState("skipped_ended")).toBe(false);
  });
});

describe("S1D-3 success and apply interpretation", () => {
  it("builds the done URL from numeric counts only and renders fixed banners", () => {
    const r = parse("updated", states("will_change", "will_change", "matches", "skipped_cancelled"), 2, "apply");
    expect(lib.seriesSettingsDoneUrl(`/app/schedule/${APPT}/edit`, r)).toBe(`/app/schedule/${APPT}/edit?success=series_settings_updated&count=2&left=2`);
    expect(lib.seriesSettingsBannerMessage("series_settings_updated", 2, 2)).toBe("Enrollment settings updated for 2 classes. 2 other classes were left as they were.");
    expect(lib.seriesSettingsBannerMessage("series_settings_updated", 1, 0)).toBe("Enrollment settings updated for 1 class.");
    expect(lib.seriesSettingsBannerMessage("series_settings_updated", null, null)).toBe("Enrollment settings updated for the following classes.");
    expect(lib.seriesSettingsBannerMessage("policy_saved", 1, 1)).toBeNull();
  });

  it("an applied change lands on the edit page; changed / blocked / no-op are shown; errors use fixed copy", () => {
    const base = `/app/schedule/${APPT}/edit`;
    expect(lib.interpretSeriesSettingsApply({ status: "ok", result: parse("updated", states("will_change"), 1, "apply") }, base)).toEqual({
      type: "done",
      url: `${base}?success=series_settings_updated&count=1&left=0`,
    });
    for (const outcome of ["changed", "blocked", "noop", "no_eligible_targets"]) {
      expect(lib.interpretSeriesSettingsApply({ status: "ok", result: parse(outcome, states("blocked_requires_funding"), 0, "apply") }, base).type).toBe("show");
    }
    expect(lib.interpretSeriesSettingsApply({ status: "error", message: "Nothing changed" }, base)).toEqual({ type: "error", message: "Nothing changed" });
    expect(lib.seriesSettingsExpectedCount(parse("ready", states("will_change", "will_change", "matches")))).toBe(2);
    expect(lib.seriesSettingsApplyLabel(1)).toBe("Update 1 class");
    expect(lib.seriesSettingsApplyLabel(4)).toBe("Update 4 classes");
  });

  it("the footer state: series scope only when enabled, This class is the default", () => {
    expect(lib.seriesSettingsFooterState({ seriesEnabled: false, scope: "series" })).toEqual({ showScopeChoice: false, effectiveScope: "single" });
    expect(lib.seriesSettingsFooterState({ seriesEnabled: true, scope: "single" })).toEqual({ showScopeChoice: true, effectiveScope: "single" });
    expect(lib.seriesSettingsFooterState({ seriesEnabled: true, scope: "series" })).toEqual({ showScopeChoice: true, effectiveScope: "series" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Server actions
// ---------------------------------------------------------------------------------------------------------------------
function fakeSupabase(rpc: Record<string, { data?: unknown; error?: { message: string } | null }> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    supabase: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve(rpc[name] ?? { data: null, error: null });
      },
    },
  };
}
const ctx = (supabase: unknown, studioRole = "studio_owner", isPlatformAdmin = false) => ({ supabase, studioId: "studio-1", user: { id: "u1" }, studioRole, isPlatformAdmin });
const request = { appointmentId: APPT, publiclyDiscoverable: true, selfEnrollmentAllowed: true, packageEnabled: true, membershipEnabled: false };

beforeEach(() => {
  requireEditAccessMock.mockReset();
  revalidatePathMock.mockReset();
});

describe("S1D-3 server actions", () => {
  it("previews through the preview RPC with only the occurrence and the four managed settings", async () => {
    const { supabase, calls } = fakeSupabase({ preview_group_class_series_enrollment_settings: { data: rawResult("ready", states("will_change", "matches")) } });
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    const out = await actions.previewSeriesSettingsAction(request);
    expect(out.status).toBe("ok");
    expect(calls).toEqual([
      {
        name: "preview_group_class_series_enrollment_settings",
        args: { p_appointment_id: APPT, p_publicly_discoverable: true, p_self_enrollment_allowed: true, p_package_enabled: true, p_membership_enabled: false },
      },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/studio|series_id|lineage|direct_payment/i);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("applies with the previewed count and revalidates only when the update was made", async () => {
    const { supabase, calls } = fakeSupabase({ apply_group_class_series_enrollment_settings: { data: rawResult("updated", states("will_change", "will_change"), 2, "apply") } });
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    expect((await actions.applySeriesSettingsAction(request, 2)).status).toBe("ok");
    expect(calls[0]).toEqual({
      name: "apply_group_class_series_enrollment_settings",
      args: { p_appointment_id: APPT, p_publicly_discoverable: true, p_self_enrollment_allowed: true, p_package_enabled: true, p_membership_enabled: false, p_expected_count: 2 },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/app/schedule");
    expect(revalidatePathMock).toHaveBeenCalledWith(`/app/schedule/${APPT}`);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/app/schedule/${APPT}/edit`);

    revalidatePathMock.mockReset();
    const blocked = fakeSupabase({ apply_group_class_series_enrollment_settings: { data: rawResult("blocked", states("blocked_requires_funding"), 0, "apply") } });
    requireEditAccessMock.mockResolvedValue(ctx(blocked.supabase));
    expect((await actions.applySeriesSettingsAction(request, 1)).status).toBe("ok");
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("settings are coerced to strict booleans and a bad expected count is sent as no expectation", async () => {
    const { supabase, calls } = fakeSupabase({ apply_group_class_series_enrollment_settings: { data: rawResult("updated", states("will_change"), 1, "apply") } });
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    await actions.applySeriesSettingsAction({ ...request, publiclyDiscoverable: "yes" as unknown as boolean, packageEnabled: 1 as unknown as boolean }, -2);
    await actions.applySeriesSettingsAction(request, 1.5);
    expect(calls[0].args).toMatchObject({ p_publicly_discoverable: false, p_package_enabled: false, p_expected_count: null });
    expect(calls[1].args.p_expected_count).toBeNull();
  });

  it("only broad staff reach the RPCs: the assigned instructor and other roles never do", async () => {
    for (const role of ["instructor", "independent_instructor", "student", "readonly"]) {
      const { supabase, calls } = fakeSupabase();
      requireEditAccessMock.mockResolvedValue(ctx(supabase, role));
      expect(await actions.previewSeriesSettingsAction(request)).toEqual({ status: "error", message: lib.seriesSettingsFailureMessage("not_authorized") });
      expect((await actions.applySeriesSettingsAction(request, 1)).status).toBe("error");
      expect(calls).toHaveLength(0);
    }
    for (const role of ["studio_owner", "studio_admin", "front_desk"]) {
      const { supabase, calls } = fakeSupabase({ preview_group_class_series_enrollment_settings: { data: rawResult("ready", states("will_change")) } });
      requireEditAccessMock.mockResolvedValue(ctx(supabase, role));
      expect((await actions.previewSeriesSettingsAction(request)).status).toBe("ok");
      expect(calls).toHaveLength(1);
    }
    const platform = fakeSupabase({ preview_group_class_series_enrollment_settings: { data: rawResult("ready", states("will_change")) } });
    requireEditAccessMock.mockResolvedValue(ctx(platform.supabase, "instructor", true));
    expect((await actions.previewSeriesSettingsAction(request)).status).toBe("ok");
  });

  it("a malformed occurrence id is refused before any RPC", async () => {
    const { supabase, calls } = fakeSupabase();
    requireEditAccessMock.mockResolvedValue(ctx(supabase));
    for (const appointmentId of ["", "nope", "x' or 1=1"]) {
      expect((await actions.previewSeriesSettingsAction({ ...request, appointmentId })).status).toBe("error");
    }
    expect(calls).toHaveLength(0);
  });

  it("database refusals and unexpected failures return fixed copy, never database text", async () => {
    const cases: Array<[string, string]> = [
      ["GCSD3_UNAUTHORIZED: Not authorized to change the enrollment settings of a whole series.", lib.seriesSettingsFailureMessage("not_authorized")],
      ["GCSD3_NOT_A_SERIES_OCCURRENCE: This class is not part of a series.", lib.seriesSettingsFailureMessage("not_a_series")],
      ['relation "group_class_enrollment_policies" does not exist (secret)', lib.seriesSettingsFailureMessage("unknown")],
    ];
    for (const [message, expected] of cases) {
      const { supabase } = fakeSupabase({ preview_group_class_series_enrollment_settings: { error: { message } } });
      requireEditAccessMock.mockResolvedValue(ctx(supabase));
      const out = await actions.previewSeriesSettingsAction(request);
      expect(out).toEqual({ status: "error", message: expected });
      expect(JSON.stringify(out)).not.toMatch(/secret|relation|GCSD3/);
    }
    const odd = fakeSupabase({ preview_group_class_series_enrollment_settings: { data: { nope: true } } });
    requireEditAccessMock.mockResolvedValue(ctx(odd.supabase));
    expect(await actions.previewSeriesSettingsAction(request)).toEqual({ status: "error", message: lib.seriesSettingsFailureMessage("unknown") });
    requireEditAccessMock.mockRejectedValue(new Error("boom secret"));
    expect(await actions.previewSeriesSettingsAction(request)).toEqual({ status: "error", message: lib.seriesSettingsFailureMessage("unknown") });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------------
const footer = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(SeriesSettingsFooter, {
      appointmentId: APPT,
      seriesEnabled: true,
      scope: "single",
      onScopeChange: () => undefined,
      settings: { publiclyDiscoverable: true, selfEnrollmentAllowed: false, packageEnabled: true, membershipEnabled: false },
      singleDisabled: false,
      timeZone: TZ,
      returnPath: `/app/schedule/${APPT}/edit`,
      ...props,
    } as never),
  );

describe("S1D-3 settings footer rendering", () => {
  it("without series scope (instructor, non-series or ineligible class) it is the unchanged single-class save", () => {
    const html = footer({ seriesEnabled: false, scope: "series" });
    expect(html).toContain("Save enrollment settings");
    expect(html).toContain('type="submit"');
    expect(html).not.toMatch(/Apply to|following|Review classes|series/i);
    expect(html).not.toContain('type="radio"');
  });

  it("with series scope, This class is the default and keeps the unchanged save; no preview or confirm before asking", () => {
    const html = footer({});
    expect(html).toContain("Apply to");
    expect(html).toContain("This class");
    expect(html).toContain("This and following classes");
    expect(html).toMatch(/<input type="radio" name="settingsScope" checked="" value="single"/);
    expect(html).toContain("Save enrollment settings");
    expect(html).not.toContain("Review classes");
    expect(html).not.toContain("Needs attention");
    expect(html).not.toContain("Update 0 classes");
  });

  it("the single-class save stays disabled when its own validation blocks it", () => {
    expect(footer({ singleDisabled: true })).toMatch(/<button[^>]*disabled=""[^>]*>Save enrollment settings/);
    expect(footer({ singleDisabled: false })).not.toMatch(/<button[^>]*disabled=""[^>]*>Save enrollment settings/);
  });

  it("the series scope states the overwrite consequence plainly and swaps the save for Review classes", () => {
    const html = footer({ scope: "series" });
    expect(html).toMatch(/<input type="radio" name="settingsScope" checked="" value="series"/);
    expect(html).toContain("replace the current ones on this class and every later class in the series, including any that were set differently");
    expect(html).toContain("Earlier classes are not changed");
    expect(html).toContain("cancelled or ended classes are skipped");
    expect(html).toContain("Review classes");
    expect(html).not.toContain("Save enrollment settings");
    expect(html).not.toMatch(/preserve|customi[sz]|override/i);
  });

  it("offers no portal series enrollment, no direct-payment pricing and no notification controls", () => {
    const html = footer({ scope: "series" });
    expect(html).not.toMatch(/portal|direct.?payment|price|notify|reminder|calendar|entire series/i);
  });
});
