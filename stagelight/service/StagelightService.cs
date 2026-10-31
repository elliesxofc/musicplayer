// Stagelight's background service (Windows), like AnyDesk's: it runs as SYSTEM, so the remote
// display's mouse and keyboard also work in programs that run as administrator, on Windows'
// "do you want to allow" prompts and on the lock screen, and it can show those (they're on a
// protected screen the normal program can't see).
//
//   stagelight-service.exe          the service itself (started by Windows)
//   stagelight-service.exe helper   started by the service in the signed-in user's session, as
//                                   SYSTEM: it presses keys, moves the mouse and takes pictures
//
// Only programs running as administrator (Stagelight with "run as administrator") can talk to it,
// through the pipe \\.\pipe\stagelight-service. One line per command, the same ones as Stagelight's
// PowerShell helper (input-win.js), and:
//   D              which screen takes input now: answers "desk NAME" (Default, Winlogon, …)
//   S width q      a picture of that screen: answers "shot BASE64" (JPEG)
//   sas            ctrl + alt + del (done by the service itself)
// Written for the C# 5 compiler that comes with Windows (.NET Framework 4).
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;

static class Program {
  static void Main(string[] args) {
    if (args.Length > 0 && args[0] == "helper") { Helper.Run(); return; }
    ServiceBase.Run(new StagelightService());
  }
}

class StagelightService : ServiceBase {
  public const string PipeName = "stagelight-service";
  volatile bool stopping;
  Thread listener;
  NamedPipeServerStream current;

  public StagelightService() { ServiceName = "StagelightService"; CanStop = true; }

  protected override void OnStart(string[] args) {
    // below normal priority, like the rest of Stagelight: OBS comes first
    try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
    listener = new Thread(Listen); listener.IsBackground = true; listener.Start();
  }
  protected override void OnStop() {
    stopping = true;
    try { if (current != null) current.Dispose(); } catch { }
  }

  // only SYSTEM and administrators (a program running as administrator) may connect
  static PipeSecurity Security() {
    var s = new PipeSecurity();
    s.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
    s.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
    return s;
  }

  void Listen() {
    while (!stopping) {
      try {
        using (var pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 65536, 65536, Security())) {
          current = pipe;
          pipe.WaitForConnection();
          Serve(pipe);
        }
      } catch { if (!stopping) Thread.Sleep(500); }
    }
  }

  // one Stagelight at a time: its lines go to a helper in the signed-in user's session
  void Serve(NamedPipeServerStream pipe) {
    var reader = new StreamReader(pipe, new UTF8Encoding(false));
    var writer = new StreamWriter(pipe, new UTF8Encoding(false)); writer.AutoFlush = true; writer.NewLine = "\n";
    object writeLock = new object();
    Action<string> say = line => { lock (writeLock) { try { writer.WriteLine(line); } catch { } } };
    string hello = reader.ReadLine();
    if (hello != "hello 1") return;
    HelperProcess helper = null;
    try {
      string line;
      while ((line = reader.ReadLine()) != null) {
        if (line == "sas") { Native.SendSAS(false); continue; }
        // a helper for the session at the screen now (it changes with switching users)
        uint session = Native.WTSGetActiveConsoleSessionId();
        if (helper == null || helper.Exited || helper.Session != session) {
          if (helper != null) helper.Kill();
          helper = HelperProcess.Start(session, say);
          if (helper == null) { say("error couldn't start the helper in session " + session); continue; }
        }
        helper.Send(line);
      }
    } finally { if (helper != null) helper.Kill(); }
  }
}

// the helper process, started as SYSTEM in a user's session, its output passed on to Stagelight
class HelperProcess {
  public uint Session;
  Process proc;
  StreamWriter input;
  public bool Exited { get { try { return proc.HasExited; } catch { return true; } } }

  public static HelperProcess Start(uint session, Action<string> say) {
    IntPtr own = IntPtr.Zero, dup = IntPtr.Zero;
    var toChild = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
    var fromChild = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
    try {
      if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_ALL_ACCESS, out own)) return null;
      if (!Native.DuplicateTokenEx(own, Native.TOKEN_ALL_ACCESS, IntPtr.Zero, 2, 1, out dup)) return null;
      uint s = session;
      if (!Native.SetTokenInformation(dup, 12, ref s, 4)) return null;
      var si = new Native.STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));
      si.lpDesktop = "winsta0\\default";
      si.dwFlags = 0x100; // STARTF_USESTDHANDLES
      si.hStdInput = toChild.ClientSafePipeHandle.DangerousGetHandle();
      si.hStdOutput = fromChild.ClientSafePipeHandle.DangerousGetHandle();
      si.hStdError = fromChild.ClientSafePipeHandle.DangerousGetHandle();
      Native.PROCESS_INFORMATION pi;
      string exe = Process.GetCurrentProcess().MainModule.FileName;
      if (!Native.CreateProcessAsUser(dup, exe, "\"" + exe + "\" helper", IntPtr.Zero, IntPtr.Zero, true, 0x08000000 /* no window */, IntPtr.Zero, Path.GetDirectoryName(exe), ref si, out pi)) return null;
      Native.CloseHandle(pi.hThread);
      var p = Process.GetProcessById((int)pi.dwProcessId);
      Native.CloseHandle(pi.hProcess);
      toChild.DisposeLocalCopyOfClientHandle(); fromChild.DisposeLocalCopyOfClientHandle();
      var h = new HelperProcess();
      h.Session = session; h.proc = p;
      h.input = new StreamWriter(toChild, new UTF8Encoding(false)); h.input.AutoFlush = true; h.input.NewLine = "\n";
      var outReader = new StreamReader(fromChild, new UTF8Encoding(false));
      var t = new Thread(() => { try { string l; while ((l = outReader.ReadLine()) != null) say(l); } catch { } });
      t.IsBackground = true; t.Start();
      return h;
    } finally {
      if (own != IntPtr.Zero) Native.CloseHandle(own);
      if (dup != IntPtr.Zero) Native.CloseHandle(dup);
    }
  }
  public void Send(string line) { try { input.WriteLine(line); } catch { } }
  public void Kill() { try { input.Dispose(); } catch { } try { if (!proc.HasExited) proc.Kill(); } catch { } }
}

// in the user's session, as SYSTEM: input and pictures go to whichever screen takes input now
static class Helper {
  static IntPtr desk = IntPtr.Zero;
  static string deskName = "";

  public static void Run() {
    try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
    Native.SetProcessDPIAware();
    var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)); stdout.AutoFlush = true; stdout.NewLine = "\n";
    stdout.WriteLine("ready");
    string line;
    while ((line = stdin.ReadLine()) != null) {
      try {
        string[] p = line.Split(' ');
        bool changed = SyncDesktop();
        if (changed || p[0] == "D") stdout.WriteLine("desk " + deskName);
        switch (p[0]) {
          case "M": Native.SetCursorPos(int.Parse(p[1]), int.Parse(p[2])); break;
          case "B":
            Mouse(uint.Parse(p[1]), 0);
            if (p.Length > 2) stdout.WriteLine("clicked " + Under());
            break;
          case "W": Mouse(0x0800, int.Parse(p[1])); break;
          case "H": Mouse(0x1000, int.Parse(p[1])); break;
          case "K": Key(ushort.Parse(p[1]), p[2] == "1", p[3] == "1"); break;
          case "T": Text(Encoding.UTF8.GetString(Convert.FromBase64String(p[1]))); break;
          case "S": stdout.WriteLine("shot " + ShotOnDesk(int.Parse(p[1]), long.Parse(p[2]))); break;
        }
      } catch (Exception e) { stdout.WriteLine("error " + e.Message.Replace("\r", " ").Replace("\n", " ")); }
    }
  }

  // the screen that takes input now: the desktop, a "do you want to allow" prompt, the lock screen
  static bool SyncDesktop() {
    IntPtr h = Native.OpenInputDesktop(0, false, 0x02000000 /* MAXIMUM_ALLOWED */);
    if (h == IntPtr.Zero) return false;
    string name = DesktopName(h);
    if (name == deskName && desk != IntPtr.Zero) { Native.CloseDesktop(h); return false; }
    if (!Native.SetThreadDesktop(h)) { Native.CloseDesktop(h); return false; }
    if (desk != IntPtr.Zero) Native.CloseDesktop(desk);
    desk = h; deskName = name;
    return true;
  }
  static string DesktopName(IntPtr h) {
    var buf = new byte[512]; int needed;
    if (!Native.GetUserObjectInformation(h, 2 /* UOI_NAME */, buf, buf.Length, out needed)) return "";
    return Encoding.Unicode.GetString(buf, 0, Math.Max(0, needed - 2)).TrimEnd('\0');
  }

  static int InputSize = Marshal.SizeOf(typeof(Native.INPUT));
  static void Mouse(uint flags, int data) {
    var i = new Native.INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = unchecked((uint)data);
    Native.SendInput(1, new[] { i }, InputSize);
  }
  static void Key(ushort vk, bool up, bool ext) {
    var i = new Native.INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.dwFlags = (up ? 2u : 0u) | (ext ? 1u : 0u);
    Native.SendInput(1, new[] { i }, InputSize);
  }
  static void Text(string s) {
    foreach (char c in s) {
      var d = new Native.INPUT(); d.type = 1; d.u.ki.wScan = c; d.u.ki.dwFlags = 4;
      var u = new Native.INPUT(); u.type = 1; u.u.ki.wScan = c; u.u.ki.dwFlags = 6;
      Native.SendInput(2, new[] { d, u }, InputSize);
    }
  }
  // the program a click landed in
  static string Under() {
    Native.POINT pt; Native.GetCursorPos(out pt);
    IntPtr w = Native.WindowFromPoint(pt);
    if (w == IntPtr.Zero) return deskName == "Default" ? "" : deskName;
    uint pid; Native.GetWindowThreadProcessId(w, out pid);
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }

  // pictures are taken on a thread of their own, put on the screen that takes input now (drawing
  // can leave windows behind on a thread, and a thread with windows can't change screens)
  static string ShotOnDesk(int width, long quality) {
    string result = ""; IntPtr d = desk;
    var t = new Thread(() => { try { if (d != IntPtr.Zero) Native.SetThreadDesktop(d); result = Shot(width, quality); } catch { } });
    t.Start(); t.Join(5000);
    return result;
  }
  // a picture of the main screen as it is now (also a prompt or the lock screen), as JPEG
  static string Shot(int width, long quality) {
    int sw = Native.GetSystemMetrics(0), sh = Native.GetSystemMetrics(1);
    if (sw <= 0 || sh <= 0) return "";
    width = Math.Max(160, Math.Min(sw, width));
    int height = (int)Math.Round((double)sh * width / sw);
    using (var full = new Bitmap(sw, sh, PixelFormat.Format24bppRgb)) {
      using (var g = Graphics.FromImage(full)) g.CopyFromScreen(0, 0, 0, 0, new System.Drawing.Size(sw, sh), CopyPixelOperation.SourceCopy);
      using (var small = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
        using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(full, 0, 0, width, height); }
        ImageCodecInfo jpeg = null;
        foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
        var ps = new EncoderParameters(1);
        ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, Math.Max(20L, Math.Min(95L, quality)));
        using (var ms = new MemoryStream()) { small.Save(ms, jpeg, ps); return Convert.ToBase64String(ms.ToArray()); }
      }
    }
  }
}

static class Native {
  public const uint TOKEN_ALL_ACCESS = 0xF01FF;
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int impersonation, int type, out IntPtr newToken);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool SetTokenInformation(IntPtr token, int cls, ref uint info, int length);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcessAsUser(IntPtr token, string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("sas.dll")] public static extern void SendSAS(bool asUser);

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr desk);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desk);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetUserObjectInformation(IntPtr obj, int index, byte[] info, int length, out int needed);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
}
