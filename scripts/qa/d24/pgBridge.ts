import { execFile, spawnSync } from "node:child_process";

/**
 * Bridge from the webhook route's Supabase client to the DISPOSABLE Postgres container started by scripts/qa/d24-stack.sh.
 * RPCs run as role service_role (the role the route's service key maps to), so grants are exercised for real. Nothing here can
 * reach a hosted database: the only transport is `docker exec` into the local container.
 */

export const CONTAINER = process.env.D24_QA_CONTAINER ?? "df-d24-qa-pg";

export function stackLayers(): string[] | null {
  // only ever talk to a container the stack script created (label), never an arbitrary one that shares the name
  const lab = spawnSync("docker", ["inspect", "-f", '{{index .Config.Labels "df-d24-qa"}}', CONTAINER], { encoding: "utf8" });
  if (lab.status !== 0 || lab.stdout.trim() !== "1") return null;
  const r = spawnSync("docker", ["exec", CONTAINER, "cat", "/tmp/d24-layers"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim().split(/\s+/).filter(Boolean);
}

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `array[${v.map(lit).join(",")}]::text[]`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

export type PgResult = { out: string; error: { code: string; message: string } | null };

export function runSql(sql: string, role: string | null = "service_role"): Promise<PgResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "docker",
      ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-f", "-"],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const m = /ERROR:\s+([0-9A-Z]{5}):\s*([^\n]*)/.exec(stderr);
        if (err && !m) return resolve({ out: stdout, error: { code: "XX000", message: (stderr || String(err)).slice(0, 300) } });
        resolve({ out: stdout.trim(), error: m ? { code: m[1], message: m[2] } : null });
      },
    );
    child.stdin!.end(`${role ? `set role ${role};\n` : ""}${sql}\n`);
  });
}

/** Scalar query as superuser (assertions only; never the route's path). */
export async function q(sql: string): Promise<string> {
  const r = await runSql(sql, null);
  if (r.error) throw new Error(`q failed: ${r.error.code} ${r.error.message}\n${sql.slice(0, 300)}`);
  return r.out;
}

/** Run SQL as an arbitrary role; returns the first line of output or "ERR <code> <message>". */
export async function as(role: string, sql: string): Promise<string> {
  const r = await runSql(sql, role);
  return r.error ? `ERR ${r.error.code} ${r.error.message}` : r.out;
}

export async function rpc(fn: string, args: Record<string, unknown>, role: string | null = "service_role"): Promise<{ data: unknown; error: { code: string; message: string } | null }> {
  const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(", ");
  const r = await runSql(`select to_jsonb(public.${fn}(${named}));`, role);
  if (r.error) return { data: null, error: r.error };
  const line = r.out.split("\n").pop() ?? "";
  return { data: line ? JSON.parse(line) : null, error: null };
}
