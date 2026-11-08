import { Readable } from "node:stream";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, provision, selfTest } from "../cli";
import { MemoryStore } from "../credstore";
import { approvalTemplate } from "../envelope";
import { baseSpec, KEY, tmp } from "./helpers";

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};
const stdinOf = (text: string) => Object.assign(Readable.from([text]), { isTTY: false }) as unknown as NodeJS.ReadStream;
const opts = (o: Record<string, string | true>) => new Map(Object.entries(o));

describe("cli", () => {
  it("refuses positional arguments so a secret can never be put on the command line", async () => {
    const t = io();
    expect(await main(["provision", KEY], t.io)).toBe(2);
    expect(await main(["provision", "--label", "x", KEY], t.io)).toBe(2);
    expect(t.err.join("\n")).not.toContain(KEY);
  });

  it("provision reads the key from stdin, stores it, prints a fingerprint but never the key", async () => {
    const t = io();
    const store = new MemoryStore();
    expect(await provision(opts({ label: "unit-label" }), t.io, stdinOf(`${KEY}\n`), tmp(), store)).toBe(0);
    expect(store.map.get("unit-label")).toBe(KEY);
    const printed = [...t.out, ...t.err].join("\n");
    expect(printed).not.toContain(KEY);
    expect(printed).toMatch(/fingerprint[^:]*: [0-9a-f]{16}/);
  });

  it("provision refuses sk_, live and pk_ keys and echoes nothing", async () => {
    for (const bad of [["sk", "test", "AAAAAAAAAAAAAAAA"], ["rk", "live", "AAAAAAAAAAAAAAAA"], ["pk", "test", "AAAAAAAAAAAAAAAA"], ["not-a-key"]].map((p) => p.join("_"))) {
      const t = io();
      const store = new MemoryStore();
      expect(await provision(opts({ label: "unit-label" }), t.io, stdinOf(bad), tmp(), store)).toBe(2);
      expect(store.map.size).toBe(0);
      expect([...t.out, ...t.err].join("\n")).not.toContain(bad);
    }
  });

  it("provision --check shows only a fingerprint; --remove deletes", async () => {
    const t = io();
    const store = new MemoryStore();
    await store.write("unit-label", KEY);
    expect(await provision(opts({ label: "unit-label", check: true }), t.io, stdinOf(""), tmp(), store)).toBe(0);
    expect(t.out.join("\n")).not.toContain(KEY);
    expect(await provision(opts({ label: "unit-label", remove: true }), t.io, stdinOf(""), tmp(), store)).toBe(0);
    expect(store.map.size).toBe(0);
  });

  it("create-envelope requires the owner's approval file; it cannot invent one", async () => {
    const t = io();
    const dir = tmp();
    const spec = baseSpec();
    writeFileSync(join(dir, "spec.json"), JSON.stringify(spec));
    expect(await main(["create-envelope", "--spec", join(dir, "spec.json"), "--out", join(dir, "e.json")], t.io)).toBe(2);
    writeFileSync(join(dir, "bad.txt"), "Approved: D24 M3-D Stripe TEST proof as written");
    expect(await main(["create-envelope", "--spec", join(dir, "spec.json"), "--approval-file", join(dir, "bad.txt"), "--approval-ref", "chat", "--out", join(dir, "e.json")], t.io)).toBe(2);
    writeFileSync(join(dir, "good.txt"), `${approvalTemplate(spec)}\n`);
    expect(await main(["create-envelope", "--spec", join(dir, "spec.json"), "--approval-file", join(dir, "good.txt"), "--approval-ref", "chat 2026-11-07", "--out", join(dir, "e.json")], t.io)).toBe(0);
    expect(await main(["validate-envelope", "--envelope", join(dir, "e.json")], t.io)).toBe(0);
    const e = JSON.parse(readFileSync(join(dir, "e.json"), "utf8"));
    e.maxRuns = 5;
    writeFileSync(join(dir, "e2.json"), JSON.stringify(e));
    expect(await main(["validate-envelope", "--envelope", join(dir, "e2.json")], t.io)).toBe(2);
  });

  it("the dry self-test passes end to end with no store access", async () => {
    const t = io();
    expect(await selfTest(t.io, () => new Date())).toBe(0);
    expect(t.out.join("\n")).toMatch(/DECISION: PASS/);
    expect(t.out.join("\n")).toMatch(/DRY: fake key injected; the credential store was not accessed/);
  });
});
