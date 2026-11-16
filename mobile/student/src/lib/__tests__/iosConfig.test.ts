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

describe("iOS plist trimming", () => {
  const optionsOf = (name: string) =>
    (appJson.expo.plugins.find((p) => Array.isArray(p) && p[0] === name) as [string, Record<string, unknown>] | undefined)?.[1];

  it("declares only when-in-use location (the app never uses background location)", () => {
    const location = optionsOf("expo-location");
    expect(location?.locationAlwaysAndWhenInUsePermission).toBe(false);
    expect(location?.locationAlwaysPermission).toBe(false);
    expect(typeof location?.locationWhenInUsePermission).toBe("string");
    expect(location?.isIosBackgroundLocationEnabled).not.toBe(true);
  });

  it("does not declare Face ID (secure storage here uses the keychain, no biometrics)", () => {
    expect(optionsOf("expo-secure-store")?.faceIDPermission).toBe(false);
  });
});

describe("iOS app icon wiring", () => {
  it("points ios.icon at the RGB (no alpha) copy and keeps the original for the shared icon", () => {
    const cfg = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "app.json"), "utf8")) as { expo: { icon: string; ios: { icon?: string } } };
    expect(cfg.expo.ios.icon).toBe("./assets/danceflow-app-icon-1024-ios.png");
    expect(cfg.expo.icon).toBe("./assets/danceflow-app-icon-1024.png");
    const png = readFileSync(join(__dirname, "..", "..", "..", cfg.expo.ios.icon as string));
    expect(png[25]).toBe(2); // color type 2: RGB, no alpha
  });
});
