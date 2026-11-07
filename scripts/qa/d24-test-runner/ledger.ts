// Append-only, hash-chained run ledger kept OUTSIDE git. A run is counted when it STARTS (before any live call), so a failed, aborted or
// crashed run still consumes one. A start without an end blocks further runs until a human reconciles it (cleanup may be incomplete).
// The chain head is also recorded in a SECOND location (the anchor file) so truncating the tail or replacing the ledger is detected.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, sha256 } from "./canon";

/** Per-credential cap across ALL envelopes: a new envelope id cannot mint a fresh budget for the same key. */
export const MAX_RUNS_PER_KEY = 5;
export type Anchor = { count: number; head: string };

export type LedgerEntry = {
  seq: number;
  atUtc: string;
  type: "run-start" | "run-end" | "reconcile";
  envelopeId: string;
  envelopeSha256: string;
  runNo: number;
  keyFp?: string;
  runId?: string;
  outcome?: string;
  note?: string;
  prev: string;
  hash: string;
};

const GENESIS = "0".repeat(64);

/** True when `dir` (or any existing ancestor) holds a .git entry: the ledger must never live in a checkout. */
export function insideGitCheckout(dir: string): boolean {
  let cur = resolve(dir);
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  cur = realpathSync(cur);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return true;
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

export class Ledger {
  readonly file: string;
  readonly lockFile: string;
  /** `anchorFile` (a second location, outside the ledger directory) records the entry count and head hash after every append. */
  constructor(readonly dir: string, private readonly now: () => Date = () => new Date(), readonly anchorFile?: string) {
    if (insideGitCheckout(dir)) throw new Error("the run ledger must live outside any git checkout or worktree");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "ledger.jsonl");
    this.lockFile = join(dir, "run.lock");
  }

  /** Reads and verifies the hash chain and the anchor. Throws on any tampering we can detect (edited, reordered, removed or truncated entries). */
  load(): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    if (existsSync(this.file)) {
      const lines = readFileSync(this.file, "utf8").split("\n").filter((l) => l.trim() !== "");
      let prev = GENESIS;
      for (const [i, line] of lines.entries()) {
        let e: LedgerEntry;
        try {
          e = JSON.parse(line) as LedgerEntry;
        } catch {
          throw new Error(`ledger line ${i + 1} is not valid JSON (tampered or corrupt)`);
        }
        const { hash, ...rest } = e;
        if (e.seq !== i + 1 || e.prev !== prev || sha256(prev + canonicalJson(rest)) !== hash) throw new Error(`ledger chain broken at entry ${i + 1} (tampered or corrupt)`);
        prev = hash;
        out.push(e);
      }
    }
    this.checkAnchor(out);
    return out;
  }

  private readAnchor(): Anchor | null {
    if (!this.anchorFile || !existsSync(this.anchorFile)) return null;
    let a: Anchor;
    try {
      a = JSON.parse(readFileSync(this.anchorFile, "utf8")) as Anchor;
    } catch {
      throw new Error("ledger anchor is not valid JSON (tampered or corrupt)");
    }
    if (!Number.isInteger(a.count) || a.count < 0 || typeof a.head !== "string") throw new Error("ledger anchor is malformed (tampered or corrupt)");
    return a;
  }

  /** Fails closed when the ledger is shorter than, or diverges from, the independently recorded anchor. */
  private checkAnchor(entries: LedgerEntry[]): void {
    if (!this.anchorFile) return;
    const a = this.readAnchor();
    if (!a) {
      if (entries.length > 0) throw new Error("ledger anchor file is missing while the ledger has entries (anchor deleted or ledger replaced); refusing to run");
      return;
    }
    if (entries.length < a.count) throw new Error(`ledger is shorter than its anchor (${entries.length} < ${a.count}): entries were removed; refusing to run`);
    if (a.count > 0 && entries[a.count - 1].hash !== a.head) throw new Error("ledger diverges from its anchor (history was rewritten); refusing to run");
  }

  private writeAnchor(entries: LedgerEntry[]): void {
    if (!this.anchorFile) return;
    mkdirSync(dirname(this.anchorFile), { recursive: true });
    const tmp = `${this.anchorFile}.tmp`;
    const a: Anchor = { count: entries.length, head: entries.length ? entries[entries.length - 1].hash : GENESIS };
    writeFileSync(tmp, JSON.stringify(a), { mode: 0o600 });
    renameSync(tmp, this.anchorFile);
  }

  private append(partial: Omit<LedgerEntry, "seq" | "atUtc" | "prev" | "hash">): LedgerEntry {
    const entries = this.load();
    const prev = entries.length ? entries[entries.length - 1].hash : GENESIS;
    const rest = { seq: entries.length + 1, atUtc: this.now().toISOString(), ...partial, prev };
    const entry = { ...rest, hash: sha256(prev + canonicalJson(rest)) } as LedgerEntry;
    const fd = openSync(this.file, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.writeAnchor([...entries, entry]);
    return entry;
  }

  runsStarted(envelopeId: string): number {
    return this.load().filter((e) => e.type === "run-start" && e.envelopeId === envelopeId).length;
  }

  /** The next run number for an envelope (display and runDir only; the authoritative number is assigned inside startRun). */
  nextRunNo(envelopeId: string): number {
    return this.runsStarted(envelopeId) + 1;
  }

  /**
   * Problems that forbid starting another run (empty = may start). Counts are bound to the envelope HASH, not only its id: the same id under a
   * different hash is refused, and a per-credential cap spans every envelope. `ignoreLock` is for the re-check made while holding the lock.
   */
  startBlockers(envelopeId: string, maxRuns: number, bind?: { envelopeSha256: string; keyFp: string }, ignoreLock = false): string[] {
    const entries = this.load();
    const out: string[] = [];
    const starts = entries.filter((e) => e.type === "run-start" && e.envelopeId === envelopeId);
    if (starts.length >= maxRuns) out.push(`run count exhausted: ${starts.length} of ${maxRuns} runs already consumed for this envelope (a failed or aborted run counts)`);
    if (bind) {
      const other = entries.find((e) => e.envelopeId === envelopeId && e.envelopeSha256 !== bind.envelopeSha256);
      if (other) out.push(`envelope id ${envelopeId} was first seen with a different hash (${other.envelopeSha256.slice(0, 12)}); a re-hashed envelope does not get a fresh run budget`);
      const perKey = entries.filter((e) => e.type === "run-start" && e.keyFp === bind.keyFp).length;
      if (perKey >= MAX_RUNS_PER_KEY) out.push(`credential run cap reached: ${perKey} of ${MAX_RUNS_PER_KEY} runs already used with this key across all envelopes (rotate the key)`);
    }
    for (const s of entries.filter((e) => e.type === "run-start")) {
      const closed = entries.some((x) => (x.type === "run-end" || x.type === "reconcile") && x.envelopeId === s.envelopeId && x.runNo === s.runNo);
      if (!closed) out.push(`run ${s.runNo} of envelope ${s.envelopeId} started at ${s.atUtc} has no recorded end: reconcile it (cleanup may be incomplete) before any new run`);
    }
    if (!ignoreLock && existsSync(this.lockFile)) out.push("run.lock exists: another run is in progress, or a previous run died; reconcile it");
    return out;
  }

  /**
   * Takes the exclusive lock, then RE-EVALUATES every blocker while holding it (the early check in the runner is advisory; this is the
   * authoritative one), then appends the run-start. Two concurrent invocations cannot both pass: the loser fails on the lock or sees the
   * winner's entry.
   */
  startRun(envelopeId: string, envelopeSha256: string, runId: string, limits: { maxRuns: number; keyFp: string }): LedgerEntry {
    const fd = openSync(this.lockFile, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, runId, atUtc: this.now().toISOString() }));
    } finally {
      closeSync(fd);
    }
    try {
      const blockers = this.startBlockers(envelopeId, limits.maxRuns, { envelopeSha256, keyFp: limits.keyFp }, true);
      if (blockers.length > 0) throw new Error(`cannot start the run (re-checked under the lock): ${blockers.join(" | ")}`);
      const runNo = this.runsStarted(envelopeId) + 1;
      return this.append({ type: "run-start", envelopeId, envelopeSha256, runNo, runId, keyFp: limits.keyFp });
    } catch (e) {
      if (existsSync(this.lockFile)) unlinkSync(this.lockFile);
      throw e;
    }
  }

  /** Closes a run and releases the lock. Not called after a timeout: a run whose child may still be alive stays open and locked. */
  endRun(start: LedgerEntry, outcome: string): LedgerEntry {
    const e = this.append({ type: "run-end", envelopeId: start.envelopeId, envelopeSha256: start.envelopeSha256, runNo: start.runNo, runId: start.runId, outcome });
    if (existsSync(this.lockFile)) unlinkSync(this.lockFile);
    return e;
  }

  /** True when run.lock names a process that is still alive: that run may still be making calls. */
  lockHolderAlive(): boolean {
    if (!existsSync(this.lockFile)) return false;
    try {
      const { pid } = JSON.parse(readFileSync(this.lockFile, "utf8")) as { pid?: number };
      if (!Number.isInteger(pid)) return true; // unreadable lock: assume the run is live
      process.kill(pid as number, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /** Human acknowledgement of an unfinished run (after checking the Stripe dashboard). Does NOT give the run back and refuses while the lock holder is alive. */
  reconcile(envelopeId: string, runNo: number, note: string): LedgerEntry {
    const s = this.load().find((e) => e.type === "run-start" && e.envelopeId === envelopeId && e.runNo === runNo);
    if (!s) throw new Error("no such run in the ledger");
    if (note.trim().length < 10) throw new Error("a reconcile note (what was checked, where) of at least 10 characters is required");
    if (this.lockHolderAlive()) throw new Error("run.lock names a process that is still running: the run may still be making calls; wait for it to exit (or kill it) before reconciling");
    const e = this.append({ type: "reconcile", envelopeId, envelopeSha256: s.envelopeSha256, runNo, note });
    if (existsSync(this.lockFile)) unlinkSync(this.lockFile);
    return e;
  }
}
