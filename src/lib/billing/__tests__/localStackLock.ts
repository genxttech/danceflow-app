import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A cross-process mutex for the local-stack test suites that exercise GLOBAL database behaviour (the recurring-charge scheduler charges every due authorization in the
 * database, so two such suites running at once would see each other's data). Local QA only: the suites that use it are skipped without the local stack.
 */
export async function acquireSuiteLock(name: string, timeoutMs = 900_000): Promise<() => void> {
  const dir = join(tmpdir(), `tw4-localstack-${name}.lock`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(dir);
      return () => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* already gone */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(dir).mtimeMs > 20 * 60_000) rmSync(dir, { recursive: true, force: true }); // a crashed holder
      } catch {
        /* raced with the holder releasing */
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the ${name} suite lock`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
