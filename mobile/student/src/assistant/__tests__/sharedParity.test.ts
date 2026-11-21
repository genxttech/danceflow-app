/*
  The assistant engine is written once in mobile/shared/assistant/ and copied into each app (no workspace package, no Metro
  watchFolders: the release builds stay unchanged). This fails if this app's copy differs from the source, or has a stale or extra file.
  Fix: `node mobile/shared/sync-assistant.js`.
*/
import fs from "fs";
import path from "path";

const HEADER = "// GENERATED from mobile/shared/assistant/ by mobile/shared/sync-assistant.js. Do not edit here; edit the source and re-run.\n";
const sourceDir = path.resolve(__dirname, "../../../../shared/assistant");
const copyDir = path.resolve(__dirname, "../shared");
const isSource = (f: string) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f);

describe("assistant shared source parity", () => {
  const sources = fs.readdirSync(sourceDir).filter(isSource);

  it("has a source to copy", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources)("%s is byte-identical to the shared source (plus the generated header)", (file) => {
    const copy = fs.readFileSync(path.join(copyDir, file), "utf8");
    expect(copy).toBe(HEADER + fs.readFileSync(path.join(sourceDir, file), "utf8"));
  });

  it("has no stale or hand-written file in the copy folder", () => {
    expect(fs.readdirSync(copyDir).sort()).toEqual([...sources].sort());
  });
});
