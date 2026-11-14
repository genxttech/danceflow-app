/*
  Screen-reader guard. Every Pressable announces a role; an icon-only one has a name; one whose
  style flips on a selected/active state also reports that state. Source scan, so a new control
  that forgets any of these fails here.
*/
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

const root = join(__dirname, "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["__tests__", "node_modules", "test"].includes(entry.name)) walk(p, out);
    } else if (entry.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

type Control = { where: string; tag: string; body: string };

function controls(): Control[] {
  const found: Control[] = [];
  for (const f of [...walk(join(root, "app")), ...walk(join(root, "src"))]) {
    const s = readFileSync(f, "utf8");
    let i = 0;
    while ((i = s.indexOf("<Pressable", i)) >= 0) {
      let depth = 0;
      let j = i + 10;
      for (; j < s.length; j++) {
        const c = s[j];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0 && s[j - 1] !== "=") break;
      }
      const end = s.indexOf("</Pressable>", j);
      found.push({
        where: `${f.slice(root.length + 1).split(sep).join("/")}:${s.slice(0, i).split("\n").length}`,
        tag: s.slice(i, j + 1),
        body: end > j ? s.slice(j, end) : "",
      });
      i = j;
    }
  }
  return found;
}

const all = controls();

describe("Student screen-reader audit", () => {
  it("finds the controls it audits", () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it("every Pressable has an accessibilityRole", () => {
    expect(all.filter((c) => !/accessibilityRole|\brole=/.test(c.tag)).map((c) => c.where)).toEqual([]);
  });

  it("every icon-only Pressable has an accessibilityLabel", () => {
    const iconOnly = all.filter((c) => /<Ionicons/.test(c.body) && !/<AppText|<Text/.test(c.body));
    expect(iconOnly.length).toBeGreaterThan(0);
    expect(iconOnly.filter((c) => !/accessibilityLabel/.test(c.tag)).map((c) => c.where)).toEqual([]);
  });

  it("every Pressable that restyles on a selected/active state reports accessibilityState", () => {
    const stateful = all.filter((c) => /&&\s*styles\.\w*(Active|Selected)/.test(c.tag));
    expect(stateful.length).toBeGreaterThan(20);
    expect(stateful.filter((c) => !/accessibilityState/.test(c.tag)).map((c) => c.where)).toEqual([]);
  });
});
