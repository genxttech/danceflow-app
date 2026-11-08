// Reads the tip of one ref of the pinned repository over git's smart-HTTP discovery request, WITHOUT git: no repository, no config, no hooks, no
// url.<x>.insteadOf, nothing on disk that an agent can write. The only things left in the path are TLS trust and the network (conceded in the design doc).
// Read-only GET of <url>/info/refs?service=git-upload-pack. Anonymous. Never Stripe, never a credential.

import http from "node:http";
import https from "node:https";

export type TipResult = { ok: true; sha: string } | { ok: false; why: string };
export type HttpGet = (url: URL) => Promise<{ status: number; contentType: string; body: Buffer }>;

const MAX_BODY = 8 * 1024 * 1024;

/** Parses a protocol v0/v1 ref advertisement. The ref name must match EXACTLY and appear exactly once (a tail match like refs/heads/x/refs/heads/main is not it). */
export function parseAdvertisement(buf: Buffer, ref: string): TipResult {
  const refs: Array<[string, string]> = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.toString("latin1", off, off + 4);
    if (!/^[0-9a-f]{4}$/.test(hex)) return { ok: false, why: "malformed pkt-line in the ref advertisement" };
    const len = parseInt(hex, 16);
    if (len === 0) {
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) return { ok: false, why: "truncated pkt-line in the ref advertisement" };
    let line = buf.toString("latin1", off + 4, off + len);
    off += len;
    line = line.replace(/\n$/, "");
    const nul = line.indexOf("\0");
    if (nul >= 0) line = line.slice(0, nul);
    const m = /^([0-9a-f]{40}) (.+)$/.exec(line);
    if (m) refs.push([m[2], m[1]]);
  }
  const hits = refs.filter(([name]) => name === ref);
  if (hits.length === 0) return { ok: false, why: `${ref} is not advertised by the pinned repository` };
  if (hits.length > 1) return { ok: false, why: `${ref} is advertised more than once (ambiguous)` };
  return { ok: true, sha: hits[0][1] };
}

export const defaultGet: HttpGet = (url) =>
  new Promise((resolve, reject) => {
    const lib = url.protocol === "http:" ? http : https;
    const req = lib.request(url, { method: "GET", headers: { "User-Agent": "git/2.50.0", Accept: "*/*", Pragma: "no-cache" }, timeout: 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on("data", (c: Buffer) => {
        n += c.length;
        if (n > MAX_BODY) {
          req.destroy(new Error("response too large"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });

/** No redirects are followed and nothing but a 200 advertisement is accepted: any anomaly is a refusal. */
export async function nodeTip(repoUrl: string, ref: string, get: HttpGet = defaultGet): Promise<TipResult> {
  let url: URL;
  try {
    url = new URL(repoUrl.replace(/\/+$/, "") + "/info/refs?service=git-upload-pack");
  } catch {
    return { ok: false, why: "the pinned repository URL is not a valid URL" };
  }
  try {
    const r = await get(url);
    if (r.status !== 200) return { ok: false, why: `the pinned repository answered HTTP ${r.status} (the gate needs anonymous read access, or a public mirror: owner decision)` };
    if (!/application\/x-git-upload-pack-advertisement/.test(r.contentType)) return { ok: false, why: "the pinned repository did not return a git ref advertisement" };
    return parseAdvertisement(r.body, ref);
  } catch (e) {
    return { ok: false, why: `could not read the pinned repository: ${String((e as Error).message)}` };
  }
}
