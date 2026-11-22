// Run: node mobile/shared/qa-a1/check-ime-parser.js  (no device needed). Fixtures are real `dumpsys window` lines captured on the df-api35 emulator (API 35).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { imeTopFromDumpsys } = require("./a1-device-checks.js");
const fx = (n) => fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8");
assert.strictEqual(imeTopFromDumpsys(fx("api35-ime-visible.txt")), 1580);
assert.strictEqual(imeTopFromDumpsys(fx("api35-ime-window-block.txt")), 1580);
assert.strictEqual(imeTopFromDumpsys(fx("api35-ime-hidden.txt")), null);
assert.strictEqual(imeTopFromDumpsys(""), null);
console.log("imeTopFromDumpsys: 4 checks passed");
