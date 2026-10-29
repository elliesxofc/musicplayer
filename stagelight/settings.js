'use strict';

const S = window.stagelight;
const $ = s => document.querySelector(s);

function addrRow(a) {
  const row = document.createElement('div');
  row.className = 'addr';
  const code = document.createElement('code');
  code.textContent = a.url;
  const kind = document.createElement('small');
  kind.textContent = a.kind === 'tailscale' ? 'tailscale' : a.kind === 'web' ? 'anywhere' : 'same Wi-Fi';
  const copy = document.createElement('button');
  copy.className = 'btn';
  copy.textContent = 'copy';
  copy.onclick = () => navigator.clipboard.writeText(a.url).then(() => { copy.textContent = 'copied ✓'; setTimeout(() => { copy.textContent = 'copy'; }, 1500); });
  row.append(code, kind, copy);
  return row;
}

function showStatus(s) {
  $('#obsStatus').textContent = s.obs;
  $('#obsDot').dataset.kind = s.connected ? 'on' : 'wait';
  const home = s.addresses.filter(a => a.kind === 'home'), ts = s.addresses.filter(a => a.kind === 'tailscale');
  $('#homeAddrs').replaceChildren(...home.map(addrRow));
  $('#noHome').hidden = home.length > 0;
  $('#tsAddrs').replaceChildren(...ts.map(addrRow));
  $('#sessions').textContent = s.sessions ? `${s.sessions} device${s.sessions === 1 ? ' is' : 's are'} logged in to the panel.` : 'nobody is logged in to the panel right now.';
  $('#openHere').dataset.url = `http://localhost:${s.port || $('#port').value}`;
  const w = s.web || {};
  if (document.activeElement !== $('#webHost')) { $('#webOn').checked = w.on; if (w.host) $('#webHost').value = w.host; }
  $('#webSeen').textContent = !w.on ? '' : w.lastVisit
    ? `working ✓ last visit through https://${w.host}: ${new Date(w.lastVisit).toLocaleTimeString()}`
    : `waiting for the first visit through https://${w.host || '…'} (open it on your phone to check)`;
  if (w.on && w.host) {
    const row = addrRow({ url: `https://${w.host}`, kind: 'web' });
    $('#tsAddrs').append(row);
  }
  const r = s.remote || {};
  $('#remoteStatus').hidden = !r.active;
  if (r.active) $('#remoteWho').textContent = `${r.from} is ${r.control ? 'controlling' : 'watching'} this PC right now`;
}
function showRemote(r) {
  $('#remoteView').checked = r.view;
  $('#remoteControl').checked = r.control;
  $('#remoteControl').disabled = !r.view;
  $('#remoteWarn').hidden = !r.control;
  $('#remoteMax').value = String(r.max || 0);
}
async function saveRemote() {
  showRemote(await S.setRemote({ view: $('#remoteView').checked, control: $('#remoteControl').checked }));
}
$('#remoteView').onchange = saveRemote;
$('#remoteMax').onchange = async () => showRemote(await S.setRemoteMax($('#remoteMax').value));
$('#remoteControl').onchange = async () => {
  if ($('#remoteControl').checked && !confirm('allow mouse and keyboard?\n\nevery full access account can then use this whole PC (not just OBS). only do this if you trust them with your PC.')) {
    $('#remoteControl').checked = false;
    return;
  }
  saveRemote();
};
async function saveWeb() {
  const r = await S.setWeb({ on: $('#webOn').checked, host: $('#webHost').value });
  $('#webSaved').classList.toggle('bad', !r.ok);
  $('#webSaved').textContent = r.ok ? ($('#webOn').checked ? 'saved ✓ the web address is on' : 'saved ✓ the web address is off') : r.error;
  if (!r.ok) $('#webOn').checked = false;
  if (r.status) showStatus(r.status);
}
$('#webOn').onchange = saveWeb;
$('#webSave').onclick = saveWeb;
$('#remoteStop').onclick = async () => showStatus(await S.stopRemote());

(async () => {
  const c = await S.get();
  $('#obsHost').value = c.obs.host;
  $('#obsPort').value = c.obs.port;
  if (c.obs.hasPassword) $('#obsPass').placeholder = 'saved ✓ (type a new one to replace it)';
  showAccounts(c.accounts);
  $('#port').value = c.port;
  $('#autostart').checked = c.autostart;
  $('#log').textContent = c.log.join('\n');
  showRemote(c.remote);
  $('#remoteNoInput').hidden = c.remote.controlWorks;
  showStatus(c.status);
})();

S.onStatus(showStatus);
S.onLog(line => { const el = $('#log'); el.textContent += (el.textContent ? '\n' : '') + line; el.scrollTop = el.scrollHeight; });

$('#obsSave').onclick = async () => {
  const next = { host: $('#obsHost').value, port: $('#obsPort').value };
  if ($('#obsPass').value) next.password = $('#obsPass').value;
  showStatus(await S.setObs(next));
  if ($('#obsPass').value) { $('#obsPass').value = ''; $('#obsPass').placeholder = 'saved ✓ (type a new one to replace it)'; }
};
// accounts: who can open the panel, and what they can do
const ROLE_NAMES = { full: 'full access', control: 'stream control', watch: 'watch only' };
function showAccounts(list) {
  const ul = $('#accountList');
  ul.replaceChildren(...list.map(a => {
    const li = document.createElement('li');
    const name = document.createElement('b');
    name.textContent = a.name;
    const role = document.createElement('small');
    role.textContent = ROLE_NAMES[a.role] || a.role;
    role.className = a.role;
    const edit = document.createElement('button');
    edit.className = 'btn'; edit.textContent = 'change';
    edit.onclick = () => {
      $('#accName').value = a.name; $('#accRole').value = a.role; $('#accPass').value = '';
      $('#accPassLabel').textContent = `new password for ${a.name} (leave empty to keep it)`;
      $('#accSave').textContent = 'save the changes';
      $('#accPass').focus();
    };
    const del = document.createElement('button');
    del.className = 'btn'; del.textContent = 'remove';
    del.onclick = async () => {
      if (!confirm(`remove the account "${a.name}"? they're logged out right away.`)) return;
      showAccounts(await S.removeAccount(a.name));
    };
    li.append(name, role, edit, del);
    return li;
  }));
  if (!list.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'no accounts yet: the panel stays locked until you add one.'; ul.append(li); }
}
const resetAccountForm = () => {
  $('#accName').value = ''; $('#accPass').value = ''; $('#accRole').value = 'control';
  $('#accPassLabel').textContent = 'password'; $('#accSave').textContent = 'add the account';
};
$('#accName').oninput = () => { $('#accPassLabel').textContent = 'password'; $('#accSave').textContent = 'add the account (or change it, if it exists)'; };
$('#accSave').onclick = async () => {
  if ($('#accRole').value === 'full' && !confirm(`give "${$('#accName').value.trim()}" full access?\n\nwith the remote display switched on, full access can use this whole PC.`)) return;
  const r = await S.saveAccount({ name: $('#accName').value, password: $('#accPass').value, role: $('#accRole').value });
  $('#accSaved').classList.toggle('bad', !r.ok);
  $('#accSaved').textContent = r.ok ? `saved ✓ ${$('#accName').value.trim()} can log in` : r.error;
  if (r.ok) { showAccounts(r.accounts); resetAccountForm(); }
};
$('#portSave').onclick = async () => {
  const r = await S.setPort($('#port').value);
  if (r.status) showStatus(r.status);
  if (!r.ok) alert(r.error || "that port didn't work (another program may use it). see \"what happened\" below.");
};
$('#autostart').onchange = async () => { $('#autostart').checked = await S.autostart($('#autostart').checked); };
$('#openHere').onclick = () => S.open($('#openHere').dataset.url);
$('#logoutAll').onclick = async () => showStatus(await S.logoutAll());
