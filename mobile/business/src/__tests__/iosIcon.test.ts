import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
  App Store Connect rejects an app icon with an alpha channel or transparency. The icon in assets/danceflow-app-icon-1024.png is RGBA (fully opaque, but with
  an alpha channel), so iOS uses a flattened RGB copy. This reads the PNG chunks directly: no image library is needed to see the colour type.
*/

const ASSETS = join(__dirname, "..", "..", "assets");
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunksOf(buffer: Buffer) {
  expect(buffer.subarray(0, 8).equals(SIGNATURE)).toBe(true);
  const list: { type: string; data: Buffer }[] = [];
  for (let at = 8; at < buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    list.push({ type: buffer.toString("ascii", at + 4, at + 8), data: buffer.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return list;
}

const chunks = (file: string) => chunksOf(readFileSync(join(ASSETS, file)));

function headerOf(list: { type: string; data: Buffer }[]) {
  const ihdr = list.find((c) => c.type === "IHDR")!.data;
  return { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), bitDepth: ihdr[8], colorType: ihdr[9] };
}
const header = (file: string) => headerOf(chunks(file));

describe("the iOS app icon", () => {
  const file = "danceflow-app-icon-1024-ios.png";

  it("is 1024 x 1024, 8 bits, and RGB (colour type 2) or palette (3): never grayscale-alpha (4) or RGBA (6)", () => {
    const h = header(file);
    expect([h.width, h.height, h.bitDepth]).toEqual([1024, 1024, 8]);
    expect([2, 3]).toContain(h.colorType);
  });

  it("has no tRNS chunk, so a palette cannot smuggle transparency back in", () => {
    expect(chunks(file).map((c) => c.type)).not.toContain("tRNS");
  });

  it("the Android adaptive-icon source keeps its own files: the original icon is still there and still the same size", () => {
    expect(header("danceflow-app-icon-1024.png")).toMatchObject({ width: 1024, height: 1024 });
  });
});

describe("the checker itself", () => {
  // a minimal 1 x 1 RGBA PNG, built in memory: IHDR (colour type 6) and a tRNS chunk, each with a dummy CRC (the reader does not check it)
  const chunk = (type: string, data: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, data.length]), Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  const ihdr = (colorType: number) => Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, colorType, 0, 0, 0]);

  it("reads the colour type, so an RGBA (6) icon is seen and rejected by the test above", () => {
    const rgba = Buffer.concat([SIGNATURE, chunk("IHDR", ihdr(6)), chunk("IEND", Buffer.alloc(0))]);
    expect(headerOf(chunksOf(rgba)).colorType).toBe(6);
    expect([2, 3]).not.toContain(6);
  });

  it("sees a tRNS chunk on a palette image", () => {
    const palette = Buffer.concat([SIGNATURE, chunk("IHDR", ihdr(3)), chunk("tRNS", Buffer.from([0])), chunk("IEND", Buffer.alloc(0))]);
    expect(chunksOf(palette).map((c) => c.type)).toContain("tRNS");
  });
});
