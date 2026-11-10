import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OJ-1 (owner decision 2026-11-10): a user who is only on an organizer team may open the judging pages ONLY with an active official assignment
 * (judge / chair / scorer) for THAT event. Organizer-team membership alone grants nothing. The authority is E1's
 * my_competition_judging_assignments() (own, active, verified, team member) and E2's round-keyed RPCs; studio staff keep the existing path.
 */

const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_TENANT_EVENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ROUND_A1 = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const ROUND_A2 = "a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2";
const ROUND_B1 = "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1";
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

type Assignment = { event_id: string; official_role: string; round_id: string | null; judge_letter?: string | null };
const state: {
  studioRole: unknown;
  platformRole: string | null;
  assignments: Assignment[] | null;
  deskRole: Record<string, string>;
  rpcCalls: string[];
} = { studioRole: null, platformRole: null, assignments: [], deskRole: {}, rpcCalls: [] };

const fakeSupabase = {
  auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  rpc: async (name: string, args: Record<string, unknown>) => {
    state.rpcCalls.push(name);
    if (name === "my_competition_judging_assignments") {
      return state.assignments === null ? { data: null, error: { message: "boom" } } : { data: state.assignments, error: null };
    }
    if (name === "competition_round_ballot_status") {
      const role = state.deskRole[String(args.p_round_id)];
      return role ? { data: { viewer_role: role }, error: null } : { data: null, error: { message: "COMP_FORBIDDEN: not allowed." } };
    }
    return { data: null, error: null };
  },
};

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase }));
vi.mock("@/lib/auth/platform", () => ({
  requireAuthenticatedUser: async () => ({ id: "user-1", platform_role: state.platformRole }),
}));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioRole: async () => state.studioRole }));

beforeEach(() => {
  state.studioRole = null;
  state.platformRole = null;
  state.assignments = [];
  state.deskRole = {};
  state.rpcCalls.length = 0;
  process.env.COMPETITION_FINALS_ENABLED = "true";
});

async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "allowed";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("OJ-1 viewer and layout decision", () => {
  it("an organizer-only member with no assignment is refused everywhere (organizer membership alone grants nothing)", async () => {
    const { resolveJudgingViewer, judgingLayoutDecision, requireJudgingEvent } = await import("@/lib/competition/officials/judgingAccess");
    const viewer = await resolveJudgingViewer(fakeSupabase as never);
    expect(viewer).toEqual({ kind: "official", assignments: [] });
    expect(judgingLayoutDecision("/app/judging", viewer)).toBe("refuse");
    expect(judgingLayoutDecision(`/app/judging/${EVENT_A}/rounds/${ROUND_A1}/ballot`, viewer)).toBe("refuse");
    expect(await outcome(() => requireJudgingEvent(EVENT_A))).toBe(NOT_FOUND);
  });

  it("an official assigned to event A is allowed on A and refused on B", async () => {
    state.assignments = [{ event_id: EVENT_A, official_role: "judge", round_id: ROUND_A1, judge_letter: "A" }];
    const { resolveJudgingViewer, judgingLayoutDecision, requireJudgingEvent } = await import("@/lib/competition/officials/judgingAccess");
    const viewer = await resolveJudgingViewer(fakeSupabase as never);
    expect(judgingLayoutDecision("/app/judging", viewer)).toBe("judging-shell");
    expect(judgingLayoutDecision(`/app/judging/${EVENT_A}/rounds/${ROUND_A1}/ballot`, viewer)).toBe("judging-shell");
    expect(judgingLayoutDecision(`/app/judging/${EVENT_B}/rounds/${ROUND_B1}/ballot`, viewer)).toBe("refuse");
    expect(await outcome(() => requireJudgingEvent(EVENT_A))).toBe("allowed");
    expect(await outcome(() => requireJudgingEvent(EVENT_B))).toBe(NOT_FOUND);
  });

  it("an assignment never opens another tenant's event, and malformed or non-judging rows are ignored", async () => {
    state.assignments = [
      { event_id: EVENT_A, official_role: "judge", round_id: ROUND_A1 },
      { event_id: OTHER_TENANT_EVENT, official_role: "manager", round_id: null },
      { event_id: "not-a-uuid", official_role: "judge", round_id: null },
    ];
    const { resolveJudgingViewer, judgingLayoutDecision, requireJudgingEvent } = await import("@/lib/competition/officials/judgingAccess");
    const viewer = await resolveJudgingViewer(fakeSupabase as never);
    expect(viewer).toEqual({ kind: "official", assignments: [{ event_id: EVENT_A, official_role: "judge", round_id: ROUND_A1 }] });
    expect(judgingLayoutDecision(`/app/judging/${OTHER_TENANT_EVENT}`, viewer)).toBe("refuse");
    expect(await outcome(() => requireJudgingEvent(OTHER_TENANT_EVENT))).toBe(NOT_FOUND);
  });

  it("a revoked or ended assignment is refused at once (the E1 reader returns only active assignments; a reader error fails closed)", async () => {
    state.assignments = [];
    const { requireJudgingEvent } = await import("@/lib/competition/officials/judgingAccess");
    expect(await outcome(() => requireJudgingEvent(EVENT_A))).toBe(NOT_FOUND);
    state.assignments = null;
    expect(await outcome(() => requireJudgingEvent(EVENT_A))).toBe(NOT_FOUND);
  });

  it("studio staff and platform admins keep the existing path: no assignment read, the studio layout renders", async () => {
    state.studioRole = { studio_id: "s1", role: "studio_owner" };
    const { resolveJudgingViewer, judgingLayoutDecision, requireJudgingEvent, requireJudgingRound } = await import("@/lib/competition/officials/judgingAccess");
    const viewer = await resolveJudgingViewer(fakeSupabase as never);
    expect(viewer).toEqual({ kind: "studio" });
    expect(judgingLayoutDecision(`/app/judging/${EVENT_B}`, viewer)).toBe("studio-layout");
    expect(await outcome(() => requireJudgingEvent(EVENT_B))).toBe("allowed");
    expect(await outcome(() => requireJudgingRound(ROUND_B1, "desk"))).toBe("allowed");
    expect(state.rpcCalls).toEqual([]);
    state.studioRole = null;
    state.platformRole = "platform_admin";
    expect(await resolveJudgingViewer(fakeSupabase as never)).toEqual({ kind: "studio" });
  });
});

describe("OJ-1 round checks used by the judging server actions", () => {
  it("ballot: only a round the official is assigned to", async () => {
    state.assignments = [{ event_id: EVENT_A, official_role: "judge", round_id: ROUND_A1, judge_letter: "A" }];
    const { requireJudgingRound } = await import("@/lib/competition/officials/judgingAccess");
    expect(await outcome(() => requireJudgingRound(ROUND_A1, "ballot"))).toBe("allowed");
    expect(await outcome(() => requireJudgingRound(ROUND_A2, "ballot"))).toBe(NOT_FOUND);
    expect(await outcome(() => requireJudgingRound(ROUND_B1, "ballot"))).toBe(NOT_FOUND);
  });

  it("desk: only a chair or scorer of the round's event, as the round-keyed RPC resolves it", async () => {
    state.assignments = [{ event_id: EVENT_A, official_role: "chair", round_id: null }];
    state.deskRole = { [ROUND_A1]: "chair", [ROUND_B1]: "manager" };
    const { requireJudgingRound } = await import("@/lib/competition/officials/judgingAccess");
    expect(await outcome(() => requireJudgingRound(ROUND_A1, "desk"))).toBe("allowed");
    expect(await outcome(() => requireJudgingRound(ROUND_A2, "desk"))).toBe(NOT_FOUND); // RPC refuses
    expect(await outcome(() => requireJudgingRound(ROUND_B1, "desk"))).toBe(NOT_FOUND); // manager is not a judging role
    state.assignments = [{ event_id: EVENT_A, official_role: "judge", round_id: ROUND_A1 }];
    expect(await outcome(() => requireJudgingRound(ROUND_A1, "desk"))).toBe(NOT_FOUND); // a judge has no desk
  });
});

describe("OJ-1 forged requests straight to the judging server actions", () => {
  const form = (values: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(values)) data.set(k, v);
    return data;
  };
  const REQ = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  it("an organizer-only member without an assignment cannot submit a ballot or use the desk: refused before any write RPC", async () => {
    const ballots = await import("@/app/app/events/[id]/competition/ballots/actions");
    const desk = await import("@/app/app/judging/[eventId]/rounds/[roundId]/ballot/desk/actions");
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["submitJudgeBallotAction", () => ballots.submitJudgeBallotAction(form({ roundId: ROUND_B1, heatId: ROUND_B1, requestId: REQ, returnTo: "/app/judging" }))],
      ["saveCallbackDraftAction", () => ballots.saveCallbackDraftAction(form({ roundId: ROUND_B1, returnTo: "/app/judging" }))],
      ["enterPaperBallotAction", () => ballots.enterPaperBallotAction(form({ roundId: ROUND_B1, heatId: ROUND_B1, officialId: REQ, requestId: REQ }))],
      ["recordAttendanceAction", () => ballots.recordAttendanceAction(form({ roundId: ROUND_B1, officialId: REQ, requestId: REQ, status: "absent" }))],
      ["lockBallotsAction", () => ballots.lockBallotsAction(form({ roundId: ROUND_B1, requestId: REQ }))],
      ["reopenBallotsAction", () => ballots.reopenBallotsAction(form({ roundId: ROUND_B1, requestId: REQ, reason: "x" }))],
      ["lockHeatAction", () => ballots.lockHeatAction(form({ roundId: ROUND_B1, heatId: ROUND_B1, requestId: REQ }))],
      ["reopenHeatAction", () => ballots.reopenHeatAction(form({ roundId: ROUND_B1, heatId: ROUND_B1, requestId: REQ, reason: "x" }))],
      ["deskNoShowAction", () => desk.deskNoShowAction(form({ roundId: ROUND_B1, heatEntryId: ROUND_B1, requestId: REQ, kind: "mark", reason: "x" }))],
    ];
    for (const [name, attempt] of attempts) {
      state.rpcCalls.length = 0;
      expect(await outcome(attempt), name).toBe(NOT_FOUND);
      expect(state.rpcCalls.filter((c) => c !== "my_competition_judging_assignments" && c !== "competition_round_ballot_status"), name).toEqual([]);
    }
  }, 60_000);

  it("an official of event A forging a request for event B's round is refused before any write RPC", async () => {
    state.assignments = [{ event_id: EVENT_A, official_role: "judge", round_id: ROUND_A1, judge_letter: "A" }];
    const ballots = await import("@/app/app/events/[id]/competition/ballots/actions");
    state.rpcCalls.length = 0;
    expect(await outcome(() => ballots.submitJudgeBallotAction(form({ roundId: ROUND_B1, heatId: ROUND_B1, requestId: REQ })))).toBe(NOT_FOUND);
    expect(state.rpcCalls).toEqual(["my_competition_judging_assignments"]);
  }, 60_000);
});

describe("OJ-1 /app layout wiring", () => {
  it("the judging branch runs only with Competition Finals on, only for /app/judging, before the studio context, and refuses to /account", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const layout = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../app/app/layout.tsx"), "utf8");
    const branch = layout.indexOf('if (competitionFinalsEnabled() && (pathname === "/app/judging" || pathname.startsWith("/app/judging/"))) {');
    const studioContext = layout.indexOf("const context = await getCurrentStudioContext();");
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(studioContext);
    const body = layout.slice(branch, studioContext);
    expect(body).toContain("judgingLayoutDecision(pathname, await resolveJudgingViewer(supabase))");
    expect(body).toContain('if (decision === "refuse") redirect("/account");');
    expect(body).toContain('if (decision === "judging-shell") return <JudgingShell>{children}</JudgingShell>;');
  });
});
