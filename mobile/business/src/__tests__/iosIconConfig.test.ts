import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
  The icon iOS actually builds from is expo.ios.icon, or expo.icon when that is not set. App Store Connect rejects an icon with an alpha channel, so
  whichever file that is must be RGB (PNG colour type 2) or palette (3) with no tRNS chunk. The file itself is checked in iosIcon.test.ts.
*/

const ROOT = join(__dirname, "..", "..");
const app = JSON.parse(readFileSync(join(ROOT, "app.json"), "utf8")).expo as { icon?: string; ios?: { icon?: string } };

function colorTypeAndChunks(file: string) {
  const buffer = readFileSync(join(ROOT, file));
  const types: string[] = [];
  let colorType = -1;
  for (let at = 8; at < buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("ascii", at + 4, at + 8);
    types.push(type);
    if (type === "IHDR") colorType = buffer[at + 8 + 9];
    at += 12 + length;
  }
  return { colorType, types };
}

describe("the icon iOS builds from", () => {
  const file = app.ios?.icon ?? app.icon;

  it("is set, and is not the Android adaptive foreground", () => {
    expect(file).toBeTruthy();
    expect(file).not.toContain("adaptive");
  });

  it("has no alpha channel and no tRNS chunk", () => {
    const { colorType, types } = colorTypeAndChunks(file!);
    expect([2, 3]).toContain(colorType);
    expect(types).not.toContain("tRNS");
  });

  it("is the dedicated iOS copy, so the RGBA icon stays available to Android", () => {
    expect(app.ios?.icon).toBe("./assets/danceflow-app-icon-1024-ios.png");
  });
});
