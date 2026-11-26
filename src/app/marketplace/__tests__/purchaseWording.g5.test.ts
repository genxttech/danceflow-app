import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// G5: the student app does not sell marketplace items (mobile/student/app/discover/marketplace says so), so the public pages must not say it does.
const read = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");

describe("public marketplace purchase wording", () => {
  it.each(["src/app/marketplace/page.tsx", "src/app/marketplace/[catalogItemId]/page.tsx"])("%s does not send people to the app to buy", (path) => {
    const source = read(path);
    expect(source).not.toMatch(/Purchases? (are completed )?in the DanceFlow student app/i);
    expect(source).not.toMatch(/receipt appears in Wallet after payment/i);
    expect(source).toMatch(/not sold on this page or in the DanceFlow student app/i);
  });

  it("matches what the app itself says", () => {
    expect(read("mobile/student/app/discover/marketplace/[catalogItemId].tsx")).toMatch(/does not sell digital videos or series inside the mobile app/);
  });
});
