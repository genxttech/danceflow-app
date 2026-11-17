/* eslint-disable @typescript-eslint/no-require-imports -- the smoke script's helpers are CommonJS */
const lib = require("../../scripts/device-smoke-lib.js");

/** A minimal Hermes bytecode image: the 128-byte header, no functions, no identifiers, then a small string table and the storage. */
function hbc(strings: string[]): Buffer {
  const header = Buffer.alloc(128);
  header.writeUInt32LE(0x03bc1fc6, 0);
  header.writeUInt32LE(0x1f1903c1, 4);
  header.writeUInt32LE(96, 8);
  header.writeUInt32LE(strings.length, 52); // stringCount
  const table = Buffer.alloc(strings.length * 4);
  const storage: Buffer[] = [];
  let offset = 0;
  strings.forEach((s, i) => {
    const bytes = Buffer.from(s, "latin1");
    table.writeUInt32LE((bytes.length << 24) | (offset << 1), i * 4); // isUTF16 = 0
    storage.push(bytes);
    offset += bytes.length;
  });
  return Buffer.concat([header, table, ...storage]);
}

describe("reading what an APK carries (Hermes string table)", () => {
  it("reads the strings back, in order", () => {
    expect(lib.hermesStrings(hbc(["http://10.0.2.2:56600", "pulse,studioSchedule", "x"]))).toEqual(["http://10.0.2.2:56600", "pulse,studioSchedule", "x"]);
  });

  it("refuses a file that is not Hermes bytecode, or a version it does not know", () => {
    expect(() => lib.hermesStrings(Buffer.from("var a = 1;".padEnd(200, " ")))).toThrow(/not a Hermes/);
    const odd = hbc(["a"]);
    odd.writeUInt32LE(7, 8);
    expect(() => lib.hermesStrings(odd)).toThrow(/version 7/);
  });

  const good = ["http://10.0.2.2:56600", "http://10.0.2.2:3107", "eyJ.anon.key"];
  const want = { stackPort: 56600, webPort: 3107, anonKey: "eyJ.anon.key" };

  it("an APK that matches its stack has no problems", () => {
    expect(lib.bakedConfigProblems(good, want)).toEqual([]);
  });

  it("an APK built for another port and key is named (the stale Metro cache of runs 7-17)", () => {
    const stale = ["http://10.0.2.2:56601", "http://10.0.2.2:3107", "eyJ.old.key"];
    const problems = lib.bakedConfigProblems(stale, want);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("56600");
    expect(problems[0]).toContain("56601");
    expect(problems[1]).toContain("anon key");
  });

  it("an APK with placeholder URLs (the RC build) is refused", () => {
    expect(lib.bakedConfigProblems(["https://qa-placeholder.invalid"], want).length).toBe(3);
  });
});

describe("logcat noise", () => {
  it("drops the uiautomator dumper lines and keeps the last lines of the rest", () => {
    const text = ["a", "11-17 W AccessibilityNodeInfoDumper: Skipping invisible child", "b", "c", "11-17 W PageIndicator: Total number of pages invalid: 0. Assuming 1 page.", "d"].join("\n");
    expect(lib.dropLogNoise(text, 10)).toBe("a\nb\nc\nd");
    expect(lib.dropLogNoise(text, 2)).toBe("c\nd");
    expect(lib.dropLogNoise(undefined)).toBe("");
  });
});

describe("a reused APK's anon key is judged by its signature", () => {
  const crypto = require("node:crypto");
  const secret = "ab".repeat(24);
  const sign = (claims: object, key = secret) => {
    const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${head}.${body}.${crypto.createHmac("sha256", key).update(`${head}.${body}`).digest("base64url")}`;
  };
  const future = Math.floor(Date.now() / 1000) + 86400;
  const base = ["http://10.0.2.2:56600", "http://10.0.2.2:3107"];

  it("accepts an older key signed with this stack's secret (--keys-from)", () => {
    const old = sign({ role: "anon", exp: future });
    expect(lib.bakedConfigProblems([...base, old], { stackPort: 56600, webPort: 3107, anonKey: "other", jwtSecret: secret })).toEqual([]);
  });

  it("refuses a key signed by another secret, an expired key, or a non-anon key", () => {
    for (const bad of [sign({ role: "anon", exp: future }, "cd".repeat(24)), sign({ role: "anon", exp: 1 }), sign({ role: "service_role", exp: future })]) {
      expect(lib.bakedConfigProblems([...base, bad], { stackPort: 56600, webPort: 3107, anonKey: "other", jwtSecret: secret })).toHaveLength(1);
    }
  });
});
