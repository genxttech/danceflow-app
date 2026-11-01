import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// D24 acceptance suite: real route + real signatures + real Postgres (disposable container). Run via scripts/qa/d24-acceptance.sh.
// M3 draft layers (PR heads) are extracted by d24-stack.sh into D24_OVERLAY and exposed as @d24overlay; inside overlay files an
// "@/..." import resolves overlay-first so a draft layer sees its own sibling changes, then falls back to the merged tree.
const root = path.resolve(import.meta.dirname, "../../..");
const overlay = process.env.D24_OVERLAY ?? "";
const EXT = ["", ".ts", ".tsx", ".mts", "/index.ts", "/index.tsx"];
const pick = (base: string) => EXT.map((e) => base + e).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
export default defineConfig({
  root,
  plugins: [
    {
      name: "d24-overlay-first",
      enforce: "pre",
      resolveId(id: string, importer?: string) {
        if (!overlay || !importer || !id.startsWith("@/")) return null;
        if (!path.resolve(importer).startsWith(path.resolve(overlay))) return null;
        return pick(path.join(overlay, "src", id.slice(2))) ?? null;
      },
    },
  ],
  test: {
    environment: "node",
    include: ["scripts/qa/d24/**/*.test.ts"],
    exclude: ["**/node_modules/**", "scripts/qa/d24/.overlay/**"],
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@d24overlay": path.join(overlay || path.join(root, "scripts/qa/d24/.overlay/none"), "src"),
      "@": path.resolve(root, "./src"),
      "server-only": path.resolve(root, "./src/test/serverOnlyStub.ts"),
    },
  },
});
