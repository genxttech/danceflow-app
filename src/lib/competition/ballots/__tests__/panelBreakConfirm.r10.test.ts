import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BallotBoard } from "../status";
import { ballotErrorMessage } from "../messages";

/**
 * R-10 panel-break confirmation. The app must (1) keep sending the original five arguments unless the user explicitly
 * confirmed, so it can be deployed before the database migration, and (2) offer that confirmation only for the judge whose
 * change the database refused.
 */

const ROUND = "11111111-1111-4111-8111-111111111111";
const JUDGE_A = "22222222-2222-4222-8222-222222222222";
const JUDGE_B = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const EVENT = "55555555-5555-4555-8555-555555555555";
const RETURN = `/app/events/${EVENT}/competition/ballots/${ROUND}`;
// The database message from migration 20270301102000.
const REFUSAL =
  "COMP_PANEL_BREAK_CONFIRM_REQUIRED: recording this change leaves 4 present judge(s); this scoring method needs at least 3 and an odd panel, so the round could not lock its ballots. Confirm to record it and keep a panel recovery case.";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  error: null as { message: string; code?: string } | null,
  board: null as unknown,
}));

const supabase = {
  auth: { getUser: async () => ({ data: { user: { id: "u" } } }) },
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "competition_round_ballot_status") return { data: state.board, error: null };
    if (name === "competition_round_floor_entries") return { data: null, error: null };
    state.calls.push({ name, args });
    return { data: null, error: state.error };
  },
  from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: ROUND } }) }) }) }) }),
};

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/competition/finalsGate", () => ({ requireCompetitionFinals: () => undefined }));
vi.mock("@/lib/competition/officials/judgingAccess", () => ({ requireJudgingRound: async () => undefined, requireJudgingEvent: async () => undefined }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }));
vi.mock("@/lib/competition/workspaceServer", () => ({ requireCompetitionWorkspace: async () => ({ supabase }) }));

function board(): BallotBoard {
  const judge = (official_id: string, judge_letter: string) => ({ official_id, judge_letter, official_status: "active", name: `Judge ${judge_letter}`, absent: false, ballots: [] });
  return {
    viewer_role: "manager",
    round: { id: ROUND, name: "Final", status: "active", scoring_method: "ordinal_majority" },
    scheme_available: false,
    callback_target: null,
    callback_entries: null,
    heats: [],
    judges: [judge(JUDGE_A, "A"), judge(JUDGE_B, "B")],
    blockers: { heats: [], heats_not_locked: [], missing_ballots: [], judges: 2, judges_present: 2, panel_min: 3, panel_odd_required: true, panel_ok: false, ready: false },
  };
}

async function submit(extra: Record<string, string> = {}) {
  const { recordAttendanceAction } = await import("@/app/app/events/[id]/competition/ballots/actions");
  const form = new FormData();
  for (const [key, value] of Object.entries({ roundId: ROUND, officialId: JUDGE_A, requestId: REQUEST, status: "absent", reason: "left early", returnTo: RETURN, ...extra })) form.set(key, value);
  const thrown = await recordAttendanceAction(form).then(
    () => "",
    (error: Error) => error.message,
  );
  expect(thrown.startsWith("REDIRECT ")).toBe(true);
  return new URL(thrown.slice("REDIRECT ".length), "https://app.test");
}

/** The attendance form of one judge, from rendered markup. */
function formOf(html: string, officialId: string) {
  const form = html.split("<form").find((part) => part.includes(`value="${officialId}"`) && part.includes('name="status"'));
  if (!form) throw new Error("form not found");
  return form.split("</form>")[0];
}

beforeEach(() => {
  state.calls = [];
  state.error = null;
  state.board = board();
});

describe("recordAttendanceAction", () => {
  const FIVE = ["p_official_id", "p_reason", "p_request_id", "p_round_id", "p_status"];

  it.each(["absent", "present"])("sends only the original five arguments for an unconfirmed %s change", async (status) => {
    const url = await submit({ status });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].name).toBe("record_competition_judge_attendance");
    expect(Object.keys(state.calls[0].args).sort()).toEqual(FIVE);
    expect(url.searchParams.get("saved")).toBeTruthy();
    expect(url.searchParams.has("confirmJudge")).toBe(false);
  });

  it("adds the confirmation flag only for the exact checkbox value", async () => {
    await submit({ confirmPanelBreak: "1" });
    expect(state.calls[0].args.p_confirm_panel_break).toBe(true);
    for (const value of ["", "0", "true", "on", "yes"]) {
      state.calls = [];
      await submit({ confirmPanelBreak: value });
      expect(Object.keys(state.calls[0].args).sort()).toEqual(FIVE);
    }
  });

  it("returns a refused panel break for confirmation without retrying or confirming by itself", async () => {
    state.error = { message: REFUSAL, code: "P0001" };
    const url = await submit();
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].args).not.toHaveProperty("p_confirm_panel_break");
    expect(url.pathname).toBe(RETURN);
    expect(url.searchParams.get("confirmJudge")).toBe(JUDGE_A);
    expect(url.searchParams.get("error")).toBe(ballotErrorMessage(REFUSAL));
    expect(url.searchParams.get("error")).toContain("Nothing was saved");
    expect(url.toString()).not.toContain("left+early");
  });

  it("does not offer confirmation for any other refusal", async () => {
    state.error = { message: "COMP_ABSENCE_HAS_BALLOTS: the judge already has ballots", code: "P0001" };
    const url = await submit();
    expect(url.searchParams.get("error")).toContain("already has ballots");
    expect(url.searchParams.has("confirmJudge")).toBe(false);
  });
});

describe("attendance confirmation on the ballot desk", () => {
  const checkbox = 'name="confirmPanelBreak"';

  it("shows no confirmation until the database asks for one", async () => {
    const { default: BallotDesk } = await import("@/app/app/events/[id]/competition/ballots/BallotDesk");
    expect(renderToStaticMarkup(createElement(BallotDesk, { board: board(), returnTo: RETURN }))).not.toContain(checkbox);
  });

  it("requires a tick on the refused judge's form only", async () => {
    const { default: BallotDesk } = await import("@/app/app/events/[id]/competition/ballots/BallotDesk");
    const html = renderToStaticMarkup(createElement(BallotDesk, { board: board(), returnTo: RETURN, confirmBreakOfficialId: JUDGE_B }));
    expect(html.split(checkbox)).toHaveLength(2);
    const confirm = formOf(html, JUDGE_B);
    // Assert on the checkbox tag itself: the same form has other required inputs.
    const tag = confirm.match(/<input[^>]*name="confirmPanelBreak"[^>]*>/)?.[0] ?? "";
    expect(tag).toContain('type="checkbox"');
    expect(tag).toContain('value="1"');
    expect(tag).toContain('required=""');
    expect(tag).not.toContain("checked");
    expect(formOf(html, JUDGE_A)).not.toContain(checkbox);
  });

  it("passes the refused judge from both desk pages", async () => {
    const manager = (await import("@/app/app/events/[id]/competition/ballots/[roundId]/page")).default;
    const official = (await import("@/app/app/judging/[eventId]/rounds/[roundId]/ballot/desk/page")).default;
    const searchParams = Promise.resolve({ confirmJudge: JUDGE_A });
    for (const element of [
      await manager({ params: Promise.resolve({ id: EVENT, roundId: ROUND }), searchParams }),
      await official({ params: Promise.resolve({ eventId: EVENT, roundId: ROUND }), searchParams }),
    ]) {
      const html = renderToStaticMarkup(element);
      expect(formOf(html, JUDGE_A)).toContain(checkbox);
      expect(formOf(html, JUDGE_B)).not.toContain(checkbox);
    }
  });
});
