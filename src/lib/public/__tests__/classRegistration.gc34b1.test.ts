import { describe, expect, it } from "vitest";
import {
  canProceedToRegister,
  classRegisterPath,
  registerUnavailableMessage,
  resolveRegistrationDancer,
  type ManageableDancer,
} from "../classRegistration";

/** GC-3.4B-1 pure decisions for the class identity step. */

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const dancer = (clientId: string, isSelf = false): ManageableDancer => ({ clientId, displayName: clientId, isSelf });

describe("resolveRegistrationDancer", () => {
  it("no manageable dancer -> unlinked", () => {
    expect(resolveRegistrationDancer([], null)).toEqual({ kind: "unlinked" });
  });

  it("one manageable dancer -> ready without a chooser", () => {
    expect(resolveRegistrationDancer([dancer(A, true)], null)).toMatchObject({ kind: "ready", dancer: { clientId: A } });
  });

  it("several -> chooser; a requested dancer from the list -> ready", () => {
    const list = [dancer(A, true), dancer(B)];
    expect(resolveRegistrationDancer(list, null)).toEqual({ kind: "choose", dancers: list });
    expect(resolveRegistrationDancer(list, B)).toMatchObject({ kind: "ready", dancer: { clientId: B } });
  });

  it("a requested dancer outside the account's own list never selects anyone", () => {
    for (const requested of ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "garbage", "%00", " "]) {
      const result = resolveRegistrationDancer([dancer(A)], requested);
      if (requested.trim()) expect(result).toEqual({ kind: "invalid_selection" });
    }
    expect(resolveRegistrationDancer([], A)).toEqual({ kind: "invalid_selection" });
  });
});

describe("class state gate", () => {
  it("only an upcoming class with open public enrollment may proceed", () => {
    expect(canProceedToRegister({ publicState: "upcoming", enrollmentState: "open" })).toBe(true);
    for (const [publicState, enrollmentState] of [
      ["upcoming", "full"],
      ["upcoming", "unavailable"],
      ["upcoming", "closed"],
      ["cancelled", "closed"],
      ["past", "closed"],
    ] as const) {
      expect(canProceedToRegister({ publicState, enrollmentState })).toBe(false);
      expect(registerUnavailableMessage({ publicState, enrollmentState })).toBeTruthy();
    }
  });

  it("builds the canonical register path with an encoded dancer", () => {
    expect(classRegisterPath("salsa house", A)).toBe(`/studios/salsa%20house/classes/${A}/register`);
    expect(classRegisterPath("s", A, B)).toBe(`/studios/s/classes/${A}/register?dancer=${B}`);
  });
});
