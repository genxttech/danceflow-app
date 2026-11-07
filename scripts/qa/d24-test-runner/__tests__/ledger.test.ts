import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../ledger";
import { REPO, tmp } from "./helpers";

const mk = () => new Ledger(join(tmp(), "ledger"), () => new Date("2026-11-07T12:00:00Z"));

describe("run ledger", () => {
  it("counts a run at start; a failed or aborted run still consumes it", () => {
    const l = mk();
    expect(l.startBlockers("e1", 2)).toEqual([]);
    const s1 = l.startRun("e1", "h", "r1");
    l.endRun(s1, "FAIL");
    expect(l.runsStarted("e1")).toBe(1);
    expect(l.startBlockers("e1", 2)).toEqual([]);
    const s2 = l.startRun("e1", "h", "r2");
    l.endRun(s2, "UNVERIFIABLE");
    expect(l.startBlockers("e1", 2).join()).toMatch(/exhausted: 2 of 2/);
  });

  it("an unfinished run (crash) blocks new runs until reconciled, and reconcile does not give the run back", () => {
    const l = mk();
    l.startRun("e1", "h", "r1");
    expect(l.startBlockers("e1", 5).join()).toMatch(/no recorded end|run.lock/);
    expect(() => l.reconcile("e1", 1, "x")).toThrow(/note/);
    l.reconcile("e1", 1, "checked the connected account dashboard: empty");
    expect(l.startBlockers("e1", 5)).toEqual([]);
    expect(l.runsStarted("e1")).toBe(1);
  });

  it("refuses a second concurrent run (exclusive lock)", () => {
    const l = mk();
    l.startRun("e1", "h", "r1");
    expect(() => l.startRun("e1", "h", "r2")).toThrow();
  });

  it("detects an edited, deleted-middle or garbage entry", () => {
    const l = mk();
    for (const n of [1, 2, 3]) l.endRun(l.startRun("e1", "h", `r${n}`), "PASS");
    const lines = readFileSync(l.file, "utf8").trim().split("\n");
    writeFileSync(l.file, [lines[0], lines[1].replace('"PASS"', '"FAIL"'), ...lines.slice(2)].join("\n") + "\n");
    expect(() => l.load()).toThrow(/chain broken/);
    writeFileSync(l.file, [lines[0], ...lines.slice(2)].join("\n") + "\n");
    expect(() => l.load()).toThrow(/chain broken/);
    appendFileSync(l.file, "not json\n");
    expect(() => l.load()).toThrow();
  });

  it("keeps counts per envelope", () => {
    const l = mk();
    l.endRun(l.startRun("e1", "h", "r1"), "PASS");
    expect(l.runsStarted("e2")).toBe(0);
    expect(l.startBlockers("e2", 1)).toEqual([]);
  });

  it("refuses to live inside a git checkout", () => {
    const d = join(REPO, "scripts", "qa", "d24-test-runner", "tmp-ledger-should-not-exist");
    expect(() => new Ledger(d)).toThrow(/outside any git/);
    expect(existsSync(d)).toBe(false);
    const nested = join(tmp(), "a");
    mkdirSync(join(nested, ".git"), { recursive: true });
    expect(() => new Ledger(join(nested, "ledger"))).toThrow(/outside any git/);
  });
});
