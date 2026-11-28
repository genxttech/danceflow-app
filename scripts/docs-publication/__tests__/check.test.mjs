// node --test scripts/docs-publication/__tests__/check.test.mjs
// Every flagged value below is assembled at run time and made up, so no identifier-shaped text is stored in this file.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { addedLines, isDocumentation, parseDenylist, run, scanLine } from "../check.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "check.mjs");
const uuid = ["3f9a1c7e", "5b2d", "4a8f", "9c1e", "7d4b2a6f8e0c"].join("-");
const email = ["person", "studio-not-real.com"].join("@");
const sid = "AC" + "0a1b2c3d".repeat(4);
const shortSid = "BU" + "0a1b2c3d" + "...";
const account = ["cus", "Q1w2E3r4T5y6U7"].join("_");
const phone = ["+1", "212", "867", "5309"].join("");
const dashedPhone = ["212", "867", "5309"].join("-");
const ein = ["47", "1029384"].join("-");
const NAME = "Quartz Meadow Dancing, LLC";

test("each identifier shape is reported by kind", () => {
  const cases = { uuid: [uuid], "provider-sid": [sid, shortSid], "provider-id": [account], email: [email], phone: [phone, dashedPhone], "ein-like": [ein] };
  for (const [kind, values] of Object.entries(cases)) {
    for (const value of values) assert.deepEqual(scanLine(`value: ${value} end`), [kind], kind);
  }
});

test("synthetic and reserved values pass", () => {
  for (const value of [
    "00000000-0000-0000-0000-000000000000", "11111111-2222-4333-8444-555555555555",
    "owner@example.com", "rep@example.test", "a@mail.example.invalid",
    "(555) 010-0100", "+15550000000", "212-555-0142", "00-0000000", "12-3456789",
    "price_unattested", "[PILOT-STUDIO-ID]", "released 2026-11-23", "migration 20261119090000_name.sql",
  ]) assert.deepEqual(scanLine(value), [], value);
});

test("the allowlist covers exact values only, without regard to case", () => {
  const allow = new Set([email]);
  assert.deepEqual(scanLine(email.toUpperCase(), { allow }), []);
  assert.deepEqual(scanLine(`x${email}`, { allow }), ["email"]);
});

test("a private name matches across case, spacing, punctuation and slug forms", () => {
  const deny = parseDenylist(`${NAME}\nab\n; Quartz Meadow `);
  assert.equal(deny.length, 2, "very short terms are ignored");
  for (const text of ["quartz-meadow-dancing-llc", "QUARTZ MEADOW DANCING LLC", "Quartz_Meadow"]) {
    assert.ok(scanLine(text, { deny }).some((k) => k.startsWith("private-name")), text);
  }
  assert.deepEqual(scanLine("a meadow with quartz", { deny }), []);
});

test("only added lines are read from a diff", () => {
  const diff = ["--- a/x.md", "+++ b/x.md", "@@ -2 +2,2 @@", "-old", "+new one", "+++ two", "@@ -9,0 +11 @@", "+three"].join("\n");
  assert.deepEqual(addedLines(diff), [[2, "new one"], [3, "++ two"], [11, "three"]]);
});

test("documentation means docs/ and Markdown, not application code", () => {
  for (const path of ["docs/a.sql", "docs/x/y.json", "README.md", "e2e/README.md"]) assert.ok(isDocumentation(path), path);
  for (const path of ["src/app/page.tsx", "scripts/a.mjs", "docs/image.png"]) assert.ok(!isDocumentation(path), path);
});

const repo = mkdtempSync(join(tmpdir(), "docs-check-"));
after(() => rmSync(repo, { recursive: true, force: true }));
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
const put = (path, text) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
const commit = (message) => { git("add", "-A"); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };

git("init", "-q");
put("docs/old.md", `already here ${uuid}\n`);
put("src/code.ts", "export {};\n");
const base = commit("base");

test("unchanged text and application code are not judged", () => {
  put("docs/old.md", `already here ${uuid}\nclean line\n`);
  put("src/code.ts", `// ${email}\n`);
  const head = commit("clean change");
  assert.deepEqual(run({ repo, base, head }).findings, []);
  assert.equal(run({ repo, head, all: true }).findings.length, 1, "the audit mode reads whole files");
});

test("added identifiers and private names are found, and never printed", () => {
  put("docs/new.md", `fine\ncontact ${email}\nfor ${NAME}\n`);
  put("docs/quartz-meadow-dancing-llc.md", "fine\n");
  const head = commit("dirty change");
  const { findings } = run({ repo, base, head, denylist: NAME });
  assert.deepEqual(findings.filter((f) => f.file === "docs/new.md").map((f) => [f.line, f.kind]), [[2, "email"], [3, "private-name #1"]]);
  assert.ok(findings.some((f) => f.line === 0 && f.file.startsWith("<documentation file")));

  const cli = spawnSync(process.execPath, [SCRIPT, "--repo", repo, "--base", base, "--head", head], { encoding: "utf8", env: { ...process.env, DOCS_PUBLICATION_DENYLIST: NAME } });
  assert.equal(cli.status, 1);
  const output = cli.stdout + cli.stderr;
  assert.ok(!output.includes(email) && !/quartz/i.test(output), output);
});

test("exit code 0 when clean, 2 when the check cannot run", () => {
  const head = git("rev-parse", "HEAD");
  const call = (...args) => spawnSync(process.execPath, [SCRIPT, "--repo", repo, ...args], { encoding: "utf8", env: { ...process.env, DOCS_PUBLICATION_DENYLIST: "" } });
  const clean = call("--base", head, "--head", head);
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /not configured/);
  assert.equal(call("--base", "no-such-ref").status, 2);
  assert.equal(call().status, 2);
});
