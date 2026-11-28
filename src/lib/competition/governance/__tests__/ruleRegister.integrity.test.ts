// Rule register integrity (no network, no DB). See docs/competition/RULEBOOK_GOVERNANCE.md.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const REGISTER_DIR = join(ROOT, "docs/competition/governance/rule-register");
const RULES_DIR = join(REGISTER_DIR, "rules");
const SOURCE_REGISTRY = join(ROOT, "docs/competition/governing-body-source-registry.md");

type Json = unknown;
type Schema = {
  type?: string | string[];
  enum?: Json[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
  minItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Minimal draft-07 subset validator (the subset register.schema.json uses). */
export function validate(value: Json, schema: Schema, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.includes(typeOf(value))) {
      return [`${path}: expected ${allowed.join("|")}, got ${typeOf(value)}`];
    }
  }
  if (schema.enum && !schema.enum.includes(value as never)) {
    errors.push(`${path}: not one of ${schema.enum.join(", ")}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern mismatch`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(v, schema.items!, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, Json>;
    for (const r of schema.required ?? []) if (!(r in obj)) errors.push(`${path}.${r}: required`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub) errors.push(...validate(v, sub, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: unknown property`);
    }
  }
  return errors;
}

type Entry = {
  id: string;
  example?: boolean;
  governing_body: string;
  rule_class: string;
  verification_status: string;
  interpretation_notes: string;
  source: null | {
    registry_document: string;
    edition: string;
    sha256: string;
    effective_from: string;
    effective_to: string | null;
  };
  applicable_event_versions: string[];
  implementation: { path: string; symbol_or_migration: string }[];
  tests: { path: string; name: string }[];
};

const POLICY_CLASSES = ["dance_flow_policy", "organizer_policy", "rulebook_silent"];
const POLICY_BODIES = ["dance_flow_policy", "organizer_policy", "silent"];
const NEEDS_NOTES = ["inconsistent", "unsupported", "requires_interpretation"];

type RegistryRow = { body: string; edition: string; sha: string; status: string };

/** Parse source-registry table rows (6 cells) keyed by the backticked file name. */
export function parseSourceRegistry(md: string): Map<string, RegistryRow> {
  const rows = new Map<string, RegistryRow>();
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 6) continue;
    const file = /^`([^`]+\.pdf)`$/i.exec(cells[3])?.[1];
    const sha = /^`([0-9a-f]{64})`$/.exec(cells[4])?.[1];
    if (file && sha) rows.set(file, { body: cells[0], edition: cells[2], sha, status: cells[5] });
  }
  return rows;
}

/** A test title must be the title of an it()/test()/describe() call, not just text anywhere in the file. */
export function hasTestTitle(src: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("\\b(?:it|test|describe)(?:\\.\\w+)*\\(\\s*([\"'`])" + esc + "\\1").test(src);
}

/** Cross-field checks beyond the schema. Returns problems (empty = ok). */
export function checkEntry(e: Entry, registry: Map<string, RegistryRow>, root = ROOT): string[] {
  const p: string[] = [];
  const policy = POLICY_CLASSES.includes(e.rule_class);
  if (policy) {
    if (e.source !== null) p.push(`${e.id}: ${e.rule_class} must not carry a governing-body source`);
    const want = e.rule_class === "rulebook_silent" ? "silent" : e.rule_class;
    if (e.governing_body !== want) p.push(`${e.id}: ${e.rule_class} needs governing_body ${want}`);
  } else {
    if (POLICY_BODIES.includes(e.governing_body)) p.push(`${e.id}: governing-body class ${e.rule_class} cannot use ${e.governing_body}`);
    if (!e.source) p.push(`${e.id}: governing-body rule needs a source`);
  }
  if (e.source) {
    if (!e.source.effective_from) p.push(`${e.id}: effective_from missing`);
    const row = registry.get(e.source.registry_document);
    if (!row) p.push(`${e.id}: registry_document not in source registry`);
    else {
      if (row.sha !== e.source.sha256) p.push(`${e.id}: sha256 does not match the registry row`);
      if (row.body !== e.governing_body) p.push(`${e.id}: governing_body ${e.governing_body} differs from registry body ${row.body} (cross-body use needs written justification and an owner decision)`);
      if (row.status !== "authoritative") p.push(`${e.id}: cited document status is "${row.status}", not authoritative`);
      if (!row.edition.includes(e.source.edition)) p.push(`${e.id}: edition does not match the registry row`);
      if (!e.applicable_event_versions.includes(e.source.edition)) p.push(`${e.id}: applicable_event_versions must include source.edition`);
    }
    if (e.source.effective_to && e.source.effective_to < e.source.effective_from) p.push(`${e.id}: effective_to before effective_from`);
  }
  if (NEEDS_NOTES.includes(e.verification_status) && !e.interpretation_notes.trim()) {
    p.push(`${e.id}: ${e.verification_status} needs interpretation_notes`);
  }
  if (e.verification_status === "verified_compliant" && !e.example) {
    if (e.implementation.length === 0) p.push(`${e.id}: verified_compliant needs implementation`);
    if (e.tests.length === 0) p.push(`${e.id}: verified_compliant needs tests`);
    for (const i of e.implementation) {
      const f = resolve(root, i.path);
      if (!f.startsWith(resolve(root) + sep)) p.push(`${e.id}: path escapes repo: ${i.path}`);
      else if (!existsSync(f) || !statSync(f).isFile()) p.push(`${e.id}: implementation path missing or not a file: ${i.path}`);
      else if (!readFileSync(f, "utf8").includes(i.symbol_or_migration)) p.push(`${e.id}: symbol not found in ${i.path}: ${i.symbol_or_migration}`);
    }
    for (const t of e.tests) {
      const f = resolve(root, t.path);
      if (!f.startsWith(resolve(root) + sep)) p.push(`${e.id}: path escapes repo: ${t.path}`);
      else if (!existsSync(f) || !statSync(f).isFile()) p.push(`${e.id}: test file missing: ${t.path}`);
      else if (!hasTestTitle(readFileSync(f, "utf8"), t.name)) p.push(`${e.id}: test name not found in ${t.path}: ${t.name}`);
    }
  }
  return p;
}

const schema = JSON.parse(readFileSync(join(REGISTER_DIR, "register.schema.json"), "utf8")) as Schema;
const registry = parseSourceRegistry(readFileSync(SOURCE_REGISTRY, "utf8"));
const files = readdirSync(RULES_DIR).filter((f) => f.endsWith(".json"));
const entries = files.map((f) => ({ file: f, entry: JSON.parse(readFileSync(join(RULES_DIR, f), "utf8")) as Entry }));

const THIS = "src/lib/competition/governance/__tests__/ruleRegister.integrity.test.ts";

const goodEntry =(over: Partial<Entry> = {}): Entry => ({
  id: "T-1",
  governing_body: "UCWDC",
  rule_class: "mandatory",
  verification_status: "unverified",
  interpretation_notes: "",
  applicable_event_versions: ["2026 (v1-26-2026)"],
  source: { registry_document: "2026-UCWDC-Rules_Couples_v1-26-2026-1.pdf", edition: "2026 (v1-26-2026)", sha256: "8a45ee58d189e65dbda142a261dd311a3404138bcf75b7a533be7b0ef8974904", effective_from: "2026-01-26", effective_to: null },
  implementation: [],
  tests: [],
  ...over,
});

describe("rule register integrity", () => {
  it("source registry parses and pins every body", () => {
    expect(registry.size).toBeGreaterThanOrEqual(8);
    for (const r of registry.values()) expect(r.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("has at least the example entry", () => {
    expect(entries.some((e) => e.entry.example === true)).toBe(true);
  });

  it("every entry validates against register.schema.json", () => {
    for (const { file, entry } of entries) expect(validate(entry, schema), file).toEqual([]);
  });

  it("ids are unique and match file names", () => {
    const ids = entries.map((e) => e.entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { file, entry } of entries) expect(file).toBe(`${entry.id}.json`);
  });

  it("every entry passes the cross-field governance checks", () => {
    for (const { entry } of entries) expect(checkEntry(entry, registry)).toEqual([]);
  });

  it("only the example entry may be marked example", () => {
    for (const { entry } of entries) if (entry.example) expect(entry.id).toMatch(/^EXAMPLE-/);
  });
});

describe("integrity checks catch violations", () => {
  it("rejects a wrong sha256", () => {
    const e = goodEntry();
    e.source!.sha256 = "0".repeat(64);
    expect(checkEntry(e, registry).join()).toMatch(/sha256 does not match/);
  });
  it("rejects cross-body citation, non-authoritative documents and edition mismatch", () => {
    expect(checkEntry(goodEntry({ governing_body: "NDCA" }), registry).join()).toMatch(/differs from registry body/);
    const draft = goodEntry({ governing_body: "WSDC" });
    draft.source!.registry_document = "2027-Draft-WSDC-Registry-Event-Rules1.pdf";
    draft.source!.sha256 = "c0bd5bdcded5f522369f8706134ef9c6f987118d7e5eb1d1f0c3b68e2f815754";
    expect(checkEntry(draft, registry).join()).toMatch(/not authoritative/);
    expect(checkEntry(goodEntry({ applicable_event_versions: ["other"] }), registry).join()).toMatch(/applicable_event_versions/);
  });
  it("test titles must be real it/test/describe titles", () => {
    expect(hasTestTitle('it("a b", () => {})', "a b")).toBe(true);
    expect(hasTestTitle("// a b", "a b")).toBe(false);
  });
  it("rejects policy classes carrying a governing-body source", () => {
    for (const c of POLICY_CLASSES) {
      expect(checkEntry(goodEntry({ rule_class: c }), registry).join()).toMatch(/must not carry/);
    }
  });
  it("requires interpretation_notes for non-compliant findings", () => {
    for (const s of NEEDS_NOTES) {
      expect(checkEntry(goodEntry({ verification_status: s }), registry).join()).toMatch(/needs interpretation_notes/);
    }
  });
  it("verified_compliant needs existing implementation and a test name present in the file", () => {
    const base = goodEntry({ verification_status: "verified_compliant" });
    expect(checkEntry(base, registry).join()).toMatch(/needs implementation/);
    const missing = goodEntry({
      verification_status: "verified_compliant",
      implementation: [{ path: "src/nope.ts", symbol_or_migration: "x" }],
      tests: [{ path: "src/nope.test.ts", name: "x" }],
    });
    expect(checkEntry(missing, registry).join()).toMatch(/implementation path missing/);
    const wrongName = goodEntry({
      verification_status: "verified_compliant",
      implementation: [{ path: THIS, symbol_or_migration: "checkEntry" }],
      tests: [{ path: THIS, name: "no such test name zzz" }],
    });
    expect(checkEntry(wrongName, registry).join()).toMatch(/test name not found/);
    const ok = goodEntry({
      verification_status: "verified_compliant",
      implementation: [{ path: THIS, symbol_or_migration: "checkEntry" }],
      tests: [{ path: THIS, name: "source registry parses and pins every body" }],
    });
    expect(checkEntry(ok, registry)).toEqual([]);
  });
  it("schema rejects missing effective_from and unknown fields", () => {
    const e = JSON.parse(JSON.stringify(entries.find((x) => x.entry.source)!.entry)) as Record<string, unknown>;
    delete (e.source as Record<string, unknown>).effective_from;
    e.extra = 1;
    const errs = validate(e, schema).join();
    expect(errs).toMatch(/effective_from: required/);
    expect(errs).toMatch(/extra: unknown property/);
  });
});

describe("governance docs and templates exist", () => {
  const required = [
    "docs/competition/RULEBOOK_GOVERNANCE.md",
    "docs/competition/governing-body-source-registry.md",
    "docs/competition/governance/rule-register/README.md",
    "docs/competition/governance/rule-register/register.schema.json",
    "docs/competition/governance/decision-record-template.md",
    "docs/competition/governance/audit/README.md",
    "docs/competition/governance/audit/TRACKER.md",
    ".github/PULL_REQUEST_TEMPLATE/competition-os.md",
    "CLAUDE.md",
  ];
  for (const f of required) {
    it(`${f} exists`, () => expect(existsSync(join(ROOT, f))).toBe(true));
  }
  it("decision record and PR template carry all 8 requirement checkboxes", () => {
    for (const f of ["docs/competition/governance/decision-record-template.md", ".github/PULL_REQUEST_TEMPLATE/competition-os.md"]) {
      const text = readFileSync(join(ROOT, f), "utf8");
      for (let n = 1; n <= 8; n++) expect(text, `${f} item ${n}`).toMatch(new RegExp(`- \\[ \\] ${n}\\. `));
    }
  });
  it("tracker lists all nine owner-listed domains", () => {
    const rows = readFileSync(join(ROOT, "docs/competition/governance/audit/TRACKER.md"), "utf8")
      .split(/\r?\n/)
      .filter((l) => /^\| \d+ \|/.test(l));
    expect(rows).toHaveLength(9);
  });
  it("CLAUDE.md points at governance, registry and audit directory", () => {
    const t = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
    expect(t).toContain("Competition OS: rulebook governance (permanent)");
    expect(t).toContain("docs/competition/RULEBOOK_GOVERNANCE.md");
    expect(t).toContain("docs/competition/governance/audit/");
  });
});
