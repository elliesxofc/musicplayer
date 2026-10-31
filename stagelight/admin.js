'use strict';

/* Running as administrator (Windows only). Windows won't let a program click or type into one
   that runs as administrator (Task Manager, often OBS), and while such a window is in front it
   blocks every click and key: the remote display would be stuck. Stagelight can restart itself as
   administrator (Windows asks first), or always start that way: a task in Windows' Task Scheduler
   with "highest privileges" starts it without asking each time, also when Windows starts. */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TASK = 'Stagelight (administrator)';
const win = process.platform === 'win32';

const run = (cmd, args) => new Promise(resolve => {
  execFile(cmd, args, { windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') }));
});
// PowerShell's single quotes: ' becomes ''
const ps = s => `'${String(s).replace(/'/g, "''")}'`;

let adminCache = null;
// "net session" only works for an administrator
async function isAdmin() {
  if (!win) return false;
  if (adminCache === null) adminCache = (await run('net', ['session'])).ok;
  return adminCache;
}

// the program and what it needs to start (a packaged app is just its .exe)
function launch(app) {
  return { exe: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] };
}

// starts a copy as administrator (Windows asks "do you want to allow…"): true when it was allowed
async function restartElevated(app, extra = []) {
  if (!win) return false;
  const { exe, args } = launch(app);
  const all = [...args, ...extra].map(a => `"${a}"`).join(' ');
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Start-Process -FilePath ${ps(exe)}${all ? ` -ArgumentList ${ps(all)}` : ''} -Verb RunAs`]);
  return r.ok;
}

const xmlEscape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/* The task: runs as this user, with highest privileges, never stopped after a time limit or on
   battery (Windows' defaults for a task would stop it after 3 days). With startup on, it also
   starts when this user signs in. */
async function makeTask(app, atLogon) {
  if (!win) return { ok: false, error: 'Windows only' };
  const { exe, args } = launch(app);
  const user = `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME || os.userInfo().username}`;
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts Stagelight as administrator, so its remote display can click into programs that run as administrator.</Description></RegistrationInfo>
  <Triggers>${atLogon ? `<LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(user)}</UserId></LogonTrigger>` : ''}</Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEscape(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <AllowStartOnDemand>true</AllowStartOnDemand>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xmlEscape(exe)}</Command><Arguments>${xmlEscape([...args.map(a => `"${a}"`), '--task'].join(' '))}</Arguments></Exec></Actions>
</Task>`;
  const file = path.join(os.tmpdir(), `stagelight-task-${process.pid}.xml`);
  try {
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
    const r = await run('schtasks', ['/Create', '/F', '/TN', TASK, '/XML', file]);
    return r.ok ? { ok: true } : { ok: false, error: r.out.trim().slice(0, 200) || "Windows didn't make the task" };
  } finally { fs.rm(file, { force: true }, () => {}); }
}
const hasTask = async () => win && (await run('schtasks', ['/Query', '/TN', TASK])).ok;
const runTask = async () => win && (await run('schtasks', ['/Run', '/TN', TASK])).ok;
const removeTask = async () => win && (await run('schtasks', ['/Delete', '/F', '/TN', TASK])).ok;

/* ───────────── the service (service/StagelightService.cs), like AnyDesk's ─────────────
   Its program is copied to Program Files (which only administrators can change: a service runs as
   SYSTEM, so its program must not sit where anyone could swap it), registered to start with
   Windows, and allowed to press ctrl + alt + del. Installing and removing it needs Stagelight to
   run as administrator. */
const SERVICE = 'StagelightService';
const serviceDir = () => path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Stagelight Service');
const serviceExe = () => path.join(serviceDir(), 'stagelight-service.exe');
// the one that comes with this version of Stagelight
const bundledExe = app => (app.isPackaged ? path.join(process.resourcesPath, 'stagelight-service.exe') : path.join(__dirname, 'service', 'bin', 'stagelight-service.exe'));

// 'missing' | 'stopped' | 'running' | 'other'
async function serviceState() {
  if (!win) return 'missing';
  const r = await run('sc', ['query', SERVICE]);
  if (!r.ok) return 'missing';
  return /RUNNING/.test(r.out) ? 'running' : /STOPPED/.test(r.out) ? 'stopped' : 'other';
}
const sameFile = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } };

async function installService(app) {
  if (!win) return { ok: false, error: 'Windows only' };
  const from = bundledExe(app);
  if (!fs.existsSync(from)) return { ok: false, error: "this copy of Stagelight doesn't include the service" };
  const state = await serviceState();
  if (state !== 'missing') { await run('sc', ['stop', SERVICE]); await new Promise(r => setTimeout(r, 1500)); }
  try {
    fs.mkdirSync(serviceDir(), { recursive: true });
    fs.copyFileSync(from, serviceExe());
  } catch (err) { return { ok: false, error: `couldn't copy it to Program Files (${err.code || err.message})` }; }
  const bin = `"${serviceExe()}"`;
  const made = state === 'missing'
    ? await run('sc', ['create', SERVICE, 'binPath=', bin, 'start=', 'auto', 'obj=', 'LocalSystem', 'DisplayName=', 'Stagelight remote display'])
    : await run('sc', ['config', SERVICE, 'binPath=', bin, 'start=', 'auto']);
  if (!made.ok) return { ok: false, error: made.out.trim().slice(0, 200) || "Windows didn't register the service" };
  await run('sc', ['description', SERVICE, "Lets Stagelight's remote display use the mouse and keyboard everywhere (also programs run as administrator, Windows prompts and the lock screen), like AnyDesk."]);
  await run('sc', ['failure', SERVICE, 'reset=', '86400', 'actions=', 'restart/5000/restart/5000/restart/30000']);
  // lets a service press ctrl + alt + del (Windows' "software secure attention sequence" policy)
  await run('reg', ['add', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', '/v', 'SoftwareSASGeneration', '/t', 'REG_DWORD', '/d', '1', '/f']);
  const started = await run('sc', ['start', SERVICE]);
  if (!started.ok && !/already/i.test(started.out)) return { ok: false, error: `registered, but it didn't start: ${started.out.trim().slice(0, 160)}` };
  return { ok: true };
}

async function removeService() {
  if (!win) return { ok: false, error: 'Windows only' };
  await run('sc', ['stop', SERVICE]);
  await new Promise(r => setTimeout(r, 1500));
  const r = await run('sc', ['delete', SERVICE]);
  try { fs.rmSync(serviceDir(), { recursive: true, force: true }); } catch { /* still in use: goes after a restart */ }
  return r.ok || /does not exist/i.test(r.out) ? { ok: true } : { ok: false, error: r.out.trim().slice(0, 200) };
}

// a newer Stagelight brings a newer service: swapped in (while running as administrator)
async function updateService(app) {
  if (!win || (await serviceState()) === 'missing') return false;
  const from = bundledExe(app);
  if (!fs.existsSync(from) || sameFile(from, serviceExe())) return false;
  return (await installService(app)).ok;
}

module.exports = { isAdmin, restartElevated, makeTask, hasTask, runTask, removeTask, serviceState, installService, removeService, updateService };
