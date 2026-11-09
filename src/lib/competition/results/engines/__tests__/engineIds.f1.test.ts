import { describe, expect, it } from "vitest";
import { STUDIO_ENGINES, STUDIO_ENGINE_IDS } from "..";

describe("engine ids match the scoring method registry (REG)", () => {
  it("exports exactly the two registry engine ids", () => {
    expect([...STUDIO_ENGINE_IDS].sort()).toEqual(["studio_callback_tally@1", "studio_ordinal_majority@1"]);
    for (const id of STUDIO_ENGINE_IDS) expect(STUDIO_ENGINES[id].id).toBe(id);
    expect(STUDIO_ENGINES["studio_callback_tally@1"].key).toBe("callback_tally");
    expect(STUDIO_ENGINES["studio_ordinal_majority@1"].key).toBe("ordinal_majority");
    expect(STUDIO_ENGINES["studio_callback_tally@1"].ballotFormat).toEqual({ id: "callback_yes", version: 1 });
    expect(STUDIO_ENGINES["studio_ordinal_majority@1"].ballotFormat).toEqual({ id: "ordinal_rank", version: 1 });
  });
});
