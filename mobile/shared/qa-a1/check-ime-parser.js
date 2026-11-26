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

// The sheet's scrim and Close button share the label "Minimize assistant"; the real ARIA sheet tree (API 35, df-api35) has both, with empty text.
const { minimizeNodes, nodes } = require("./a1-device-checks.js");
const sheet = fs.readFileSync(path.join(__dirname, "fixtures", "aria-sheet-open.xml"), "utf8");
const m = minimizeNodes(sheet);
assert.strictEqual(m.scrim.bounds, "[0,0][1080,1462]");
assert.strictEqual(m.close.bounds, "[900,1503][1036,1619]");
assert.strictEqual(nodes(sheet).find((n) => n["content-desc"] === "Send message").enabled, "false");
// hidden keyboard with a stale IME window region: the insets source says hidden, so no keyboard.
assert.strictEqual(imeTopFromDumpsys(fx("api35-ime-hidden.txt") + fx("api35-ime-window-block.txt")), null);
console.log("minimizeNodes + hidden-keyboard checks passed");
