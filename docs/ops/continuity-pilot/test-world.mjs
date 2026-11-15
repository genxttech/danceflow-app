// TEST HELPER ONLY: a throwaway protected remote + queue root with a valid, attested, isolation-ready policy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as O from './orchestrator.mjs';
import { entries } from './owner-tool.mjs';
import { childConfigSha } from './child-config.mjs';

const G = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const PILOT = { enabled: true, coordinator: 'W', not_before: '2000-01-01T00:00:00Z', not_after: '2099-01-01T00:00:00Z', maxHours: 4, maxWakeups: 12, maxClaims: 100, maxCalls: 1000, claimTtlMs: 600000, maxAttempts: 2 };
export const ISO = { allow: ['Read(//c/Dev/df-iso-test/**)', 'Bash(bash {CODE}/phase2/scripts/git_read.sh C:/Dev/df-iso-test status)'], examples: ['bash {CODE}/phase2/scripts/git_read.sh C:/Dev/df-iso-test status'], addDirs: ['C:/Dev/df-iso-test'], cwd: 'w', model: 'haiku', maxBudgetUsd: 1, timeoutMs: 60000 };
export const TPL = { work: { class: 'A', title: 'fictional work', cmd: 'echo {n}', params: { n: '^[0-9]+$' }, done: 'x', ...ISO } };

export function world(items, { templates = TPL, pilot = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cpilot-w-'));
  const origin = path.join(base, 'origin.git'); const clone = path.join(base, 'clone'); const root = path.join(base, 'root'); const workRoot = path.join(base, 'work');
  G(base, 'init', '--bare', '--quiet', '-b', 'main', origin); G(base, 'clone', '--quiet', origin, clone); G(clone, 'checkout', '-q', '-b', 'main');
  O.init(root); fs.mkdirSync(workRoot);
  const qi = items.map((i) => ({ state: 'PENDING', params: { n: '1' }, ...i }));
  fs.writeFileSync(path.join(root, 'queue.json'), JSON.stringify({ meta: {}, items: qi }));
  const w = { base, origin, clone, root, workRoot, source: { url: origin, ref: 'refs/heads/main', policyPath: 'p/policy.json', authPath: 'p/authorizations.json', allowFile: true, cacheMs: 0 } };
  w.policy = { pilot: { ...PILOT, ...pilot }, templates };
  const h = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  w.publish = (policy, auths) => {
    const pj = JSON.stringify(policy); const aj = JSON.stringify(auths);
    fs.mkdirSync(path.join(clone, 'p'), { recursive: true }); fs.writeFileSync(path.join(clone, 'p/policy.json'), pj); fs.writeFileSync(path.join(clone, 'p/authorizations.json'), aj);
    G(clone, 'add', '-A'); G(clone, 'commit', '-q', '-m', 'owner'); G(clone, 'push', '-q', 'origin', 'main');
    O.writeAttestation(root, { policySha: h(pj), authSha: h(aj), childConfigSha: childConfigSha(policy), expiresAt: Date.parse('2099-12-31T00:00:00Z') });
  };
  w.publish(w.policy, entries({ items: qi }, w.policy));
  return w;
}
