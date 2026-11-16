import { readFileSync } from "node:fs";
import { join } from "node:path";

const appJson = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "app.json"), "utf8")) as {
  expo: { plugins: Array<string | [string, Record<string, unknown>]> };
};

describe("iOS photo-library permission string", () => {
  const entry = appJson.expo.plugins.find((p) => Array.isArray(p) && p[0] === "expo-image-picker") as [string, Record<string, unknown>] | undefined;

  it("registers the image-picker plugin with a purpose string (iOS aborts the permission request without one)", () => {
    expect(entry).toBeDefined();
    const text = entry?.[1].photosPermission;
    expect(typeof text).toBe("string");
    expect((text as string).length).toBeGreaterThan(30);
    expect(text).toMatch(/photo/i);
    expect(text).toMatch(/Partner Search/); // says what the photo is for
  });

  it("does not ask for camera or microphone (the app only picks from the library)", () => {
    expect(entry?.[1].cameraPermission).toBe(false);
    expect(entry?.[1].microphonePermission).toBe(false);
  });

  it("is used by the screens that request the permission", () => {
    const access = readFileSync(join(__dirname, "..", "photoLibraryAccess.ts"), "utf8");
    expect(access).toContain("requestMediaLibraryPermissionsAsync");
  });
});
