// TEST HELPER ONLY: runs the CLI against an injected source. The production entry (orchestrator.mjs) has no such seam.
import { main } from './orchestrator.mjs';
process.exit(await main(process.argv.slice(2), JSON.parse(process.env.PILOT_TEST_SOURCE), { settingsFiles: [] }));
