import { actionOptions, actionValue, hasProxyTargets, parseActionValue } from './actions.js';
import { defaultBrowserApp, hostVariants, mergeTargets } from './targets.js';

const $ = (sel) => document.querySelector(sel);

let state = { profile: null, proxies: [], chains: [], editing: null, host: null };

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
  }, kind === 'err' ? 6000 : 2500);
}

function actionLabel(action) {
  if (action.type === 'Proxy') return `Proxy → ${action.id}`;
  return action.type;
}

function renderActions(selected) {
  const sel = $('#f-action');
  sel.innerHTML = '';
  for (const option of actionOptions(state)) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    sel.append(opt);
  }
  sel.value = actionValue(selected);

  // Explain the empty case instead of silently offering only Direct/Block.
  const hint = $('#action-hint');
  if (hasProxyTargets(state)) {
    hint.hidden = true;
  } else {
    hint.textContent =
      'This profile defines no proxies or chains, so only Direct and Block are available. ' +
      'Add a proxy in the extension options (⚙ → Proxies), then reopen this popup.';
    hint.hidden = false;
  }
}

function readAction() {
  return parseActionValue($('#f-action').value);
}

function openEditor(rule) {
  state.editing = rule;
  $('#f-name').value = rule.name ?? '';
  $('#f-targets').value = (rule.targets ?? []).join('; ');
  $('#f-apps').value = (rule.applications ?? []).join('; ') || defaultBrowserApp();
  renderActions(rule.action);
  $('#editor').hidden = false;
}

function closeEditor() {
  state.editing = null;
  $('#editor').hidden = true;
}

function renderRules(rules) {
  const list = $('#rules');
  list.innerHTML = '';
  $('#rule-count').textContent = `(${rules.length})`;

  if (!rules.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No rules in this profile.';
    list.append(li);
    return;
  }

  rules.forEach((rule, index) => {
    const li = document.createElement('li');
    if (!rule.enabled) li.classList.add('off');

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(index);

    const body = document.createElement('div');
    body.className = 'name';
    body.innerHTML = '';
    const title = document.createElement('span');
    title.textContent = rule.name || '(unnamed)';
    const sub = document.createElement('span');
    sub.className = 'targets';
    sub.textContent = [rule.targets.join(', ') || 'any target', rule.applications.join(', ') || 'any app', actionLabel(rule.action)]
      .join('  ·  ');
    body.append(title, sub);

    const toggle = document.createElement('button');
    toggle.textContent = rule.enabled ? '●' : '○';
    toggle.title = rule.enabled ? 'Disable' : 'Enable';
    toggle.onclick = () => patchRule(index, { enabled: !rule.enabled });

    const edit = document.createElement('button');
    edit.textContent = '✎';
    edit.title = 'Edit';
    edit.onclick = () => openEditor({ ...rule, index });

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '✕';
    del.title = 'Delete';
    del.onclick = () => deleteRule(index);

    const parts = [idx, body];
    if (state.host) {
      const addHost = document.createElement('button');
      addHost.className = 'add';
      addHost.textContent = '＋';
      addHost.title = `Add ${state.host} and ${hostVariants(state.host)[1]} to this rule`;
      addHost.onclick = () => addHostToRule(index, rule);
      parts.push(addHost);
    }
    parts.push(toggle, edit, del);
    li.append(...parts);
    list.append(li);
  });
}

async function loadProfile() {
  const name = state.profile;
  if (!name) {
    renderRules([]);
    return;
  }
  const res = await api(`/profiles/${encodeURIComponent(name)}`);
  if (!res.ok) return toast(res.error, 'err');
  state.proxies = res.data.proxies ?? [];
  state.chains = res.data.chains ?? [];
  renderRules(res.data.rules ?? []);
  renderActions();
}

async function loadProfiles() {
  const res = await api('/profiles');
  if (!res.ok) {
    $('#health').textContent = 'offline';
    $('#health').className = 'tag err';
    renderRules([]);
    return toast(res.error, 'err');
  }
  $('#health').textContent = 'online';
  $('#health').className = 'tag ok';

  const stored = await chrome.storage.local.get({ activeProfile: '' });
  const sel = $('#profile');
  sel.innerHTML = '';
  for (const p of res.data.profiles) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    sel.append(opt);
  }
  if (!res.data.profiles.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no profiles — create one in options)';
    sel.append(opt);
  }
  state.profile = res.data.profiles.some((p) => p.name === stored.activeProfile)
    ? stored.activeProfile
    : res.data.profiles[0]?.name ?? null;
  sel.value = state.profile ?? '';
}

async function saveRule() {
  const payload = {
    name: $('#f-name').value.trim(),
    targets: $('#f-targets').value.split(';').map((s) => s.trim()).filter(Boolean),
    applications: $('#f-apps').value.split(';').map((s) => s.trim()).filter(Boolean),
    action: readAction(),
  };
  if (!payload.name) return toast('Rule name is required', 'err');

  const res = state.editing?.index !== undefined
    ? await api(`/profiles/${encodeURIComponent(state.profile)}/rules/${state.editing.index}`, { method: 'PATCH', body: { patch: payload } })
    : await api(`/profiles/${encodeURIComponent(state.profile)}/rules`, { method: 'POST', body: { rule: payload } });

  if (!res.ok) return toast(res.error, 'err');
  closeEditor();
  toast('Saved — Proxifier reloads automatically');
  await loadProfile();
}

async function patchRule(index, patch) {
  const res = await api(`/profiles/${encodeURIComponent(state.profile)}/rules/${index}`, { method: 'PATCH', body: { patch } });
  if (!res.ok) return toast(res.error, 'err');
  await loadProfile();
}

async function deleteRule(index) {
  const res = await api(`/profiles/${encodeURIComponent(state.profile)}/rules/${index}`, { method: 'DELETE' });
  if (!res.ok) return toast(res.error, 'err');
  renderRules(res.data.rules);
}

/** One-click "put the current site into this existing rule" — no typing. */
async function addHostToRule(index, rule) {
  const { targets, added } = mergeTargets(rule.targets ?? [], state.host);
  if (!added) {
    return toast(`"${rule.name}" already covers ${state.host}`, 'ok');
  }
  const res = await api(`/profiles/${encodeURIComponent(state.profile)}/rules/${index}`, {
    method: 'PATCH',
    body: { patch: { targets } },
  });
  if (!res.ok) return toast(res.error, 'err');
  toast(`Added ${state.host} to "${rule.name}"`);
  await loadProfile();
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    state.host = new URL(tab.url).hostname;
    if (state.host) {
      $('#host').textContent = state.host;
      $('#quick').disabled = false;
    }
  } catch {
    $('#host').textContent = '(not a web page)';
  }

  await loadProfiles();
  await loadProfile();

  $('#profile').onchange = async (e) => {
    state.profile = e.target.value;
    await chrome.storage.local.set({ activeProfile: state.profile });
    // Tell the bridge which profile Proxifier should be served: it does not
    // always request the name shown in File > Load Profile (it asks for
    // default.ppx for its built-in profile).
    await api('/active', { method: 'POST', body: { name: state.profile } });
    await loadProfile();
  };

  $('#quick').onclick = () => {
    // Prefer a chain, else a bare proxy, else leave it Direct.
    const target = state.chains[0] ?? state.proxies[0];
    openEditor({
      name: state.host.replace(/^www\./, ''),
      targets: hostVariants(state.host),
      applications: [defaultBrowserApp()],
      action: target ? { type: 'Proxy', id: target.id } : { type: 'Direct' },
    });
  };

  $('#save').onclick = saveRule;
  $('#cancel').onclick = closeEditor;
  $('#settings').onclick = () => chrome.runtime.openOptionsPage();
  $('#reload').onclick = async () => {
    const res = await api('/reload', { method: 'POST' });
    if (!res.ok) return toast(res.error, 'err');
    if (res.data.ok) return toast('Proxifier reloaded');
    toast(`Automatic reload failed (${res.data.result}). ${res.data.hint ?? ''}`, 'err');
  };
}

init();
