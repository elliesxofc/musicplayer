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

module.exports = { isAdmin, restartElevated, makeTask, hasTask, runTask, removeTask };
