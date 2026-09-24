/**
 * Service worker: owns all bridge communication.
 *
 * The popup and options pages never talk to the bridge directly, so the token
 * lives in exactly one place and CORS/permission handling stays in one file.
 */
import { hostVariants } from './targets.js';

const DEFAULTS = { bridgeUrl: 'http://127.0.0.1:47653', token: '' };

export async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

/**
 * Call the bridge JSON API.
 * @returns {{ok: true, status: number, data: any} | {ok: false, error: string}}
 */
export async function api(path, { method = 'GET', body, as = 'json', connection = null } = {}) {
  // `connection` lets the options page test values that are not saved yet.
  const { bridgeUrl, token } = connection ?? (await getSettings());
  if (!token) {
    return {
      ok: false,
      error:
        'No bridge token yet. Run `node bridge/cli.js link` and paste the whole URL ' +
        '(it contains /t/<token>/) into the Token box, then click "Save & test".',
    };
  }

  try {
    const res = await fetch(`${bridgeUrl.replace(/\/$/, '')}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-bridge-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // /raw returns XML, not JSON — asking for it as JSON would throw.
    const data = as === 'text'
      ? await res.text()
      : await res.json().catch(() => null);
    if (!res.ok) {
      const message = typeof data === 'object' && data?.error ? data.error : `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: message };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return {
      ok: false,
      error: `Cannot reach the bridge at ${bridgeUrl} (${err.message}). Is \`npm run serve\` running?`,
    };
  }
}

const MENU_ID = 'proxifier-add-rule';

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Proxifier: add rule for "%s"',
    contexts: ['page', 'link'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID) return;
  const raw = info.linkUrl ?? info.pageUrl;
  if (!raw) return;
  let host;
  try {
    host = new URL(raw).hostname;
  } catch {
    return;
  }
  const { activeProfile } = await chrome.storage.local.get({ activeProfile: '' });
  if (!activeProfile) {
    await badge('no profile set — open the extension options', '#d29922');
    return;
  }

  // Pick a proxy/chain that actually exists in the active profile. A hardcoded
  // id would create a rule pointing at a chain the profile does not define.
  const profile = await api(`/profiles/${encodeURIComponent(activeProfile)}`);
  if (!profile.ok) {
    await badge(profile.error, '#e5534b');
    return;
  }
  const target = profile.data.chains?.[0] ?? profile.data.proxies?.[0] ?? null;
  if (!target?.id) {
    await badge('profile has no proxy or chain — add one in Proxifier', '#d29922');
    return;
  }

  const result = await api(`/profiles/${encodeURIComponent(activeProfile)}/rules`, {
    method: 'POST',
    body: {
      rule: {
        name: host,
        targets: hostVariants(host),
        applications: ['Google Chrome'],
        action: { type: 'Proxy', id: target.id },
      },
    },
  });
  await badge(result.ok ? `added ${host}` : result.error, result.ok ? '#3fb950' : '#e5534b');
});

/** Short-lived toolbar badge used as feedback (no notifications permission). */
async function badge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text: text.length > 4 ? 'ok' : text });
  await chrome.action.setTitle({ title: text });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Proxifier Rules' });
  }, 4000);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'api') {
    api(msg.path, { method: msg.method, body: msg.body, as: msg.as, connection: msg.connection }).then(sendResponse);
    return true; // async
  }
  if (msg?.type === 'settings') {
    getSettings().then(sendResponse);
    return true;
  }
  return false;
});
