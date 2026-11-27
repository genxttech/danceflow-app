/** An in-memory stand-in for one storage bucket: one-level listing (folders have a null id), paged, and removal by full path. */
export class FakeStorage {
  files = new Set<string>();
  buckets: string[] = [];
  removeCalls: string[][] = [];
  listCalls = 0;
  failList = false;
  /** Fail the removal call with this 1-based number. */
  failRemoveCall: number | null = null;
  /** Removal answers success but removes nothing. */
  removesNothing = false;
  /** Once: another request removes the batch between our listing and our removal. */
  raceOnce = false;
  /** Runs after every successful removal (to add a file "during" a deletion). */
  afterRemove: (() => void) | null = null;

  from(bucket: string) {
    this.buckets.push(bucket);
    return {
      list: async (folder: string, options: { limit: number; offset: number }) => {
        this.listCalls += 1;
        if (this.failList) return { data: null, error: { message: `cannot list ${folder}` } };
        const children = new Map<string, string | null>();
        for (const path of this.files) {
          if (!path.startsWith(`${folder}/`)) continue;
          const rest = path.slice(folder.length + 1);
          const slash = rest.indexOf("/");
          if (slash === -1) children.set(rest, `id-${path}`);
          else children.set(rest.slice(0, slash), null);
        }
        const data = [...children.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .slice(options.offset, options.offset + options.limit)
          .map(([name, id]) => ({ name, id }));
        return { data, error: null };
      },
      remove: async (paths: string[]) => {
        this.removeCalls.push(paths);
        if (this.failRemoveCall === this.removeCalls.length) return { data: null, error: { message: `cannot remove ${paths[0]}` } };
        if (this.removesNothing) return { data: [], error: null };
        if (this.raceOnce) {
          this.raceOnce = false;
          for (const path of paths) this.files.delete(path);
          return { data: [], error: null };
        }
        const data = paths.filter((path) => this.files.delete(path)).map((name) => ({ name }));
        this.afterRemove?.();
        return { data, error: null };
      },
    };
  }
}
