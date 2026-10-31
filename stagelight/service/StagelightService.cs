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
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class Program {
  static void Main(string[] args) {
    if (args.Length > 0 && args[0] == "helper") { Helper.Run(); return; }
    // only for testing the sign-in page away from Windows: a stand-in screen, no Windows calls
    if (args.Length > 0 && args[0] == "signin-test") {
      var t = new SignIn(Arg(args, "--config"), new FakeScreen(Arg(args, "--shot"), Arg(args, "--log")), false, Arg(args, "--html"));
      t.Start();
      Console.WriteLine("listening");
      Thread.Sleep(Timeout.Infinite);
      return;
    }
    ServiceBase.Run(new StagelightService());
  }
  public static string Arg(string[] args, string name) {
    for (int i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1];
    return null;
  }
}

class StagelightService : ServiceBase {
  public const string PipeName = "stagelight-service";
  volatile bool stopping;
  Thread listener;
  NamedPipeServerStream current;

  public StagelightService() { ServiceName = "StagelightService"; CanStop = true; }

  SignIn signIn;
  protected override void OnStart(string[] args) {
    // below normal priority, like the rest of Stagelight: OBS comes first
    try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal; } catch { }
    listener = new Thread(Listen); listener.IsBackground = true; listener.Start();
    // before anyone signs in to Windows (Stagelight itself isn't running then), the service shows
    // a small sign-in page on Stagelight's address; it steps aside once someone is signed in
    string[] cmd = Environment.GetCommandLineArgs();
    string config = Program.Arg(cmd, "--config");
    if (config != null) {
      signIn = new SignIn(config, new HelperScreen(), true, null);
      // and while someone is signed in: Stagelight closed or crashed by accident comes back
      var keep = new KeepRunning(config, Program.Arg(cmd, "--app"));
      var watch = new Thread(() => {
        while (!stopping) {
          try { signIn.Tick(); } catch { }
          try { keep.Tick(); } catch { }
          Thread.Sleep(2000);
        }
      });
      watch.IsBackground = true; watch.Start();
    }
  }
  protected override void OnStop() {
    stopping = true;
    try { if (current != null) current.Dispose(); } catch { }
    try { if (signIn != null) signIn.Stop(); } catch { }
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
          case "m": { // a place as 0…1 across the main screen (the sign-in page)
            double fx = double.Parse(p[1], System.Globalization.CultureInfo.InvariantCulture), fy = double.Parse(p[2], System.Globalization.CultureInfo.InvariantCulture);
            int sw = Native.GetSystemMetrics(0), sh = Native.GetSystemMetrics(1);
            Native.SetCursorPos((int)Math.Round(Math.Max(0, Math.Min(1, fx)) * (sw - 1)), (int)Math.Round(Math.Max(0, Math.Min(1, fy)) * (sh - 1)));
            break;
          }
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
  [DllImport("kernel32.dll")] public static extern ulong GetTickCount64();
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
  [DllImport("wtsapi32.dll")] public static extern bool WTSQuerySessionInformation(IntPtr server, uint session, int info, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQueryUserToken(uint session, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int cls, out IntPtr info, int length, out int returned);
  [DllImport("userenv.dll", SetLastError = true)] public static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
  [DllImport("userenv.dll")] public static extern bool DestroyEnvironmentBlock(IntPtr env);

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

/* ───────────── before anyone signs in ─────────────
   With nobody signed in to Windows (after a restart, or signed out) Stagelight isn't running, so
   the service answers on Stagelight's address with a small page: log in with a full access account
   (the same accounts and passwords, read from Stagelight's settings file), see the sign-in screen
   and use mouse and keyboard to sign in. Once someone is signed in it stops, and Stagelight's own
   panel takes the address back. Only when the remote display with mouse and keyboard is on. */
interface IScreen { string Shot(int width); void Send(string line); void Stop(); }

// the real one: the helper in the session at the screen (the sign-in screen)
class HelperScreen : IScreen {
  HelperProcess helper; string lastShot; readonly AutoResetEvent got = new AutoResetEvent(false); readonly object gate = new object();
  void Ensure() {
    uint session = Native.WTSGetActiveConsoleSessionId();
    if (helper != null && !helper.Exited && helper.Session == session) return;
    if (helper != null) helper.Kill();
    helper = HelperProcess.Start(session, line => { if (line.StartsWith("shot ")) { lastShot = line.Substring(5); got.Set(); } });
  }
  public string Shot(int width) {
    lock (gate) {
      Ensure(); if (helper == null) return null;
      got.Reset(); lastShot = null;
      helper.Send("D"); helper.Send("S " + width + " 60");
      return got.WaitOne(4000) ? lastShot : null;
    }
  }
  public void Send(string line) { lock (gate) { Ensure(); if (helper != null) helper.Send(line); } }
  public void Stop() { lock (gate) { if (helper != null) helper.Kill(); helper = null; } }
}
// for testing away from Windows: a fixed picture, and the commands written to a file
class FakeScreen : IScreen {
  readonly string shot, log;
  public FakeScreen(string shotFile, string logFile) { shot = File.ReadAllText(shotFile).Trim(); log = logFile; }
  public string Shot(int width) { return shot; }
  public void Send(string line) { File.AppendAllText(log, line + "\n"); }
  public void Stop() { }
}

class SignIn {
  readonly string configPath, htmlPath; readonly IScreen screen; readonly bool onWindows;
  HttpListener http; int port;
  readonly Dictionary<string, DateTime> sessions = new Dictionary<string, DateTime>();
  readonly Dictionary<string, Fail> fails = new Dictionary<string, Fail>();
  class Fail { public int Count; public DateTime Until; public int LockSeconds = 60; }
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

  public SignIn(string config, IScreen screen, bool onWindows, string html) {
    configPath = config; this.screen = screen; this.onWindows = onWindows;
    htmlPath = html ?? Path.Combine(Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName), "signin.html");
  }

  // nobody signed in at the screen: no user name on the console session
  public static bool NobodySignedIn() {
    uint session = Native.WTSGetActiveConsoleSessionId();
    if (session == 0xFFFFFFFF) return true;
    IntPtr buf; int bytes;
    if (!Native.WTSQuerySessionInformation(IntPtr.Zero, session, 5 /* WTSUserName */, out buf, out bytes)) return false;
    try { return string.IsNullOrEmpty(Marshal.PtrToStringUni(buf)); } finally { Native.WTSFreeMemory(buf); }
  }
  public void Tick() {
    bool want = NobodySignedIn();
    if (want && http == null) Start();
    else if (!want && http != null) Stop();
  }

  Dictionary<string, object> Config() {
    try { return Json.DeserializeObject(File.ReadAllText(configPath)) as Dictionary<string, object>; } catch { return null; }
  }
  static object Get(Dictionary<string, object> d, string key) { object v; return d != null && d.TryGetValue(key, out v) ? v : null; }

  public void Start() {
    var c = Config();
    port = 4850;
    try { object p = Get(c, "port"); if (p != null) port = Convert.ToInt32(p); } catch { }
    var h = new HttpListener();
    h.Prefixes.Add("http://+:" + port + "/");
    try { h.Start(); } catch { try { h.Close(); } catch { } return; } // the address is taken: try again later
    http = h;
    var t = new Thread(() => {
      while (true) {
        HttpListenerContext ctx;
        try { ctx = h.GetContext(); } catch { break; }
        ThreadPool.QueueUserWorkItem(_ => { try { Handle(ctx); } catch { try { ctx.Response.Abort(); } catch { } } });
      }
    });
    t.IsBackground = true; t.Start();
  }
  public void Stop() {
    var h = http; http = null;
    if (h != null) { try { h.Stop(); h.Close(); } catch { } }
    lock (sessions) sessions.Clear();
    screen.Stop();
  }

  void Send(HttpListenerContext ctx, int code, string type, byte[] body, string cookie) {
    var r = ctx.Response;
    r.StatusCode = code; r.ContentType = type;
    r.Headers["Cache-Control"] = "no-store";
    r.Headers["X-Content-Type-Options"] = "nosniff";
    r.Headers["X-Frame-Options"] = "DENY";
    r.Headers["Referrer-Policy"] = "no-referrer";
    r.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    if (cookie != null) r.Headers["Set-Cookie"] = cookie;
    r.ContentLength64 = body.Length;
    r.OutputStream.Write(body, 0, body.Length);
    r.Close();
  }
  void SendJson(HttpListenerContext ctx, int code, object o) { Send(ctx, code, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(Json.Serialize(o)), null); }
  static Dictionary<string, object> Obj(params object[] kv) { var d = new Dictionary<string, object>(); for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1]; return d; }

  // through Cloudflare: from this PC, with Cloudflare's headers (the visitor's own address is in one)
  static bool ViaWeb(HttpListenerRequest q) { return IPAddress.IsLoopback(q.RemoteEndPoint.Address) && (q.Headers["CF-Ray"] != null || q.Headers["CF-Connecting-IP"] != null); }
  static string IpOf(HttpListenerRequest q) {
    if (ViaWeb(q)) { string ip = (q.Headers["CF-Connecting-IP"] ?? "").Trim(); if (ip.Length > 2 && ip.Length < 46) return ip; }
    return q.RemoteEndPoint.Address.ToString();
  }
  bool LoggedIn(HttpListenerRequest q) {
    var c = q.Cookies["slsignin"];
    if (c == null) return false;
    lock (sessions) {
      DateTime until;
      if (!sessions.TryGetValue(c.Value, out until)) return false;
      if (DateTime.UtcNow > until) { sessions.Remove(c.Value); return false; }
      return true;
    }
  }
  static string ReadBody(HttpListenerRequest q, int max) {
    if (q.ContentLength64 > max) return null;
    using (var r = new StreamReader(q.InputStream, Encoding.UTF8)) { var buf = new char[max + 1]; int n = r.ReadBlock(buf, 0, buf.Length); return n > max ? null : new string(buf, 0, n); }
  }

  void Handle(HttpListenerContext ctx) {
    var q = ctx.Request; string path = q.Url.AbsolutePath;
    if (q.HttpMethod == "GET" && (path == "/" || path == "/index.html")) {
      Send(ctx, 200, "text/html; charset=utf-8", File.ReadAllBytes(htmlPath), null); return;
    }
    if (q.HttpMethod == "GET" && path == "/api/signin") { SendJson(ctx, 200, Obj("signin", true)); return; }
    // changes only with Stagelight's own header (other websites can't send it)
    if (q.HttpMethod == "POST" && q.Headers["X-Stagelight"] != "1") { SendJson(ctx, 403, Obj("error", "bad request")); return; }
    if (q.HttpMethod == "POST" && path == "/api/login") { Login(ctx); return; }
    if (!LoggedIn(q)) { SendJson(ctx, 401, Obj("error", "log in first")); return; }
    if (q.HttpMethod == "GET" && path == "/api/shot") {
      int w = 1280; int.TryParse(q.QueryString["w"] ?? "", out w); w = Math.Max(320, Math.Min(1920, w == 0 ? 1280 : w));
      string b64 = screen.Shot(w);
      if (string.IsNullOrEmpty(b64)) { SendJson(ctx, 503, Obj("error", "no picture of the screen right now")); return; }
      Send(ctx, 200, "image/jpeg", Convert.FromBase64String(b64), null); return;
    }
    if (q.HttpMethod == "POST" && path == "/api/input") {
      string body = ReadBody(q, 20000);
      var d = body == null ? null : Json.DeserializeObject(body) as Dictionary<string, object>;
      var events = Get(d, "events") as object[];
      if (events == null) { SendJson(ctx, 400, Obj("error", "bad request")); return; }
      int n = 0;
      foreach (var e in events) {
        string line = e as string;
        if (line == null || n++ > 300 || !Allowed.IsMatch(line)) continue;
        if (line == "sas") { if (onWindows) Native.SendSAS(false); else screen.Send("sas"); }
        else screen.Send(line);
      }
      SendJson(ctx, 200, Obj("ok", true)); return;
    }
    if (q.HttpMethod == "POST" && path == "/api/logout") {
      var c = q.Cookies["slsignin"]; if (c != null) lock (sessions) sessions.Remove(c.Value);
      Send(ctx, 200, "application/json", Encoding.UTF8.GetBytes("{\"ok\":true}"), "slsignin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"); return;
    }
    SendJson(ctx, 404, Obj("error", "not found"));
  }
  static readonly System.Text.RegularExpressions.Regex Allowed = new System.Text.RegularExpressions.Regex(
    @"^(m [01](\.\d{1,6})? [01](\.\d{1,6})?|B (2|4|8|16)( \?)?|K \d{1,3} [01] [01]|T [A-Za-z0-9+/=]{1,4000}|W -?\d{1,5}|sas)$");

  void Login(HttpListenerContext ctx) {
    var q = ctx.Request; string ip = IpOf(q);
    Fail f;
    lock (fails) {
      if (fails.TryGetValue(ip, out f) && DateTime.UtcNow < f.Until) {
        SendJson(ctx, 429, Obj("error", "too many wrong passwords: wait " + (int)Math.Ceiling((f.Until - DateTime.UtcNow).TotalSeconds) + " s")); return;
      }
    }
    string body = ReadBody(q, 4000);
    var d = body == null ? null : Json.DeserializeObject(body) as Dictionary<string, object>;
    string user = (Get(d, "username") as string ?? "").Trim(), pass = Get(d, "password") as string ?? "";
    var c = Config();
    var remote = Get(c, "remote") as Dictionary<string, object>;
    bool control = remote != null && true.Equals(Get(remote, "view")) && true.Equals(Get(remote, "control"));
    Dictionary<string, object> account = null;
    var list = Get(c, "accounts") as object[];
    if (list != null) foreach (var o in list) { var a = o as Dictionary<string, object>; if (a != null && string.Equals(Get(a, "name") as string, user, StringComparison.OrdinalIgnoreCase)) account = a; }
    // a wrong username takes as long as a wrong password
    bool ok = Check(pass, account != null ? Get(account, "salt") as string : "AAAAAAAAAAAAAAAAAAAAAA==", account != null ? Get(account, "hash") as string : "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=") && account != null;
    if (!ok) {
      lock (fails) {
        if (!fails.TryGetValue(ip, out f)) { f = new Fail(); fails[ip] = f; }
        if (++f.Count >= 5) { f.Until = DateTime.UtcNow.AddSeconds(f.LockSeconds); f.LockSeconds = Math.Min(3600, f.LockSeconds * 2); f.Count = 0; }
      }
      SendJson(ctx, 401, Obj("error", "wrong username or password")); return;
    }
    lock (fails) fails.Remove(ip);
    if ((Get(account, "role") as string) != "full") { SendJson(ctx, 403, Obj("error", "only full access accounts can sign in to Windows from here")); return; }
    if (!control) { SendJson(ctx, 403, Obj("error", "the remote display with mouse and keyboard is off in Stagelight's settings")); return; }
    var bytes = new byte[32]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
    string token = Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=');
    lock (sessions) sessions[token] = DateTime.UtcNow.AddHours(1);
    Send(ctx, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes("{\"ok\":true}"),
      "slsignin=" + token + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600" + (ViaWeb(q) ? "; Secure" : ""));
  }

  // the password against Stagelight's scrypt hash (N 16384, r 8, p 1), in the same time either way
  static bool Check(string password, string salt, string hash) {
    try {
      byte[] want = Convert.FromBase64String(hash ?? ""), s = Convert.FromBase64String(salt ?? "");
      byte[] got = Scrypt.Derive(Encoding.UTF8.GetBytes(password), s, 16384, 8, 1, want.Length == 0 ? 32 : want.Length);
      int diff = want.Length ^ got.Length;
      for (int i = 0; i < Math.Min(want.Length, got.Length); i++) diff |= want[i] ^ got[i];
      return diff == 0 && want.Length > 0;
    } catch { return false; }
  }
}

// scrypt (RFC 7914), the way Stagelight's passwords are kept
static class Scrypt {
  public static byte[] Derive(byte[] password, byte[] salt, int N, int r, int p, int dkLen) {
    byte[] B = Pbkdf2(password, salt, 1, p * 128 * r);
    var X = new uint[32 * r]; var V = new uint[32 * r * N]; var Y = new uint[32 * r];
    for (int i = 0; i < p; i++) {
      for (int k = 0; k < 32 * r; k++) X[k] = BitConverter.ToUInt32(B, i * 128 * r + k * 4);
      for (int j = 0; j < N; j++) { Array.Copy(X, 0, V, j * 32 * r, 32 * r); BlockMix(X, Y, r); }
      for (int j = 0; j < N; j++) {
        int idx = (int)(X[(2 * r - 1) * 16] & (uint)(N - 1));
        for (int k = 0; k < 32 * r; k++) X[k] ^= V[idx * 32 * r + k];
        BlockMix(X, Y, r);
      }
      for (int k = 0; k < 32 * r; k++) { byte[] b = BitConverter.GetBytes(X[k]); Array.Copy(b, 0, B, i * 128 * r + k * 4, 4); }
    }
    return Pbkdf2(password, B, 1, dkLen);
  }
  static void BlockMix(uint[] B, uint[] Y, int r) {
    var X = new uint[16]; Array.Copy(B, (2 * r - 1) * 16, X, 0, 16);
    for (int i = 0; i < 2 * r; i++) {
      for (int k = 0; k < 16; k++) X[k] ^= B[i * 16 + k];
      Salsa8(X);
      Array.Copy(X, 0, Y, i * 16, 16);
    }
    for (int i = 0; i < r; i++) Array.Copy(Y, (2 * i) * 16, B, i * 16, 16);
    for (int i = 0; i < r; i++) Array.Copy(Y, (2 * i + 1) * 16, B, (r + i) * 16, 16);
  }
  static uint R(uint a, int b) { return (a << b) | (a >> (32 - b)); }
  static void Salsa8(uint[] B) {
    var x = (uint[])B.Clone();
    for (int i = 0; i < 8; i += 2) {
      x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
      x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
      x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
      x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
      x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
      x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
      x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
      x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
    }
    for (int i = 0; i < 16; i++) B[i] += x[i];
  }
  // PBKDF2 with HMAC-SHA256 (the one in .NET 4 only does SHA-1)
  static byte[] Pbkdf2(byte[] password, byte[] salt, int iterations, int length) {
    using (var hmac = new HMACSHA256(password)) {
      var result = new byte[length]; int blocks = (length + 31) / 32;
      for (int i = 1; i <= blocks; i++) {
        var input = new byte[salt.Length + 4]; Array.Copy(salt, input, salt.Length);
        input[salt.Length] = (byte)(i >> 24); input[salt.Length + 1] = (byte)(i >> 16); input[salt.Length + 2] = (byte)(i >> 8); input[salt.Length + 3] = (byte)i;
        byte[] u = hmac.ComputeHash(input), t = (byte[])u.Clone();
        for (int j = 1; j < iterations; j++) { u = hmac.ComputeHash(u); for (int k = 0; k < t.Length; k++) t[k] ^= u[k]; }
        Array.Copy(t, 0, result, (i - 1) * 32, Math.Min(32, length - (i - 1) * 32));
      }
      return result;
    }
  }
}

/* ───────────── keeping Stagelight running ─────────────
   While someone is signed in, Stagelight closed by accident or crashed is started again (in the
   tray, as that person; as administrator when "always run as administrator" is on). Not after
   quitting it on purpose from its tray icon (until Windows restarts), not while an installer is
   updating it, not when switched off in its settings, and not over and over if it keeps crashing. */
class KeepRunning {
  readonly string config, app;
  uint session = 0xFFFFFFFF; DateTime sessionSince, goneSince = DateTime.MinValue;
  readonly List<DateTime> starts = new List<DateTime>();
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  // when Windows started (GetTickCount64: the 32-bit count wraps after 25 days)
  static readonly DateTime Booted = DateTime.UtcNow.AddMilliseconds(-(double)Native.GetTickCount64());

  public KeepRunning(string config, string app) { this.config = config; this.app = app; }

  public void Tick() {
    if (string.IsNullOrEmpty(app) || !File.Exists(app) || SignIn.NobodySignedIn()) { goneSince = DateTime.MinValue; return; }
    Dictionary<string, object> c;
    try { c = Json.DeserializeObject(File.ReadAllText(config)) as Dictionary<string, object>; } catch { return; }
    if (c == null) return;
    object v;
    if (c.TryGetValue("keepRunning", out v) && false.Equals(v)) return;
    // quit on purpose (from the tray icon) since Windows started: left alone
    if (c.TryGetValue("quitOnPurpose", out v) && v != null) {
      try { if (new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(Convert.ToDouble(v)) > Booted) return; } catch { }
    }
    uint now = Native.WTSGetActiveConsoleSessionId();
    // just signed in: Stagelight starts with Windows by itself first
    if (now != session) { session = now; sessionSince = DateTime.UtcNow; goneSince = DateTime.MinValue; return; }
    if (DateTime.UtcNow - sessionSince < TimeSpan.FromSeconds(40)) return;
    if (Running(now)) { goneSince = DateTime.MinValue; return; }
    if (goneSince == DateTime.MinValue) { goneSince = DateTime.UtcNow; return; }
    if (DateTime.UtcNow - goneSince < TimeSpan.FromSeconds(8)) return;
    if (Updating()) return;
    // crashing again and again: stop trying (until the service or Windows restarts)
    starts.RemoveAll(t => DateTime.UtcNow - t > TimeSpan.FromMinutes(10));
    if (starts.Count >= 5) return;
    starts.Add(DateTime.UtcNow);
    bool admin = c.TryGetValue("admin", out v) && true.Equals(v);
    Start(now, admin);
    goneSince = DateTime.MinValue;
  }

  bool Running(uint s) {
    foreach (var p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(app))) { try { if ((uint)p.SessionId == s) return true; } catch { } }
    return false;
  }
  // an installer (or uninstaller) at work, or its files just changed: wait
  bool Updating() {
    try { if (DateTime.UtcNow - File.GetLastWriteTimeUtc(app) < TimeSpan.FromMinutes(1)) return true; } catch { return true; }
    foreach (var p in Process.GetProcesses()) {
      string n; try { n = p.ProcessName.ToLowerInvariant(); } catch { continue; }
      if (n.Contains("stagelight-setup") || n.Contains("stagelight setup") || n.StartsWith("un_") || n.Contains("uninstall stagelight")) return true;
    }
    return false;
  }

  // as the person signed in (their own settings and files), in the tray
  void Start(uint s, bool admin) {
    IntPtr user = IntPtr.Zero, linked = IntPtr.Zero, env = IntPtr.Zero;
    try {
      if (!Native.WTSQueryUserToken(s, out user)) return;
      IntPtr token = user;
      // "always run as administrator": the same person's administrator side
      if (admin) { int got; if (Native.GetTokenInformation(user, 19 /* TokenLinkedToken */, out linked, IntPtr.Size, out got) && linked != IntPtr.Zero) token = linked; }
      Native.CreateEnvironmentBlock(out env, user, false);
      var si = new Native.STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));
      si.lpDesktop = "winsta0\\default";
      Native.PROCESS_INFORMATION pi;
      if (Native.CreateProcessAsUser(token, app, "\"" + app + "\" --hidden --restarted", IntPtr.Zero, IntPtr.Zero, false, 0x00000400 /* unicode environment */, env, Path.GetDirectoryName(app), ref si, out pi)) {
        Native.CloseHandle(pi.hThread); Native.CloseHandle(pi.hProcess);
      }
    } finally {
      if (env != IntPtr.Zero) Native.DestroyEnvironmentBlock(env);
      if (linked != IntPtr.Zero) Native.CloseHandle(linked);
      if (user != IntPtr.Zero) Native.CloseHandle(user);
    }
  }
}
