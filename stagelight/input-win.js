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
      'B' { [SL]::Mouse([uint32]$p[1], 0) }
      'W' { [SL]::Mouse(0x0800, [int]$p[1]) }
      'H' { [SL]::Mouse(0x1000, [int]$p[1]) }
      'K' { [SL]::Key([uint16]$p[1], $p[2] -eq '1', $p[3] -eq '1') }
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

function createInput({ log = () => {} } = {}) {
  let child = null;
  const held = { keys: new Set(), buttons: new Set() };

  function ensure() {
    if (child) return child;
    // tests swap PowerShell for a stand-in that writes the commands down
    child = process.env.STAGELIGHT_INPUT_CMD
      ? spawn(process.execPath, [process.env.STAGELIGHT_INPUT_CMD], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'ignore'] })
      : spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(SCRIPT, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    child.stdout.on('data', d => { const s = String(d); if (/error/.test(s)) log(`mouse/keyboard: ${s.trim().slice(0, 200)}`); });
    child.on('exit', () => { child = null; });
    child.on('error', err => { log(`mouse/keyboard helper failed: ${err.message}`); child = null; });
    return child;
  }
  const send = line => { const c = ensure(); if (c && c.stdin.writable) c.stdin.write(`${line}\n`); };

  return {
    available,
    move: (x, y) => send(`M ${Math.round(x)} ${Math.round(y)}`),
    button(b, down) {
      const f = BUTTONS[b];
      if (!f) return;
      if (down) held.buttons.add(b); else held.buttons.delete(b);
      send(`B ${f[down ? 0 : 1]}`);
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
  };
}

module.exports = { createInput, VK };
