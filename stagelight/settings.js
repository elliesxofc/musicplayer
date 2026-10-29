'use strict';

const S = window.stagelight;
const $ = s => document.querySelector(s);

function addrRow(a) {
  const row = document.createElement('div');
  row.className = 'addr';
  const code = document.createElement('code');
  code.textContent = a.url;
  const kind = document.createElement('small');
  kind.textContent = a.kind === 'tailscale' ? 'tailscale' : 'same Wi-Fi';
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
}

(async () => {
  const c = await S.get();
  $('#obsHost').value = c.obs.host;
  $('#obsPort').value = c.obs.port;
  if (c.obs.hasPassword) $('#obsPass').placeholder = 'saved ✓ (type a new one to replace it)';
  $('#panelPassLabel').textContent = c.hasPanelPassword ? 'panel password (saved ✓, type a new one to change it)' : 'panel password (not set yet: the panel stays locked until you set one)';
  $('#port').value = c.port;
  $('#autostart').checked = c.autostart;
  $('#log').textContent = c.log.join('\n');
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
$('#panelPassSave').onclick = async () => {
  const r = await S.setPanelPassword($('#panelPass').value);
  $('#panelPassSaved').classList.toggle('bad', !r.ok);
  $('#panelPassSaved').textContent = r.ok ? 'saved ✓ everyone logged in before has to log in again' : r.error;
  if (r.ok) { $('#panelPass').value = ''; $('#panelPassLabel').textContent = 'panel password (saved ✓, type a new one to change it)'; }
};
$('#portSave').onclick = async () => {
  const r = await S.setPort($('#port').value);
  if (r.status) showStatus(r.status);
  if (!r.ok) alert(r.error || "that port didn't work (another program may use it). see \"what happened\" below.");
};
$('#autostart').onchange = async () => { $('#autostart').checked = await S.autostart($('#autostart').checked); };
$('#openHere').onclick = () => S.open($('#openHere').dataset.url);
$('#logoutAll').onclick = async () => showStatus(await S.logoutAll());
