import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

/*
  App Store Connect rejects an app icon with an alpha channel or transparency. The icon in assets/danceflow-app-icon-1024.png is RGBA (fully opaque, but with
  an alpha channel), so iOS uses a flattened RGB copy. This reads the PNG chunks directly and decodes the pixels with Node's zlib: no image library is needed.
*/

const ASSETS = join(__dirname, "..", "..", "assets");
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Chunk = { type: string; data: Buffer };

function chunksOf(buffer: Buffer): Chunk[] {
  expect(buffer.subarray(0, 8).equals(SIGNATURE)).toBe(true);
  const list: Chunk[] = [];
  for (let at = 8; at < buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    list.push({ type: buffer.toString("ascii", at + 4, at + 8), data: buffer.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return list;
}

const chunks = (file: string) => chunksOf(readFileSync(join(ASSETS, file)));

function headerOf(list: Chunk[]) {
  const ihdr = list.find((c) => c.type === "IHDR")!.data;
  return { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), bitDepth: ihdr[8], colorType: ihdr[9] };
}
const header = (file: string) => headerOf(chunks(file));

/** Decodes an 8-bit RGB or RGBA PNG (Node zlib plus the five PNG scanline filters). */
function decode(file: string) {
  const list = chunks(file);
  const { width, height, colorType } = headerOf(list);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(list.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x];
      const left = x >= bpp ? out[y * stride + x - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[(y - 1) * stride + x - bpp] : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(up - upLeft);
        const pb = Math.abs(left - upLeft);
        const pc = Math.abs(left + up - 2 * upLeft);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[y * stride + x] = (cur + add) & 255;
    }
  }
  return { width, height, bpp, pixels: out };
}

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

describe("the iOS icon is the same picture as the original", () => {
  const original = decode("danceflow-app-icon-1024.png");
  const ios = decode("danceflow-app-icon-1024-ios.png");

  it("the original is fully opaque (every alpha is 255), so dropping the channel loses nothing", () => {
    expect(original.bpp).toBe(4);
    let notOpaque = 0;
    for (let i = 3; i < original.pixels.length; i += 4) if (original.pixels[i] !== 255) notOpaque++;
    expect(notOpaque).toBe(0);
  });

  it("every RGB value of the iOS copy equals the original", () => {
    expect([ios.width, ios.height]).toEqual([original.width, original.height]);
    expect(ios.bpp).toBe(3);
    let different = 0;
    for (let i = 0, j = 0; i < original.pixels.length; i += 4, j += 3) {
      if (original.pixels[i] !== ios.pixels[j] || original.pixels[i + 1] !== ios.pixels[j + 1] || original.pixels[i + 2] !== ios.pixels[j + 2]) different++;
    }
    expect(different).toBe(0);
  });

  it("the corner is the brand background #0E1028", () => {
    expect(Array.from(ios.pixels.subarray(0, 3))).toEqual([0x0e, 0x10, 0x28]);
  });
});

describe("the checker itself", () => {
  // a minimal 1 x 1 PNG built in memory: IHDR and a tRNS chunk, each with a dummy CRC (the reader does not check it)
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
