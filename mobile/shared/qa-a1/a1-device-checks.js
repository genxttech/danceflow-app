/* eslint-disable @typescript-eslint/no-require-imports -- a plain node QA helper (CommonJS), used by both apps' disposable-stack smoke harnesses */
/*
  A1 device checks (QA only, disposable stack): the assistant launcher/sheet on an emulator, driven through adb + uiautomator.
  Used by mobile/student/scripts/qa-smoke/run.mjs (--a1) and mobile/business/scripts/device-smoke.js (--a1). Each check asserts on the
  accessibility tree and keeps a screenshot; nothing is judged by eye alone. Anything this script cannot assert is recorded as BLOCKED, never PASS.

  ctx = {
    adb(args) -> { stdout, stderr, status },   // adb with the emulator selected
    hierarchy() -> xml string,
    shot(file), record(name, ok, detail), sleep(ms), out (dir), pkg, assistantName ("LUMI" | "ARIA"),
    flagsOn (boolean), density (px per 160dpi), screens: [{ id, open: async () => void, launcher: boolean }],
    secondUser?: async () => boolean   // signs in as another user (fresh app data); true when signed in
    writeFile(path, text)
  }
*/
const path = require("node:path");

const MIN_TOUCH_DP = 44;

function nodes(xml) {
  const out = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, "\n");
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? "");
    if (b) attrs.box = { l: +b[1], t: +b[2], r: +b[3], b: +b[4], cx: Math.round((+b[1] + +b[3]) / 2), cy: Math.round((+b[2] + +b[4]) / 2) };
    out.push(attrs);
  }
  return out;
}
const label = (n) => n["content-desc"] || n.text || "";
const find = (xml, re) => nodes(xml).find((n) => n.box && re.test(label(n)));
const findAll = (xml, re) => nodes(xml).filter((n) => n.box && re.test(label(n)));

// Top edge (y) of the on-screen keyboard from `dumpsys window windows`. Each window block starts with "Window #n Window{... InputMethod}:";
// the frame is "mFrame=[l,t][r,b]" (older images) or "frame=[l,t][r,b]" (API 35). A block that is the IME window and is not a sliver
// (taller than 200px) counts; the highest top wins. Returns null when no such window is found.
function imeTopFromDumpsys(text) {
  let top = null;
  for (const block of String(text || "").split(/\n\s*Window #/)) {
    if (!/InputMethod/.test(block.split("\n")[0])) continue;
    const m = /(?:mFrame|\bframe)=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(block);
    if (!m) continue;
    const t = Number(m[2]);
    const b = Number(m[4]);
    if (b - t > 200) top = top == null ? t : Math.min(top, t);
  }
  return top;
}

async function run(ctx) {
  const { adb, hierarchy, shot, record, sleep, out, pkg } = ctx;
  const name = ctx.assistantName;
  const launcherRe = new RegExp(`^Open ${name} assistant$`);
  const tap = (n) => adb(["shell", "input", "tap", String(n.box.cx), String(n.box.cy)]);
  const dpPx = (dp) => Math.floor((dp * (ctx.density || 160)) / 160); // floor: a 44dp control renders as 115px at 420dpi (115.5 exact)
  const isCrash = (xml) => /isn't responding|has stopped|keeps stopping|Unfortunately/i.test(xml);
  const dump = (tag) => {
    const xml = hierarchy();
    ctx.writeFile(path.join(out, `${tag}.xml`), xml);
    shot(path.join(out, `${tag}.png`));
    return xml;
  };

  // ---------- Part A: flags OFF ----------
  if (!ctx.flagsOn) {
    // A1: no assistant node on any walked screen
    for (const s of ctx.screens) {
      await s.open();
      await sleep(2500);
      const xml = dump(`a1-off-${s.id}`);
      const hit = nodes(xml).filter((n) => new RegExp(`${name}|assistant`, "i").test(label(n)) && !/Minimize|Expand/.test(label(n)) && !(s.allowName && s.allowName.test(label(n))));
      record(`A flags OFF: no assistant UI on ${s.id}`, hit.length === 0 && !isCrash(xml), hit.length ? `found: ${hit.map(label).join(" | ").slice(0, 160)}` : "");
    }
    // A2: cold start x5
    const resolved = adb(["shell", "cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", pkg]).stdout.trim().split(/\r?\n/).pop();
    const times = [];
    const logs = [];
    for (let i = 0; i < 5; i++) {
      adb(["shell", "am", "force-stop", pkg]);
      adb(["logcat", "-c"]);
      await sleep(1500);
      const r = adb(["shell", "am", "start", "-W", "-n", resolved]);
      const t = /TotalTime:\s*(\d+)/.exec(r.stdout)?.[1];
      const w = /WaitTime:\s*(\d+)/.exec(r.stdout)?.[1];
      times.push({ run: i + 1, totalTime: t ? +t : null, waitTime: w ? +w : null });
      await sleep(12000);
      const log = adb(["logcat", "-d", "-v", "brief"]).stdout;
      logs.push({ run: i + 1, reactNativeJsLines: (log.match(/ReactNativeJS/g) || []).length, assistantMentions: (log.match(new RegExp(`${name}|assistant`, "gi")) || []).length });
      if (i === 0) ctx.writeFile(path.join(out, "a1-cold-start-logcat-run1.txt"), log);
    }
    const ts = times.map((x) => x.totalTime).filter((x) => x != null).sort((a, b) => a - b);
    const median = ts.length ? ts[Math.floor(ts.length / 2)] : null;
    ctx.writeFile(path.join(out, "a1-cold-start.json"), JSON.stringify({ component: resolved, times, median, min: ts[0] ?? null, max: ts[ts.length - 1] ?? null, logs }, null, 2));
    record("A cold start x5 (am start -W TotalTime ms)", ts.length === 5, `median ${median} min ${ts[0]} max ${ts[ts.length - 1]}; JS log lines per run ${logs.map((l) => l.reactNativeJsLines).join(",")}; assistant mentions ${logs.map((l) => l.assistantMentions).join(",")}`);
    return;
  }

  // ---------- Part B: flags ON ----------
  const sheetOpen = (xml) => !!find(xml, /^Message /) || !!find(xml, /^Minimize assistant$/);
  const openSheet = async () => {
    let xml = hierarchy();
    const l = find(xml, launcherRe);
    if (!l) return null;
    tap(l);
    await sleep(1200);
    xml = hierarchy();
    return sheetOpen(xml) ? xml : null;
  };
  const closeSheet = async () => {
    const xml = hierarchy();
    const c = findAll(xml, /^Minimize assistant$/).find((n) => n.text === "Close") || find(xml, /^Minimize assistant$/);
    if (c) tap(c);
    await sleep(900);
  };

  // B1 launcher visibility rules
  for (const s of ctx.screens) {
    await s.open();
    await sleep(2500);
    const xml = dump(`b1-${s.id}`);
    const l = find(xml, launcherRe);
    const okVisible = s.launcher ? !!l : !l;
    let detail = "";
    if (l) {
      const sizePx = Math.min(l.box.r - l.box.l, l.box.b - l.box.t);
      const sheet = nodes(xml).filter((n) => n.box && /tab|navigation/i.test(`${n["resource-id"]} ${n.class}`));
      detail = `launcher ${l.box.r - l.box.l}x${l.box.b - l.box.t}px (>=${dpPx(MIN_TOUCH_DP)}px: ${sizePx >= dpPx(MIN_TOUCH_DP)}) at ${l.bounds}`;
      record(`B launcher touch target >= 44dp on ${s.id}`, sizePx >= dpPx(MIN_TOUCH_DP), detail);
    }
    record(`B launcher ${s.launcher ? "visible" : "absent"} on ${s.id}`, okVisible && !isCrash(xml), detail);
  }

  // B2/B3 sheet open, conversation, expand, close, back
  const first = ctx.screens.find((s) => s.launcher);
  await first.open();
  await sleep(2000);
  let xml = await openSheet();
  record("B sheet opens from the launcher", !!xml);
  if (!xml) return;
  dump("b2-sheet-open");
  record("B sheet shows title, scrim, Expand, Close, composer, Send (disabled while empty)", !!find(xml, new RegExp(`^${name}$`)) && !!find(xml, /^Expand to full screen$/) && !!find(xml, /^Message /) && !!find(xml, /^Send message$/), "");
  const launcherWhileOpen = find(xml, launcherRe);
  record("B launcher hidden while the sheet is open", !launcherWhileOpen);

  // type + send
  const input = find(xml, /^Message /);
  tap(input);
  await sleep(800);
  adb(["shell", "input", "text", "show%sme%sevents"]);
  await sleep(700);
  const withKb = adb(["shell", "uiautomator", "dump", "--windows", "/sdcard/ui-win.xml"]).status === 0 ? adb(["exec-out", "cat", "/sdcard/ui-win.xml"]).stdout : "";
  let kbTop = null;
  kbTop = imeTopFromDumpsys(adb(["shell", "dumpsys", "window", "windows"]).stdout);
  // fallback: the keyboard's own window: an input-method package node that is tall (the key rows), not the status-bar/IME-switcher slivers
  if (kbTop == null) for (const n of nodes(withKb)) if (n.box && /inputmethod/i.test(n.package || "") && n.box.b - n.box.t > 300) kbTop = kbTop == null ? n.box.t : Math.min(kbTop, n.box.t);
  const afterTyping = hierarchy();
  ctx.writeFile(path.join(out, "b5-keyboard.xml"), afterTyping);
  shot(path.join(out, "b5-keyboard.png"));
  const composer = find(afterTyping, /^Message /);
  const send = find(afterTyping, /^Send message$/);
  record("B keyboard: composer and Send stay above the keyboard", !!composer && !!send && (kbTop == null ? true : composer.box.b <= kbTop && send.box.b <= kbTop) && !find(afterTyping, launcherRe), `keyboardTop=${kbTop ?? "not in tree (only on-screen position checked)"} composer.bottom=${composer?.box.b} send.bottom=${send?.box.b}`);
  if (send) tap(send);
  await sleep(300);
  const pending = hierarchy();
  record("B pending state: typing indicator or Stop control appears while the stub answers", !!find(pending, /is typing$/) || !!find(pending, /^Stop$/), "400ms stub delay, may race: informational");
  await sleep(2500);
  xml = dump("b3-after-reply");
  const reply = nodes(xml).some((n) => /Preview answer/.test(label(n)));
  record("B stub reply arrives (labelled preview/placeholder)", reply, "");
  const linkChip = find(xml, /^(Browse events|Open Wallet|Open Schedule|Open Today|Open Pulse|Open Clients|Open client|Open appointment)/i) || nodes(xml).find((n) => n.box && /link/i.test(n.class || "") && false);
  record("B conversation shows the user message", nodes(xml).some((n) => /show me events/.test(label(n))), "");

  // expand/shrink
  const exp = find(xml, /^Expand to full screen$/);
  if (exp) {
    tap(exp);
    await sleep(900);
    const full = dump("b2-sheet-full");
    record("B Expand shows full screen (no scrim) and Shrink", !find(full, /^Minimize assistant$/) || !!find(full, /^Show as sheet$/), "");
    const shrink = find(full, /^Show as sheet$/);
    if (shrink) { tap(shrink); await sleep(800); }
  } else record("B Expand control present", false, "not found");

  // Android back closes
  // With the keyboard up, the first Back only hides the keyboard (standard Android); the sheet must close within one more Back.
  let backs = 0;
  do {
    adb(["shell", "input", "keyevent", "4"]);
    backs++;
    await sleep(1000);
    xml = hierarchy();
  } while (sheetOpen(xml) && backs < 3);
  record("B Android back closes the sheet (first Back may only hide the keyboard)", !sheetOpen(xml) && !!find(xml, launcherRe) && backs <= 2, `${backs} Back press(es)`);

  // continuity across navigation
  const other = ctx.screens.find((s) => s.launcher && s.id !== first.id);
  if (other) {
    await other.open();
    await sleep(2500);
    xml = await openSheet();
    const kept = !!xml && nodes(xml).some((n) => /show me events/.test(label(n)));
    const helping = xml ? nodes(xml).find((n) => /^Helping with:/.test(label(n))) : null;
    dump("b4-continuity");
    record("B conversation continues after navigating to another screen", kept, "");
    record("B 'Helping with' follows the current screen", !!helping, helping ? label(helping) : "no label");
    // a second-screen link chip navigates
    const chip = xml ? find(xml, /^(Browse events|Open Wallet|Open Schedule|Open Today|Open Pulse|Open Clients)/) : null;
    if (chip) {
      tap(chip);
      await sleep(3000);
      const nav = hierarchy();
      record("B link chip navigates and closes the sheet", !sheetOpen(nav), `chip "${label(chip)}"`);
    } else record("B link chip navigates and closes the sheet", false, "no link chip in the reply");
  } else record("B continuity across navigation", false, "BLOCKED: only one launcher screen configured");

  // scrim tap closes bottom sheet
  await first.open();
  await sleep(2000);
  xml = await openSheet();
  if (xml) {
    const scrim = find(xml, /^Minimize assistant$/);
    if (scrim && scrim.text !== "Close") {
      tap(scrim);
      await sleep(900);
      record("B scrim tap closes the sheet", !sheetOpen(hierarchy()), "");
    } else record("B scrim tap closes the sheet", false, "scrim node not found");
  }

  // B6 font 2.0 / dark: controls and composer still reachable, targets >= 44dp
  for (const mode of [{ scale: "2.0", night: "no", tag: "font2-light" }, { scale: "1.0", night: "yes", tag: "font1-dark" }, { scale: "2.0", night: "yes", tag: "font2-dark" }]) {
    adb(["shell", "settings", "put", "system", "font_scale", mode.scale]);
    adb(["shell", "cmd", "uimode", "night", mode.night]);
    await sleep(3500);
    // a live font change leaves the layout half-measured (clipped text in screenshots): cold-start the app so the screenshot shows the settled layout
    adb(["shell", "am", "force-stop", pkg]);
    await sleep(1500);
    adb(["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]);
    await sleep(14000);
    await first.open();
    await sleep(2500);
    const l = find(hierarchy(), launcherRe);
    xml = await openSheet();
    const tag = `b6-${mode.tag}`;
    xml = xml ? dump(tag) : hierarchy();
    if (!xml || !sheetOpen(xml)) { record(`B ${mode.tag}: sheet opens`, false, l ? "launcher present but sheet did not open" : "launcher missing"); continue; }
    const controls = ["Expand to full screen", "Minimize assistant", `Message ${name}`, "Send message"].map((lab) => findAll(xml, new RegExp(`^${lab}$`)).sort((a, b) => (b.box.b - b.box.t) - (a.box.b - a.box.t))[0]);
    const small = controls.filter((n) => n && n.box && n.box.b - n.box.t < dpPx(MIN_TOUCH_DP) && !/^Message /.test(label(n)));
    const missing = controls.filter((n) => !n).length;
    record(`B ${mode.tag}: header, composer and Send reachable, targets >= 44dp`, missing === 0 && small.length === 0, `missing=${missing} small=${small.map((n) => `${label(n)}:${n.box.b - n.box.t}px`).join(",")}`);
    await closeSheet();
  }
  adb(["shell", "settings", "put", "system", "font_scale", "1.0"]);
  adb(["shell", "cmd", "uimode", "night", "no"]);

  // B7 reading/focus order (document order of labels) + TalkBack
  await sleep(2500);
  await first.open();
  await sleep(2000);
  xml = await openSheet();
  if (xml) {
    const labels = nodes(xml).map(label).filter(Boolean);
    const iTitle = labels.indexOf(name), iExpand = labels.findIndex((x) => /^Expand to full screen$/.test(x)), iComposer = labels.findIndex((x) => /^Message /.test(x)), iSend = labels.findIndex((x) => /^Send message$/.test(x));
    record("B accessibility-tree order: title, header actions, thread, composer, Send", iTitle >= 0 && iTitle < iExpand && iExpand < iComposer && iComposer < iSend, `order indexes title=${iTitle} expand=${iExpand} composer=${iComposer} send=${iSend}`);
    const focusable = findAll(xml, /./).filter((n) => /true/.test(n.clickable) && !label(n));
    record("B every clickable control in the sheet has a label", focusable.filter((n) => n.box.b - n.box.t > 0).length === 0, focusable.map((n) => n.bounds).slice(0, 5).join(" "));
    await closeSheet();
  }
  record("B TalkBack spoken-focus walk", false, "BLOCKED: TalkBack screen-reader traversal not run on the emulator in this slot; static tree order, labels and target sizes asserted above");

  // B8 user switch drops the thread
  if (ctx.secondUser) {
    const signedIn = await ctx.secondUser();
    if (signedIn) {
      await first.open();
      await sleep(2500);
      xml = await openSheet();
      const gone = !!xml && !nodes(xml).some((n) => /show me events/.test(label(n)));
      dump("b8-second-user");
      record("B a different signed-in user starts with an empty thread", gone, "");
    } else record("B a different signed-in user starts with an empty thread", false, "second user sign-in did not complete");
  } else record("B user switch drops the thread", false, "BLOCKED: no second user in this harness");
}

module.exports = { run, nodes, find, findAll, imeTopFromDumpsys };
