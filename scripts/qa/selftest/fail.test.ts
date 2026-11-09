import { expect, it } from "vitest";

it("control: an application-level assertion failure on a healthy stack is exit 1", () => {
  expect(1).toBe(2);
});
