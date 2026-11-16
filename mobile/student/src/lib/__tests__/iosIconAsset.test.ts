import { readFileSync } from "node:fs";
import { join } from "node:path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PNG } = require("pngjs") as { PNG: { sync: { read: (b: Buffer) => { width: number; height: number; data: Buffer } } } };

const assets = join(__dirname, "..", "..", "..", "assets");
const ios = readFileSync(join(assets, "danceflow-app-icon-1024-ios.png"));

// App Store Connect rejects a marketing icon that has an alpha channel, even a fully opaque one.
describe("iOS app icon asset", () => {
  it("is 1024x1024 8-bit RGB (PNG color type 2), with no alpha channel and no transparency chunk", () => {
    expect(ios.subarray(1, 4).toString()).toBe("PNG");
    expect(ios.readUInt32BE(16)).toBe(1024);
    expect(ios.readUInt32BE(20)).toBe(1024);
    expect(ios[24]).toBe(8);
    expect(ios[25]).toBe(2);
    expect(ios.includes(Buffer.from("tRNS"))).toBe(false);
  });

  it("looks identical to the Android/Expo icon (the original was fully opaque, so removing alpha changes no pixel)", () => {
    const a = PNG.sync.read(readFileSync(join(assets, "danceflow-app-icon-1024.png")));
    const b = PNG.sync.read(ios);
    expect([b.width, b.height]).toEqual([a.width, a.height]);
    let differing = 0;
    for (let i = 0; i < a.width * a.height; i++) for (let c = 0; c < 3; c++) if (a.data[i * 4 + c] !== b.data[i * 4 + c]) differing++;
    expect(differing).toBe(0);
    for (let i = 3; i < a.data.length; i += 4) if (a.data[i] !== 255) throw new Error("original icon has transparency; flatten onto the brand background instead");
  });
});
