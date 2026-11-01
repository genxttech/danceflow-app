// Summarize a vitest JSON report into real PASS / FAIL / BLOCKED counts per section (section = describe title up to the first ".").
// Exit 1 on any FAIL, on a crashed suite file, or when no test was counted (a crash must never look like a clean run).
import { existsSync, readFileSync } from "node:fs";

if (!existsSync(process.argv[2])) { console.log("D24 acceptance: NO REPORT (vitest did not finish)"); process.exit(1); }
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const sections = {};
let pass = 0, fail = 0, blocked = 0, superseded = 0;
for (const file of report.testResults) {
  if (file.status === "failed" && file.assertionResults.length === 0) { fail++; console.log(`FAIL (suite crashed) ${file.name}: ${String(file.message).slice(0, 300)}`); }
  for (const a of file.assertionResults) {
    const s = (a.ancestorTitles[0] || "?").split(".")[0];
    sections[s] ??= { PASS: 0, FAIL: 0, BLOCKED: 0, SUPERSEDED: 0 };
    const k = a.status === "passed" ? "PASS" : a.status === "failed" ? "FAIL" : a.title.startsWith("SUPERSEDED(") ? "SUPERSEDED" : "BLOCKED";
    sections[s][k]++;
    if (k === "PASS") pass++; else if (k === "FAIL") fail++; else if (k === "SUPERSEDED") superseded++; else blocked++;
    if (k === "FAIL") console.log(`FAIL ${a.fullName}`);
  }
}
console.log(`\nD24 acceptance: PASS=${pass} FAIL=${fail} BLOCKED=${blocked} SUPERSEDED=${superseded}`);
for (const [s, c] of Object.entries(sections)) console.log(`  ${s}: PASS=${c.PASS} FAIL=${c.FAIL} BLOCKED=${c.BLOCKED}${c.SUPERSEDED ? ` SUPERSEDED=${c.SUPERSEDED}` : ""}`);
const bad = fail > 0 || pass + fail === 0 || report.numFailedTestSuites > 0 || (process.env.D24_FAIL_ON_BLOCKED === "1" && blocked > 0);
process.exit(bad ? 1 : 0);
