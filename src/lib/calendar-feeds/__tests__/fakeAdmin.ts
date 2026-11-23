/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory PostgREST stand-in for tests */

type Filter = { op: "eq" | "in" | "gte" | "lte"; col: string; val: any };
export type QueryRecord = { table: string; filters: Filter[] };

export class FakeAdmin {
  tables: Record<string, any[]> = {};
  queries: QueryRecord[] = [];
  rpcCalls: Array<{ fn: string; args: any }> = [];
  rpcHandlers: Record<string, (args: any) => { data: any; error: any }> = {};

  constructor(tables: Record<string, any[]> = {}) {
    this.tables = tables;
  }

  from(table: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- closure over the fake for the chainable builder
    const self = this;
    const filters: Filter[] = [];
    let limit = Infinity;
    let orderCol: string | null = null;
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: any) => (filters.push({ op: "eq", col, val }), builder),
      in: (col: string, val: any[]) => (filters.push({ op: "in", col, val }), builder),
      gte: (col: string, val: any) => (filters.push({ op: "gte", col, val }), builder),
      lte: (col: string, val: any) => (filters.push({ op: "lte", col, val }), builder),
      order: (col: string) => ((orderCol = col), builder),
      limit: (n: number) => ((limit = n), builder),
      maybeSingle: () => run(true),
      then: (resolve: any, reject: any) => run(false).then(resolve, reject),
    };
    function run(single: boolean): Promise<{ data: any; error: any }> {
      self.queries.push({ table, filters: [...filters] });
      let rows = (self.tables[table] ?? []).filter((row) =>
        filters.every((f) => {
          const v = f.col.split(".").reduce((acc: any, k: string) => (acc == null ? acc : acc[k]), row);
          if (f.op === "eq") return v === f.val;
          if (f.op === "in") return (f.val as any[]).includes(v);
          if (f.op === "gte") return v >= f.val;
          return v <= f.val;
        }),
      );
      if (orderCol) rows = [...rows].sort((a, b) => (a[orderCol!] < b[orderCol!] ? -1 : 1));
      rows = rows.slice(0, limit);
      return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
    }
    return builder;
  }

  rpc(fn: string, args: any) {
    this.rpcCalls.push({ fn, args });
    const handler = this.rpcHandlers[fn];
    return Promise.resolve(handler ? handler(args) : { data: null, error: { message: "no handler" } });
  }
}
