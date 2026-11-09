import { expect, it } from "vitest";

it("passes", () => expect(true).toBe(true));
it.skip("a skipped test must never let the run count as a pass (exit 4)", () => expect(true).toBe(true));
