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
