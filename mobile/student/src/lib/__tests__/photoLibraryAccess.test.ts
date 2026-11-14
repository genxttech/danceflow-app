import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ImagePicker from "expo-image-picker";
import { ensurePhotoLibraryAccess } from "@/lib/photoLibraryAccess";

jest.mock("react-native", () => ({ Platform: { OS: "android" } }));
jest.mock("expo-image-picker", () => ({ requestMediaLibraryPermissionsAsync: jest.fn() }));

const request = ImagePicker.requestMediaLibraryPermissionsAsync as unknown as jest.Mock;
beforeEach(() => request.mockReset());

describe("ensurePhotoLibraryAccess", () => {
  it("never asks on Android, where the system picker needs no permission", async () => {
    request.mockResolvedValue({ granted: false });
    await expect(ensurePhotoLibraryAccess("android")).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("asks on iOS and follows the answer", async () => {
    request.mockResolvedValueOnce({ granted: true });
    await expect(ensurePhotoLibraryAccess("ios")).resolves.toBe(true);
    request.mockResolvedValueOnce({ granted: false });
    await expect(ensurePhotoLibraryAccess("ios")).resolves.toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("defaults to the running platform (Android here)", async () => {
    await expect(ensurePhotoLibraryAccess()).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("is the only gate in both partner screens, and nothing uses the camera", () => {
    const root = join(__dirname, "..", "..", "..");
    for (const f of ["app/partners/draft.tsx", "app/partners/index.tsx"]) {
      const s = readFileSync(join(root, f), "utf8");
      expect(s).toContain("ensurePhotoLibraryAccess()");
      expect(s).not.toContain("requestMediaLibraryPermissionsAsync");
      expect(s).not.toMatch(/launchCameraAsync|requestCameraPermissions/);
    }
  });
});
