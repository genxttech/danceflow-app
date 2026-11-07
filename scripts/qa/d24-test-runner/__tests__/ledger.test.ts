import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger, MAX_RUNS_PER_KEY } from "../ledger";
import { REPO, tmp } from "./helpers";

const L = { maxRuns: 9, keyFp: "k1" };
const NOWF = () => new Date("2026-11-07T12:00:00Z");
const mk = () => new Ledger(join(tmp(), "ledger"), NOWF);
const mkAnchored = () => new Ledger(join(tmp(), "ledger"), NOWF, join(tmp(), "anchor.json"));
/** Simulates a crashed runner: the lock names a process that no longer exists. */
const killLockHolder = (l: Ledger) => writeFileSync(l.lockFile, JSON.stringify({ pid: 2_147_483_000, runId: "x", atUtc: "2026-11-07T12:00:00Z" }));

describe("run ledger", () => {
  it("counts a run at start; a failed or aborted run still consumes it", () => {
    const l = mk();
    expect(l.startBlockers("e1", 2)).toEqual([]);
    const s1 = l.startRun("e1", "h", "r1", L);
    l.endRun(s1, "FAIL");
    expect(l.runsStarted("e1")).toBe(1);
    expect(l.startBlockers("e1", 2)).toEqual([]);
    const s2 = l.startRun("e1", "h", "r2", L);
    l.endRun(s2, "UNVERIFIABLE");
    expect(l.startBlockers("e1", 2).join()).toMatch(/exhausted: 2 of 2/);
  });

  it("an unfinished run (crash) blocks new runs until reconciled, and reconcile does not give the run back", () => {
    const l = mk();
    l.startRun("e1", "h", "r1", L);
    expect(l.startBlockers("e1", 5).join()).toMatch(/no recorded end|run.lock/);
    killLockHolder(l);
    expect(() => l.reconcile("e1", 1, "x")).toThrow(/note/);
    l.reconcile("e1", 1, "checked the connected account dashboard: empty");
    expect(l.startBlockers("e1", 5)).toEqual([]);
    expect(l.runsStarted("e1")).toBe(1);
  });

  it("reconcile refuses to close a run whose process is still alive, and keeps the lock (P3)", () => {
    const l = mk();
    l.startRun("e1", "h", "r1", L); // lock names THIS process, which is alive
    expect(l.lockHolderAlive()).toBe(true);
    expect(() => l.reconcile("e1", 1, "checked the dashboard: nothing there")).toThrow(/still running/);
    expect(existsSync(l.lockFile)).toBe(true);
    expect(l.load().map((e) => e.type)).toEqual(["run-start"]);
  });

  it("refuses a second concurrent run (exclusive lock)", () => {
    const l = mk();
    l.startRun("e1", "h", "r1", L);
    expect(() => l.startRun("e1", "h", "r2", L)).toThrow();
  });

  it("detects an edited, deleted-middle or garbage entry", () => {
    const l = mk();
    for (const n of [1, 2, 3]) l.endRun(l.startRun("e1", "h", `r${n}`, L), "PASS");
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
    l.endRun(l.startRun("e1", "h", "r1", L), "PASS");
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

describe("ledger binds to the envelope HASH and the credential (P2-1)", () => {
  const bind = (h: string, k = "k1") => ({ envelopeSha256: h, keyFp: k });
  it("the same envelope id re-hashed (e.g. a higher maxRuns) does not get a fresh budget", () => {
    const l = mk();
    l.endRun(l.startRun("e1", "hash-A", "r1", { maxRuns: 1, keyFp: "k1" }), "PASS");
    expect(l.startBlockers("e1", 1, bind("hash-A")).join()).toMatch(/exhausted/);
    expect(l.startBlockers("e1", 5, bind("hash-B")).join()).toMatch(/different hash/);
    expect(() => l.startRun("e1", "hash-B", "r2", { maxRuns: 5, keyFp: "k1" })).toThrow(/different hash/);
    expect(existsSync(l.lockFile)).toBe(false); // the failed start released its lock
  });
  it("a new envelope id cannot mint a fresh budget for the same key (per-credential cap)", () => {
    const l = mk();
    for (let i = 1; i <= MAX_RUNS_PER_KEY; i++) l.endRun(l.startRun(`env-${i}`, `h${i}`, `r${i}`, { maxRuns: 1, keyFp: "k1" }), "PASS");
    expect(l.startBlockers("env-new", 1, bind("hnew", "k1")).join()).toMatch(/credential run cap reached/);
    expect(l.startBlockers("env-new", 1, bind("hnew", "other-key"))).toEqual([]);
  });
});

describe("tail truncation and ledger replacement are detected via the anchor (P2-1)", () => {
  it("removing the tail entries fails closed", () => {
    const l = mkAnchored();
    for (const n of [1, 2]) l.endRun(l.startRun("e1", "h", `r${n}`, L), "PASS");
    const lines = readFileSync(l.file, "utf8").trim().split("\n");
    writeFileSync(l.file, lines.slice(0, 2).join("\n") + "\n"); // a valid chain prefix: only the anchor can notice
    expect(() => l.load()).toThrow(/shorter than its anchor/);
    expect(() => l.startBlockers("e1", 2)).toThrow();
  });
  it("deleting the whole ledger file fails closed", () => {
    const l = mkAnchored();
    l.endRun(l.startRun("e1", "h", "r1", L), "PASS");
    unlinkSync(l.file);
    expect(() => l.load()).toThrow(/shorter than its anchor/);
  });
  it("a different history of the same length diverges from the anchor", () => {
    const a = mkAnchored();
    const b = new Ledger(join(tmp(), "ledger-b"), NOWF);
    a.endRun(a.startRun("e1", "h", "r1", L), "PASS");
    b.endRun(b.startRun("other", "h", "r1", L), "PASS");
    writeFileSync(a.file, readFileSync(b.file, "utf8"));
    expect(() => a.load()).toThrow(/diverges from its anchor/);
  });
  it("a missing anchor while entries exist fails closed (anchor deleted)", () => {
    const l = mkAnchored();
    l.endRun(l.startRun("e1", "h", "r1", L), "PASS");
    unlinkSync(l.anchorFile as string);
    expect(() => l.load()).toThrow(/anchor file is missing/);
  });
  it("a crash between ledger write and anchor write is tolerated (anchor behind the ledger)", () => {
    const l = mkAnchored();
    l.endRun(l.startRun("e1", "h", "r1", L), "PASS");
    const behind = readFileSync(l.anchorFile as string, "utf8");
    l.startRun("e1", "h", "r2", { maxRuns: 9, keyFp: "k1" });
    writeFileSync(l.anchorFile as string, behind);
    expect(l.load()).toHaveLength(3);
  });
});

describe("startRun re-checks under the lock (P2-1 race)", () => {
  it("run 2 of 1: B passes the early check, A completes, B's startRun must still refuse", () => {
    const dir = join(tmp(), "ledger");
    const a = new Ledger(dir, NOWF);
    const b = new Ledger(dir, NOWF); // second invocation, same directory
    expect(b.startBlockers("e1", 1, { envelopeSha256: "h", keyFp: "k1" })).toEqual([]); // B's early (advisory) check
    a.endRun(a.startRun("e1", "h", "rA", { maxRuns: 1, keyFp: "k1" }), "PASS"); // A starts and finishes
    expect(() => b.startRun("e1", "h", "rB", { maxRuns: 1, keyFp: "k1" })).toThrow(/re-checked under the lock.*exhausted/);
    expect(a.runsStarted("e1")).toBe(1);
    expect(existsSync(a.lockFile)).toBe(false);
  });
  it("B also refuses when A's run is still unclosed", () => {
    const dir = join(tmp(), "ledger");
    const a = new Ledger(dir, NOWF);
    const b = new Ledger(dir, NOWF);
    a.startRun("e1", "h", "rA", { maxRuns: 3, keyFp: "k1" });
    expect(() => b.startRun("e1", "h", "rB", { maxRuns: 3, keyFp: "k1" })).toThrow(); // lock held
    expect(b.runsStarted("e1")).toBe(1);
  });
  it("two simultaneous starters: exactly one wins", async () => {
    const dir = join(tmp(), "ledger");
    const results = await Promise.allSettled([1, 2, 3].map(async (i) => new Ledger(dir, NOWF).startRun("e1", "h", `r${i}`, { maxRuns: 1, keyFp: "k1" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(new Ledger(dir, NOWF).runsStarted("e1")).toBe(1);
  });
});
