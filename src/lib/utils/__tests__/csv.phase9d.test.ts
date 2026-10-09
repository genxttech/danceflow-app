import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { csvEscape, neutralizeCsvFormula, toCsv } from "../csv";

/** Minimal RFC 4180 reader used to prove the output round-trips. */
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

describe("csvEscape quoting", () => {
  it("leaves ordinary text unchanged", () => {
    expect(csvEscape("plain text")).toBe("plain text");
    expect(csvEscape("Élan 舞蹈 💃")).toBe("Élan 舞蹈 💃");
  });
  it("quotes commas and doubles embedded quotes", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('He said "hello"')).toBe('"He said ""hello"""');
  });
  it("quotes LF, CR and CRLF", () => {
    expect(csvEscape("hello\nworld")).toBe('"hello\nworld"');
    expect(csvEscape("hello\rworld")).toBe('"hello\rworld"');
    expect(csvEscape("hello\r\nworld")).toBe('"hello\r\nworld"');
  });
  it("serializes null, undefined and empty as an empty cell", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
    expect(csvEscape("")).toBe("");
  });
  it("keeps trusted numbers and booleans unchanged, including negatives", () => {
    expect(csvEscape(12.5)).toBe("12.5");
    expect(csvEscape(-5)).toBe("-5");
    expect(csvEscape(0)).toBe("0");
    expect(csvEscape(true)).toBe("true");
    expect(csvEscape(false)).toBe("false");
  });
});

describe("csvEscape formula neutralization", () => {
  it.each(["=1+1", "+1+1", "-1+1", "@SUM(A1)", "=SUM(A1)", "+SUM(A1)", "-1+2", '=HYPERLINK("http://x","y")'])(
    "neutralizes %s",
    (text) => {
      expect(neutralizeCsvFormula(text)).toBe(`'${text}`);
      expect(parseCsv(csvEscape(text))[0][0]).toBe(`'${text}`);
    },
  );
  it.each([
    [" =1+1"], ["   =1+1"], ["\t=1+1"], ["\t=CMD(1)"], ["\r=1+1"], ["\n=1+1"], ["\r\n=1+1"],
    [" \t \r\n +SUM(A1)"], ["\u0001=1+1"], [" @SUM(A1)"], ["​=1+1"], ["﻿-1+2"],
  ])("neutralizes formula hidden behind leading whitespace/control characters %j", (text) => {
    expect(neutralizeCsvFormula(text)).toBe(`'${text}`);
    expect(parseCsv(csvEscape(text))[0][0]).toBe(`'${text}`);
  });
  it("neutralizes a bare leading tab or CR", () => {
    expect(neutralizeCsvFormula("\tabc")).toBe("'\tabc");
    expect(neutralizeCsvFormula("\rabc")).toBe("'\rabc");
  });
  it("preserves the original text (nothing trimmed) behind the apostrophe", () => {
    expect(csvEscape("  =1+1  ")).toBe("'  =1+1  ");
  });
  it("leaves ordinary text, mid-string markers and numbers-as-text unchanged", () => {
    for (const text of ["hello", "a=b", "x+y", "e-mail", "user@example.com", "2026-10-09", "  hello", "'quoted", "1+1"]) {
      expect(csvEscape(text)).toBe(text);
    }
    expect(csvEscape("-12.50")).toBe("-12.50");
    expect(csvEscape("-3")).toBe("-3");
  });
  it("still neutralizes numeric-looking text that is not a plain decimal", () => {
    for (const text of ["+1", "+12.5", "-1e3", "-1.5.2", "-", "+", "=", "@", "-.5", "-5 "]) {
      expect(csvEscape(text)).toBe(`'${text}`);
    }
  });
  it("removes NUL characters", () => {
    expect(csvEscape("a\u0000b")).toBe("ab");
    expect(csvEscape("\u0000=1+1")).toBe("'=1+1");
  });
  it("quotes after neutralizing when needed", () => {
    expect(csvEscape("=A1,B1")).toBe('"\'=A1,B1"');
    expect(csvEscape("\r=1+1")).toBe('"\'\r=1+1"');
  });
});

describe("toCsv", () => {
  it("round-trips headers and rows, preserving column order", () => {
    const csv = toCsv(["Name", "Note", "Amount"], [
      ["Ana", 'say "hi", ok', -12.5],
      ["Bo", "line1\r\nline2", 3],
      ["=EVIL()", null, undefined],
    ]);
    expect(parseCsv(csv)).toEqual([
      ["Name", "Note", "Amount"],
      ["Ana", 'say "hi", ok', "-12.5"],
      ["Bo", "line1\r\nline2", "3"],
      ["'=EVIL()", "", ""],
    ]);
  });
  it("neutralizes header cells with the same rule", () => {
    expect(toCsv(["=H"], [])).toBe("'=H");
  });
});

describe("export families use the shared helper", () => {
  const root = path.resolve(__dirname, "../../../..");
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
  const migrated = [
    "src/app/app/instructor-pay/export/route.ts",
    "src/lib/accountant-deliveries/reports.ts",
    "src/app/app/events/[id]/registrations/export/route.ts",
    "src/app/app/events/[id]/settlement/export/route.ts",
    "src/app/app/events/export/attention/route.ts",
    "src/app/app/events/export/financial-summary/route.ts",
    "src/app/app/reports/export/event-profitability/route.ts",
    "src/app/app/reports/export/event-registrations/route.ts",
    "src/app/app/reports/export/expenses/route.ts",
    "src/app/app/reports/export/instructor-activity/route.ts",
    "src/app/app/reports/export/accounting/route.ts",
    "src/app/app/reports/export/accounting-map/route.ts",
    "src/app/app/reports/export/appointments/route.ts",
    "src/app/app/reports/export/balances/route.ts",
    "src/app/app/reports/export/clients/route.ts",
    "src/app/app/reports/export/ledger/route.ts",
    "src/app/app/reports/export/payments/route.ts",
    "src/app/app/reports/export/payout-items/route.ts",
    "src/app/app/reports/export/payouts/route.ts",
    "src/app/app/reports/client-birthdays/export/route.ts",
  ];
  it.each(migrated)("%s imports the shared helper and defines no local CSV escaping", (rel) => {
    const src = read(rel);
    expect(src).toMatch(/from "@\/lib\/utils\/csv"/);
    expect(src).not.toMatch(/function\s+(csvEscape|toCsv|csvSafe|safeCsv|safeCsvCell)\b/);
  });
  it("accountant reports build every CSV through toCsv", () => {
    const src = read("src/lib/accountant-deliveries/reports.ts");
    expect(src).toMatch(/import \{ toCsv \} from "@\/lib\/utils\/csv"/);
    expect(src).not.toMatch(/safeCsv/);
  });
  it("payroll export no longer pre-escapes rows locally", () => {
    const src = read("src/app/app/instructor-pay/export/route.ts");
    expect(src).toMatch(/import \{ toCsv \} from "@\/lib\/utils\/csv"/);
    expect(src).toMatch(/toCsv\(HEADERS, rows\)/);
    expect(src).not.toMatch(/csvSafe/);
  });
});

describe("strict plain-decimal text exception (money compatibility)", () => {
  it.each(["-12.50", "-5", "0", "42", "0.25", "-0.75"])("leaves plain decimal text %j unchanged", (text) => {
    expect(csvEscape(text)).toBe(text);
  });
  it.each(["+1", "-1e3", "-1+2", "-5 ", " -5", "-5\n", "\n-5", "=1+1", "@SUM(A1)", "-5-", "--5", "-5,5"])(
    "still neutralizes %j",
    (text) => {
      expect(neutralizeCsvFormula(text)).toBe(`'${text}`);
    },
  );
});
