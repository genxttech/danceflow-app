import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStorage } from "./helpers/fakeStorage";

let storage: FakeStorage;

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ storage }) }));

const { purgeOwnPartnerPhotos, AccountFilesDeletionError, PARTNER_PHOTO_BUCKET } = await import("@/lib/student-identity/account-files");

const USER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const add = (...paths: string[]) => paths.forEach((path) => storage.files.add(path));
const code = (promise: Promise<unknown>) => promise.then(
  () => "no error",
  (error: unknown) => (error instanceof AccountFilesDeletionError ? error.code : `other: ${String(error)}`),
);

beforeEach(() => {
  storage = new FakeStorage();
});

describe("purgeOwnPartnerPhotos: ownership", () => {
  it("removes only this account's files, from the partner photo bucket", async () => {
    add(`${USER}/profile-1.jpg`, `${USER}/profile-2.png`, `${OTHER}/profile-9.jpg`, `${USER}x/profile.jpg`, `${USER}.jpg`);

    await expect(purgeOwnPartnerPhotos(USER)).resolves.toBe(2);

    expect([...storage.files].sort()).toEqual([`${OTHER}/profile-9.jpg`, `${USER}.jpg`, `${USER}x/profile.jpg`].sort());
    expect(new Set(storage.buckets)).toEqual(new Set([PARTNER_PHOTO_BUCKET]));
    for (const path of storage.removeCalls.flat()) expect(path.startsWith(`${USER}/`)).toBe(true);
  });

  it.each(["", " ", "user-a", "..", "/", `${USER}/..`, `${USER}%`, OTHER.slice(0, 8)])("refuses the id %j before touching storage", async (id) => {
    add(`${OTHER}/profile.jpg`);
    await expect(code(purgeOwnPartnerPhotos(id))).resolves.toBe("invalid_user");
    expect(storage.buckets).toEqual([]);
    expect(storage.files.size).toBe(1);
  });

  it.each([`${USER}/../${OTHER}.jpg`, `${USER}/./a.jpg`, `${USER}//a.jpg`])("removes every other file, then fails, for a name it cannot address safely (%s)", async (path) => {
    add(path, `${USER}/0-first.jpg`, `${USER}/zz-last.jpg`, `${OTHER}/profile.jpg`);
    await expect(code(purgeOwnPartnerPhotos(USER))).resolves.toBe("unsafe_name");
    expect([...storage.files].sort()).toEqual([`${OTHER}/profile.jpg`, path].sort());
    expect(storage.removeCalls.flat().every((p) => p.startsWith(`${USER}/`) && !p.includes("..") && !p.includes("//"))).toBe(true);
  });

  it("does not walk absurdly deep folders, but still removes everything else", async () => {
    const deep = `${USER}/${"d/".repeat(40)}x.jpg`;
    add(deep, `${USER}/zz.jpg`, `${USER}/${"e/".repeat(20)}ok.jpg`);
    await expect(code(purgeOwnPartnerPhotos(USER))).resolves.toBe("unsafe_name");
    expect([...storage.files]).toEqual([deep]);
  });
});

describe("purgeOwnPartnerPhotos: finding every file", () => {
  it("succeeds with nothing to remove", async () => {
    await expect(purgeOwnPartnerPhotos(USER)).resolves.toBe(0);
    expect(storage.removeCalls).toEqual([]);
  });

  it("removes files in sub-folders and far more than one page, in batches", async () => {
    for (let i = 0; i < 250; i += 1) add(`${USER}/profile-${String(i).padStart(3, "0")}.jpg`);
    add(`${USER}/a/b/c/deep.jpg`, `${USER}/a/odd name (1).jpg`, `${USER}/.emptyFolderPlaceholder`);
    for (let i = 0; i < 120; i += 1) add(`${USER}/folder-${i}/one.jpg`);

    await expect(purgeOwnPartnerPhotos(USER)).resolves.toBe(373);

    expect(storage.files.size).toBe(0);
    expect(Math.max(...storage.removeCalls.map((batch) => batch.length))).toBeLessThanOrEqual(100);
  });
});

describe("purgeOwnPartnerPhotos: failure and retry", () => {
  const seed = () => { for (let i = 0; i < 150; i += 1) add(`${USER}/p-${String(i).padStart(3, "0")}.jpg`); };

  it("reports a partial failure without file names, and a retry finishes the job", async () => {
    seed();
    storage.failRemoveCall = 2;

    const error = await purgeOwnPartnerPhotos(USER).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AccountFilesDeletionError);
    expect(error).toMatchObject({ code: "remove_failed", removed: 100 });
    expect((error as Error).message).not.toContain(USER);
    expect(storage.files.size).toBe(50);

    await expect(purgeOwnPartnerPhotos(USER)).resolves.toBe(50);
    expect(storage.files.size).toBe(0);
  });

  it("fails on a listing error, never reporting success", async () => {
    seed();
    storage.failList = true;
    await expect(code(purgeOwnPartnerPhotos(USER))).resolves.toBe("list_failed");
    expect(storage.files.size).toBe(150);
  });

  it("carries on when another request removed the same files first", async () => {
    seed();
    storage.raceOnce = true;
    await expect(purgeOwnPartnerPhotos(USER)).resolves.toBe(50);
    expect(storage.files.size).toBe(0);
  });

  it("does not loop forever when a removal removes nothing", async () => {
    seed();
    storage.removesNothing = true;
    await expect(code(purgeOwnPartnerPhotos(USER))).resolves.toBe("no_progress");
    expect(storage.removeCalls).toHaveLength(1);
  });

  it("stops at its time budget with the progress kept", async () => {
    seed();
    let clock = 0;
    await expect(code(purgeOwnPartnerPhotos(USER, { now: () => (clock += 15_000), budgetMs: 10_000 }))).resolves.toBe("out_of_time");
    expect(storage.files.size).toBe(50);
  });

  it("makes progress even when the budget is already spent", async () => {
    seed();
    let clock = 0;
    await expect(code(purgeOwnPartnerPhotos(USER, { now: () => (clock += 60_000) }))).resolves.toBe("out_of_time");
    expect(storage.files.size).toBe(50);
  });
});
