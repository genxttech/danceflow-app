/*
  Large-text guard (system font scale 2.0). Android scales fontSize but not a fixed lineHeight, and a
  fixed height clips text that grows. The app's defences are structural, so the audit pins them:
  every string is an AppText (caps scale at 1.35x, drops lineHeight on Android), text boxes use
  minHeight, and a fixed height is only for icons, images and bars.
*/
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { platformTextStyle } from "@/components/AppText";

jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

const root = join(__dirname, "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(p, out);
    } else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

const files = [...walk(join(root, "app")), ...walk(join(root, "src"))].filter(
  (f) => !f.endsWith(`${sep}test${sep}warmUpRenderer.tsx`),
);
const rel = (f: string) => f.slice(root.length + 1).split(sep).join("/");

describe("Student large-text audit", () => {
  it("only AppText renders text (raw <Text> would ignore the scale cap)", () => {
    const offenders = files
      // LegalLinks nests <Text> spans inside one AppText; a span inherits the parent cap.
      .filter((f) => !f.endsWith(`${sep}AppText.tsx`) && !f.endsWith(`${sep}LegalLinks.tsx`))
      .filter((f) => /<Text[\s>]/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("AppText caps scaling and never hands Android a fixed lineHeight", () => {
    const source = readFileSync(join(root, "src", "components", "AppText.tsx"), "utf8");
    expect(source).toContain("maxFontSizeMultiplier={1.35}");
    expect(platformTextStyle({ fontSize: 16, lineHeight: 24 }, "android")).toEqual({ fontSize: 16 });
    expect(platformTextStyle({ fontSize: 16, lineHeight: 24 }, "ios")).toEqual({ fontSize: 16, lineHeight: 24 });
  });

  it("text inputs and controls grow: no fixed height on a text-bearing style", () => {
    const decorative = /(dot|bar|track|fill|progress|thumb|avatar|icon|image|art|hero|cover|photo|logo|skeleton|divider|line|poster|thumbnail|media|switch|pdf)/i;
    const offenders: string[] = [];
    for (const f of files) {
      const source = readFileSync(f, "utf8");
      const block = /(\w+):\s*\{([^{}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = block.exec(source))) {
        const [, name, body] = m;
        const height = body.match(/(?<![A-Za-z])height:\s*(\d+)/);
        if (!height || name === "shadowOffset") continue;
        const width = body.match(/(?<![A-Za-z])width:\s*(\d+)/);
        if (width && width[1] === height[1]) continue; // square icon, avatar or dot
        if (decorative.test(name)) continue;
        offenders.push(`${rel(f)} ${name} height ${height[1]}`);
      }
    }
    // dayCell: a 48pt calendar cell holding one day number (16pt * 1.35 fits), reviewed.
    expect(offenders).toEqual(["app/schedule/request.tsx dayCell height 48"]);
  });

  it("text inputs use minHeight so a larger font is never clipped", () => {
    const offenders = files
      .filter((f) => /<TextInput/.test(readFileSync(f, "utf8")))
      .filter((f) => /\binput:\s*\{[^{}]*(?<![A-Za-z])height:/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
