// Entry point for the OWNER commands (keygen / sign / rotate / show). Separate from the runner CLI (cli.ts), which never imports the key operations.
//   npx tsx scripts/qa/d24-test-runner/ownermain.ts owner-keygen --commit <reviewed commit sha>
//   npx tsx scripts/qa/d24-test-runner/ownermain.ts owner-sign --envelope E.json --commit <sha> [--out S.json]

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { resolveGit } from "./bins";
import { baseEnv } from "./childenv";
import { realExec } from "./exec";
import { ownerKeygen, ownerRotate, ownerShow, ownerSign, type OwnerIo, type Prompter, type Pristine } from "./ownercli";
import { defaultOwnerDir } from "./ownerverify";
import { readSecret } from "./secretprompt";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function makePrompter(stdin: NodeJS.ReadStream): Prompter {
  return {
    isTty: Boolean(stdin.isTTY),
    hidden: (label) => readSecret(stdin, (x) => process.stderr.write(x), label),
    line: (label) =>
      new Promise((res) => {
        const rl = createInterface({ input: stdin, output: process.stderr, terminal: true });
        rl.question(label, (a) => {
          rl.close();
          res(a);
        });
      }),
  };
}

export type OwnerCtx = { ownerDir?: string; prompter?: Prompter; pristine?: Pristine };

export async function ownerMain(argv: string[], io: OwnerIo, stdin: NodeJS.ReadStream = process.stdin, ctx: OwnerCtx = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  const o = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) {
      io.err("refused: positional arguments are not accepted");
      return 2;
    }
    const nx = rest[i + 1];
    if (nx !== undefined && !nx.startsWith("--")) {
      o.set(rest[i].slice(2), nx);
      i++;
    } else o.set(rest[i].slice(2), true);
  }
  const s = (k: string) => (typeof o.get(k) === "string" ? (o.get(k) as string) : undefined);
  const ownerDir = ctx.ownerDir ?? defaultOwnerDir();
  const pr = ctx.prompter ?? makePrompter(stdin);
  if (cmd === "owner-show") return ownerShow(io, ownerDir);
  const commit = s("commit");
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
    io.err("--commit <40-hex reviewed commit sha> is required: the owner commands run only from a pristine checkout at that commit");
    return 2;
  }
  const gitBin = resolveGit(process.env.PATH);
  const pristine: Pristine = ctx.pristine ?? { repoDir: REPO, commitSha: commit, exec: realExec, env: baseEnv(process.env).env, gitBin: gitBin ?? undefined };
  if (!ctx.pristine && !gitBin) {
    io.err("refused: git was not found at an absolute path on PATH");
    return 2;
  }
  try {
    if (cmd === "owner-keygen") return await ownerKeygen(io, pr, pristine, ownerDir, s("ledger-dir"));
    if (cmd === "owner-rotate") return await ownerRotate(io, pr, pristine, ownerDir, o.has("new-key"));
    if (cmd === "owner-sign") {
      const e = s("envelope");
      if (!e) {
        io.err("--envelope is required");
        return 2;
      }
      return await ownerSign(io, pr, pristine, e, s("out") ?? `${e}.sig.json`, ownerDir);
    }
    io.err("usage: owner-keygen | owner-sign | owner-rotate | owner-show");
    return 2;
  } catch (e) {
    io.err(`error: ${String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, "?")}`);
    return 1;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  ownerMain(process.argv.slice(2), { out: (x) => process.stdout.write(`${x}\n`), err: (x) => process.stderr.write(`${x}\n`) }).then((c) => process.exit(c));
}
