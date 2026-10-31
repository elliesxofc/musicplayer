'use strict';

/* Mouse and keyboard for the remote display (Windows only). A small hidden PowerShell process
   presses keys and moves the mouse through Windows' own SendInput, so nothing extra has to be
   installed. Stagelight sends it one command per line:
     M x y        move the mouse to x, y (screen pixels)
     B flags      a mouse button (Windows' MOUSEEVENTF_ flags)
     W delta      the wheel (H delta: sideways)
     K vk up ext  a key (virtual-key code, 1 = let go, 1 = extended key)
     T base64     type text (any letters, emoji included)
   It stops by itself when Stagelight closes (its input ends). */

const { spawn } = require('node:child_process');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SL {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  static int Size = Marshal.SizeOf(typeof(INPUT));
  public static void Mouse(uint flags, int data) {
    var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = unchecked((uint)data);
    SendInput(1, new[] { i }, Size);
  }
  public static void Key(ushort vk, bool up, bool ext) {
    var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.dwFlags = (up ? 2u : 0u) | (ext ? 1u : 0u);
    SendInput(1, new[] { i }, Size);
  }
  // Windows ignores clicks and keys sent into a program that runs as administrator, unless the
  // sender does too: find out whether that's the case for the window under the pointer (or in front)
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr tok);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr tok, int cls, out uint info, int len, out int ret);
  // 1: runs as administrator (or can't even be looked at, which comes to the same), 0: doesn't
  static int Elevated(uint pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return 1;
    try {
      IntPtr t;
      if (!OpenProcessToken(p, 8, out t)) return 1;
      uint e; int r;
      bool ok = GetTokenInformation(t, 20, out e, 4, out r);
      CloseHandle(t);
      return ok && e == 0 ? 0 : 1;
    } finally { CloseHandle(p); }
  }
  static int self = -1;
  public static string Blocked(bool front) {
    if (self < 0) self = Elevated((uint)System.Diagnostics.Process.GetCurrentProcess().Id);
    if (self == 1) return null;
    POINT pt; GetCursorPos(out pt);
    IntPtr w = front ? GetForegroundWindow() : WindowFromPoint(pt);
    if (w == IntPtr.Zero) return null;
    uint pid; GetWindowThreadProcessId(w, out pid);
    if (pid == 0 || Elevated(pid) == 0) return null;
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return "a program"; }
  }
  // the program a click landed in (said back to the panel, so it knows the click arrived)
  public static string Under() {
    POINT pt; GetCursorPos(out pt);
    IntPtr w = WindowFromPoint(pt);
    if (w == IntPtr.Zero) return "";
    uint pid; GetWindowThreadProcessId(w, out pid);
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }
  public static void Text(string s) {
    foreach (char c in s) {
      var d = new INPUT(); d.type = 1; d.u.ki.wScan = c; d.u.ki.dwFlags = 4;
      var u = new INPUT(); u.type = 1; u.u.ki.wScan = c; u.u.ki.dwFlags = 6;
      SendInput(2, new[] { d, u }, Size);
    }
  }
}
"@
[SL]::SetProcessDPIAware() | Out-Null
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { exit 0 }
  $p = $line.Split(' ')
  try {
    switch ($p[0]) {
      'M' { [SL]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null }
      'B' { [SL]::Mouse([uint32]$p[1], 0); if ($p.Length -gt 2) { $b = [SL]::Blocked($false); if ($b) { [Console]::Out.WriteLine('blocked ' + $b) } else { [Console]::Out.WriteLine('clicked ' + [SL]::Under()) } } }
      'W' { [SL]::Mouse(0x0800, [int]$p[1]) }
      'H' { [SL]::Mouse(0x1000, [int]$p[1]) }
      'K' { [SL]::Key([uint16]$p[1], $p[2] -eq '1', $p[3] -eq '1'); if ($p[2] -eq '0') { $b = [SL]::Blocked($true); if ($b) { [Console]::Out.WriteLine('blocked ' + $b) } } }
      'T' { [SL]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))) }
    }
  } catch { [Console]::Out.WriteLine('error ' + $_.Exception.Message) }
}
`;

// KeyboardEvent.code → [Windows virtual-key code, extended key]
const VK = (() => {
  const m = {
    Enter: [0x0d], Escape: [0x1b], Backspace: [0x08], Tab: [0x09], Space: [0x20], CapsLock: [0x14],
    ShiftLeft: [0xa0], ShiftRight: [0xa1], ControlLeft: [0xa2], ControlRight: [0xa3, 1], AltLeft: [0xa4], AltRight: [0xa5, 1],
    MetaLeft: [0x5b, 1], MetaRight: [0x5c, 1], ContextMenu: [0x5d, 1],
    ArrowLeft: [0x25, 1], ArrowUp: [0x26, 1], ArrowRight: [0x27, 1], ArrowDown: [0x28, 1],
    Insert: [0x2d, 1], Delete: [0x2e, 1], Home: [0x24, 1], End: [0x23, 1], PageUp: [0x21, 1], PageDown: [0x22, 1],
    PrintScreen: [0x2c, 1], ScrollLock: [0x91], Pause: [0x13], NumLock: [0x90, 1],
    Minus: [0xbd], Equal: [0xbb], BracketLeft: [0xdb], BracketRight: [0xdd], Backslash: [0xdc], IntlBackslash: [0xe2],
    Semicolon: [0xba], Quote: [0xde], Backquote: [0xc0], Comma: [0xbc], Period: [0xbe], Slash: [0xbf],
    NumpadMultiply: [0x6a], NumpadAdd: [0x6b], NumpadSubtract: [0x6d], NumpadDecimal: [0x6e], NumpadDivide: [0x6f, 1], NumpadEnter: [0x0d, 1],
  };
  for (let i = 0; i < 26; i++) m[`Key${String.fromCharCode(65 + i)}`] = [0x41 + i];
  for (let i = 0; i < 10; i++) { m[`Digit${i}`] = [0x30 + i]; m[`Numpad${i}`] = [0x60 + i]; }
  for (let i = 1; i <= 24; i++) m[`F${i}`] = [0x6f + i];
  return m;
})();

// mouse buttons: 0 left, 1 middle, 2 right → [down flag, up flag]
const BUTTONS = { 0: [0x0002, 0x0004], 1: [0x0020, 0x0040], 2: [0x0008, 0x0010] };

const available = () => process.platform === 'win32' || !!process.env.STAGELIGHT_INPUT_CMD;

function createInput({ log = () => {}, onBlocked = () => {}, onClicked = () => {}, onFailed = () => {} } = {}) {
  let child = null;
  const held = { keys: new Set(), buttons: new Set() };
  // the helper not starting (PowerShell blocked, say by antivirus) would otherwise drop every click
  // and key without a word: say why, and stop trying after a few failed starts in a row
  let fails = 0, broken = '';

  function ensure() {
    if (child || broken) return child;
    // tests swap PowerShell for a stand-in that writes the commands down
    const c = child = process.env.STAGELIGHT_INPUT_CMD
      ? spawn(process.execPath, [process.env.STAGELIGHT_INPUT_CMD], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(SCRIPT, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let ready = false, rest = '', err = '';
    c.stdout.on('data', d => {
      rest += String(d);
      const lines = rest.split(/\r?\n/); rest = lines.pop();
      for (const line of lines) {
        if (line === 'ready') { ready = true; fails = 0; }
        else if (/^blocked /.test(line)) onBlocked(line.slice(8).trim().slice(0, 60));
        else if (/^clicked/.test(line)) onClicked(line.slice(8).trim().slice(0, 60));
        else if (/error/.test(line)) log(`mouse/keyboard: ${line.trim().slice(0, 200)}`);
      }
    });
    c.stderr.on('data', d => { err = (err + String(d)).slice(-600); });
    // below normal priority, like the rest of Stagelight: OBS comes first
    try { require('node:os').setPriority(c.pid, require('node:os').constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* fine */ }
    const gone = why => {
      if (child === c) child = null;
      if (ready) return;
      const text = why || err.replace(/\s+/g, ' ').trim().slice(0, 300) || 'it stopped right away';
      log(`mouse/keyboard helper didn't start: ${text}`);
      if (++fails >= 3) { broken = text; onFailed(text); }
    };
    c.on('exit', () => gone(''));
    c.on('error', e => gone(e.message));
    c.stdin.on('error', () => { /* it's gone: said above */ });
    return c;
  }
  const send = line => { const c = ensure(); if (c && c.stdin.writable) c.stdin.write(`${line}\n`); };

  return {
    available,
    move: (x, y) => send(`M ${Math.round(x)} ${Math.round(y)}`),
    button(b, down) {
      const f = BUTTONS[b];
      if (!f) return;
      if (down) held.buttons.add(b); else held.buttons.delete(b);
      send(`B ${f[down ? 0 : 1]}${down ? ' ?' : ''}`); // on a press, check the window can take it
    },
    wheel(dy, dx) {
      // browsers scroll down with +, Windows with −; 120 is one notch
      if (dy) send(`W ${Math.max(-1200, Math.min(1200, Math.round(-dy)))}`);
      if (dx) send(`H ${Math.max(-1200, Math.min(1200, Math.round(dx)))}`);
    },
    key(code, down) {
      const k = VK[code];
      if (!k) return;
      if (down) held.keys.add(code); else held.keys.delete(code);
      send(`K ${k[0]} ${down ? 0 : 1} ${k[1] ? 1 : 0}`);
    },
    text(s) {
      s = String(s || '').slice(0, 500);
      if (s) send(`T ${Buffer.from(s, 'utf8').toString('base64')}`);
    },
    // the session ended: let go of everything still held down, so no key stays stuck
    releaseAll() {
      for (const code of held.keys) this.key(code, false);
      for (const b of held.buttons) this.button(b, false);
    },
    stop() { if (child) { try { child.stdin.end(); } catch { /* gone */ } child = null; } },
    // why mouse and keyboard don't work ('' when they do, as far as is known)
    broken: () => broken,
  };
}

module.exports = { createInput, VK };
