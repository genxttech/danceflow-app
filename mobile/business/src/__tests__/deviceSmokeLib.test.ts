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

describe("system UI stability and ANR kills (run 8)", () => {
  const BAD = [
    "11-16 17:05:19.022   574  2501 E ActivityManager: ANR in com.android.systemui",
    "11-16 17:05:20.360   574   605 W ActivityManager: Process com.android.systemui has crashed too many times, killing! Reason: crashed quickly",
    "11-16 17:05:21.000  1733  1733 E AndroidRuntime: Process: com.android.systemui, PID: 1733",
  ].join("\n");

  it("finds system UI crashes and ANRs in a logcat dump", () => {
    expect(lib.systemUiTrouble(BAD)).toHaveLength(3);
  });

  it("ignores ordinary lines, other apps' ANRs and empty input", () => {
    expect(lib.systemUiTrouble("11-16 17:05:19 I ActivityManager: Start proc 2661:com.idanceflow.business")).toEqual([]);
    expect(lib.systemUiTrouble("E ActivityManager: ANR in com.google.android.apps.photos")).toEqual([]);
    expect(lib.systemUiTrouble("")).toEqual([]);
    expect(lib.systemUiTrouble(undefined)).toEqual([]);
  });

  it("recognises the ANR exit of the app, but not a crash or a low-memory kill", () => {
    const anr = "process=com.idanceflow.business reason=6 (ANR) subreason=0 (UNKNOWN) description=user request after error: Input dispatching timed out (Application does not have a focused window)";
    expect(lib.isAnrExit(anr)).toBe(true);
    expect(lib.isAnrExit("reason=4 (CRASH) subreason=0")).toBe(false);
    expect(lib.isAnrExit("reason=3 (LOW MEMORY)")).toBe(false);
    expect(lib.isAnrExit(undefined)).toBe(false);
  });

  it("knows when a launcher has the screen", () => {
    expect(lib.isLauncherTop("topResumedActivity=ActivityRecord{a1 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t2}")).toBe(true);
    expect(lib.isLauncherTop("topResumedActivity=ActivityRecord{a1 u0 com.idanceflow.business/.MainActivity t64}")).toBe(false);
    expect(lib.isLauncherTop("")).toBe(false);
  });
});

describe("reusing an APK needs the build stack's keys (run 11)", () => {
  const SECRET = "2e04d70b0bb4d72fea9fae6840fcbeb40c555257819f67ea";
  it("reads the JWT secret from the build run's stack.json", () => {
    expect(lib.secretFromStackJson(JSON.stringify({ TW4A_LOCAL_JWT_SECRET: SECRET }))).toBe(SECRET);
  });
  it("refuses a file that is not a stack.json or has no usable secret", () => {
    expect(() => lib.secretFromStackJson("not json")).toThrow(/not a stack.json/);
    expect(() => lib.secretFromStackJson("{}")).toThrow(/no TW4A_LOCAL_JWT_SECRET/);
    expect(() => lib.secretFromStackJson(JSON.stringify({ TW4A_LOCAL_JWT_SECRET: "short" }))).toThrow(/no TW4A_LOCAL_JWT_SECRET/);
  });
  it("takes --keys-from as a value", () => {
    expect(lib.parseArgs(["--apk", "a", "--keys-from", "s.json"]).keysFrom).toBe("s.json");
    expect(() => lib.parseArgs(["--apk", "a", "--keys-from"])).toThrow(/needs a value/);
  });
});

describe("emulator memory", () => {
  it("defaults to 2048 MB and takes --memory as a number", () => {
    expect(lib.parseArgs(["--dry-run"]).memory).toBe(2048);
    expect(lib.parseArgs(["--dry-run", "--memory", "3072"]).memory).toBe(3072);
  });
});

describe("which activity has the screen", () => {
  const APP_TOP = "  topResumedActivity=ActivityRecord{31966dd u0 com.idanceflow.business/.MainActivity t64}\n  ResumedActivity: ActivityRecord{31966dd u0 com.idanceflow.business/.MainActivity t64}";
  const LAUNCHER_TOP = "  topResumedActivity=ActivityRecord{a1b2c3 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t2}";

  it("reads the top activity as package/Activity", () => {
    expect(lib.topActivity(APP_TOP)).toBe("com.idanceflow.business/.MainActivity");
    expect(lib.topActivity(LAUNCHER_TOP)).toBe("com.google.android.apps.nexuslauncher/.NexusLauncherActivity");
    expect(lib.topActivity("nothing useful")).toBeNull();
    expect(lib.topActivity(undefined)).toBeNull();
  });

  it("the app is in the foreground only when its own package has the screen", () => {
    expect(lib.isAppForeground(APP_TOP, "com.idanceflow.business")).toBe(true);
    expect(lib.isAppForeground(LAUNCHER_TOP, "com.idanceflow.business")).toBe(false);
    expect(lib.isAppForeground("", "com.idanceflow.business")).toBe(false);
  });

  it("another app with a similar name is not the app (the Student app shares the machine)", () => {
    const student = "  topResumedActivity=ActivityRecord{38fcb8d u0 com.idanceflow.student/.MainActivity t49}";
    expect(lib.isAppForeground(student, "com.idanceflow.business")).toBe(false);
    expect(lib.isAppForeground("topResumedActivity=ActivityRecord{1 u0 com.idanceflow.businessx/.Main t1}", "com.idanceflow.business")).toBe(false);
  });
});

describe("emulator reachability probe", () => {
  it("builds a plain GET to the host alias and rejects odd input", () => {
    const cmd = lib.reachProbeCommand(56600, "/auth/v1/health");
    expect(cmd).toContain("GET /auth/v1/health HTTP/1.0");
    expect(cmd).toContain("nc -w 4 10.0.2.2 56600");
    expect(() => lib.reachProbeCommand(0)).toThrow();
    expect(() => lib.reachProbeCommand(80, "/a; rm -rf /")).toThrow();
  });

  it("any HTTP status counts as answered; silence and refusals do not", () => {
    expect(lib.probeAnswered("HTTP/1.1 200 OK\r\ncontent-type: application/json")).toBe(true);
    expect(lib.probeAnswered("HTTP/1.0 401 Unauthorized")).toBe(true);
    expect(lib.probeAnswered("")).toBe(false);
    expect(lib.probeAnswered("nc: connect failed: Connection refused")).toBe(false);
    expect(lib.probeAnswered(undefined)).toBe(false);
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
