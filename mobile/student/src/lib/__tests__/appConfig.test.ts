import { readFileSync } from "node:fs";
import { join } from "node:path";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  APP_CONFIG_CACHE_MS,
  APP_CONFIG_MAX_CHARS,
  dismissNotice,
  isNoticeDismissed,
  loadAppConfig,
  NOTICE_DISMISS_MS,
  parseAppConfig,
  safeStoreUrl,
  updateNoticeFor,
} from "@/lib/appConfig";

jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

const PLAY = "https://play.google.com/store/apps/details?id=com.idanceflow.student";
// the jest preset runs as one platform; the loader reads that one, so a test document carries both
const doc = (entry: unknown) => ({ schema: 1, apps: { student: { android: entry, ios: entry } } });
const answer = (body: string, ok = true) => ({ ok, text: async () => body }) as unknown as Response;
const fetchMock = jest.fn();

beforeEach(async () => {
  await AsyncStorage.clear();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("parseAppConfig fails open", () => {
  it("reads a good document", () => {
    expect(parseAppConfig(doc({ recommendedCode: 4, storeUrl: PLAY }), "android")).toEqual({ recommendedCode: 4, storeUrl: PLAY });
  });

  it.each([
    ["null", null],
    ["a string", "x"],
    ["an array", []],
    ["a wrong schema", { schema: 2, apps: { student: { android: { recommendedCode: 4 } } } }],
    ["no apps", { schema: 1 }],
    ["no student entry", { schema: 1, apps: {} }],
    ["no platform entry", doc(undefined)],
    ["a string number", doc({ recommendedCode: "400" })],
    ["a fraction", doc({ recommendedCode: 4.5 })],
    ["a negative number", doc({ recommendedCode: -1 })],
    ["a huge number", doc({ recommendedCode: 3_000_000_000 })],
  ])("shows nothing for %s", (_name, value) => {
    expect(parseAppConfig(value, "android")).toBeNull();
  });

  it("opens only this app's store pages", () => {
    expect(safeStoreUrl(PLAY)).toBe(PLAY);
    expect(safeStoreUrl("https://apps.apple.com/us/app/danceflow/id1234567890")).not.toBeNull();
    for (const bad of [
      "https://play.google.com/store/apps/details?id=com.attacker.app",
      `${PLAY}&referrer=x`,
      "https://play.google.com.attacker.test/store/apps/details?id=com.idanceflow.student",
      "http://play.google.com/store/apps/details?id=com.idanceflow.student",
      "market://details?id=com.idanceflow.student",
      "danceflow://auth/callback?token_hash=a",
      "https://apps.apple.com/redirect?to=https://attacker.test",
      42,
      null,
    ]) {
      expect(safeStoreUrl(bad)).toBeNull();
    }
  });
});

describe("updateNoticeFor", () => {
  const config = { recommendedCode: 4, storeUrl: PLAY };

  it("shows only for a newer recommended build", () => {
    expect(updateNoticeFor(config, 3)).toEqual(config);
    expect(updateNoticeFor(config, 4)).toBeNull();
    expect(updateNoticeFor(config, 5)).toBeNull();
    expect(updateNoticeFor(config, null)).toBeNull();
    expect(updateNoticeFor(null, 3)).toBeNull();
  });
});

describe("loadAppConfig", () => {
  const good = () => answer(JSON.stringify(doc({ recommendedCode: 4, storeUrl: PLAY })));

  it("fetches the public file without credentials", async () => {
    fetchMock.mockResolvedValue(good());
    await expect(loadAppConfig()).resolves.toMatchObject({ recommendedCode: 4 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://danceflow.test/app-config/student.json");
    expect(init.headers).toEqual({ accept: "application/json" });
    expect(init.credentials).toBe("omit");
  });

  it.each([
    ["a 404", () => answer("not found", false)],
    ["an oversized body", () => answer(JSON.stringify({ ...doc({ recommendedCode: 4 }), pad: "x".repeat(APP_CONFIG_MAX_CHARS) }))],
    ["another shape", () => answer("{}")],
    ["a page that is not JSON", () => answer("<html>")],
  ])("is nothing for %s, and forgets the earlier answer (rollback)", async (_name, response) => {
    fetchMock.mockResolvedValueOnce(good());
    await loadAppConfig();
    fetchMock.mockResolvedValueOnce(response());
    await expect(loadAppConfig()).resolves.toBeNull();
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    await expect(loadAppConfig()).resolves.toBeNull();
  });

  it("withdraws the notice as soon as the file says so", async () => {
    fetchMock.mockResolvedValueOnce(good());
    await loadAppConfig();
    fetchMock.mockResolvedValueOnce(answer(JSON.stringify(doc({ recommendedCode: 0 }))));
    expect(updateNoticeFor(await loadAppConfig(), 3)).toBeNull();
  });

  it("offline: a recent answer is used, an old one or one from the future is not", async () => {
    const now = 1_000_000_000_000;
    fetchMock.mockResolvedValueOnce(good());
    await loadAppConfig(now);
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    await expect(loadAppConfig(now + 1000)).resolves.toMatchObject({ recommendedCode: 4 });
    await expect(loadAppConfig(now + APP_CONFIG_CACHE_MS + 1)).resolves.toBeNull();
    await expect(loadAppConfig(now - 1000)).resolves.toBeNull();
  });

  it("gives up after the timeout and never throws", async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const pending = loadAppConfig();
    await jest.advanceTimersByTimeAsync(3100);
    await expect(pending).resolves.toBeNull();
    jest.useRealTimers();
  });
});

describe("dismissal", () => {
  it("lasts three days and only for the same recommendation", async () => {
    await dismissNotice(4, 1000);
    await expect(isNoticeDismissed(4, 2000)).resolves.toBe(true);
    await expect(isNoticeDismissed(5, 2000)).resolves.toBe(false);
    await expect(isNoticeDismissed(4, 1000 + NOTICE_DISMISS_MS)).resolves.toBe(false);
  });
});

describe("the Today screen", () => {
  it("shows the notice to guests and to signed-in dancers", () => {
    const home = readFileSync(join(__dirname, "..", "..", "..", "app", "(tabs)", "home.tsx"), "utf8");
    expect(home.split("<AppUpdateNotice />")).toHaveLength(3);
  });
});

describe("the published file (public/app-config/student.json)", () => {
  const raw = readFileSync(join(__dirname, "..", "..", "..", "..", "..", "public", "app-config", "student.json"), "utf8");

  it("is a document the app accepts, small enough, for both platforms", () => {
    expect(raw.length).toBeLessThanOrEqual(APP_CONFIG_MAX_CHARS);
    const parsed = JSON.parse(raw);
    for (const platform of ["android", "ios"] as const) expect(parseAppConfig(parsed, platform)).not.toBeNull();
  });

  it("never recommends a build newer than the one in the repository (raise app.json first, publish after the build is in the store)", () => {
    const app = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "app.json"), "utf8")) as { expo: { android: { versionCode: number } } };
    expect(JSON.parse(raw).apps.student.android.recommendedCode).toBeLessThanOrEqual(app.expo.android.versionCode);
  });
});
