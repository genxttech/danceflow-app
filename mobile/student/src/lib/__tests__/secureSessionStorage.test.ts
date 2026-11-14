import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { clearPersistedSessions, secureSessionStorage } from "@/lib/secureSessionStorage";

const mockSecure = new Map<string, string>();

jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlockThisDeviceOnly",
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

const secure = SecureStore as jest.Mocked<typeof SecureStore>;
const KEY = "sb-testproject-auth-token";
// A realistic session: well over SecureStore's 2048-byte limit, with multi-byte text.
const LONG_SESSION = JSON.stringify({ access_token: "x".repeat(5000), name: "Zoë 💃".repeat(300) });

function bytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}

beforeEach(async () => {
  mockSecure.clear();
  await AsyncStorage.clear();
  secure.getItemAsync.mockImplementation(async (key) => mockSecure.get(key) ?? null);
  secure.setItemAsync.mockImplementation(async (key, value) => {
    // The real validation: SecureStore rejects any other character in a key.
    if (!/^[\w.-]+$/.test(key)) throw new Error(`invalid key ${key}`);
    mockSecure.set(key, value);
  });
  secure.deleteItemAsync.mockImplementation(async (key) => {
    mockSecure.delete(key);
  });
});

describe("secureSessionStorage", () => {
  it("round-trips a session larger than the SecureStore limit without exceeding it", async () => {
    await secureSessionStorage.setItem(KEY, LONG_SESSION);

    expect(mockSecure.size).toBeGreaterThan(2);
    for (const value of mockSecure.values()) {
      expect(bytes(value)).toBeLessThanOrEqual(2048);
      // A lone surrogate would become U+FFFD when encoded on the device.
      expect(Buffer.from(value, "utf8").toString("utf8")).toBe(value);
    }
    await expect(secureSessionStorage.getItem(KEY)).resolves.toBe(LONG_SESSION);
  });

  it("never writes the session to AsyncStorage", async () => {
    await secureSessionStorage.setItem(KEY, LONG_SESSION);

    await expect(AsyncStorage.getItem(KEY)).resolves.toBeNull();
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
  });

  it("uses device-only keychain access", async () => {
    await secureSessionStorage.setItem(KEY, "value");

    for (const call of secure.setItemAsync.mock.calls) {
      expect(call[2]).toEqual({ keychainAccessible: "afterFirstUnlockThisDeviceOnly" });
    }
  });

  it("replacing a session leaves no chunks from the old one", async () => {
    await secureSessionStorage.setItem(KEY, LONG_SESSION);
    await secureSessionStorage.setItem(KEY, "short");

    expect(mockSecure.size).toBe(2);
    await expect(secureSessionStorage.getItem(KEY)).resolves.toBe("short");
  });

  it("keeps the old session when a write fails partway", async () => {
    await secureSessionStorage.setItem(KEY, "the session before");
    secure.setItemAsync.mockRejectedValueOnce(new Error("keychain failed"));

    await expect(secureSessionStorage.setItem(KEY, LONG_SESSION)).rejects.toThrow("keychain failed");
    await expect(secureSessionStorage.getItem(KEY)).resolves.toBe("the session before");
    await expect(AsyncStorage.getItem(KEY)).resolves.toBeNull();
  });

  it("moves a session saved by an older build out of AsyncStorage", async () => {
    await AsyncStorage.setItem(KEY, LONG_SESSION);

    await expect(secureSessionStorage.getItem(KEY)).resolves.toBe(LONG_SESSION);
    await expect(AsyncStorage.getItem(KEY)).resolves.toBeNull();
    expect(mockSecure.size).toBeGreaterThan(0);
    await expect(secureSessionStorage.getItem(KEY)).resolves.toBe(LONG_SESSION);
  });

  it("removes the plaintext copy even when moving it into secure storage fails", async () => {
    await AsyncStorage.setItem(KEY, "old plaintext");
    secure.setItemAsync.mockRejectedValue(new Error("keychain failed"));

    await expect(secureSessionStorage.getItem(KEY)).resolves.toBe("old plaintext");
    await expect(AsyncStorage.getItem(KEY)).resolves.toBeNull();
  });

  it("treats a missing chunk as signed out and cleans up", async () => {
    await secureSessionStorage.setItem(KEY, LONG_SESSION);
    const chunk = [...mockSecure.keys()].find((key) => key !== KEY) as string;
    mockSecure.delete(chunk);

    await expect(secureSessionStorage.getItem(KEY)).resolves.toBeNull();
    expect(mockSecure.size).toBe(0);
  });

  it("treats an entry the keystore can no longer decrypt as signed out", async () => {
    await secureSessionStorage.setItem(KEY, "value");
    secure.getItemAsync.mockRejectedValueOnce(new Error("could not decrypt"));

    await expect(secureSessionStorage.getItem(KEY)).resolves.toBeNull();
  });

  it("removes the manifest and every chunk", async () => {
    await secureSessionStorage.setItem(KEY, LONG_SESSION);
    await secureSessionStorage.removeItem(KEY);

    expect(mockSecure.size).toBe(0);
    await expect(secureSessionStorage.getItem(KEY)).resolves.toBeNull();
  });

  it("serializes concurrent writes so the last one wins cleanly", async () => {
    await Promise.all([
      secureSessionStorage.setItem(KEY, LONG_SESSION),
      secureSessionStorage.setItem(KEY, "last"),
    ]);

    await expect(secureSessionStorage.getItem(KEY)).resolves.toBe("last");
    expect(mockSecure.size).toBe(2);
  });
});

describe("clearPersistedSessions", () => {
  it("clears secure sessions and any legacy AsyncStorage sessions, and nothing else", async () => {
    await secureSessionStorage.setItem(KEY, LONG_SESSION);
    await AsyncStorage.multiSet([
      ["sb-oldproject-auth-token", "old"],
      ["sb-oldproject-auth-token-code-verifier", "old"],
      ["appearance-mode", "dark"],
    ]);

    await clearPersistedSessions([KEY]);

    expect(mockSecure.size).toBe(0);
    expect(await AsyncStorage.getAllKeys()).toEqual(["appearance-mode"]);
  });
});
