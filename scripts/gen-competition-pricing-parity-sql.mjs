// Regenerates the Phase 10C SQL pricing parity suite from the shared fixtures.
//   node scripts/gen-competition-pricing-parity-sql.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateParitySql } from "../src/lib/competition/__tests__/fixtures/pricingParity.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src/lib/supabase/migrations/sql-tests/test_T_phase10c_pricing_parity.sql");
writeFileSync(target, generateParitySql());
console.log(`wrote ${target}`);
