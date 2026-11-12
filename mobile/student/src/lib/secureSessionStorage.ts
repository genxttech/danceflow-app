import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/*
  Supabase session storage backed by the iOS Keychain / Android Keystore.

  SecureStore documents a 2048-byte limit per value and a Supabase session is
  usually larger, so a value is split into chunks. The entry at the key itself
  is a manifest naming the chunk generation, and it is written last: a crash
  mid-write leaves the previous session intact, never a mix of two sessions.

  Sessions that older builds saved in AsyncStorage (unencrypted) move here on
  first read and are removed from AsyncStorage. A failed secure write is raised,
  never saved to AsyncStorage instead. Web has no SecureStore; it keeps
  AsyncStorage (localStorage), which is the normal Supabase web behaviour.
*/

const MANIFEST_PREFIX = "chunks-v1:";
// UTF-8 uses at most 3 bytes per UTF-16 code unit, so 680 units stay under 2048 bytes.
const MAX_CHUNK_UNITS = 680;

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

function secureKey(key: string) {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

function chunkKey(key: string, generation: string, index: number) {
  return `${secureKey(key)}.${generation}.${index}`;
}

function splitIntoChunks(value: string) {
  const chunks: string[] = [];
  let start = 0;

  while (start < value.length) {
    let end = Math.min(start + MAX_CHUNK_UNITS, value.length);
    const last = value.charCodeAt(end - 1);
    // Never split a surrogate pair: half of one cannot be encoded as UTF-8.
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(value.slice(start, end));
    start = end;
  }

  return chunks.length ? chunks : [""];
}

function parseManifest(raw: string | null) {
  if (!raw?.startsWith(MANIFEST_PREFIX)) return null;

  const [generation, count] = raw.slice(MANIFEST_PREFIX.length).split(":");
  const parsedCount = Number(count);

  return generation && Number.isInteger(parsedCount) && parsedCount > 0
    ? { generation, count: parsedCount }
    : null;
}

async function deleteChunks(key: string, manifest: { generation: string; count: number }) {
  for (let index = 0; index < manifest.count; index += 1) {
    await SecureStore.deleteItemAsync(chunkKey(key, manifest.generation, index), secureOptions).catch(
      () => undefined,
    );
  }
}

async function writeSecure(key: string, value: string) {
  const previous = parseManifest(
    await SecureStore.getItemAsync(secureKey(key), secureOptions).catch(() => null),
  );
  const generation = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const chunks = splitIntoChunks(value);

  for (let index = 0; index < chunks.length; index += 1) {
    await SecureStore.setItemAsync(chunkKey(key, generation, index), chunks[index], secureOptions);
  }

  await SecureStore.setItemAsync(
    secureKey(key),
    `${MANIFEST_PREFIX}${generation}:${chunks.length}`,
    secureOptions,
  );

  if (previous) await deleteChunks(key, previous);
}

async function readSecure(key: string) {
  const raw = await SecureStore.getItemAsync(secureKey(key), secureOptions);
  if (raw === null) return null;

  const manifest = parseManifest(raw);
  if (!manifest) {
    await SecureStore.deleteItemAsync(secureKey(key), secureOptions).catch(() => undefined);
    return null;
  }

  const parts: string[] = [];
  for (let index = 0; index < manifest.count; index += 1) {
    const part = await SecureStore.getItemAsync(
      chunkKey(key, manifest.generation, index),
      secureOptions,
    );

    if (part === null) {
      await deleteChunks(key, manifest);
      await SecureStore.deleteItemAsync(secureKey(key), secureOptions).catch(() => undefined);
      return null;
    }

    parts.push(part);
  }

  return parts.join("");
}

async function removeSecure(key: string) {
  const manifest = parseManifest(
    await SecureStore.getItemAsync(secureKey(key), secureOptions).catch(() => null),
  );

  if (manifest) await deleteChunks(key, manifest);
  await SecureStore.deleteItemAsync(secureKey(key), secureOptions);
}

// One read-modify-write at a time, so a token refresh and a sign-out cannot interleave.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

export const secureSessionStorage = {
  getItem(key: string): Promise<string | null> {
    if (Platform.OS === "web") return AsyncStorage.getItem(key);

    return enqueue(async () => {
      let stored: string | null = null;

      try {
        stored = await readSecure(key);
      } catch {
        // A keystore entry that can no longer be decrypted is a signed-out device, not a crash.
        await removeSecure(key).catch(() => undefined);
      }

      const legacy = await AsyncStorage.getItem(key).catch(() => null);
      if (legacy === null) return stored;

      try {
        if (stored === null) await writeSecure(key, legacy);
      } catch {
        // Keeps this launch signed in; the next successful save moves it into secure storage.
      } finally {
        await AsyncStorage.removeItem(key).catch(() => undefined);
      }

      return stored ?? legacy;
    });
  },

  setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") return AsyncStorage.setItem(key, value);

    return enqueue(async () => {
      await writeSecure(key, value);
      await AsyncStorage.removeItem(key).catch(() => undefined);
    });
  },

  removeItem(key: string): Promise<void> {
    if (Platform.OS === "web") return AsyncStorage.removeItem(key);

    return enqueue(async () => {
      await removeSecure(key).catch(() => undefined);
      await AsyncStorage.removeItem(key).catch(() => undefined);
    });
  },
};

/** Removes every Supabase session this device may hold, in secure storage and in legacy AsyncStorage. */
export async function clearPersistedSessions(keys: string[]) {
  await Promise.all(keys.map((key) => secureSessionStorage.removeItem(key)));

  const legacyKeys = (await AsyncStorage.getAllKeys()).filter(
    (key) => key.startsWith("sb-") && key.includes("-auth-token"),
  );

  if (legacyKeys.length) await AsyncStorage.multiRemove(legacyKeys);
}
