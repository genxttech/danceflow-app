// TEST HELPER ONLY (not pinned, never used by the driver in production): a stand-in for the claude binary that replays a scenario
// as stream-json so the driver's isolation plumbing can be unit-tested without a model or authentication.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, 'utf8'));
if (args.includes('--version')) { console.log(scenario.version ?? '2.1.321 (Claude Code)'); process.exit(0); }
const si = args.indexOf('--settings');
fs.writeFileSync(path.join(process.cwd(), 'dump.json'), JSON.stringify({ args, envKeys: Object.keys(process.env), cwd: process.cwd(), settings: si >= 0 ? JSON.parse(fs.readFileSync(args[si + 1], 'utf8')) : null }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const ev of scenario.events ?? []) { if (ev.delayMs) await sleep(ev.delayMs); process.stdout.write(JSON.stringify(ev.line) + '\n'); }
if (scenario.hangMs) await sleep(scenario.hangMs);
process.exit(scenario.exitCode ?? 0);
