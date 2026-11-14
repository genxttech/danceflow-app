// Reads policy + owner authorizations from a PROTECTED remote ref (main behind CODEOWNERS), never from local files.
// The only child process in the pilot is `git` (fetch + cat-file) run in a SCRUBBED environment against a FRESH
// throwaway bare repo each call: no persistent cache (no replace refs / insteadOf / hooks to pre-seed), no user or
// system git config, no ext:: or other transports. Fails closed: any error throws and the orchestrator HALTs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const memo = new Map();
const env = (cfg) => {
  const keep = ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'];
  const e = Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  return { ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: cfg, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
};
const run = (cwd, args, input, aux) => execFileSync('git', ['--no-replace-objects', '-c', `core.hooksPath=${aux.hooks}`, ...args], { cwd, env: env(aux.cfg), input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 16 * 1024 * 1024 });

// src = { url, ref, policyPath, authPath, credentialHelper?, allowFile?(tests only), cacheMs? (tests only; 0 = always fetch) }
export function loadProtected(src) {
  if (!src?.url || !src.ref || !src.policyPath || !src.authPath) throw new Error('protected source not configured');
  if (!src.allowFile && !/^https:\/\//.test(src.url)) throw new Error('only https sources allowed');
  const key = JSON.stringify([src.url, src.ref, src.policyPath, src.authPath]); const hit = memo.get(key);
  if (hit && Date.now() - hit.at < (src.cacheMs || 0)) return hit.v;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpilot-src-'));
  const aux = { cfg: path.join(dir, 'empty.gitconfig'), hooks: path.join(dir, 'nohooks') };
  fs.writeFileSync(aux.cfg, ''); fs.mkdirSync(aux.hooks);
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  try {
    run(repo, ['init', '--bare', '--quiet', '--template='], undefined, aux);
    const proto = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...(src.allowFile ? ['-c', 'protocol.file.allow=always'] : [])];
    const cred = src.credentialHelper ? ['-c', 'credential.helper=', '-c', `credential.helper=${src.credentialHelper}`] : ['-c', 'credential.helper='];
    run(repo, [...proto, ...cred, 'fetch', '--quiet', '--no-tags', '--force', '--no-recurse-submodules', src.url, `${src.ref}:refs/pilot/protected`], undefined, aux);
    const out = run(repo, ['cat-file', '--batch'], `refs/pilot/protected\nrefs/pilot/protected:${src.policyPath}\nrefs/pilot/protected:${src.authPath}\n`, aux);
    const parts = []; let off = 0;
    while (off < out.length) {
      const nl = out.indexOf(0x0a, off); const header = out.slice(off, nl).toString('utf8').split(' ');
      if (header[1] === 'missing') throw new Error(`missing in protected ref: ${header[0]}`);
      const size = Number(header[2]); parts.push({ sha: header[0], body: out.slice(nl + 1, nl + 1 + size).toString('utf8') }); off = nl + 1 + size + 1;
    }
    if (parts.length !== 3) throw new Error('unexpected cat-file output');
    const v = { commit: parts[0].sha, policy: JSON.parse(parts[1].body), auths: JSON.parse(parts[2].body) };
    memo.set(key, { at: Date.now(), v });
    return v;
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}
