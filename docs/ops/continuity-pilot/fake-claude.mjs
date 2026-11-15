// TEST HELPER ONLY (not pinned, never used by the driver in production): a stand-in for the claude binary that replays a scenario
// as stream-json so the driver's isolation plumbing can be unit-tested without a model or authentication.
// Scenario extras: writeFiles [{ path, content }] (simulates the child's Write tool), commitIn <dir> (simulates a child that commits).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, 'utf8'));
if (args.includes('--version')) { console.log(scenario.version ?? '2.1.321 (Claude Code)'); process.exit(0); }
const si = args.indexOf('--settings');
fs.writeFileSync(path.join(process.cwd(), 'dump.json'), JSON.stringify({ args, envKeys: Object.keys(process.env), cwd: process.cwd(), settingsPath: si >= 0 ? args[si + 1] : null, settings: si >= 0 ? JSON.parse(fs.readFileSync(args[si + 1], 'utf8')) : null }));
for (const f of scenario.writeFiles ?? []) { fs.mkdirSync(path.dirname(f.path), { recursive: true }); fs.writeFileSync(f.path, f.content); }
if (scenario.commitIn) execFileSync('git', ['-C', scenario.commitIn, '-c', 'user.name=fake', '-c', 'user.email=fake@fake', 'commit', '--allow-empty', '-m', 'child commit'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const ev of scenario.events ?? []) { if (ev.delayMs) await sleep(ev.delayMs); process.stdout.write(JSON.stringify(ev.line) + '\n'); }
if (scenario.hangMs) await sleep(scenario.hangMs);
process.exit(scenario.exitCode ?? 0);
