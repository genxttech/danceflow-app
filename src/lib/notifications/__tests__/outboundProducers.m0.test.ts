import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Marketing M-0 (D): queued notifications are written ONLY with the service role. Stage 2 of the M-0 migrations removes
 * every client-role write to outbound_deliveries (a signed-in user could otherwise forge operational or DanceFlow
 * notifications, or send arbitrary content through the transactional sender). This guard fails as soon as any producer
 * inserts or upserts outbound_deliveries through a client that is not provably created by createAdminClient().
 */

const ROOT = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

type Producer = { file: string; line: number; receiver: string };

function outboundWriters(): Producer[] {
  const found: Producer[] = [];
  for (const file of sourceFiles(ROOT)) {
    const lines = readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
    lines.forEach((text, index) => {
      if (!text.includes('.from("outbound_deliveries")')) return;
      const following = lines.slice(index, index + 3).join(" ");
      if (!/\.(insert|upsert)\(/.test(following)) return;
      // The receiver is on this line (`x.from(...)`) or the line above (`await x` + newline + `.from(...)`).
      const sameLine = text.match(/([\w.]+(?:\(\))?)\s*\.from\("outbound_deliveries"\)/);
      const previous = lines[index - 1] ?? "";
      const prevLine = previous.match(/(?:await\s+)?([\w.]+(?:\(\))?)\s*$/);
      const receiver = (sameLine?.[1] ?? prevLine?.[1] ?? "").trim();
      found.push({ file: relative(process.cwd(), file).replace(/\\/g, "/"), line: index + 1, receiver });
    });
  }
  return found;
}

function isServiceRoleReceiver(producer: Producer) {
  if (producer.receiver === "createAdminClient()") return true;
  const source = readFileSync(join(process.cwd(), producer.file), "utf8");
  const name = producer.receiver.split(".").pop() ?? "";
  if (!name) return false;
  return (
    new RegExp(`\\b${name}\\s*=\\s*createAdminClient\\(\\)`).test(source) ||
    new RegExp(`\\b${name}\\s*:\\s*ReturnType<typeof createAdminClient>`).test(source)
  );
}

describe("outbound_deliveries producers (Marketing M-0, D)", () => {
  const producers = outboundWriters();

  it("finds the known producers (the scan itself works)", () => {
    const files = new Set(producers.map((p) => p.file));
    expect(files).toEqual(
      new Set([
        "src/app/api/cron/aria-digest/route.ts",
        "src/app/app/automations/actions.ts",
        "src/app/app/clients/[id]/actions.ts",
        "src/app/app/documents/actions.ts",
        "src/app/app/documents/sign/actions.ts",
        "src/app/book/[studioSlug]/actions.ts",
        "src/app/app/schedule/actions.ts",
        "src/app/portal/[studioSlug]/schedule/actions.ts",
        "src/lib/notifications/outbound.ts",
      ]),
    );
  });

  it("every producer writes with a service-role client, never the signed-in user's session client", () => {
    const offenders = producers.filter((p) => !isServiceRoleReceiver(p));
    expect(offenders).toEqual([]);
  });

  it("the appointment producer uses its admin client, not the caller's session client", () => {
    const schedule = producers.filter((p) => p.file === "src/app/app/schedule/actions.ts");
    expect(schedule.map((p) => p.receiver)).toEqual(["notificationSupabase"]);
  });
});
