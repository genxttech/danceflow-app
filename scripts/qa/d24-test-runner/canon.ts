import { createHash } from "node:crypto";

export const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

/** Deterministic JSON: object keys sorted recursively, no whitespace. Arrays keep their order. */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])]));
    }
    return x;
  };
  return JSON.stringify(norm(v));
}
