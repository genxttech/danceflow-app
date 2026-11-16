import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
  Expo's MainActivity omits fontScale from android:configChanges, so a live system text-size change
  recreates the activity while React Native keeps its old shadow tree (glyphs grow, boxes keep their
  size, text is clipped). Handling fontScale in the app avoids the recreate. Device evidence: Student
  release build, sign-in clipped after 1.0 -> 2.0 while running. Same fix as Business (#531).
*/
describe("Android MainActivity configChanges", () => {
  it("includes fontScale and keeps the usual entries", () => {
    const manifest = readFileSync(join(__dirname, "..", "..", "..", "android", "app", "src", "main", "AndroidManifest.xml"), "utf8");
    const activity = manifest.match(/<activity[^>]*android:name="\.MainActivity"[^>]*>/)?.[0] ?? "";
    const changes = (activity.match(/android:configChanges="([^"]*)"/)?.[1] ?? "").split("|");
    expect(changes).toEqual(expect.arrayContaining(["fontScale", "keyboard", "keyboardHidden", "orientation", "screenSize", "screenLayout", "uiMode"]));
  });
});
