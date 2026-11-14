// The branch tip is read without git. Parser tests on canned pkt-lines, and the HTTP client against a LOCAL http server (127.0.0.1): no internet.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { nodeTip, parseAdvertisement } from "../remotetip";

const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const adv = (...lines: string[]) => Buffer.from(`${pkt("# service=git-upload-pack\n")}0000${lines.map((l, i) => pkt(i === 0 ? `${l}\0multi_ack side-band-64k\n` : `${l}\n`)).join("")}0000`, "latin1");

describe("parseAdvertisement", () => {
  it("returns the sha of the exact ref (capabilities after NUL on the first line are ignored)", () => {
    expect(parseAdvertisement(adv(`${A} HEAD`, `${B} refs/heads/main`, `${C} refs/heads/other`), "refs/heads/main")).toEqual({ ok: true, sha: B });
    expect(parseAdvertisement(adv(`${B} refs/heads/main`), "refs/heads/main")).toEqual({ ok: true, sha: B });
  });

  it("N5: a ref that merely ENDS with the pinned name is not it, even when it sorts first", () => {
    const r = parseAdvertisement(adv(`${A} refs/heads/aaa/refs/heads/main`, `${B} refs/heads/main`), "refs/heads/main");
    expect(r).toEqual({ ok: true, sha: B });
    expect(parseAdvertisement(adv(`${A} refs/heads/aaa/refs/heads/main`), "refs/heads/main").ok).toBe(false);
  });

  it("a missing ref, a duplicated ref and malformed or truncated data are refusals", () => {
    expect(parseAdvertisement(adv(`${A} refs/heads/other`), "refs/heads/main").ok).toBe(false);
    expect(parseAdvertisement(adv(`${A} refs/heads/main`, `${B} refs/heads/main`), "refs/heads/main")).toMatchObject({ ok: false, why: expect.stringMatching(/more than once/) });
    expect(parseAdvertisement(Buffer.from("zzzz"), "refs/heads/main").ok).toBe(false);
    expect(parseAdvertisement(Buffer.from("0fff short"), "refs/heads/main").ok).toBe(false);
    expect(parseAdvertisement(Buffer.alloc(0), "refs/heads/main").ok).toBe(false);
  });
});

async function withServer(handler: http.RequestListener, fn: (base: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/o/r.git`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe("nodeTip against a local server", () => {
  it("asks for info/refs?service=git-upload-pack anonymously and parses the answer", async () => {
    let seen = "";
    let auth: string | undefined;
    await withServer((req, res) => {
      seen = req.url ?? "";
      auth = req.headers.authorization;
      res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-advertisement" });
      res.end(adv(`${A} HEAD`, `${B} refs/heads/main`));
    }, async (base) => {
      expect(await nodeTip(base, "refs/heads/main")).toEqual({ ok: true, sha: B });
    });
    expect(seen).toBe("/o/r.git/info/refs?service=git-upload-pack");
    expect(auth).toBeUndefined();
  });

  it("a 401/404 (private repository) is a refusal that names the anonymous-access requirement and the owner decision", async () => {
    await withServer((_q, res) => { res.writeHead(404); res.end("no"); }, async (base) => {
      const r = await nodeTip(base, "refs/heads/main");
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.why).toMatch(/anonymous read access/);
      expect(r.ok === false && r.why).toMatch(/owner decision/);
    });
  });

  it("a redirect is not followed, and a non-advertisement answer is refused", async () => {
    await withServer((_q, res) => { res.writeHead(302, { Location: "http://127.0.0.1:1/x" }); res.end(); }, async (base) => {
      expect((await nodeTip(base, "refs/heads/main")).ok).toBe(false);
    });
    await withServer((_q, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(adv(`${B} refs/heads/main`)); }, async (base) => {
      expect((await nodeTip(base, "refs/heads/main")).ok).toBe(false);
    });
  });

  it("a connection failure or an invalid URL is a refusal, not an exception", async () => {
    expect((await nodeTip("http://127.0.0.1:1/o/r.git", "refs/heads/main")).ok).toBe(false);
    expect((await nodeTip("not a url", "refs/heads/main")).ok).toBe(false);
  });
});
