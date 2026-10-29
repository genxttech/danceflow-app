import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * The environment a billing QA tool runs with. Values in `--env-file` WIN over the shell: Node's own loadEnvFile keeps
 * any variable already exported, so a stale exported Price ID, flag or key would silently beat the file the operator
 * named. Never written back to process.env.
 */
export function qaEnvironment(envFile: string | null, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  if (!envFile) return base;
  return { ...base, ...parseEnv(readFileSync(envFile, "utf8")) };
}
