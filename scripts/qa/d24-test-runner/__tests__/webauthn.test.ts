import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorFingerprint, checkAgainstState, counterFloor, emptyState, parseAnchor, readState, strictDerEcdsa, topLevelKeys, verifyAndRecord, verifyAssertion, type HardwareAnchor } from "../webauthn";
import { makeAssertion, makeSoftAuth, ORIGIN, P256_N, RP_ID, type AssertionOpts } from "./softauth";
import { tmp } from "./helpers";

const H = createHash("sha256").update("envelope-under-test").digest("hex");
const H2 = createHash("sha256").update("another-envelope").digest("hex");
const auth = makeSoftAuth();
const verify = (o: AssertionOpts = {}, stored = 0, hash = H, anchor: HardwareAnchor = auth.anchor, envelopeHash = hash) => verifyAssertion({ envelopeSha256: envelopeHash, doc: makeAssertion(auth, hash, o), anchor, storedSignCount: stored });
const reason = (r: ReturnType<typeof verifyAssertion>) => (r.ok ? "ok" : r.reason);

const derToRS = (der: Buffer) => {
  let off = 2;
  const out: bigint[] = [];
  for (let i = 0; i < 2; i++) {
    const len = der[off + 1];
    out.push(BigInt(`0x${der.subarray(off + 2, off + 2 + len).toString("hex")}`));
    off += 2 + len;
  }
  return out as [bigint, bigint];
};
const int = (v: bigint) => {
  let h = v.toString(16);
  if (h.length % 2) h = `0${h}`;
  let b = Buffer.from(h, "hex");
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return Buffer.concat([Buffer.from([0x02, b.length]), b]);
};
const derFromRS = (r: bigint, s: bigint) => {
  const body = Buffer.concat([int(r), int(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
};

describe("verifyAssertion: the accepted shape", () => {
  it("accepts a well-formed hardware-style assertion (UP+UV, device-bound, counter advanced)", () => {
    const r = verify({ signCount: 5 }, 4);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signCount).toBe(5);
  });
  it("refuses the ED (extension data) flag and any bytes beyond the 37-byte header", () => {
    expect(reason(verify({ flags: 0x85, extension: Buffer.from([0xa0]), signCount: 2 }, 1))).toMatch(/ED flag/);
    expect(reason(verify({ flags: 0x05, extension: Buffer.from([0xa0]), signCount: 2 }, 1))).toMatch(/unexpected bytes/);
    expect(reason(verify({ flags: 0x85, signCount: 2 }, 1))).toMatch(/ED flag/);
  });
  it("a token that never counts (0 -> 0) is accepted", () => {
    expect(verify({ signCount: 0 }, 0).ok).toBe(true);
  });
});

describe("verifyAssertion: binding to the envelope and the ceremony", () => {
  it("rejects an approval for a different envelope hash", () => {
    expect(reason(verifyAssertion({ envelopeSha256: H2, doc: makeAssertion(auth, H), anchor: auth.anchor, storedSignCount: 0 }))).toMatch(/different envelope hash/);
  });
  it("rejects a challenge that is the hash of ANOTHER envelope (document claims H, challenge is H2)", () => {
    expect(reason(verify({ challengeHex: H2 }))).toMatch(/challenge is not the base64url/);
  });
  it("rejects padded / standard-base64 / altered / text challenges", () => {
    const good = Buffer.from(H, "hex");
    for (const c of [good.toString("base64"), `${good.toString("base64url")}=`, good.toString("hex"), `${good.toString("base64url")}A`, ""]) expect(reason(verify({ challengeText: c })), c).toMatch(/challenge/);
  });
  it("rejects type other than webauthn.get (e.g. webauthn.create)", () => {
    expect(reason(verify({ type: "webauthn.create" }))).toMatch(/type/);
  });
  it("rejects an origin that is not exactly pinned (sub-domain, scheme, port, trailing slash)", () => {
    for (const o of ["https://evil.example.test", `${ORIGIN}/`, "http://ops.example.test", `${ORIGIN}:8443`, "https://ops.example.test.evil.com"]) expect(reason(verify({ origin: o })), o).toMatch(/origin/);
  });
  it("rejects cross-origin and embedded contexts", () => {
    expect(reason(verify({ crossOrigin: true }))).toMatch(/cross-origin/);
    expect(reason(verify({ crossOrigin: "false" }))).toMatch(/cross-origin/);
    expect(reason(verify({ topOrigin: ORIGIN }))).toMatch(/embedded/);
    expect(verify({ crossOrigin: false }).ok).toBe(true);
  });
  it("rejects a different rpId hash", () => {
    expect(reason(verify({ rpId: "evil.example.test" }))).toMatch(/rpIdHash/);
  });
  it("rejects a different credential id", () => {
    expect(reason(verify({ credentialId: "A".repeat(43) }))).toMatch(/not the pinned owner credential/);
  });
  it("rejects duplicate keys in clientDataJSON, including ones hidden behind JSON escapes, and non-JSON / non-object client data", () => {
    const good = Buffer.from(H, "hex").toString("base64url");
    const bad = Buffer.from(H2, "hex").toString("base64url");
    const dup = `{"type":"webauthn.get","challenge":"${good}","challenge":"${bad}","origin":"${ORIGIN}"}`;
    expect(reason(verify({ clientDataText: dup }))).toMatch(/duplicate key/);
    // JSON.parse keeps the LAST value; an escaped spelling of the same key must not hide the duplicate
    const esc = `{"type":"webauthn.get","challenge":"${good}","\\u0063hallenge":"${bad}","origin":"${ORIGIN}"}`;
    expect(esc).toContain("\\u0063hallenge");
    expect(reason(verify({ clientDataText: esc }))).toMatch(/duplicate key/);
    const esc2 = `{"\\u0074ype":"webauthn.get","type":"webauthn.create","challenge":"${good}","origin":"${ORIGIN}"}`;
    expect(reason(verify({ clientDataText: esc2 }))).toMatch(/duplicate key/);
    expect(reason(verify({ clientDataText: "not json" }))).toMatch(/plain JSON object/);
    expect(reason(verify({ clientDataText: "[1,2]" }))).toMatch(/plain JSON object/);
    expect(reason(verify({ clientDataText: "null" }))).toMatch(/plain JSON object/);
  });
  it("topLevelKeys decodes escapes, ignores nested keys and rejects malformed input", () => {
    expect(topLevelKeys('{"a":1,"b":{"a":2,"a":3},"c":[{"a":1}]}')).toEqual(["a", "b", "c"]);
    expect(topLevelKeys('{"\\u0061":1,"a":2}')).toEqual(["a", "a"]);
    expect(topLevelKeys('{"s":"x,\\"y}","k":1}')).toEqual(["s", "k"]);
    expect(topLevelKeys("{}")).toEqual([]);
    for (const bad of ["", "[]", '{"a"}', '{"a":1', '{"a":1,}', '{a:1}', '{"a":"unterminated}']) expect(topLevelKeys(bad), bad).toBeNull();
  });
});

describe("verifyAssertion: authenticator data flags and counter", () => {
  it("requires UP and UV", () => {
    expect(reason(verify({ flags: 0x04 }))).toMatch(/UP/);
    expect(reason(verify({ flags: 0x01 }))).toMatch(/UV/);
  });
  it("UV can NOT be waived from the anchor: an anchor with requireUV false is invalid, and even a forced one is ignored; only the test-only parameter waives it", () => {
    const lax = makeSoftAuth({ requireUV: false as unknown as true });
    const p = parseAnchor(lax.anchor);
    expect(p.ok).toBe(false);
    expect((p as { problems: string[] }).problems.join()).toMatch(/requireUV must be exactly true/);
    // a forced anchor object (bypassing parseAnchor) still cannot waive UV
    expect(reason(verifyAssertion({ envelopeSha256: H, doc: makeAssertion(lax, H, { flags: 0x01 }), anchor: lax.anchor, storedSignCount: 0 }))).toMatch(/UV/);
    // the explicit TEST-ONLY code parameter is the only way
    expect(verifyAssertion({ envelopeSha256: H, doc: makeAssertion(auth, H, { flags: 0x01 }), anchor: auth.anchor, storedSignCount: 0, testOnly: { allowNoUV: true } }).ok).toBe(true);
    for (const f of readdirSync(join(__dirname, ".."))) if (f.endsWith(".ts")) expect(readFileSync(join(__dirname, "..", f), "utf8"), f).not.toMatch(/allowNoUV:\s*true/);
  });
  it("rejects backup-eligible / backed-up (synced) credentials, attested-data and reserved bits", () => {
    expect(reason(verify({ flags: 0x0d }))).toMatch(/backup/);
    expect(reason(verify({ flags: 0x15 }))).toMatch(/backup/);
    expect(reason(verify({ flags: 0x45 }))).toMatch(/attested/);
    expect(reason(verify({ flags: 0x25 }))).toMatch(/reserved/);
    expect(reason(verify({ flags: 0x07 }))).toMatch(/reserved/);
  });
  it("rejects authenticatorData shorter than 37 bytes", () => {
    expect(reason(verify({ tamperAuthData: (b) => b.subarray(0, 36) }))).toMatch(/shorter than 37 bytes/);
  });
  it("sign counter must strictly increase (equal, lower, and 0 after non-zero are refused)", () => {
    expect(reason(verify({ signCount: 4 }, 4))).toMatch(/did not increase/);
    expect(reason(verify({ signCount: 3 }, 4))).toMatch(/did not increase/);
    expect(reason(verify({ signCount: 0 }, 4))).toMatch(/did not increase/);
    expect(verify({ signCount: 0xffffffff }, 0xfffffffe).ok).toBe(true);
  });
});

describe("verifyAssertion: signature checks, edge cases and malleability", () => {
  it("rejects a signature by another key, and any tampering with authenticatorData or clientDataJSON after signing", () => {
    const other = makeSoftAuth();
    expect(reason(verify({ signWith: other.privateKey }))).toMatch(/does not verify/);
    expect(reason(verify({ tamperAuthData: (b) => Buffer.concat([b.subarray(0, 36), Buffer.from([b[36] ^ 1])]) }))).toMatch(/does not verify|rpIdHash|did not increase/);
    expect(reason(verify({ tamperClientData: (b) => Buffer.concat([b, Buffer.from(" ")]) }))).toMatch(/does not verify/);
  });
  it("rejects non-DER encodings: raw r||s, trailing bytes, BER long-form length, negative integer, non-minimal zero padding, zero, truncated", () => {
    const base = makeAssertion(auth, H);
    const der = Buffer.from(base.signature, "base64url");
    const [r, s] = derToRS(der);
    const tries: Record<string, Buffer> = {
      raw: Buffer.concat([Buffer.from(r.toString(16).padStart(64, "0"), "hex"), Buffer.from(s.toString(16).padStart(64, "0"), "hex")]),
      trailing: Buffer.concat([der, Buffer.from([0])]),
      longForm: Buffer.concat([Buffer.from([0x30, 0x81, der[1]]), der.subarray(2)]),
      negative: Buffer.concat([Buffer.from([0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01])]),
      nonMinimal: Buffer.concat([Buffer.from([0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01, 0x00])]).subarray(0, 9),
      zero: Buffer.from([0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x01]),
      truncated: der.subarray(0, der.length - 3),
      empty: Buffer.alloc(0),
    };
    for (const [name, sig] of Object.entries(tries)) {
      expect(strictDerEcdsa(sig), name).toBe(false);
      expect(reason(verify({ rawSignature: sig })), name).toMatch(/strictly encoded DER|does not verify/);
    }
    expect(strictDerEcdsa(der)).toBe(true);
  });
  it("DOCUMENTED non-requirement: the high-S twin of a valid signature also verifies (ECDSA malleability) but authorises the SAME single envelope, and the counter state makes it idempotent", () => {
    const high = (der: Buffer) => {
      const [r, s] = derToRS(der);
      return derFromRS(r, P256_N - s);
    };
    const a = verify({ signCount: 3 }, 2);
    const b = verify({ signCount: 3, signatureTransform: high }, 2);
    expect(a.ok && b.ok).toBe(true);
    const twin = Buffer.from(makeAssertion(auth, H, { signCount: 3, signatureTransform: high }).signature, "base64url");
    expect(strictDerEcdsa(twin)).toBe(true);
  });
  it("rejects invalid base64url fields, oversized fields and malformed documents without throwing", () => {
    const good = makeAssertion(auth, H);
    const bad = (patch: Record<string, unknown>) => verifyAssertion({ envelopeSha256: H, doc: { ...good, ...patch }, anchor: auth.anchor, storedSignCount: 0 });
    for (const p of [{ signature: "AA==" }, { signature: "a+b/" }, { authenticatorData: "!!" }, { clientDataJSON: 5 }, { authenticatorData: "A".repeat(2000) }, { clientDataJSON: "A".repeat(7000) }, { v: 2 }, { kind: "webauthn-eddsa" }, { envelopeSha256: undefined }]) expect(bad(p).ok, JSON.stringify(p).slice(0, 40)).toBe(false);
    for (const d of [null, undefined, 5, "x", [], {}]) expect(verifyAssertion({ envelopeSha256: H, doc: d, anchor: auth.anchor, storedSignCount: 0 }).ok).toBe(false);
    expect(verifyAssertion({ envelopeSha256: "xyz", doc: good, anchor: auth.anchor, storedSignCount: 0 }).ok).toBe(false);
    expect(verifyAssertion({ envelopeSha256: H, doc: good, anchor: auth.anchor, storedSignCount: -1 }).ok).toBe(false);
  });
  it("base64url must be canonical: stray trailing bits, impossible lengths, padding and standard-alphabet characters are refused", () => {
    const good = makeAssertion(auth, H);
    const sig = good.signature;
    const probes = [`${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : sig.slice(-1) === "Q" ? "R" : "A"}`];
    // build a non-canonical twin: same bytes, but the final sextet carries non-zero padding bits
    const bytes = Buffer.from(sig, "base64url");
    const rem = bytes.length % 3;
    if (rem !== 0) {
      const chars = sig.split("");
      const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(chars[chars.length - 1]);
      chars[chars.length - 1] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[last ^ 1];
      probes.push(chars.join(""));
    }
    probes.push(`${sig}A`, `${sig}=`, sig.replace(/[-_]/, "+"), `${sig}AAAAA`);
    for (const p of probes) {
      const r = verifyAssertion({ envelopeSha256: H, doc: { ...good, signature: p }, anchor: auth.anchor, storedSignCount: 0 });
      expect(r.ok, p.slice(-8)).toBe(false);
    }
    for (const field of ["authenticatorData", "clientDataJSON"] as const) {
      const v = good[field];
      expect(verifyAssertion({ envelopeSha256: H, doc: { ...good, [field]: `${v}A` }, anchor: auth.anchor, storedSignCount: 0 }).ok, field).toBe(false);
    }
  });
  it("the sign counter cannot wrap: at the 32-bit maximum the credential must be re-enrolled", () => {
    expect(reason(verify({ signCount: 0 }, 0xffffffff))).toMatch(/32-bit maximum/);
    expect(reason(verify({ signCount: 0xffffffff }, 0xffffffff))).toMatch(/32-bit maximum/);
    expect(verify({ signCount: 0xffffffff }, 0xfffffffe).ok).toBe(true);
  });
  it("refusal reasons are fixed labels: hostile document content is never echoed", () => {
    const hostile = "\u001b[2JSIGN-EVERYTHING";
    const r = verifyAssertion({ envelopeSha256: H, doc: { ...makeAssertion(auth, H), credentialId: hostile, kind: "webauthn-es256" }, anchor: auth.anchor, storedSignCount: 0 });
    expect(JSON.stringify(r)).not.toContain("SIGN-EVERYTHING");
  });
});

describe("anchor validation (the pinned credential public key)", () => {
  const raw = () => JSON.parse(JSON.stringify(auth.anchor)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  it("accepts a valid anchor", () => {
    expect(parseAnchor(auth.anchor).ok).toBe(true);
  });
  it("any edit after the fingerprint was recorded is refused", () => {
    const edits: Array<(a: Record<string, any>) => unknown> = [(a) => (a.rpId = "evil.example.test"), (a) => (a.origins = ["https://evil.example.test"]), (a) => (a.credentialId = "B".repeat(43)), (a) => (a.requireUV = false), (a) => (a.branch = "other"), (a) => (a.repoUrl = "https://github.com/evil/repo.git")]; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const edit of edits) {
      const a = raw();
      edit(a);
      const r = parseAnchor(a);
      expect(r.ok).toBe(false);
    }
    const swapped = raw();
    swapped.publicKey = makeSoftAuth().anchor.publicKey;
    expect(parseAnchor(swapped).ok).toBe(false);
    // and a re-fingerprinted swap is "valid" as a file: the protection is that the fingerprint is recorded out of band and the file arrives only via the owner's merge
    const sw2 = raw();
    sw2.publicKey = makeSoftAuth().anchor.publicKey;
    sw2.fingerprintSha256 = anchorFingerprint(sw2 as never);
    expect(parseAnchor(sw2).ok).toBe(true);
    expect(sw2.fingerprintSha256).not.toBe(auth.anchor.fingerprintSha256);
  });
  it("refuses a point not on P-256, wrong coordinate length, unknown fields, bad origins/rpId/repoUrl", () => {
    const mut = (f: (a: Record<string, any>) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const a = raw();
      f(a);
      a.fingerprintSha256 = anchorFingerprint(a as never);
      return parseAnchor(a);
    };
    expect(mut((a) => (a.publicKey = { x: a.publicKey.x, y: a.publicKey.x })).ok).toBe(false);
    expect(mut((a) => (a.publicKey = { x: "AAAA", y: "AAAA" })).ok).toBe(false);
    expect(mut((a) => (a.extra = 1)).ok).toBe(false);
    expect(mut((a) => (a.origins = ["ftp://ops.example.test"])).ok).toBe(false);
    expect(mut((a) => (a.origins = ["https://unrelated.example.org"])).ok).toBe(false);
    expect(mut((a) => (a.rpId = "UPPER.example.test")).ok).toBe(false);
    expect(mut((a) => (a.repoUrl = "git@github.com:o/r.git")).ok).toBe(false);
    expect(mut((a) => (a.requireUV = "yes")).ok).toBe(false);
    expect(parseAnchor(null).ok).toBe(false);
    expect(RP_ID).toBe("ops.example.test");
  });
});

describe("sign-counter state (one approval document is reused across the runs of its envelope)", () => {
  const stateFile = () => join(tmp(), "state", "hw-signcount.json");
  const run = (file: string, hash: string, o: AssertionOpts) => verifyAndRecord(file, { envelopeSha256: hash, doc: makeAssertion(auth, hash, o), anchor: auth.anchor });
  it("records on first use; the SAME approval is accepted again; another assertion for that envelope is refused", () => {
    const f = stateFile();
    expect(run(f, H, { signCount: 7 }).ok).toBe(true);
    expect(readState(f)).toMatchObject({ last: 7, byEnvelope: { [H]: 7 } });
    expect(run(f, H, { signCount: 7 }).ok).toBe(true);
    expect(reason(run(f, H, { signCount: 9 }))).toMatch(/already approved with another counter/);
    expect(reason(run(f, H, { signCount: 6 }))).toMatch(/did not increase|another counter/);
  });
  it("a NEW envelope needs a strictly higher counter than any accepted before (a replayed old tap cannot approve it)", () => {
    const f = stateFile();
    run(f, H, { signCount: 7 });
    expect(reason(run(f, H2, { signCount: 7 }))).toMatch(/did not increase/);
    expect(reason(run(f, H2, { signCount: 3 }))).toMatch(/did not increase/);
    expect(run(f, H2, { signCount: 8 }).ok).toBe(true);
    expect(readState(f).last).toBe(8);
  });
  it("tokens that never count (always 0) are accepted for successive envelopes", () => {
    const f = stateFile();
    expect(run(f, H, { signCount: 0 }).ok).toBe(true);
    expect(run(f, H2, { signCount: 0 }).ok).toBe(true);
    expect(run(f, H, { signCount: 0 }).ok).toBe(true);
  });
  it("checkAgainstState records NOTHING until commit() is called; commit is idempotent and refuses an incompatible concurrent change", () => {
    const f = stateFile();
    const c = checkAgainstState(f, { envelopeSha256: H, doc: makeAssertion(auth, H, { signCount: 7 }), anchor: auth.anchor });
    expect(c.result.ok).toBe(true);
    expect(existsSync(f)).toBe(false);
    c.commit();
    c.commit();
    expect(readState(f)).toMatchObject({ last: 7, byEnvelope: { [H]: 7 } });
    // another run advanced the counter past this (not yet committed) approval
    const g = stateFile();
    const c1 = checkAgainstState(g, { envelopeSha256: H, doc: makeAssertion(auth, H, { signCount: 5 }), anchor: auth.anchor });
    const c2 = checkAgainstState(g, { envelopeSha256: H2, doc: makeAssertion(auth, H2, { signCount: 6 }), anchor: auth.anchor });
    c2.commit();
    expect(() => c1.commit()).toThrow(/advanced by another run/);
  });
  it("the state write uses a unique temp file and a lock: no leftovers, and a held lock makes the writer fail rather than race", () => {
    const f = stateFile();
    run(f, H, { signCount: 2 });
    expect(readdirSync(join(f, "..")).filter((n) => /\.(tmp|lock)$/.test(n))).toEqual([]);
    writeFileSync(`${f}.lock`, "someone-else"); // a fresh lock held by another process
    const c = checkAgainstState(f, { envelopeSha256: H2, doc: makeAssertion(auth, H2, { signCount: 3 }), anchor: auth.anchor });
    expect(c.result.ok).toBe(true);
    expect(() => c.commit()).toThrow(/locked by another process/);
    expect(readFileSync(join(__dirname, "..", "webauthn.ts"), "utf8")).toContain("randomBytes(6).toString(\"hex\")}.tmp"); // unique temp name
    expect(readState(f).byEnvelope[H2]).toBeUndefined();
  }, 20_000);
  it("a failed verification records nothing", () => {
    const f = stateFile();
    expect(run(f, H, { signCount: 7, flags: 0x01 }).ok).toBe(false);
    expect(existsSync(f)).toBe(false);
  });
  it("a malformed state file fails closed", () => {
    const f = stateFile();
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, "{not json");
    expect(reason(run(f, H, { signCount: 1 }))).toMatch(/state file/);
    writeFileSync(f, JSON.stringify({ v: 1, last: -3, byEnvelope: {} }));
    expect(reason(run(f, H, { signCount: 1 }))).toMatch(/state file/);
    expect(readFileSync(f, "utf8")).toContain("-3");
    expect(counterFloor(emptyState(), H)).toEqual({ storedSignCount: 0, sameEnvelope: false });
  });
});
