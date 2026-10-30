// node --test scripts/qa/tw4f/rehearsalPlan.test.mjs   (pure; no docker, no git)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildRehearsalPlan, compareFp, judgeStages, lfSha256, maskKi2, parseApplyOrder, parseHashTable, tokenToVersion } from "./rehearsalPlan.mjs";

const H = (c) => c.repeat(64);
const md = (orderLine, rows) => `# m\n## 3. Table\n${rows}\n## 4. Apply order and method\n\nNumeric order:\n\n${orderLine}\n\n- note → not an order line\n## 5. next\n`;

test("tokens", () => {
  assert.equal(tokenToVersion("1205"), "20261205090000");
  assert.equal(tokenToVersion("1119_090"), "20261119090000");
  assert.equal(tokenToVersion("1119_092100"), "20261119092100");
  assert.equal(tokenToVersion("1202_140"), "20261202140000");
  assert.equal(tokenToVersion("1231"), "20261231090000");
  assert.equal(tokenToVersion("1231b"), "20261231100000");
  assert.equal(tokenToVersion("20261231100000"), "20261231100000");
  assert.throws(() => tokenToVersion("12x"));
});

test("order line: arrows, brackets, tail 1230 -> 1231 -> 1231b", () => {
  const o = parseApplyOrder(md("`1119_090 → 1205 → 1207 → [1215, merged] → 1206 → 1230 → 1231 → 1231b`", ""));
  assert.deepEqual(o, ["20261119090000", "20261205090000", "20261207090000", "20261215090000", "20261206090000", "20261230090000", "20261231090000", "20261231100000"]);
  assert.throws(() => parseApplyOrder(md("`1205 → 1205`", "")), /twice/);
  assert.throws(() => parseApplyOrder("# no section"), /no '## 4/);
});

test("the real manifest parses and every order entry has a hash row (when the doc is present)", () => {
  const doc = new URL("../../../docs/twilio/TW-4F_Hosted_Apply_Manifest.md", import.meta.url);
  const text = readFileSync(doc, "utf8");
  const order = parseApplyOrder(text);
  const table = parseHashTable(text);
  assert.ok(order.length >= 40);
  for (const v of order) assert.ok(table.has(v), `no hash row for ${v}`);
});

test("plan: complete, missing file, omission, wrong cutoff", () => {
  const rows = `| 20261206090000 | 20261206090000_twilio_a.sql | ${H("a")} | ${H("b")} | x |\n| 20261207090000 | 20261207090000_twilio_b.sql | ${H("c")} | n/a | x |`;
  const table = parseHashTable(md("", rows));
  assert.equal(table.size, 2);
  assert.equal(table.get("20261207090000").rollbackSha, null);
  const files = ["20261206090000_twilio_a.sql", "20261207090000_twilio_b.sql"];
  const plan = buildRehearsalPlan({ order: ["20261206090000", "20261207090000"], table, filesAtRef: files, cutoff: "20261118090000" });
  assert.deepEqual(plan.map((p) => p.version), ["20261206090000", "20261207090000"]);
  assert.throws(() => buildRehearsalPlan({ order: ["20261206090000", "20261207090000"], table, filesAtRef: files.slice(0, 1), cutoff: "20261118090000" }), /exactly once/);
  assert.throws(() => buildRehearsalPlan({ order: ["20261206090000"], table, filesAtRef: files, cutoff: "20261118090000" }), /not in the manifest apply order/);
  assert.throws(() => buildRehearsalPlan({ order: ["20261206090000", "20261207090000"], table, filesAtRef: files, cutoff: "20261206090000" }), /already inside the image/);
  assert.throws(() => buildRehearsalPlan({ order: ["20261206090000", "20261207090000", "20261231090000"], table, filesAtRef: [...files, "20261231090000_twilio_c.sql"], cutoff: "20261118090000" }), /no manifest hash row/);
});

test("fingerprints: exact / KI-2 residue only / anything else", () => {
  const ki2 = "con studio_sms_approval_refs studio_sms_approval_refs_shape abc";
  const ki2n = "con studio_sms_approval_refs studio_sms_approval_refs_shape narrow";
  const base = ["fn a 1", "tbl t"];
  assert.equal(judgeStages([{ cmp: compareFp(base, [...base]) }]), "PASS");
  assert.equal(judgeStages([{ cmp: compareFp([...base, ki2n], [...base, ki2]) }]), "KNOWN");
  assert.equal(judgeStages([{ cmp: compareFp(base, [...base, ki2]) }]), "FAIL", "a new KI-2-named constraint is not widening");
  assert.equal(judgeStages([{ cmp: compareFp([...base, ki2n], base) }]), "FAIL", "a dropped one is not widening");
  assert.equal(judgeStages([{ cmp: compareFp([...base, ki2n], [...base, ki2, "fn b 2"]) }]), "FAIL");
  assert.equal(judgeStages([{ cmp: compareFp(base, ["fn a 2", "tbl t"]) }]), "FAIL");
  assert.equal(judgeStages([{ cmp: compareFp(base, [...base, "con t some_other_con x"]) }]), "FAIL");
  assert.deepEqual(maskKi2([ki2, "fn a"]), ["fn a"]);
});

test("hash convention is LF-normalised", () => {
  assert.equal(lfSha256("a\r\nb"), lfSha256("a\nb"));
});
