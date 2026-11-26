import { createAdminClient } from "@/lib/supabase/admin";

/*
  Files that belong to a dancer's own account and are removed with it.

  The one safety rule: only objects under `<this account's id>/` in the listed bucket are ever removed. The target comes from the verified
  user id alone, never from a stored URL or anything a client sent, and every path is checked against that prefix just before removal.
*/

export const PARTNER_PHOTO_BUCKET = "partner-profile-photos";

const BATCH = 100;
/** Folders deeper than this are not walked (the app writes none). */
const MAX_DEPTH = 32;
const TIME_BUDGET_MS = 20_000;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Carries a short reason code and a count only: file names and storage messages are never part of it. */
export class AccountFilesDeletionError extends Error {
  constructor(
    readonly code: "invalid_user" | "list_failed" | "remove_failed" | "no_progress" | "unsafe_name" | "out_of_time",
    readonly removed = 0,
  ) {
    super(`Account files could not be removed (${code}).`);
    this.name = "AccountFilesDeletionError";
  }
}

type Bucket = ReturnType<ReturnType<typeof createAdminClient>["storage"]["from"]>;

/** One batch of files, plus the entries that cannot be addressed safely (they are left for support; everything else is still removed). */
type Batch = { files: string[]; skipped: Set<string> };

const isSafeName = (name: string) => Boolean(name) && name !== "." && name !== ".." && !name.includes("/");

/** Fills the batch with full file paths below `folder`, looking into sub-folders (listing returns one level, with a null id for a folder). */
async function collect(bucket: Bucket, folder: string, batch: Batch, removed: number, depth = 0): Promise<void> {
  for (let offset = 0; batch.files.length < BATCH; offset += BATCH) {
    const { data, error } = await bucket.list(folder, { limit: BATCH, offset, sortBy: { column: "name", order: "asc" } });
    if (error || !data) throw new AccountFilesDeletionError("list_failed", removed);

    for (const entry of data) {
      if (batch.files.length >= BATCH) break;
      const path = `${folder}/${entry.name}`;
      if (!isSafeName(entry.name) || (entry.id === null && depth >= MAX_DEPTH)) batch.skipped.add(path);
      else if (entry.id === null) await collect(bucket, path, batch, removed, depth + 1);
      else batch.files.push(path);
    }

    if (data.length < BATCH) break;
  }
}

/**
 * Removes every Partner Search photo of one account and returns how many were removed. Idempotent: nothing to remove is success. It only
 * returns after a listing finds nothing left; anything else throws, and calling again continues where it stopped. Entries with a name that
 * cannot be addressed safely never stop the others from being removed, but the call then fails (`unsafe_name`) so they are looked at.
 */
export async function purgeOwnPartnerPhotos(
  userId: string,
  options: { now?: () => number; budgetMs?: number } = {},
): Promise<number> {
  if (!USER_ID.test(userId)) throw new AccountFilesDeletionError("invalid_user");

  const bucket = createAdminClient().storage.from(PARTNER_PHOTO_BUCKET);
  const prefix = `${userId}/`;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? TIME_BUDGET_MS);
  let removed = 0;

  for (;;) {
    // Always from the start: removing files shifts every later page.
    const batch: Batch = { files: [], skipped: new Set() };
    await collect(bucket, userId, batch, removed);
    if (batch.files.length === 0) {
      if (batch.skipped.size > 0) throw new AccountFilesDeletionError("unsafe_name", removed);
      return removed;
    }
    if (!batch.files.every((path) => path.startsWith(prefix))) throw new AccountFilesDeletionError("unsafe_name", removed);

    const { data, error } = await bucket.remove(batch.files);
    if (error) throw new AccountFilesDeletionError("remove_failed", removed);
    if (!data || data.length === 0) {
      // Nothing removed: fine if another request removed these first, otherwise we would list the same files forever.
      const again: Batch = { files: [], skipped: new Set() };
      await collect(bucket, userId, again, removed);
      if (again.files.some((path) => batch.files.includes(path))) throw new AccountFilesDeletionError("no_progress", removed);
      if (now() > deadline) throw new AccountFilesDeletionError("out_of_time", removed);
      continue;
    }
    removed += data.length;
    // Checked after removing, so every call makes progress even when listing is slow.
    if (now() > deadline) throw new AccountFilesDeletionError("out_of_time", removed);
  }
}
