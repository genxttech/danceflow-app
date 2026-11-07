// Append-only, hash-chained run ledger kept OUTSIDE git. A run is counted when it STARTS (before any live call), so a failed, aborted or
// crashed run still consumes one. A start without an end blocks further runs until a human reconciles it (cleanup may be incomplete).

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, sha256 } from "./canon";

export type LedgerEntry = {
  seq: number;
  atUtc: string;
  type: "run-start" | "run-end" | "reconcile";
  envelopeId: string;
  envelopeSha256: string;
  runNo: number;
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
  constructor(readonly dir: string, private readonly now: () => Date = () => new Date()) {
    if (insideGitCheckout(dir)) throw new Error("the run ledger must live outside any git checkout or worktree");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "ledger.jsonl");
    this.lockFile = join(dir, "run.lock");
  }

  /** Reads and verifies the hash chain. Throws on any tampering we can detect (edited, reordered or removed middle entries). */
  load(): LedgerEntry[] {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").split("\n").filter((l) => l.trim() !== "");
    const out: LedgerEntry[] = [];
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
    return out;
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
    return entry;
  }

  runsStarted(envelopeId: string): number {
    return this.load().filter((e) => e.type === "run-start" && e.envelopeId === envelopeId).length;
  }

  /** Problems that forbid starting another run for this envelope (empty = may start). */
  startBlockers(envelopeId: string, maxRuns: number): string[] {
    const entries = this.load();
    const out: string[] = [];
    const starts = entries.filter((e) => e.type === "run-start" && e.envelopeId === envelopeId);
    if (starts.length >= maxRuns) out.push(`run count exhausted: ${starts.length} of ${maxRuns} runs already consumed for this envelope (a failed or aborted run counts)`);
    for (const s of entries.filter((e) => e.type === "run-start")) {
      const closed = entries.some((x) => (x.type === "run-end" || x.type === "reconcile") && x.envelopeId === s.envelopeId && x.runNo === s.runNo);
      if (!closed) out.push(`run ${s.runNo} of envelope ${s.envelopeId} started at ${s.atUtc} has no recorded end: reconcile it (cleanup may be incomplete) before any new run`);
    }
    if (existsSync(this.lockFile)) out.push("run.lock exists: another run is in progress, or a previous run died; reconcile it");
    return out;
  }

  /** Writes the lock and the run-start entry. The caller must have checked startBlockers. */
  startRun(envelopeId: string, envelopeSha256: string, runId: string): LedgerEntry {
    const fd = openSync(this.lockFile, "wx", 0o600); // exclusive: a second concurrent runner fails here
    closeSync(fd);
    const runNo = this.runsStarted(envelopeId) + 1;
    return this.append({ type: "run-start", envelopeId, envelopeSha256, runNo, runId });
  }

  endRun(start: LedgerEntry, outcome: string): LedgerEntry {
    const e = this.append({ type: "run-end", envelopeId: start.envelopeId, envelopeSha256: start.envelopeSha256, runNo: start.runNo, runId: start.runId, outcome });
    if (existsSync(this.lockFile)) unlinkSync(this.lockFile);
    return e;
  }

  /** Human acknowledgement of an unfinished run (after checking the Stripe dashboard). Does NOT give the run back. */
  reconcile(envelopeId: string, runNo: number, note: string): LedgerEntry {
    const s = this.load().find((e) => e.type === "run-start" && e.envelopeId === envelopeId && e.runNo === runNo);
    if (!s) throw new Error("no such run in the ledger");
    if (note.trim().length < 10) throw new Error("a reconcile note (what was checked, where) of at least 10 characters is required");
    const e = this.append({ type: "reconcile", envelopeId, envelopeSha256: s.envelopeSha256, runNo, note });
    if (existsSync(this.lockFile)) unlinkSync(this.lockFile);
    return e;
  }
}
