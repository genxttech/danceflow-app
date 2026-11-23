import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createOAuthStateCookieValue, isValidOAuthState, parseOAuthStateCookie, safeOAuthErrorCode } from "../oauth";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const INSTR = "33333333-3333-4333-8333-333333333333";

afterEach(() => vi.useRealTimers());

describe("S0-f OAuth state", () => {
  it("round-trips and validates for the same studio and user", () => {
    const { state, cookieValue } = createOAuthStateCookieValue({ studioId: STUDIO, userId: USER });
    const parsed = parseOAuthStateCookie(cookieValue);
    expect(parsed).toMatchObject({ studioId: STUDIO, userId: USER, connectionScope: "studio", instructorId: null });
    expect(isValidOAuthState({ expected: parsed, returnedState: state, studioId: STUDIO, userId: USER })).toBe(true);
  });

  it("rejects a wrong state, a missing state, another studio and another user", () => {
    const { state, cookieValue } = createOAuthStateCookieValue({ studioId: STUDIO, userId: USER });
    const parsed = parseOAuthStateCookie(cookieValue);
    const other = createOAuthStateCookieValue({ studioId: STUDIO, userId: USER }).state;
    expect(isValidOAuthState({ expected: parsed, returnedState: other, studioId: STUDIO, userId: USER })).toBe(false);
    expect(isValidOAuthState({ expected: parsed, returnedState: null, studioId: STUDIO, userId: USER })).toBe(false);
    expect(isValidOAuthState({ expected: parsed, returnedState: "short", studioId: STUDIO, userId: USER })).toBe(false);
    expect(isValidOAuthState({ expected: parsed, returnedState: state, studioId: "44444444-4444-4444-8444-444444444444", userId: USER })).toBe(false);
    expect(isValidOAuthState({ expected: parsed, returnedState: state, studioId: STUDIO, userId: "44444444-4444-4444-8444-444444444444" })).toBe(false);
    expect(isValidOAuthState({ expected: null, returnedState: state, studioId: STUDIO, userId: USER })).toBe(false);
  });

  it("expires after ten minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T12:00:00Z"));
    const { state, cookieValue } = createOAuthStateCookieValue({ studioId: STUDIO, userId: USER });
    const parsed = parseOAuthStateCookie(cookieValue);
    vi.setSystemTime(new Date("2026-11-23T12:09:59Z"));
    expect(isValidOAuthState({ expected: parsed, returnedState: state, studioId: STUDIO, userId: USER })).toBe(true);
    vi.setSystemTime(new Date("2026-11-23T12:10:01Z"));
    expect(isValidOAuthState({ expected: parsed, returnedState: state, studioId: STUDIO, userId: USER })).toBe(false);
  });

  it("instructor scope needs a valid instructor id, and the id survives the round trip", () => {
    expect(() => createOAuthStateCookieValue({ studioId: STUDIO, userId: USER, connectionScope: "instructor" })).toThrow();
    expect(() => createOAuthStateCookieValue({ studioId: STUDIO, userId: USER, connectionScope: "instructor", instructorId: "nope" })).toThrow();
    const { cookieValue } = createOAuthStateCookieValue({ studioId: STUDIO, userId: USER, connectionScope: "instructor", instructorId: INSTR });
    expect(parseOAuthStateCookie(cookieValue)).toMatchObject({ connectionScope: "instructor", instructorId: INSTR });
    expect(() => createOAuthStateCookieValue({ studioId: "bad", userId: USER })).toThrow();
  });

  it("rejects forged or malformed cookies", () => {
    expect(parseOAuthStateCookie(null)).toBeNull();
    expect(parseOAuthStateCookie("not json")).toBeNull();
    expect(parseOAuthStateCookie(JSON.stringify({ state: "x", studioId: STUDIO, userId: USER, createdAt: Date.now() }))).toBeNull();
    const { cookieValue } = createOAuthStateCookieValue({ studioId: STUDIO, userId: USER });
    const forged = { ...JSON.parse(cookieValue), studioId: "not-a-uuid" };
    expect(parseOAuthStateCookie(JSON.stringify(forged))).toBeNull();
    const noTime = { ...JSON.parse(cookieValue), createdAt: 0 };
    expect(parseOAuthStateCookie(JSON.stringify(noTime))).toBeNull();
    const instructorNoId = { ...JSON.parse(cookieValue), connectionScope: "instructor", instructorId: null };
    expect(parseOAuthStateCookie(JSON.stringify(instructorNoId))).toBeNull();
  });

  it("sanitises provider error codes before they reach a redirect URL", () => {
    expect(safeOAuthErrorCode("access_denied")).toBe("access_denied");
    expect(safeOAuthErrorCode("<script>x</script>&a=b")).toBe("_script_x__script__a_b");
    expect(safeOAuthErrorCode("")).toBe("oauth_error");
    expect(safeOAuthErrorCode(null)).toBe("oauth_error");
    expect(safeOAuthErrorCode("a".repeat(200)).length).toBe(80);
  });
});
