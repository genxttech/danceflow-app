import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envelopeFingerprint } from "../fingerprint";
import { ASSERTION_FILE, ENVELOPE_FILE, launch, MAX_INBOX_FILE_BYTES, pendingRuns, type LauncherDeps } from "../launcher";
import { makeEnvelope, tmp } from "./helpers";
import { makeAssertion, testAuth } from "./softauth";

const AFP = testAuth.anchor.fingerprintSha256;
function setup(runs: Record<string, object | string> = {}) {
  const inbox = tmp("d24-inbox-");
  for (const [id, body] of Object.entries(runs)) {
    mkdirSync(join(inbox, id), { recursive: true });
    writeFileSync(join(inbox, id, ENVELOPE_FILE), typeof body === "string" ? body : JSON.stringify(body));
  }
  return inbox;
}
function deps(inbox: string, over: Partial<LauncherDeps> = {}, typed?: (fp: string) => string) {
  const lines: string[] = [];
  const taps: string[] = [];
  const d: LauncherDeps = {
    inbox,
    expectedAnchorFingerprint: AFP,
    out: (l) => void lines.push(l),
    confirm: async (q) => (typed ? typed(/\(([0-9A-F]{4})\)/.exec(q)![1]) : /\(([0-9A-F]{4})\)/.exec(q)![1]),
    tap: async (h) => {
      taps.push(h);
      return makeAssertion(testAuth, h, { signCount: 3 });
    },
    ...over,
  };
  return { d, lines, taps };
}

describe("launcher", () => {
  it("shows the fingerprint and terms BEFORE asking, requires the typed first group, then taps once and writes the assertion", async () => {
    const e = makeEnvelope();
    const inbox = setup({ "run-0001": e });
    const order: string[] = [];
    const { d, lines, taps } = deps(inbox, { confirm: async (q) => (order.push(`ask:${lines.length}`), /\(([0-9A-F]{4})\)/.exec(q)![1]) });
    const r = await launch(d);
    expect(r).toMatchObject({ ok: true, runId: "run-0001", fingerprint: envelopeFingerprint(e.envelopeSha256) });
    expect(order[0]).toMatch(/^ask:[1-9]/); // terms were already printed when the question was asked
    expect(lines.join("\n")).toContain(envelopeFingerprint(e.envelopeSha256));
    expect(taps).toEqual([e.envelopeSha256]);
    const written = JSON.parse(readFileSync(join(inbox, "run-0001", ASSERTION_FILE), "utf8"));
    expect(written.envelopeSha256).toBe(e.envelopeSha256);
  });

  it("a wrong or empty typed group raises NO tap and writes nothing", async () => {
    const e = makeEnvelope();
    for (const t of ["", "0000", "yes"]) {
      const inbox = setup({ "run-0001": e });
      const { d, taps } = deps(inbox, {}, () => t);
      const r = await launch(d);
      expect(r.ok).toBe(false);
      expect(taps).toEqual([]);
      expect(existsSync(join(inbox, "run-0001", ASSERTION_FILE))).toBe(false);
    }
  });

  it("refuses when zero or more than one envelope is pending", async () => {
    const e = makeEnvelope();
    expect((await launch(deps(setup()).d)).why).toMatch(/nothing is pending/);
    const two = deps(setup({ "run-0001": e, "run-0002": makeEnvelope({ envelopeId: "unit-env-2" }) }));
    const r = await launch(two.d);
    expect(r.why).toMatch(/2 envelopes are pending/);
    expect(two.taps).toEqual([]);
  });

  it("an envelope already holding an assertion is not pending again", () => {
    const inbox = setup({ "run-0001": makeEnvelope() });
    writeFileSync(join(inbox, "run-0001", ASSERTION_FILE), "{}");
    expect(pendingRuns(inbox)).toEqual([]);
  });

  it("refuses an invalid envelope, an envelope for another anchor, a tampered hash, and oversize or non-JSON files before any tap", async () => {
    const e = makeEnvelope();
    const cases: Array<[string, object | string]> = [
      ["not json", "{nope"],
      ["edited body, old hash", { ...e, maxRuns: 1 }],
      ["unknown field", { ...e, extra: true }],
      ["oversize", " ".repeat(MAX_INBOX_FILE_BYTES + 1)],
    ];
    for (const [name, body] of cases) {
      const { d, taps } = deps(setup({ "run-0001": body }));
      const r = await launch(d);
      expect(r.ok, name).toBe(false);
      expect(taps, name).toEqual([]);
    }
    const other = deps(setup({ "run-0001": e }), { expectedAnchorFingerprint: "e".repeat(64) });
    expect((await launch(other.d)).why).toMatch(/different hardware anchor/);
    expect(other.taps).toEqual([]);
  });

  it("a failing authenticator, or an assertion naming another envelope, writes nothing", async () => {
    const e = makeEnvelope();
    const a = setup({ "run-0001": e });
    expect((await launch(deps(a, { tap: async () => { throw new Error("cancelled"); } }).d)).ok).toBe(false);
    expect(existsSync(join(a, "run-0001", ASSERTION_FILE))).toBe(false);
    const b = setup({ "run-0001": e });
    const r = await launch(deps(b, { tap: async () => makeAssertion(testAuth, "ab".repeat(32)) }).d);
    expect(r.why).toMatch(/different envelope hash/);
    expect(existsSync(join(b, "run-0001", ASSERTION_FILE))).toBe(false);
  });

  it("ignores directory names that are not well-formed run ids", () => {
    const inbox = setup({ a: "x", "bad name": "x" });
    expect(pendingRuns(inbox)).toEqual([]);
  });
});
