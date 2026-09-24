import { resolveConnection } from './connection.js';
import { chainLabel, proxyLabel } from './actions.js';

const $ = (sel) => document.querySelector(sel);

let state = { profile: null };

async function api(path, opts = {}) {
  return chrome.runtime.sendMessage({ type: 'api', path, ...opts });
}

function toast(message, kind = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, kind === 'err' ? 8000 : 3000);
}

/**
 * Accept a raw token OR the full /t/<token>/ URL that `cli.js link` prints.
 * A plain URL with no /t/ segment must NOT be mistaken for a token.
 */
function applyConnection({ bridgeUrl, token }) {
  $('#bridgeUrl').value = bridgeUrl;
  $('#token').value = token;
  $('#proxifier-url').value = `${bridgeUrl.replace(/\/$/, '')}/t/${token}/`;
}

/**
 * The connection as currently typed in the form, so Test works before saving.
 * The linked URL is accepted in either box — `cli.js link` prints a single URL
 * and pasting it into the wrong field should still work.
 */
function formConnection() {
  return resolveConnection($('#token').value, $('#bridgeUrl').value);
}

async function testConnection(connection = null) {
  if (connection && !connection.token) {
    $('#health').textContent = 'no token';
    $('#health').className = 'tag err';
    toast(
      'No token in these settings. Run `node bridge/cli.js link` in a terminal and paste the ' +
        'whole URL (it contains /t/<token>/) into the Token box.',
      'err',
    );
    return false;
  }
  const res = await api('/profiles', { connection });
  if (!res.ok) {
    $('#health').textContent = 'offline';
    $('#health').className = 'tag err';
    toast(res.error, 'err');
    return false;
  }
  $('#health').textContent = 'online';
  $('#health').className = 'tag ok';
  return true;
}

async function loadProfiles() {
  const res = await api('/profiles');
  if (!res.ok) return;
  const stored = await chrome.storage.local.get({ activeProfile: '' });
  const sel = $('#profiles');
  sel.innerHTML = '';
  for (const p of res.data.profiles) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = `${p.name}  (${p.bytes} B)`;
    sel.append(opt);
  }
  if (!res.data.profiles.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no profiles yet)';
    sel.append(opt);
  }
  state.profile = res.data.profiles.some((p) => p.name === stored.activeProfile)
    ? stored.activeProfile
    : res.data.profiles[0]?.name ?? null;
  sel.value = state.profile ?? '';
  // Keep the bridge's notion of "the profile Proxifier gets" in sync.
  if (state.profile) {
    await chrome.storage.local.set({ activeProfile: state.profile });
    await api('/active', { method: 'POST', body: { name: state.profile } });
  }
  await loadDetail();
}

async function loadDetail() {
  if (!state.profile) {
    $('#chains').innerHTML = '<li class="empty">No profile selected.</li>';
    $('#backups').innerHTML = '<li class="empty">No profile selected.</li>';
    $('#raw').value = '';
    return;
  }
  const [profile, backups] = await Promise.all([
    api(`/profiles/${encodeURIComponent(state.profile)}`),
    api(`/profiles/${encodeURIComponent(state.profile)}/backups`),
  ]);

  // A rule's <Action type="Proxy"> points at a proxy id or a chain id. Profiles
  // routinely have proxies with an empty <ChainList/>, so list both.
  const proxies = profile.ok ? profile.data.proxies ?? [] : [];
  const chains = profile.ok ? profile.data.chains ?? [] : [];

  $('#chain-count').textContent = `(${proxies.length} proxies, ${chains.length} chains)`;
  $('#chains').innerHTML = '';
  if (!proxies.length && !chains.length) {
    $('#chains').innerHTML =
      '<li class="empty">No proxies — add them in Proxifier (Profile → Proxy Servers…), then reload here.</li>';
  }
  for (const p of proxies) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="idx">${esc(p.id ?? '')}</span><div class="name">${esc(proxyLabel(p))}` +
      `<span class="targets">proxy id ${esc(p.id ?? '?')} — a rule's Action points at this id</span></div>`;
    $('#chains').append(li);
  }
  for (const c of chains) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="idx">${esc(c.id ?? '')}</span><div class="name">${esc(chainLabel(c))}` +
      `<span class="targets">chain · members: ${esc((c.members ?? []).join(', ') || 'none')}</span></div>`;
    $('#chains').append(li);
  }

  const list = backups.ok ? backups.data.backups : [];
  $('#backup-count').textContent = `(${list.length})`;
  $('#backups').innerHTML = '';
  if (!list.length) $('#backups').innerHTML = '<li class="empty">No snapshots yet.</li>';
  for (const b of list) {
    const li = document.createElement('li');
    const label = document.createElement('div');
    label.className = 'name';
    label.textContent = b.id;
    const btn = document.createElement('button');
    btn.textContent = 'Restore';
    btn.onclick = async () => {
      const res = await api(`/profiles/${encodeURIComponent(state.profile)}/backups`, {
        method: 'POST',
        body: { id: b.id },
      });
      toast(res.ok ? 'Restored' : res.error, res.ok ? 'ok' : 'err');
      await loadDetail();
    };
    li.append(label, btn);
    $('#backups').append(li);
  }
}

async function loadRaw() {
  if (!state.profile) return toast('Select a profile first', 'err');
  const res = await api(`/profiles/${encodeURIComponent(state.profile)}/raw`, { as: 'text' });
  if (!res.ok) return toast(res.error, 'err');
  $('#raw').value = res.data;
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * Explain a profile-name mismatch.
 *
 * Proxifier requests `<active profile name>.ppx`. When its active profile is
 * unnamed (the window shows "Untitled") it asks for an internal name, the
 * bridge serves the designated active profile instead, and everything still
 * syncs — but the unnamed profile may not survive a restart, so say so.
 */
async function checkSync() {
  const el = $('#notice');
  const res = await api('/state');
  const last = res.ok ? res.data.lastFetch : null;

  if (!last || !last.fallback) {
    el.hidden = true;
    return;
  }
  el.innerHTML =
    `Proxifier last asked for <code>${esc(last.requested)}.ppx</code>, which does not exist, ` +
    `so the bridge served <code>${esc(last.served)}</code> instead. That normally means ` +
    `Proxifier's active profile has no name (its window shows “Untitled”). ` +
    `Run <b>File → Load Profile → ${esc(last.served)}</b> in Proxifier to pin the name, ` +
    `then click Reload ↻ here.`;
  el.hidden = false;
}

function init() {
  chrome.runtime.sendMessage({ type: 'settings' }).then((settings) => {
    applyConnection(settings);
    testConnection().then((ok) => ok && loadProfiles().then(checkSync));
  });

  $('#save-conn').onclick = async () => {
    const conn = formConnection();
    if (!conn.token) {
      return toast(
        'No token found. Run `node bridge/cli.js link` and paste the whole URL into the Token box.',
        'err',
      );
    }
    await chrome.storage.local.set(conn);
    applyConnection(conn);
    if (await testConnection()) {
      toast('Connected and saved');
      await loadProfiles();
    }
  };

  $('#test').onclick = async () => {
    // Test what is in the form, not just what has been saved.
    if (await testConnection(formConnection())) {
      toast('Reachable — click "Save & test" to keep these settings');
    }
  };

  $('#copy').onclick = async () => {
    await navigator.clipboard.writeText($('#proxifier-url').value);
    toast('Proxifier URL copied');
  };

  $('#profiles').onchange = async (e) => {
    state.profile = e.target.value;
    await chrome.storage.local.set({ activeProfile: state.profile });
    await api('/active', { method: 'POST', body: { name: state.profile } });
    await loadDetail();
    await checkSync();
  };

  $('#create').onclick = async () => {
    const name = $('#new-name').value.trim();
    if (!name) return toast('Name is required', 'err');
    const res = await api('/profiles', { method: 'POST', body: { name } });
    if (!res.ok) return toast(res.error, 'err');
    $('#new-name').value = '';
    state.profile = name;
    await chrome.storage.local.set({ activeProfile: name });
    await loadProfiles();
    toast(`Created "${name}"`);
  };

  $('#delete').onclick = async () => {
    if (!state.profile) return;
    if (!confirm(`Delete profile "${state.profile}"? A backup snapshot is kept.`)) return;
    const res = await api(`/profiles/${encodeURIComponent(state.profile)}`, { method: 'DELETE' });
    if (!res.ok) return toast(res.error, 'err');
    state.profile = null;
    await loadProfiles();
    toast('Deleted');
  };

  $('#reload').onclick = async () => {
    const res = await api('/reload', { method: 'POST' });
    if (!res.ok) return toast(res.error, 'err');
    if (res.data.ok) {
      toast('Proxifier reloaded');
    } else {
      toast(`Automatic reload failed (${res.data.result}). ${res.data.hint ?? ''}`, 'err');
    }
    await checkSync();
  };

  $('#raw-load').onclick = loadRaw;

  $('#raw-save').onclick = async () => {
    if (!state.profile) return toast('Select a profile first', 'err');
    const res = await api(`/profiles/${encodeURIComponent(state.profile)}/raw`, {
      method: 'PUT',
      body: { xml: $('#raw').value },
    });
    toast(res.ok ? `Saved (${res.data.rules} rules)` : res.error, res.ok ? 'ok' : 'err');
    await loadDetail();
  };
}

init();
