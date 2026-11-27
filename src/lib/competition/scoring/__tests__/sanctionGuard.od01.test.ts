import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCORING_REGISTRY } from "../registry";
import {
  BODY_CITATION_KEYS,
  VERIFIED_BODY_SCORING,
  WSDC_NON_WSDC_CONTEST_OPT_OUT,
  evaluateSanctionScoringGuard,
  guardRoundResultsForSanction,
} from "../sanctionGuard";
import { publicationControls } from "../../results/publication";

/**
 * OD-01 (owner decision 2026-11-23, BLOCK): a declared UCWDC/NDCA/WSDC event cannot have results approved or published until that
 * body's scoring is implemented and verified. Studio/Custom (none) and other are unchanged. See OD01-* in the rule register.
 */

const METHOD_KEYS = [...SCORING_REGISTRY.map((e) => e.key), "unknown_method", null, undefined];
const BODIES = ["ucwdc", "ndca", "wsdc"] as const;

describe("OD-01 guard: every body x method x declaration combination", () => {
  for (const body of BODIES) {
    for (const methodKey of METHOD_KEYS) {
      it(`${body} declared + ${String(methodKey)} is blocked, cites ${body} register ids`, () => {
        const r = evaluateSanctionScoringGuard({ sanctioning: body, methodKey });
        expect(r.allowed).toBe(false);
        expect(r.code).toBe("SANCTION_BODY_SCORING_NOT_VERIFIED");
        expect(r.body).toBe(body);
        expect(r.citationKeys).toEqual(BODY_CITATION_KEYS[body]);
        expect(r.citationKeys.every((k) => k.startsWith(`OD01-${body.toUpperCase()}-`))).toBe(true);
      });
    }
  }

  for (const methodKey of METHOD_KEYS) {
    it(`none / unset / other stay unblocked for ${String(methodKey)}`, () => {
      for (const v of ["none", null, undefined, ""]) {
        const r = evaluateSanctionScoringGuard({ sanctioning: v, methodKey });
        expect(r).toMatchObject({ allowed: true, code: "SANCTION_NOT_DECLARED", body: null, citationKeys: [] });
      }
      const other = evaluateSanctionScoringGuard({ sanctioning: "other", methodKey });
      expect(other).toMatchObject({ allowed: true, code: "SANCTION_OTHER_UNVERIFIED", body: null });
    });
  }

  it("an unrecognized stored value fails closed", () => {
    for (const v of ["NDCA", "usdc", "wsdc ", "garbage"]) {
      const r = evaluateSanctionScoringGuard({ sanctioning: v, methodKey: "studio_ordinal_majority" });
      expect(r.allowed).toBe(false);
      expect(r.code).toBe("SANCTION_DECLARATION_UNRECOGNIZED");
    }
  });

  it("no scoring method is verified for any body: a body-named method is not enough, Studio methods never are", () => {
    for (const body of BODIES) expect(VERIFIED_BODY_SCORING[body]).toEqual([]);
    for (const e of SCORING_REGISTRY) {
      for (const body of BODIES) expect(evaluateSanctionScoringGuard({ sanctioning: body, methodKey: e.key }).allowed).toBe(false);
    }
  });

  it("other copy says the declaration is unverified and never implies sanctioning compliance", () => {
    const r = evaluateSanctionScoringGuard({ sanctioning: "other" });
    expect(r.reason).toMatch(/not verified/i);
    expect(r.reason).not.toMatch(/compliant|certified|approved by/i);
  });

  it("copy is body-specific and never claims compliance", () => {
    expect(evaluateSanctionScoringGuard({ sanctioning: "ndca" }).reason).toMatch(/NDCA.*Skating System/);
    expect(evaluateSanctionScoringGuard({ sanctioning: "ucwdc" }).reason).toMatch(/UCWDC.*Majority Rules/);
    const wsdc = evaluateSanctionScoringGuard({ sanctioning: "wsdc" }).reason;
    expect(wsdc).toMatch(/WSDC.*Callback.*Relative Placement.*Jack and Jill/);
    expect(wsdc).not.toMatch(/NDCA|UCWDC/);
    expect(evaluateSanctionScoringGuard({ sanctioning: "ndca" }).reason).not.toMatch(/WSDC|UCWDC/);
    for (const body of BODIES) {
      const reason = evaluateSanctionScoringGuard({ sanctioning: body }).reason;
      expect(reason).toMatch(/not implemented and verified/);
      expect(reason).toMatch(/non-scoring operations are not affected/);
      expect(reason).toMatch(/acknowledgement cannot override/);
    }
  });

  it("organizer acknowledgement is not an input and cannot override a body block", () => {
    const r = evaluateSanctionScoringGuard({ sanctioning: "wsdc", acknowledged: true, override: true } as unknown as Parameters<typeof evaluateSanctionScoringGuard>[0]);
    expect(r.allowed).toBe(false);
  });

  it("WSDC non-WSDC-contest opt-out is documented, not implemented, and never applies to Jack and Jill", () => {
    expect(WSDC_NON_WSDC_CONTEST_OPT_OUT.implemented).toBe(false);
    expect(WSDC_NON_WSDC_CONTEST_OPT_OUT.appliesToJackAndJill).toBe(false);
    expect(evaluateSanctionScoringGuard({ sanctioning: "wsdc" }).wsdcOptOut).toBe("not_implemented");
    expect(evaluateSanctionScoringGuard({ sanctioning: "ndca" }).wsdcOptOut).toBeNull();
  });
});

/** Minimal supabase fake: one table lookup per call. */
function fakeDb(tables: Record<string, unknown>, failTable?: string) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => (table === failTable ? { data: null, error: { message: "boom" } } : { data: tables[table] ?? null, error: null }),
        }),
      }),
    }),
  };
}
const ROUND = { event_id: "e1", scoring_override_key: null, division_id: "d1" };
const DIV = { scoring_method_key: "studio_ordinal_majority" };

describe("OD-01 guard: server-side loader fails closed", () => {
  it("blocks a declared event, allows none/other", async () => {
    for (const body of BODIES) {
      const r = await guardRoundResultsForSanction(fakeDb({ event_competition_rounds: ROUND, events: { competition_sanctioning: body }, event_competition_divisions: DIV }), "r1");
      expect(r.allowed).toBe(false);
    }
    for (const v of ["none", "other", null]) {
      const r = await guardRoundResultsForSanction(fakeDb({ event_competition_rounds: ROUND, events: { competition_sanctioning: v }, event_competition_divisions: DIV }), "r1");
      expect(r.allowed).toBe(true);
    }
  });
  it("any read failure or missing row is a block", async () => {
    const ok = { event_competition_rounds: ROUND, events: { competition_sanctioning: "none" }, event_competition_divisions: DIV };
    for (const fail of ["event_competition_rounds", "events"]) {
      expect((await guardRoundResultsForSanction(fakeDb(ok, fail), "r1")).code).toBe("SANCTION_DECLARATION_UNAVAILABLE");
    }
    expect((await guardRoundResultsForSanction(fakeDb({ event_competition_rounds: ROUND }), "r1")).allowed).toBe(false);
    expect((await guardRoundResultsForSanction({ from: () => { throw new Error("x"); } }, "r1")).allowed).toBe(false);
  });
});

describe("OD-01 publication readiness mirrors the guard", () => {
  const base = {
    isManager: true,
    roundStatus: "approved",
    latestVersion: { id: "v1", status: "approved", stale: false },
    unresolvedTie: false,
    publications: [],
  };
  it("offers publish when not blocked and withholds it with the reason when blocked", () => {
    expect(publicationControls(base).publishVersionId).toBe("v1");
    const blocked = publicationControls({ ...base, sanctionBlockedReason: "blocked by OD-01" });
    expect(blocked.publishVersionId).toBeNull();
    expect(blocked.publishBlockedReason).toBe("blocked by OD-01");
  });
  it("withdrawal is never blocked by the guard", () => {
    const pub = { id: "p1", publicationVersion: 1, resultVersionId: "v1", visibility: "public" as const, publishedAt: null, withdrawnAt: null, withdrawnReason: null, state: "current" as const };
    const c = publicationControls({ ...base, roundStatus: "published", publications: [pub], sanctionBlockedReason: "blocked by OD-01" });
    expect(c.withdrawPublicationId).toBe("p1");
  });
});

// --- server actions: approve and publish refuse before any RPC; everything else is untouched ---------------------------------------

const rpcCalls: string[] = [];
let db: ReturnType<typeof fakeDb>;
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: async (name: string) => {
      rpcCalls.push(name);
      return { data: { replayed: false }, error: null };
    },
    from: (t: string) => db.from(t),
  }),
}));

const ID = "11111111-1111-4111-8111-111111111111";
function form(extra: Record<string, string> = {}) {
  const f = new FormData();
  f.set("roundId", ID);
  f.set("versionId", ID);
  f.set("requestId", ID);
  f.set("visibility", "entrants");
  f.set("publicationId", ID);
  f.set("reason", "r");
  f.set("returnTo", "/app/events/e1/competition/results/x");
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
}
async function run(fn: (f: FormData) => Promise<void>) {
  try {
    await fn(form());
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}

describe("OD-01 server actions", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    process.env.COMPETITION_FINALS_ENABLED = "true";
  });
  const declared = (v: string | null) => {
    db = fakeDb({ event_competition_rounds: ROUND, events: { competition_sanctioning: v }, event_competition_divisions: DIV });
  };

  for (const body of BODIES) {
    it(`approve and publish refuse a ${body}-declared event before calling the database`, async () => {
      declared(body);
      const actions = await import("@/app/app/events/[id]/competition/results/actions");
      const a = await run(actions.approveRoundResultAction);
      const p = await run(actions.publishRoundResultAction);
      expect(decodeURIComponent(a.replaceAll("+", " "))).toMatch(new RegExp(`${body.toUpperCase()} sanctioning`));
      expect(decodeURIComponent(p.replaceAll("+", " "))).toMatch(new RegExp(`${body.toUpperCase()} sanctioning`));
      expect(rpcCalls).toEqual([]);
    });
  }

  it("a guard read failure fails closed for approve and publish", async () => {
    db = fakeDb({ event_competition_rounds: ROUND }, "events");
    const actions = await import("@/app/app/events/[id]/competition/results/actions");
    await run(actions.approveRoundResultAction);
    await run(actions.publishRoundResultAction);
    expect(rpcCalls).toEqual([]);
  });

  it("none and other still reach the database transition (Studio/Custom unchanged)", async () => {
    const actions = await import("@/app/app/events/[id]/competition/results/actions");
    for (const v of ["none", "other", null]) {
      rpcCalls.length = 0;
      declared(v);
      await run(actions.approveRoundResultAction);
      await run(actions.publishRoundResultAction);
      expect(rpcCalls).toEqual(["approve_competition_round_result", "publish_competition_round_result"]);
    }
  });

  it("non-scoring-approval operations are not guarded: withdraw and calculate do not consult the declaration", async () => {
    declared("ndca");
    const actions = await import("@/app/app/events/[id]/competition/results/actions");
    await run(actions.withdrawRoundResultAction);
    expect(rpcCalls).toContain("withdraw_competition_round_result");
  });

  it("only approve and publish import the guard; registration, scheduling and payment code do not", () => {
    const root = path.join(__dirname, "..", "..", "..", "..");
    const text = fs.readFileSync(path.join(root, "app/app/events/[id]/competition/results/actions.ts"), "utf8");
    expect(text.match(/guardRoundResultsForSanction\(/g)?.length).toBe(2);
    for (const rel of ["app/app/events/[id]/competition/actions.ts", "app/app/events/[id]/competition/simpleActions.ts"]) {
      expect(fs.readFileSync(path.join(root, rel), "utf8")).not.toMatch(/sanctionGuard/);
    }
  });
});
