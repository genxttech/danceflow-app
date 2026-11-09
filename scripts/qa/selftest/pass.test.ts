import { expect, it } from "vitest";

it("control: a passing suite on a healthy stack is a PASS (exit 0)", () => {
  expect(process.env.TW4_ISO_QA).toBe("1");
  expect(String(process.env.TW4A_LOCAL_DB_CONTAINER)).toMatch(/^df-isoqa-/);
});
