param(
  [Parameter(Mandatory)][int]$TargetPid,
  [Parameter(Mandatory)][string]$StepsFile,   # JSON array of: text:<chars> | burst:<chars> | bracketed:<chars> | ctrlv | enter | bs | esc | wait:<ms>
  [int]$DelayBeforeMs = 3500
)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ConInject2 {
  [StructLayout(LayoutKind.Explicit, Size = 20)]
  public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public int bKeyDown;
    [FieldOffset(8)] public ushort wRepeatCount;
    [FieldOffset(10)] public ushort wVirtualKeyCode;
    [FieldOffset(12)] public ushort wVirtualScanCode;
    [FieldOffset(14)] public char UnicodeChar;
    [FieldOffset(16)] public uint dwControlKeyState;
  }
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int h);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] buf, uint n, out uint written);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  static INPUT_RECORD Key(char c, bool down) {
    var r = new INPUT_RECORD();
    r.EventType = 1; r.bKeyDown = down ? 1 : 0; r.wRepeatCount = 1; r.UnicodeChar = c;
    if (c == '\r') { r.wVirtualKeyCode = 0x0D; r.wVirtualScanCode = 0x1C; }
    else if (c == '\u001b') { r.wVirtualKeyCode = 0x1B; r.wVirtualScanCode = 0x01; }
    else if (c == '\b') { r.wVirtualKeyCode = 0x08; r.wVirtualScanCode = 0x0E; }
    else {
      short vk = VkKeyScan(c);
      r.wVirtualKeyCode = (ushort)(vk & 0xFF);
      r.wVirtualScanCode = (ushort)MapVirtualKey(r.wVirtualKeyCode, 0);
      if ((vk & 0x100) != 0) r.dwControlKeyState = 0x10;
    }
    return r;
  }
  public static void Send(string s) {
    IntPtr h = GetStdHandle(-10);
    var recs = new INPUT_RECORD[s.Length * 2];
    for (int i = 0; i < s.Length; i++) { recs[2 * i] = Key(s[i], true); recs[2 * i + 1] = Key(s[i], false); }
    uint w; WriteConsoleInput(h, recs, (uint)recs.Length, out w);
  }
  public static void CtrlV() {
    IntPtr h = GetStdHandle(-10);
    var recs = new INPUT_RECORD[2];
    for (int i = 0; i < 2; i++) {
      recs[i] = Key((char)0x16, i == 0);
      recs[i].wVirtualKeyCode = 0x56; recs[i].wVirtualScanCode = 0x2F; recs[i].dwControlKeyState = 0x08;
    }
    uint w; WriteConsoleInput(h, recs, 2, out w);
  }
}
"@
$Steps = @(Get-Content -Raw $StepsFile | ConvertFrom-Json | ForEach-Object { $_ })
Start-Sleep -Milliseconds $DelayBeforeMs
[void][ConInject2]::FreeConsole()
if (-not [ConInject2]::AttachConsole([uint32]$TargetPid)) { throw "AttachConsole failed" }
$esc = [string][char]27
foreach ($step in $Steps) {
  $kind, $arg = $step.Split(":", 2)
  switch ($kind) {
    "text"      { foreach ($c in $arg.ToCharArray()) { [ConInject2]::Send([string]$c); Start-Sleep -Milliseconds 15 } }
    "burst"     { [ConInject2]::Send($arg) }                                   # one WriteConsoleInput call: how a paste arrives
    "bracketed" { [ConInject2]::Send($esc + "[200~" + $arg + $esc + "[201~") }
    "ctrlv"     { [ConInject2]::CtrlV() }
    "enter"     { [ConInject2]::Send("`r") }
    "bs"        { [ConInject2]::Send([string][char]8) }
    "esc"       { [ConInject2]::Send($esc) }
    "wait"      { Start-Sleep -Milliseconds ([int]$arg) }
  }
  Start-Sleep -Milliseconds 350
}
[void][ConInject2]::FreeConsole()
