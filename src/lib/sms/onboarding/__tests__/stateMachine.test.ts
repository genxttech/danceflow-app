import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  ONBOARDING_STATES,
  OWNER_CANCEL_STATES,
  OWNER_EDIT_STATES,
  STATE_DETAILS,
  STATE_LABELS,
  canTransition,
  isOnboardingState,
  ownerCanCancel,
  ownerCanEdit,
  trackerSteps,
} from "@/lib/sms/onboarding/stateMachine";

const SQL = readFileSync(join(process.cwd(), "src", "lib", "supabase", "migrations", "20261119090000_twilio_tw4a_sms_onboarding.sql"), "utf8").replace(/\r\n/g, "\n");

describe("state graph is pinned to the database", () => {
  it("has exactly the states of the table check", () => {
    const match = /state text not null default 'draft' check \(state in \(([\s\S]*?)\)\),/.exec(SQL);
    const sqlStates = [...(match?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...ONBOARDING_STATES].sort()).toEqual(sqlStates.sort());
  });
  it("allows exactly the transitions of _sms_onb_transition_allowed, no more and no fewer", () => {
    const block = SQL.slice(SQL.indexOf("create or replace function public._sms_onb_transition_allowed"), SQL.indexOf("create or replace function public._sms_onb_integrity"));
    const sqlPairs = [...block.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    const tsPairs = ONBOARDING_STATES.flatMap((from) => ALLOWED_TRANSITIONS[from].map((to) => `${from}>${to}`)).sort();
    expect(tsPairs).toEqual(sqlPairs);
  });
  it("the owner edit and cancel windows equal the RPC checks", () => {
    expect([...OWNER_EDIT_STATES].sort()).toEqual(["draft", "needs_info"]);
    const cancelBlock = /create or replace function public\.cancel_sms_onboarding[\s\S]*?if o\.state not in \(([^)]*)\)/.exec(SQL);
    const sqlCancel = [...(cancelBlock?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...OWNER_CANCEL_STATES].sort()).toEqual(sqlCancel.sort());
  });
});

describe("transitions", () => {
  it("the happy path is legal end to end and cancelled is terminal", () => {
    const path = ["draft", "submitted_for_checks", "profile_review", "brand_pending", "service_setup", "campaign_pending", "ready_for_activation", "active"] as const;
    for (let i = 0; i < path.length - 1; i += 1) expect(canTransition(path[i], path[i + 1])).toBe(true);
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
    expect(canTransition("active", "draft")).toBe(false);
    expect(canTransition("brand_pending", "cancelled")).toBe(false);
    expect(canTransition("draft", "draft")).toBe(false);
  });
  it("no state can return to draft", () => {
    for (const from of ONBOARDING_STATES) expect(canTransition(from, "draft")).toBe(false);
  });
  it("narrows unknown values", () => {
    expect(isOnboardingState("active")).toBe(true);
    expect(isOnboardingState("not_started")).toBe(false);
    expect(isOnboardingState(null)).toBe(false);
  });
});

describe("owner windows and copy", () => {
  it("owners edit before submission and when more information is requested", () => {
    for (const state of ["not_started", "draft", "needs_info"] as const) expect(ownerCanEdit(state)).toBe(true);
    for (const state of ["submitted_for_checks", "brand_pending", "active", "cancelled"] as const) expect(ownerCanEdit(state)).toBe(false);
    expect(ownerCanCancel("not_started")).toBe(false);
    expect(ownerCanCancel("profile_review")).toBe(true);
    expect(ownerCanCancel("brand_pending")).toBe(false);
  });
  it("every state has plain-language copy and none leaks provider vocabulary", () => {
    for (const state of [...ONBOARDING_STATES, "not_started" as const]) {
      expect(STATE_LABELS[state].length).toBeGreaterThan(2);
      expect(STATE_DETAILS[state].length).toBeGreaterThan(10);
      expect(`${STATE_LABELS[state]} ${STATE_DETAILS[state]}`).not.toMatch(/\b(twilio|trust ?hub|sid|api|tcr|10dlc)\b/i);
    }
  });
});

describe("tracker", () => {
  const statuses = (state: Parameters<typeof trackerSteps>[0]) => trackerSteps(state).map((s) => s.status).join(",");
  it("walks the five steps in order", () => {
    expect(trackerSteps("draft").map((s) => s.key)).toEqual(["business", "brand", "campaign", "number", "activate"]);
    expect(statuses("draft")).toBe("upcoming,upcoming,upcoming,upcoming,upcoming");
    expect(statuses("profile_review")).toBe("current,upcoming,upcoming,upcoming,upcoming");
    expect(statuses("brand_pending")).toBe("done,current,upcoming,upcoming,upcoming");
    expect(statuses("campaign_pending")).toBe("done,done,current,upcoming,upcoming");
    expect(statuses("ready_for_activation")).toBe("done,done,done,done,current");
    expect(statuses("active")).toBe("done,done,done,done,done");
  });
  it("flags trouble on the step where it happened", () => {
    expect(statuses("needs_info")).toBe("attention,upcoming,upcoming,upcoming,upcoming");
    expect(statuses("suspended")).toBe("done,done,done,done,attention");
    expect(statuses("cancelled")).toBe("upcoming,upcoming,upcoming,upcoming,upcoming");
  });
});
