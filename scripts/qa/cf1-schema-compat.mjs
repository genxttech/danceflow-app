// CF1 candidate static schema-compatibility check (no database connection).
// Usage: node scripts/qa/cf1-schema-compat.mjs <base-commit> <prod-post-fingerprint-dir> <manifest.tsv> <out.json>
// Every RPC, table/view and column that app code changed since <base-commit> refers to is checked against:
//   functions, relations and grants: the PROD post-S3 catalog fingerprints (q02_F, q04_R, q08_G);
//   columns and RPC argument names: the repo migration DDL, attributed to the migration that defines them.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [base, fpDir, manifestPath, outPath] = process.argv.slice(2);
const MIG = "src/lib/supabase/migrations";
const rows = (q) => JSON.parse(fs.readFileSync(path.join(fpDir, `${q}.json`), "utf8")).rows.map((r) => r.l);

const prodFns = new Map(); // name -> [{args, acl}]
for (const l of rows("q02_F")) {
  const m = l.match(/^F ([a-z0-9_]+)\(([^)]*)\) \S+ \S+ (.*)$/);
  if (!m) continue;
  const list = prodFns.get(m[1]) ?? [];
  list.push({ args: m[2] ? m[2].split(",") : [], acl: m[3] });
  prodFns.set(m[1], list);
}
const prodRels = new Map(rows("q04_R").map((l) => { const [, name, kind] = l.split(" "); return [name, kind]; }));
const prodGrants = new Map(rows("q08_G").map((l) => { const i = l.indexOf(" ", 2); return [l.slice(2, i), l.slice(i + 1)]; }));
const manifest = new Set(fs.readFileSync(manifestPath, "utf8").split(/\r?\n/).slice(1).map((l) => l.split("\t")[5]).filter(Boolean));

const changed = execFileSync("git", ["diff", "--name-only", base, "HEAD", "--", "src"], { encoding: "utf8" }).split(/\r?\n/)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/__tests__|\.test\.ts$/.test(f) && fs.existsSync(f));

// ---- migration DDL index
const migFiles = fs.readdirSync(MIG).filter((f) => /\.sql$/.test(f)).sort();
const cols = new Map(); // table -> Map(col -> first migration)
const fnDefs = new Map(); // name -> [{params:[{name,hasDefault}], file}]
const addCol = (t, c, f) => { const m = cols.get(t) ?? new Map(); if (!m.has(c)) m.set(c, f); cols.set(t, m); };
function splitTop(s) { const out = []; let depth = 0, cur = ""; for (const ch of s) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur); return out; }
function body(sql, start) { let depth = 0; for (let i = start; i < sql.length; i++) { if (sql[i] === "(") depth++; else if (sql[i] === ")") { depth--; if (depth === 0) return sql.slice(start + 1, i); } } return ""; }
for (const f of migFiles) {
  const sql = fs.readFileSync(path.join(MIG, f), "utf8").replace(/--[^\n]*/g, "");
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi)) {
    for (const part of splitTop(body(sql, m.index + m[0].length - 1))) {
      const c = part.trim().match(/^"?([a-z_][a-z0-9_]*)"?\s+/i);
      if (c && !/^(constraint|primary|unique|check|foreign|exclude|like)$/i.test(c[1])) addCol(m[1].toLowerCase(), c[1].toLowerCase(), f);
    }
  }
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?([a-z0-9_]+)"?([\s\S]*?);/gi)) {
    for (const a of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) addCol(m[1].toLowerCase(), a[1].toLowerCase(), f);
    for (const a of m[2].matchAll(/rename\s+column\s+"?([a-z0-9_]+)"?\s+to\s+"?([a-z0-9_]+)"?/gi)) addCol(m[1].toLowerCase(), a[2].toLowerCase(), f);
  }
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?"?([a-z0-9_]+)"?[\s\S]*?\bas\s+select([\s\S]*?)\bfrom\b/gi)) {
    for (const part of splitTop(m[2])) { const a = part.trim().match(/(?:\bas\s+"?([a-z0-9_]+)"?|\.?"?([a-z0-9_]+)"?)\s*$/i); if (a) addCol(m[1].toLowerCase(), (a[1] ?? a[2]).toLowerCase(), f); }
  }
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi)) {
    const params = splitTop(body(sql, m.index + m[0].length - 1)).map((p) => p.trim()).filter(Boolean).map((p) => {
      const t = p.replace(/^(in|out|inout|variadic)\s+/i, "");
      return { name: t.split(/\s+/)[0].replace(/"/g, "").toLowerCase(), hasDefault: /\bdefault\b|=/i.test(t), out: /^out\s/i.test(p) };
    }).filter((p) => !p.out);
    const list = fnDefs.get(m[1].toLowerCase()) ?? [];
    list.push({ params, file: f });
    fnDefs.set(m[1].toLowerCase(), list);
  }
}

// ---- app references
const refs = { rpc: [], table: [], column: [] };
for (const file of changed) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/\brpc\(\s*"([a-z0-9_]+)"\s*(?:,\s*\{([^}]*)\})?/g)) {
    const keys = m[2] ? [...m[2].matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*(?=:|,|$)/gi)].map((k) => k[1].toLowerCase()) : [];
    refs.rpc.push({ file, name: m[1], keys });
  }
  // RPC names handed to helpers as a string argument, e.g. run(supabase, "fn", ...): presence-checked only.
  for (const m of src.matchAll(/"([a-z][a-z0-9_]{6,})"/g)) if (fnDefs.has(m[1]) && !refs.rpc.some((r) => r.file === file && r.name === m[1])) refs.rpc.push({ file, name: m[1], keys: null });
  for (const m of src.matchAll(/\.from\(\s*"([a-z0-9_]+)"\s*\)([\s\S]*?)(?:;|\n\s*\n|\]\);|\),\n)/g)) {
    const table = m[1];
    if (/storage\s*$/.test(src.slice(Math.max(0, m.index - 30), m.index))) continue;
    refs.table.push({ file, table });
    const chain = m[2];
    for (const s of chain.matchAll(/\.select\(\s*"([^"]*)"/g)) {
      for (const raw of splitTop(s[1])) {
        const c = raw.trim();
        if (!c || c === "*" || c.includes("(")) continue; // embeds are checked as relations below
        const name = c.split(":").pop().split("::")[0].trim().toLowerCase();
        if (/^[a-z_][a-z0-9_]*$/.test(name)) refs.column.push({ file, table, column: name, via: "select" });
      }
      for (const e of s[1].matchAll(/([a-z0-9_]+)(?:!\w+)?\s*\(/g)) refs.table.push({ file, table: e[1], embedded: true });
    }
    for (const f of chain.matchAll(/\.(eq|neq|in|is|gt|gte|lt|lte|order|not|filter|contains|match)\(\s*"([a-z0-9_]+)"/g)) refs.column.push({ file, table, column: f[2], via: f[1] });
  }
}

// ---- columns the base (live) release already reads per table, from its whole src tree
let baseIndex = null;
function baseQueries(table) {
  if (!baseIndex) {
    baseIndex = new Map();
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", base, "--", "src"], { encoding: "utf8" }).split(/\r?\n/).filter((f) => /\.(ts|tsx)$/.test(f) && !/__tests__|\.test\.ts$/.test(f));
    for (const f of files) {
      const s = execFileSync("git", ["show", `${base}:${f}`], { encoding: "utf8", maxBuffer: 64 << 20 });
      for (const m of s.matchAll(/\.from\(\s*"([a-z0-9_]+)"\s*\)([\s\S]*?)(?:;|\n\s*\n|\]\);|\),\n)/g)) {
        const set = baseIndex.get(m[1]) ?? new Set();
        for (const w of m[2].matchAll(/[a-z_][a-z0-9_]*/g)) set.add(w[0]);
        baseIndex.set(m[1], set);
      }
    }
  }
  return baseIndex.get(table) ?? new Set();
}

// ---- evaluate
const results = { rpc: [], table: [], column: [] };
const seen = new Set();
for (const r of refs.rpc) {
  const key = `${r.name}|${r.keys === null ? "?" : r.keys.join(",")}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const prod = prodFns.get(r.name) ?? [];
  const defs = fnDefs.get(r.name) ?? [];
  let argsOk = null;
  let matched = null;
  if (r.keys) {
    const ks = new Set(r.keys);
    const byNames = new Map();
    for (const d of defs) byNames.set(d.params.map((p) => p.name).join(","), d); // latest definition per parameter list
    matched = [...byNames.values()].find((d) => r.keys.every((k) => d.params.some((p) => p.name === k)) && d.params.every((p) => p.hasDefault || ks.has(p.name))) ?? null;
    argsOk = Boolean(matched) && prod.some((p) => p.args.length === matched.params.length);
  }
  const definedIn = matched?.file ?? defs.at(-1)?.file ?? null;
  results.rpc.push({
    name: r.name, keys: r.keys,
    files: [...new Set(refs.rpc.filter((x) => x.name === r.name).map((x) => x.file))],
    inProd: prod.length > 0, prodOverloads: prod.map((p) => p.args.join(",")),
    authenticatedExecute: prod.some((p) => /authenticated=X/.test(p.acl)),
    argNamesMatch: argsOk, definedIn, definedInManifest: definedIn ? manifest.has(definedIn) : false,
  });
}
for (const t of [...new Set(refs.table.map((x) => x.table))].sort()) {
  results.table.push({ table: t, inProd: prodRels.has(t), kind: prodRels.get(t) ?? null, authenticatedGrant: /authenticated=/.test(prodGrants.get(t) ?? ""), files: [...new Set(refs.table.filter((x) => x.table === t).map((x) => x.file))] });
}
const colSeen = new Set();
for (const c of refs.column) {
  const key = `${c.table}.${c.column}`;
  if (colSeen.has(key)) continue;
  colSeen.add(key);
  const src = cols.get(c.table)?.get(c.column) ?? null;
  // A column the live release already queries on the same table is proven by production use (base tables such as events were
  // created outside this migration folder).
  const liveQueried = !src && baseQueries(c.table).has(c.column);
  results.column.push({ table: c.table, column: c.column, definedIn: src, liveQueried, definedInManifest: src ? manifest.has(src) : false, files: [...new Set(refs.column.filter((x) => x.table === c.table && x.column === c.column).map((x) => x.file))] });
}
const problems = [
  ...results.rpc.filter((r) => !r.inProd || r.argNamesMatch === false || !r.authenticatedExecute).map((r) => ({ kind: "rpc", ...r })),
  ...results.table.filter((t) => !t.inProd).map((t) => ({ kind: "table", ...t })),
  ...results.column.filter((c) => !c.definedIn && !c.liveQueried).map((c) => ({ kind: "column", ...c })),
];
const summary = { base, files: changed.length, rpcs: results.rpc.length, tables: results.table.length, columns: results.column.length, problems: problems.length };
fs.writeFileSync(outPath, JSON.stringify({ summary, problems, ...results }, null, 2));
console.log(JSON.stringify(summary));
for (const p of problems) {
  const detail = p.kind === "rpc" ? `inProd=${p.inProd} args=${p.argNamesMatch} authExec=${p.authenticatedExecute} keys=${p.keys} prod=${p.prodOverloads.join(" | ")}` : "";
  console.log(p.kind, p.name ?? p.table, p.column ?? "", detail, (p.files ?? []).join(" "));
}
