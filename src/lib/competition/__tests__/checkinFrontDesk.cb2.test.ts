import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canCheckInCompetition, canManageCompetition, competitionAccessLevel } from "@/lib/competition/access";
import { activeNavKey, competitionNav, competitionNavForAccess } from "@/lib/competition/workspaceNav";

const ctx = vi.hoisted(() => ({
  studioRole: "front_desk" as string | null,
  isPlatformAdmin: false,
  organizerRole: null as string | null,
  eventFound: true,
  organizerId: null as string | null,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: "studio-1", userId: "user-1", studioRole: ctx.studioRole, isPlatformAdmin: ctx.isPlatformAdmin }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => {
        if (table === "events") return { data: ctx.eventFound ? { id: "e1", name: "E", studio_id: "studio-1", organizer_id: ctx.organizerId } : null, error: null };
        return { data: ctx.organizerRole ? { role: ctx.organizerRole } : null, error: null };
      };
      return chain;
    },
  }),
}));

import { loadCompetitionWorkspace, requireCompetitionCheckinAccess, requireCompetitionManager, requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";

const ROOT = join(__dirname, "..", "..", "..", "..");
const WORKSPACE = join(ROOT, "src/app/app/events/[id]/competition");
const EVENT = "11111111-1111-1111-1111-111111111111";

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : pages(path);
    return name === "page.tsx" ? [path] : [];
  });
}

beforeEach(() => {
  ctx.studioRole = "front_desk";
  ctx.isPlatformAdmin = false;
  ctx.organizerRole = null;
  ctx.organizerId = null;
  ctx.eventFound = true;
});

describe("CB-2 access levels", () => {
  const base = { isPlatformAdmin: false, organizerUserRole: null };
  it("front_desk is check-in only; managers stay managers", () => {
    expect(competitionAccessLevel({ ...base, studioRole: "front_desk" })).toBe("check_in_only");
    expect(canManageCompetition({ ...base, studioRole: "front_desk" })).toBe(false);
    expect(canCheckInCompetition({ ...base, studioRole: "front_desk" })).toBe(true);
    for (const studioRole of ["studio_owner", "studio_admin"]) expect(competitionAccessLevel({ ...base, studioRole })).toBe("manager");
    expect(competitionAccessLevel({ isPlatformAdmin: true, studioRole: null, organizerUserRole: null })).toBe("manager");
    for (const organizerUserRole of ["organizer_owner", "organizer_admin", "organizer_staff"]) expect(competitionAccessLevel({ isPlatformAdmin: false, studioRole: null, organizerUserRole })).toBe("manager");
  });
  it("instructors, independent instructors, unknown and empty roles have no access", () => {
    for (const studioRole of ["instructor", "independent_instructor", "student", "", null, undefined]) {
      expect(competitionAccessLevel({ ...base, studioRole })).toBe("none");
      expect(canCheckInCompetition({ ...base, studioRole })).toBe(false);
    }
    expect(competitionAccessLevel({ isPlatformAdmin: false, studioRole: null, organizerUserRole: "viewer" })).toBe("none");
  });
});

describe("CB-2 gate helper", () => {
  it("front_desk: requireCompetitionWorkspace redirects to check-in; requireCompetitionCheckinAccess passes", async () => {
    await expect(requireCompetitionWorkspace("e1")).rejects.toThrow("REDIRECT:/app/events/e1/competition/checkin");
    const ws = await requireCompetitionCheckinAccess("e1");
    expect(ws.accessLevel).toBe("check_in_only");
    expect(ws.canManage).toBe(false);
    expect(ws.canEditOperations).toBe(false);
  });
  it("front_desk cannot use the manager action guard", async () => {
    await expect(requireCompetitionManager("e1")).rejects.toThrow("permission");
  });
  it("instructor roles get a 404 from both gates", async () => {
    for (const role of ["instructor", "independent_instructor"]) {
      ctx.studioRole = role;
      await expect(requireCompetitionWorkspace("e1")).rejects.toThrow("NOT_FOUND");
      await expect(requireCompetitionCheckinAccess("e1")).rejects.toThrow("NOT_FOUND");
    }
  });
  it("managers pass both gates", async () => {
    for (const role of ["studio_owner", "studio_admin"]) {
      ctx.studioRole = role;
      expect((await requireCompetitionWorkspace("e1")).canManage).toBe(true);
      expect((await requireCompetitionCheckinAccess("e1")).accessLevel).toBe("manager");
    }
    ctx.studioRole = null;
    ctx.organizerId = "org-1";
    ctx.organizerRole = "organizer_staff";
    expect((await requireCompetitionWorkspace("e1")).canManage).toBe(true);
  });
  it("platform admin passes; a missing event 404s even for managers", async () => {
    ctx.studioRole = null;
    ctx.isPlatformAdmin = true;
    expect((await loadCompetitionWorkspace("e1")).accessLevel).toBe("manager");
    ctx.eventFound = false;
    await expect(requireCompetitionCheckinAccess("e1")).rejects.toThrow("NOT_FOUND");
  });
  it("front_desk with an organizer role that does not manage stays check-in only", async () => {
    ctx.organizerId = "org-1";
    ctx.organizerRole = "viewer";
    expect((await loadCompetitionWorkspace("e1")).accessLevel).toBe("check_in_only");
  });
});

describe("CB-2 every workspace page applies a gate", () => {
  const all = pages(WORKSPACE);
  it("finds the workspace pages", () => {
    expect(all.length).toBeGreaterThanOrEqual(12);
  });
  for (const file of all) {
    const rel = file.slice(WORKSPACE.length + 1).replaceAll("\\", "/");
    const isCheckin = rel.startsWith("checkin/");
    it(`${rel} calls ${isCheckin ? "requireCompetitionCheckinAccess" : "requireCompetitionWorkspace"}`, () => {
      const source = readFileSync(file, "utf8");
      if (isCheckin) {
        expect(source).toMatch(/await requireCompetitionCheckinAccess\(/);
      } else {
        expect(source).toMatch(/await requireCompetitionWorkspace\(/);
        expect(source).not.toMatch(/requireCompetitionCheckinAccess/);
      }
    });
  }
  it("the layout admits check-in users and the manager-only action guards never mention front_desk outside check-in", () => {
    expect(readFileSync(join(WORKSPACE, "layout.tsx"), "utf8")).toMatch(/requireCompetitionCheckinAccess/);
    for (const file of ["actions.ts", "registrations/actions.ts", "readiness/actions.ts", "schedule/actions.ts", "simpleActions.ts"]) {
      expect(readFileSync(join(WORKSPACE, file), "utf8")).not.toMatch(/front_desk/);
    }
  });
  it("entry verification is manager-only; the other check-in actions allow the front desk", () => {
    const source = readFileSync(join(WORKSPACE, "checkin/actions.ts"), "utf8");
    expect(source).toMatch(/verifyCompetitionCheckinEntryAction[\s\S]*?requireEventManager\(eventId, \{ managerOnly: true \}\)/);
    expect(source.match(/managerOnly: true/g)?.length).toBe(1);
  });
});

describe("CB-2 navigation", () => {
  it("front_desk sees only Check-in", () => {
    const items = competitionNavForAccess(EVENT, true);
    expect(items.map((item) => item.key)).toEqual(["check_in"]);
    expect(items[0].href).toBe(`/app/events/${EVENT}/competition/checkin`);
    expect(activeNavKey(EVENT, `/app/events/${EVENT}/competition/checkin/abc`)).toBe("check_in");
  });
  it("managers keep the whole nav unchanged", () => {
    expect(competitionNavForAccess(EVENT, false)).toEqual(competitionNav(EVENT));
  });
});
