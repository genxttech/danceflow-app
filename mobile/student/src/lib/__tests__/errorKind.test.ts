import { classifyError } from "@/lib/errorKind";

describe("classifyError", () => {
  it.each([
    ["Network request failed", "offline"],
    [new TypeError("Failed to fetch"), "offline"],
    ["The request timed out.", "offline"],
    ["Authentication required.", "signedOut"],
    ["JWT expired", "signedOut"],
    ["Not authorized to manage this roster.", "forbidden"],
    ['new row violates row-level security policy (42501)', "forbidden"],
    ["This recap could not be found.", "notFound"],
    ["Event not found", "notFound"],
    ["Stripe returned an unexpected response.", "unknown"],
    ["", "unknown"],
    [null, "unknown"],
    [undefined, "unknown"]
  ])("%p is %s", (error, kind) => {
    expect(classifyError(error)).toBe(kind);
  });
});

describe("friendlyMessage", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { friendlyMessage } = require("@/lib/errorKind") as typeof import("@/lib/errorKind");

  it("never shows a raw network failure", () => {
    expect(friendlyMessage(new TypeError("Network request failed"), "x")).toBe("You're offline. Check your connection, then try again.");
  });

  it("tells an ended session to sign in again", () => {
    expect(friendlyMessage(new Error("JWT expired"), "x")).toBe("Sign in again. Your session ended. Sign in to pick up where you left off.");
  });

  it("keeps the server's own wording, and falls back when there is none", () => {
    expect(friendlyMessage(new Error("That time was just taken."), "x")).toBe("That time was just taken.");
    expect(friendlyMessage(undefined, "Could not submit the request.")).toBe("Could not submit the request.");
    expect(friendlyMessage(new Error(""), "Could not submit the request.")).toBe("Could not submit the request.");
  });
});

describe("screens use friendlyMessage, not a raw error.message", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readdirSync, readFileSync, statSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? (name === "__tests__" ? [] : walk(p)) : /\.tsx$/.test(name) ? [p] : [];
    });

  it("no screen shows `error instanceof Error ? error.message : ...` directly", () => {
    const root = join(__dirname, "..", "..", "..");
    const offenders = [...walk(join(root, "app")), ...walk(join(root, "src", "components"))].filter((file) =>
      /set(Error|Message)\(\s*\w+ instanceof Error \? \w+\.message/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("the Lumi screen shows a retryable error when its studio data fails to load", () => {
    const root = join(__dirname, "..", "..", "..");
    const lumi = readFileSync(join(root, "app", "lumi.tsx"), "utf8");
    expect(lumi).toMatch(/<ErrorState[^>]*onRetry=/);
    expect(lumi).toMatch(/\[session\?\.user\.id, loadAttempt\]/);
  });
});
