import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { judgingRoundLinks } from "@/lib/competition/officials/judging";

/** CF1 review P2-1: an assigned official must be able to open their ballot or desk from /app/judging (not only by typing a URL). */

const EVENT = "11111111-1111-4111-8111-111111111111";
const ROUND = "22222222-2222-4222-8222-222222222222";

describe("judgingRoundLinks", () => {
  it("a judge with a panel letter gets the ballot link only", () => {
    expect(judgingRoundLinks(EVENT, { roundId: ROUND, judgeLetter: "A" }, "judge")).toEqual({
      ballot: `/app/judging/${EVENT}/rounds/${ROUND}/ballot`,
      desk: null,
    });
  });

  it("the chair and the scorer get the desk link; a chair who also judges gets both", () => {
    expect(judgingRoundLinks(EVENT, { roundId: ROUND, judgeLetter: null }, "scorer")).toEqual({ ballot: null, desk: `/app/judging/${EVENT}/rounds/${ROUND}/ballot/desk` });
    expect(judgingRoundLinks(EVENT, { roundId: ROUND, judgeLetter: null }, "chair")).toEqual({ ballot: null, desk: `/app/judging/${EVENT}/rounds/${ROUND}/ballot/desk` });
    expect(judgingRoundLinks(EVENT, { roundId: ROUND, judgeLetter: "C" }, "chair")).toEqual({
      ballot: `/app/judging/${EVENT}/rounds/${ROUND}/ballot`,
      desk: `/app/judging/${EVENT}/rounds/${ROUND}/ballot/desk`,
    });
  });

  it("never builds a link from a malformed id or an unknown role", () => {
    expect(judgingRoundLinks("../x", { roundId: ROUND, judgeLetter: "A" }, "judge")).toEqual({ ballot: null, desk: null });
    expect(judgingRoundLinks(EVENT, { roundId: "r1/../../admin", judgeLetter: "A" }, "judge")).toEqual({ ballot: null, desk: null });
    expect(judgingRoundLinks(EVENT, { roundId: ROUND, judgeLetter: null }, "manager")).toEqual({ ballot: null, desk: null });
  });

  it("the judging home page renders these links", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../app/app/judging/page.tsx"), "utf8");
    expect(source).toContain("judgingRoundLinks(");
    expect(source).toMatch(/<Link[^>]+href=\{links\.ballot\}/);
    expect(source).toMatch(/<Link[^>]+href=\{links\.desk\}/);
  });
});
