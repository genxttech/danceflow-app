// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require("../../scripts/device-smoke-lib.js");

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="Studio today" resource-id="" class="android.widget.TextView" content-desc="" clickable="false" bounds="[45,180][700,260]" />
<node index="1" text="" resource-id="" class="android.widget.EditText" content-desc="Email" clickable="true" bounds="[44,600][1036,725]" />
<node index="2" text="Email" resource-id="" class="android.widget.TextView" content-desc="" clickable="false" bounds="[44,540][200,590]" />
<node index="3" text="" resource-id="" class="android.view.ViewGroup" content-desc="Sign in" clickable="true" bounds="[44,1000][1036,1125]">
<node index="0" text="Tom &amp; Jerry &quot;class&quot;" resource-id="" class="android.widget.TextView" content-desc="" clickable="false" bounds="[0,0][10,10]" /></node>
<node index="4" text="" class="android.view.ViewGroup" content-desc="Today" clickable="true" bounds="[0,2200][270,2380]" />
</hierarchy>
UI hierchary dumped to: /dev/tty`;

describe("parseArgs", () => {
  it("needs a way to get an APK unless it is a dry run", () => {
    expect(() => lib.parseArgs([])).toThrow(/--apk/);
    expect(lib.parseArgs(["--dry-run"]).dryRun).toBe(true);
    expect(lib.parseArgs(["--apk", "a.apk"]).apk).toBe("a.apk");
    expect(lib.parseArgs(["--build-dir", "C:/dfq"]).buildDir).toBe("C:/dfq");
  });

  it("validates values and refuses what it does not know", () => {
    expect(() => lib.parseArgs(["--apk"])).toThrow(/needs a value/);
    expect(() => lib.parseArgs(["--apk", "--dry-run"])).toThrow(/needs a value/);
    expect(() => lib.parseArgs(["--apk", "a", "--web-port", "80"])).toThrow(/web-port/);
    expect(() => lib.parseArgs(["--apk", "a", "--stack-name", "Bad Name"])).toThrow(/stack-name/);
    expect(() => lib.parseArgs(["--apk", "a", "--nope"])).toThrow(/unknown option/);
    expect(lib.parseArgs(["--apk", "a", "--web-port", "4000", "--allow-busy", "--keep-emulator"])).toMatchObject({ webPort: 4000, allowBusy: true, keepEmulator: true });
  });
});

describe("--a11y", () => {
  it("is off by default, switches on with the flag and adds a step to the plan", () => {
    expect(lib.parseArgs(["--apk", "a"]).a11y).toBe(false);
    const on = lib.parseArgs(["--apk", "a", "--a11y"]);
    expect(on.a11y).toBe(true);
    expect(lib.buildPlan(on).join("\n")).toContain("a11y-audit.js");
    expect(lib.buildPlan(lib.parseArgs(["--apk", "a"])).join("\n")).not.toContain("a11y-audit.js");
  });
});

describe("buildPlan", () => {
  it("always ends with teardown, and builds or reuses the APK as asked", () => {
    const reuse = lib.buildPlan(lib.parseArgs(["--apk", "x.apk"]));
    const build = lib.buildPlan(lib.parseArgs(["--build-dir", "C:/dfq"]));
    expect(reuse.at(-1)).toMatch(/^teardown \(always\)/);
    expect(reuse.join("\n")).toContain("reuse x.apk");
    expect(build.join("\n")).toContain("Gradle assembleRelease in C:/dfq");
    expect(reuse[0]).toMatch(/preflight/);
  });
});

describe("busyReason", () => {
  it("is free only with no emulator and no Java/Gradle", () => {
    expect(lib.busyReason({ emulators: [], processes: ["node.exe", "adb.exe", "docker.exe"] })).toBeNull();
  });
  it("names who is in the way", () => {
    expect(lib.busyReason({ emulators: ["emulator-5554"], processes: [] })).toMatch(/emulator-5554/);
    expect(lib.busyReason({ emulators: [], processes: ["java.exe", "java.exe"] })).toMatch(/java\.exe/);
    expect(lib.busyReason({ emulators: ["emulator-5554"], processes: ["gradle"] })).toMatch(/emulator.*; .*gradle/);
  });
});

describe("uiautomator parsing", () => {
  const nodes = lib.parseNodes(XML);

  it("reads text, content-desc, class, bounds and unescapes entities, ignoring the trailing line", () => {
    expect(nodes).toHaveLength(6);
    expect(nodes[0]).toMatchObject({ text: "Studio today", bounds: { left: 45, top: 180, right: 700, bottom: 260 } });
    expect(nodes.find((n: { text: string }) => n.text.startsWith("Tom"))?.text).toBe('Tom & Jerry "class"');
  });

  it("finds by exact text, by substring, by regex, and by content-desc", () => {
    expect(lib.hasLabel(nodes, "Studio today")).toBe(true);
    expect(lib.hasLabel(nodes, "Studio")).toBe(true);
    expect(lib.hasLabel(nodes, /^Studio$/)).toBe(false); // exact only
    expect(lib.hasLabel(nodes, /^Today$/)).toBe(true); // the tab, by content-desc
    expect(lib.hasLabel(nodes, "Not on screen")).toBe(false);
  });

  it("can pick the input over a caption with the same label", () => {
    expect(lib.findNode(nodes, "Email", { cls: "EditText" })?.bounds.top).toBe(600);
    expect(lib.findNode(nodes, "Email", { cls: "TextView" })?.bounds.top).toBe(540);
  });

  it("gives the centre of a node to tap", () => {
    expect(lib.centerOf(lib.findNode(nodes, "Sign in"))).toEqual({ x: 540, y: 1063 });
  });
});

describe("findTappable", () => {
  const nodes = lib.parseNodes(`<hierarchy>
<node text="Sign in again" class="android.widget.TextView" content-desc="" clickable="false" bounds="[100,300][500,360]" />
<node text="" class="android.view.ViewGroup" content-desc="Sign in again" clickable="true" bounds="[100,500][900,640]" />
</hierarchy>`);

  it("taps the button, not the heading that shares its words", () => {
    expect(lib.findNode(nodes, /^Sign in again$/)?.clickable).toBe(false); // first in tree order: the heading
    expect(lib.findTappable(nodes, /^Sign in again$/)?.bounds.top).toBe(500);
  });

  it("falls back to a plain match when nothing clickable has the label", () => {
    const plain = lib.parseNodes('<hierarchy><node text="Pulse" class="android.widget.TextView" content-desc="" clickable="false" bounds="[0,0][10,10]" /></hierarchy>');
    expect(lib.findTappable(plain, /^Pulse$/)?.bounds.right).toBe(10);
    expect(lib.findTappable(nodes, "Not there")).toBeNull();
  });
});

describe("summarize", () => {
  it("passes only when something ran and everything passed", () => {
    expect(lib.summarize([]).ok).toBe(false);
    expect(lib.summarize([lib.makeResult("a", true), lib.makeResult("b", true)])).toEqual({ total: 2, passed: 2, failed: [], ok: true });
    const mixed = lib.summarize([lib.makeResult("a", true), lib.makeResult("b", false, "not on screen")]);
    expect(mixed).toMatchObject({ passed: 1, failed: ["b"], ok: false });
  });
});
