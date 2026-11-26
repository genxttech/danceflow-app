// node --test scripts/ops/__tests__/repo-owner-refs.test.mjs
// Runs against a throwaway repository with synthetic owner names.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { classify, report, rewrite, scan } from "../repo-owner-refs.mjs";

const files = {
  ".github/workflows/a.yml": "if: github.repository == 'old-owner/app'\r\nurl: https://github.com/old-owner/app.git\r\n",
  ".github/CODEOWNERS": "/x/ @old-owner\n",
  "scripts/verify.ts": 'export const OWNER = "old-owner";\nexport const REPO = "app";\n',
  "scripts/other.ts": "const a = 'old-owner/app-archive'; const b = 'very-old-owner/app';\n",
  "docs/ops/pilot/config.mjs": "export const url = 'https://github.com/old-owner/app/';\n",
  "docs/guide.md": "Open old-owner/app. Sign in as old-owner.\n",
  "docs/x/evidence/run.json": '{ "repo": "old-owner/app" }\n',
  "unrelated.txt": "nothing here\n",
};

let repo;
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const read = (path) => readFileSync(join(repo, path), "utf8");
const paths = (rows) => [...new Set(rows.map((r) => r.path))];

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "owner-refs-"));
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "base");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("classify", () => {
  it("separates behaviour from prose and records", () => {
    assert.equal(classify(".github/workflows/a.yml"), "pin");
    assert.equal(classify("docs/ops/pilot/config.mjs"), "pin");
    assert.equal(classify("docs/guide.md"), "document");
    assert.equal(classify("docs/x/evidence/run.json"), "document");
    assert.equal(classify("scripts/README.md"), "document");
  });
});

describe("scan", () => {
  it("reports pins, owner constants, logins and documents separately", () => {
    const r = scan(repo, "old-owner/app");
    assert.deepEqual(paths(r.pins), [".github/workflows/a.yml", "docs/ops/pilot/config.mjs"]);
    assert.deepEqual(r.constants, [{ path: "scripts/verify.ts", line: 1 }]);
    assert.deepEqual(paths(r.logins), [".github/CODEOWNERS", "docs/guide.md", "scripts/other.ts"]);
    assert.deepEqual(paths(r.documents), ["docs/guide.md", "docs/x/evidence/run.json"]);
    assert.match(report("old-owner/app", r), /PINS.*3 lines in 2 files/);
  });
  it("returns nothing for an owner that is not referenced", () => {
    assert.deepEqual(scan(repo, "nobody-here/app"), { pins: [], documents: [], constants: [], logins: [] });
  });
});

describe("rewrite", () => {
  it("changes only the pins and keeps line endings", () => {
    assert.deepEqual(rewrite(repo, "old-owner/app", "new-org/app"), [".github/workflows/a.yml", "docs/ops/pilot/config.mjs"]);
    assert.equal(read(".github/workflows/a.yml"), "if: github.repository == 'new-org/app'\r\nurl: https://github.com/new-org/app.git\r\n");
    for (const path of [".github/CODEOWNERS", "scripts/verify.ts", "scripts/other.ts", "docs/guide.md", "docs/x/evidence/run.json"]) assert.equal(read(path), files[path], path);
    assert.equal(scan(repo, "old-owner/app").pins.length, 0);
  });
  it("refuses to run over uncommitted changes and changes nothing", () => {
    writeFileSync(join(repo, "docs/ops/pilot/config.mjs"), `${files["docs/ops/pilot/config.mjs"]}// edited\n`);
    assert.throws(() => rewrite(repo, "old-owner/app", "new-org/app"), /commit or discard/);
    assert.equal(read(".github/workflows/a.yml"), files[".github/workflows/a.yml"]);
  });
  it("refuses a malformed destination", () => {
    assert.throws(() => rewrite(repo, "old-owner/app", "new-org"), /owner\/name/);
  });
});
