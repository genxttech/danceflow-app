// eslint-disable-next-line @typescript-eslint/no-require-imports
const { auditTree, parseTree, report } = require("../../scripts/a11y-audit-lib.js");

// density 420 = 2.625 px per dp: 44dp = 115.5 px
const PX = 420 / 160;

const tree = (...nodes: string[]) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${nodes.join("")}</hierarchy>`;
const node = (attrs: string, children = "") => `<node class="android.view.ViewGroup" ${attrs}>${children}</node>`;
const leaf = (attrs: string) => `<node class="android.widget.TextView" clickable="false" ${attrs} />`;

describe("parseTree", () => {
  it("nests children, reads bounds and unescapes entities", () => {
    const root = parseTree(tree(node('text="" content-desc="" clickable="true" bounds="[0,100][400,260]"', leaf('text="Tom &amp; Jerry &quot;x&quot;" content-desc="" bounds="[0,0][10,10]"'))));
    expect(root.children).toHaveLength(1);
    const outer = root.children[0];
    expect(outer).toMatchObject({ left: 0, top: 100, w: 400, h: 160 });
    expect(outer.children[0].text).toBe('Tom & Jerry "x"');
  });
});

describe("auditTree", () => {
  it("a button whose child text names it is fine; TalkBack merges the descendants", () => {
    const xml = tree(node('text="" content-desc="" clickable="true" bounds="[0,0][1000,200]"', leaf('text="Sign in" content-desc="" bounds="[0,0][100,50]"')));
    expect(auditTree(xml, PX).unlabelled).toEqual([]);
  });

  it("a clickable node with nothing readable anywhere inside it is UNLABELLED", () => {
    const xml = tree(node('text="" content-desc="" clickable="true" resource-id="x" bounds="[0,0][1000,200]"', leaf('text="" content-desc="" bounds="[0,0][100,50]"')));
    const r = auditTree(xml, PX);
    expect(r.unlabelled).toHaveLength(1);
    expect(r.unlabelled[0]).toContain("bounds [0,0][1000,200]");
  });

  it("a node's own content-desc is what is spoken, so a labelled button needs no child text", () => {
    const xml = tree(node('text="" content-desc="Pulse" clickable="true" bounds="[0,2200][270,2380]"'));
    expect(auditTree(xml, PX).unlabelled).toEqual([]);
  });

  it("a control under 44dp is reported as small, a wide short one too, and a big one is not", () => {
    const xml = tree(
      node('content-desc="Tiny" clickable="true" bounds="[0,0][80,80]"'),
      node('content-desc="Flat" clickable="true" bounds="[0,100][1000,190]"'),
      node('content-desc="Fine" clickable="true" bounds="[0,300][1000,460]"'),
    );
    const r = auditTree(xml, PX);
    expect(r.small).toHaveLength(2);
    expect(r.small[0]).toContain('"Tiny" is 30x30dp');
    expect(r.small.join(" ")).not.toContain("Fine");
  });

  it("a row cut off at the bottom of the screen is not an undersized control", () => {
    const xml = tree(node('content-desc="Row" clickable="true" bounds="[0,2300][1000,2400]"'));
    expect(auditTree(xml, PX, 2400).small).toEqual([]);
    expect(auditTree(xml, PX).small).toHaveLength(1); // without the screen height it cannot tell
  });

  it("reading order lists interactive items in brackets and flags the same words twice in a row", () => {
    const xml = tree(
      leaf('text="Email" content-desc="" bounds="[0,0][100,50]"'),
      `<node class="android.widget.EditText" text="" content-desc="Email" clickable="true" bounds="[0,60][1000,300]" />`,
      leaf('text="Password" content-desc="" bounds="[0,320][100,370]"'),
    );
    const r = auditTree(xml, PX);
    expect(r.order).toEqual(["Email", "[Email]", "Password"]);
    expect(r.stutter).toEqual([]); // "Email" then "[Email]" differ; a bare repeat is what counts
    const dup = auditTree(tree(leaf('text="Today" content-desc="" bounds="[0,0][9,9]"'), leaf('text="Today" content-desc="" bounds="[0,10][9,19]"')), PX);
    expect(dup.stutter).toEqual(["Today"]);
  });
});

describe("report", () => {
  it("is a table per screen with the details of anything wrong, and the reading order", () => {
    const bad = auditTree(tree(node('text="" content-desc="" clickable="true" bounds="[0,0][1000,200]"')), PX);
    const good = auditTree(tree(leaf('text="Pulse" content-desc="" bounds="[0,0][9,9]"')), PX);
    const md = report({ today: good, broken: bad }, { density: 420, pxPerDp: PX });
    expect(md).toContain("| today | 0 | 0 | 0 |");
    expect(md).toContain("| broken | 1 | 0 | 0 |");
    expect(md).toContain("- UNLABELLED:");
    expect(md).toContain("**today**: Pulse");
  });
});

// Real `uiautomator dump` output from the release build on the Android 15 emulator (the sign-in screen, empty and after a refused sign-in): the parser and the
// rules are exercised on what the device really produces, not only on hand-written trees. Fictional test account text only; the password field shows bullets.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readFileSync } = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { join } = require("node:path");
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");

describe("on real device dumps (sign-in screen, 1080 x 2400 at density 420)", () => {
  const empty = auditTree(fixture("uiautomator-sign-in.xml"), PX, 2400);
  const refused = auditTree(fixture("uiautomator-sign-in-error.xml"), PX, 2400);

  it("every control is named and every target is at least 44dp", () => {
    for (const r of [empty, refused]) {
      expect(r.unlabelled).toEqual([]);
      expect(r.small).toEqual([]);
      expect(r.stutter).toEqual([]);
    }
  });

  it("reads identity, headline, the form top to bottom, then the two ways in, then the footnote", () => {
    const plain = empty.order.map((s: string) => s.replace(/^\[|\]$/g, ""));
    // exact words for the short items ("Sign in" is also a prefix of the headline), a prefix match for the long footnote
    const at = (text: string) => plain.findIndex((s: string) => (text.length > 30 ? s.startsWith(text) : s === text));
    const sequence = ["DanceFlow Business", "Sign in to your studio", "Email", "Password", "Sign in", "Email me a sign-in link", "Accounts are created by your studio"].map(at);
    expect(sequence.every((i: number) => i >= 0)).toBe(true);
    expect([...sequence].sort((a, b) => a - b)).toEqual(sequence);
  });

  it("the inputs and the two buttons are interactive items; the headline and the footnote are not", () => {
    expect(empty.order).toEqual(expect.arrayContaining(["[Email]", "[Password]", "[Sign in]", "[Email me a sign-in link]", "Sign in to your studio"]));
    expect(empty.order).not.toContain("[Sign in to your studio]");
  });

  it("a refused sign-in puts its message between the password and the Sign in button, where a screen reader meets it before retrying", () => {
    const message = refused.order.findIndex((s: string) => s.startsWith("That email and password did not match"));
    const password = refused.order.findIndex((s: string) => s.startsWith("[") && s.includes("Password"));
    const button = refused.order.indexOf("[Sign in]");
    expect(message).toBeGreaterThan(password);
    expect(message).toBeLessThan(button);
  });

  it("never carries a typed password: the field is bullets", () => {
    expect(fixture("uiautomator-sign-in-error.xml")).toContain("••••••••••");
    expect(fixture("uiautomator-sign-in-error.xml")).not.toMatch(/Walk2026/);
  });
});
