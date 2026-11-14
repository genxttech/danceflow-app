/*
  Every <Stack.Screen name="..."> in the root layout must name a real route. expo-router warns
  ("No route named ... exists in nested children") and ignores the options of one that does not,
  so a screen registered under a wrong name silently loses its header title. A directory's index
  route is named "<dir>/index", not "<dir>".
*/
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const appDir = join(__dirname, "..", "..", "..", "app");
const layout = readFileSync(join(appDir, "_layout.tsx"), "utf8");
const names = [...layout.matchAll(/<Stack\.Screen\s+name="([^"]+)"/g)].map((match) => match[1]);

/** Route names expo-router derives from a file path: "a/b.tsx" -> "a/b", "a/b/index.tsx" -> "a/b/index". */
function routeExists(name: string) {
  // A route group is its own route only when it has a layout, like (tabs). A group without one, like
  // (auth), is flattened: its screens are named "(auth)/sign-in", so a Stack.Screen "(auth)" matches nothing.
  if (/^\([^)]+\)$/.test(name)) return existsSync(join(appDir, name, "_layout.tsx"));
  return existsSync(join(appDir, `${name}.tsx`));
}

describe("root Stack screens", () => {
  it("registers at least the screens the app relies on", () => {
    expect(names.length).toBeGreaterThan(20);
  });

  it.each(names)("%s names a real route", (name) => {
    expect(routeExists(name)).toBe(true);
  });

  it("does not register the same route twice", () => {
    expect(new Set(names).size).toBe(names.length);
  });
});
