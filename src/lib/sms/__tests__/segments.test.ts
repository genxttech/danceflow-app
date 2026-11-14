import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import cases from "./fixtures/ucs2SegmentCases.json";
import { estimateBilledSegments } from "../segments";

const seg = (body: string) => estimateBilledSegments(body).segments;
const bodyOf = (parts: [string | number, number][]) => parts.map(([x, n]) => (typeof x === "number" ? String.fromCodePoint(x) : x).repeat(n)).join("");

/**
 * Independent reference: Twilio's segment calculator (TwilioDevEd/message-segment-calculator) rebuilt on Intl.Segmenter graphemes. 140-octet parts, a 6-octet header
 * when concatenated, each grapheme (and each GSM-7 extension character) indivisible, CR LF split into two characters as the calculator does.
 * Intl.Segmenter follows current Unicode, not the calculator's grapheme-splitter 1.0.4 (Unicode 10); the estimator must be at or above both, so the shared fixture
 * pins the cases where they differ (a case's `ref` is the value this reference gives when it is not the expected count).
 */
const REF_GSM = new Set(Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"));
const REF_GSM_EXT = new Set(Array.from("^{}\\[~]|€\f"));
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
function twilioReference(body: string): number {
  const gs = Array.from(graphemes.segment(body), (s) => s.segment).flatMap((g) => (g === "\r\n" ? ["\r", "\n"] : [g]));
  const gsm = gs.every((g) => g.length === 1 && (REF_GSM.has(g) || REF_GSM_EXT.has(g)));
  const widths = gs.map((g) => (gsm ? (REF_GSM_EXT.has(g) ? 14 : 7) : 16 * g.length));
  const total = widths.reduce((a, w) => a + w, 0);
  if (total === 0) return 0;
  if (total <= 1120) return 1;
  let parts = 1;
  let used = 48;
  for (const w of widths) {
    if (used + w > 1120) {
      parts += 1;
      used = 48 + w;
    } else used += w;
  }
  return parts;
}

/** Deterministic generator (mulberry32) of bodies from weighted pieces. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const cps = (...c: number[]) => String.fromCodePoint(...c);
/** Text where the cluster rule is exactly Twilio's grapheme split: English, GSM-7 extension characters, Latin accents, curly quotes, CJK, Hangul syllables, emoji. */
const EXACT_PIECES = [
  "a", "b", "Z", " ", " ", ".", "!", "\n", "\r\n", "€", "{", "\\", "é", "á", "ñ", "’", "“", "—", "…", "✓", "★", "中", "안",
  cps(0x1f600), cps(0x1f389), cps(0x2764, 0xfe0f), cps(0x1f44d, 0x1f3fd), cps(0x1f483, 0x1f3fb), cps(0x31, 0xfe0f, 0x20e3),
  cps(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467), cps(0x1f3f3, 0xfe0f, 0x200d, 0x1f308), cps(0x1f1fa, 0x1f1f8), cps(0x1f1ec, 0x1f1e7),
  cps(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f), cps(0x1f1fa), "e" + cps(0x301), "n" + cps(0x303, 0x323),
];
/** Other scripts and edge sequences, where the cluster rule may be coarser than a grapheme (never finer). */
const WIDE_PIECES = [
  ...EXACT_PIECES, "नमस्ते", "क्षत्रिय", "مَرْحَبًا", cps(0x600) + "12", "สวัสดี", "ำ", cps(0x1100, 0x1161, 0x11a8), cps(0x1100), cps(0x1161), "a" + cps(0x200d) + "b",
  cps(0x200c), cps(0xfe0f), cps(0x1f3fb), cps(0x200d), "שָׁלוֹם", "ゕ" + cps(0x3099), "Z" + cps(0x301, 0x302, 0x303, 0x304, 0x305, 0x306, 0x307, 0x308, 0x309, 0x30a),
  cps(0x600, 0x1f1fa, 0x1f1fa, 0x1f1fa), cps(0x915, 0x94d, 0x93c, 0x937), cps(0x915, 0x94d, 0x951, 0x937), "ສະບາຍດີ",
];
function randomBody(next: () => number, pieces: string[], maxUnits: number): string {
  let s = "";
  const target = Math.floor(next() * maxUnits);
  while (s.length < target) s += pieces[Math.floor(next() * pieces.length)];
  return s;
}

describe("estimateBilledSegments", () => {
  it("counts an empty body as 0", () => {
    expect(seg("")).toBe(0);
  });

  it("GSM-7 boundaries: 160 / 306 / 307", () => {
    expect(seg("a".repeat(160))).toBe(1);
    expect(seg("a".repeat(161))).toBe(2);
    expect(seg("a".repeat(306))).toBe(2);
    expect(seg("a".repeat(307))).toBe(3);
    expect(estimateBilledSegments("a".repeat(161)).encoding).toBe("gsm7");
  });

  it("extension characters take two septets", () => {
    expect(estimateBilledSegments("a".repeat(158) + "€").units).toBe(160);
    expect(seg("a".repeat(158) + "€")).toBe(1);
    expect(seg("a".repeat(159) + "€")).toBe(2);
  });

  it("an extension character ends a part early only where it would split", () => {
    expect(seg("a".repeat(302) + "€")).toBe(2); // 304 septets
    expect(seg("a".repeat(303) + "€")).toBe(2); // 305 septets: 153 + 152
    expect(seg("a".repeat(152) + "€" + "a".repeat(152))).toBe(3); // the euro cannot split at septet 153
    expect(seg("a".repeat(153) + "€" + "a".repeat(151))).toBe(2);
  });

  it("a non-GSM character switches to UCS-2", () => {
    expect(estimateBilledSegments("a".repeat(69) + "✓").encoding).toBe("ucs2");
    expect(seg("a".repeat(69) + "✓")).toBe(1); // 70 units
    expect(seg("a".repeat(70) + "✓")).toBe(2); // 71 units
    expect(seg("a".repeat(133) + "✓")).toBe(2); // 134 units
    expect(seg("a".repeat(134) + "✓")).toBe(3); // 135 units
  });

  it("emoji count as two UTF-16 units", () => {
    expect(seg("😀".repeat(35))).toBe(1);
    expect(seg("😀".repeat(36))).toBe(2);
  });

  it("packs UCS-2 greedily at 67 units per part and never splits an emoji or other character cluster (cases shared with the SQL parity test)", () => {
    for (const c of cases) expect(seg(bodyOf(c.parts as [string | number, number][])), c.name).toBe(c.expect);
  });

  it("the TypeScript and SQL cluster tables are identical", () => {
    const ts = readFileSync(join(__dirname, "../segments.ts"), "utf8");
    const sql = readFileSync(join(__dirname, "../../supabase/migrations/20270217090000_twilio_ucs2_surrogate_segments.sql"), "utf8");
    const tsTable = (name: string) => Array.from((ts.match(new RegExp(`const ${name}[^=]*= \\[([\\s\\S]*?)\\n\\];`)) as RegExpMatchArray)[1].matchAll(/0x[0-9a-f]+/g), (m) => parseInt(m[0], 16));
    const sqlTable = (name: string) =>
      (sql.match(new RegExp(`${name} int\\[\\] := array\\[([\\s\\S]*?)\\];`)) as RegExpMatchArray)[1].replace(/--[^\n]*/g, "").split(",").map((x) => parseInt(x.trim(), 10));
    expect(sqlTable("v_starters")).toEqual(tsTable("STARTERS"));
    expect(sqlTable("v_joins_next")).toEqual(tsTable("JOINS_NEXT"));
    expect(tsTable("STARTERS").length).toBeGreaterThan(40);
  });

  it("every shared case agrees with the Twilio reference, or is pinned at or above it (never fewer)", () => {
    for (const c of cases as { name: string; parts: [string | number, number][]; expect: number; ref?: number }[]) {
      const ref = twilioReference(bodyOf(c.parts));
      expect(ref, c.name).toBe(c.ref ?? c.expect);
      expect(c.expect).toBeGreaterThanOrEqual(ref);
    }
  });

  it("matches the Twilio reference exactly for English, GSM-7 and emoji text (3,000 generated bodies across every part boundary)", () => {
    const next = rng(489);
    for (let i = 0; i < 3000; i++) {
      const body = randomBody(next, EXACT_PIECES, 720);
      expect(seg(body), JSON.stringify(body)).toBe(twilioReference(body));
    }
  }, 60_000);

  it("never undercounts against the Twilio reference for any script (3,000 generated bodies)", () => {
    const next = rng(20270217);
    let over = 0;
    for (let i = 0; i < 3000; i++) {
      const body = randomBody(next, WIDE_PIECES, 720);
      const est = seg(body);
      const ref = twilioReference(body);
      expect(est, JSON.stringify(body)).toBeGreaterThanOrEqual(ref);
      if (est > ref) over += 1;
    }
    expect(over).toBeLessThan(3000 * 0.08); // 177 with this seed: WIDE_PIECES is adversarial (unspaced Lao, ZWJ between letters, lone jamo); one part over, never under
  }, 60_000);

  it("the SQL parity test runs exactly the shared cases, in the same order", () => {
    const sql = readFileSync(join(__dirname, "../../supabase/migrations/sql-tests/test_T_tw4f_ucs2_segments.sql"), "utf8").replace(/\r/g, "");
    const rows = (cases as { name: string; parts: [string | number, number][]; expect: number }[]).map(
      (c) => `    ('${c.name.replace(/'/g, "''")}', ${c.parts.map(([x, n]) => `repeat(${typeof x === "number" ? `chr(${x})` : `'${x.replace(/'/g, "''")}'`},${n})`).join(" || ")}, ${c.expect})`,
    );
    expect(sql).toContain(rows.join(",\n") + "\n  ) v(name, body, expected)");
  });

  it("counts are exact above ten parts (callers refuse more than ten)", () => {
    expect(seg("a".repeat(1530))).toBe(10);
    expect(seg("a".repeat(1531))).toBe(11);
    expect(seg("😀".repeat(400))).toBe(13);
  });

  it("newline and carriage return are GSM", () => {
    expect(estimateBilledSegments("a\nb\rc").encoding).toBe("gsm7");
    expect(estimateBilledSegments("a\nb\rc").units).toBe(5);
  });

  it("matches the database _tw4us_segments parity cases", () => {
    expect(seg("hello")).toBe(1);
    expect(seg("a".repeat(160))).toBe(1);
    expect(seg("a".repeat(161))).toBe(2);
    expect(seg("a".repeat(158) + "€")).toBe(1);
    expect(seg("héllo ✓")).toBe(1);
    expect(seg("😀".repeat(35))).toBe(1);
    expect(seg("😀".repeat(36))).toBe(2);
  });
});
