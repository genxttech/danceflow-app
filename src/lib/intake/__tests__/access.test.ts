import { describe, expect, it } from "vitest";
import { STUDENT_INTAKE_CONFIG_ENV, canConfigureStudentIntake, isStudentIntakeConfigAvailable, parseAllowlist } from "@/lib/intake/access";

const A = "a5200000-0000-0000-0000-00000000000a";
const B = "a5200000-0000-0000-0000-00000000000b";

describe("canConfigureStudentIntake", () => {
  it("allows only the studio owner and studio admin", () => {
    expect(canConfigureStudentIntake("studio_owner")).toBe(true);
    expect(canConfigureStudentIntake("studio_admin")).toBe(true);
  });
  it.each(["front_desk", "instructor", "independent_instructor", "client", "organizer_owner", "organizer_admin", "platform_admin", "", null, undefined])(
    "refuses %s",
    (role) => expect(canConfigureStudentIntake(role as string | null | undefined)).toBe(false),
  );
});

describe("isStudentIntakeConfigAvailable (no automatic entitlement)", () => {
  it("is off when the allowlist is missing or empty", () => {
    expect(isStudentIntakeConfigAvailable(A, {})).toBe(false);
    expect(isStudentIntakeConfigAvailable(A, { [STUDENT_INTAKE_CONFIG_ENV]: "" })).toBe(false);
    expect(isStudentIntakeConfigAvailable(A, { [STUDENT_INTAKE_CONFIG_ENV]: "  ,  " })).toBe(false);
  });
  it("is on only for listed studios, case-insensitively", () => {
    const env = { [STUDENT_INTAKE_CONFIG_ENV]: ` ${A.toUpperCase()} , not-a-uuid ` };
    expect(isStudentIntakeConfigAvailable(A, env)).toBe(true);
    expect(isStudentIntakeConfigAvailable(B, env)).toBe(false);
  });
  it("fails closed on missing or malformed studio ids and ignores malformed entries", () => {
    const env = { [STUDENT_INTAKE_CONFIG_ENV]: `*,all,${A}` };
    expect(isStudentIntakeConfigAvailable(null, env)).toBe(false);
    expect(isStudentIntakeConfigAvailable("*", env)).toBe(false);
    expect([...parseAllowlist(env[STUDENT_INTAKE_CONFIG_ENV])]).toEqual([A]);
  });
});
