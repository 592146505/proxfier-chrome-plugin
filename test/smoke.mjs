/**
 * End-to-end smoke test: starts the bridge in-process and exercises the full
 * rule CRUD surface plus the Proxifier-facing download surface.
 *
 *   node test/smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, BACKUPS_DIR } from '../bridge/config.js';
import { createServer } from '../bridge/server.js';
import * as store from '../bridge/store.js';

const cfg = loadConfig();
// Port 0 = ephemeral, so the test never collides with a running bridge.
// persist:false keeps the test from rewriting the real config.json, and
// activeProfile is pinned so the real config cannot leak into assertions.
const { listen } = createServer({ ...cfg, port: 0, activeProfile: null }, { persist: false });
const addr = await listen();
const base = `http://127.0.0.1:${addr.port}`;

const api = (p, o = {}) =>
  fetch(`/api${p}`.replace(/^/, base), {
    ...o,
    headers: { 'content-type': 'application/json', 'x-bridge-token': cfg.token, ...(o.headers ?? {}) },
  });

const asJson = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

const NAME = 'SmokeTest';
let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${e}\n        actual   ${a}`);
}

try {
  store.remove(NAME);
} catch {
  /* first run */
}

check('create profile', (await asJson(await api('/profiles', { method: 'POST', body: JSON.stringify({ name: NAME, empty: true }) }))).status, 201);

const added = await asJson(
  await api(`/profiles/${NAME}/rules`, {
    method: 'POST',
    body: JSON.stringify({
      rule: {
        name: 'example.com via chain 1100',
        targets: ['*.example.com'],
        applications: ['Google Chrome'],
        action: { type: 'Proxy', id: '1100' },
      },
    }),
  }),
);
check('new rule lands before catch-all', added.body.rules.map((r) => r.name), ['Localhost', 'example.com via chain 1100', 'Default']);

const toggled = await asJson(
  await api(`/profiles/${NAME}/rules/1`, { method: 'PATCH', body: JSON.stringify({ patch: { enabled: false } }) }),
);
check('toggle rule off', toggled.body.rule.enabled, false);

const moved = await asJson(await api(`/profiles/${NAME}/move/1`, { method: 'POST', body: JSON.stringify({ to: 0 }) }));
check('move rule to top', moved.body.rules.map((r) => `${r.name}${r.enabled ? '' : '[off]'}`), [
  'example.com via chain 1100[off]',
  'Localhost',
  'Default',
]);

check('delete rule', (await asJson(await api(`/profiles/${NAME}/rules/0`, { method: 'DELETE' }))).body.rules.map((r) => r.name), [
  'Localhost',
  'Default',
]);

check('backups recorded', (await asJson(await api(`/profiles/${NAME}/backups`))).body.backups.length >= 4, true);

check('reject missing token', (await fetch(`${base}/api/profiles`)).status, 401);
check('reject bad token', (await fetch(`${base}/api/profiles`, { headers: { 'x-bridge-token': 'wrong' } })).status, 401);
check('reject bad action type', (await asJson(await api(`/profiles/${NAME}/rules`, { method: 'POST', body: JSON.stringify({ rule: { name: 'x', action: { type: 'Nope' } } }) }))).status, 400);

const index = await fetch(`${base}/t/${cfg.token}/`);
const links = (await index.text()).match(/href="[^"]+"/g) ?? [];
check('proxifier index lists profile', links.includes(`href="${NAME}.ppx"`), true);

const ppx = await fetch(`${base}/t/${cfg.token}/${NAME}.ppx`);
const ppxText = await ppx.text();
check('proxifier serves xml', [ppx.status, ppx.headers.get('content-type')], [200, 'application/xml; charset=utf-8']);
check('served xml is a proxifier profile', ppxText.includes('<ProxifierProfile') && ppxText.includes('</ProxifierProfile>'), true);

// The pull surface serves the normalised profile, so a value written into the
// file behind the bridge's back — by Proxifier's own GUI, say — cannot reach
// the client unnormalised.
{
  const target = store.profilePath(NAME);
  const onDisk = fs.readFileSync(target, 'utf8');
  check('the profile on disk has the DNS auto switch off', /<AutoModeDetection enabled="false"\/>/.test(onDisk), true);

  fs.writeFileSync(target, onDisk.replace(/<AutoModeDetection[^>]*\/>/, '<AutoModeDetection enabled="true"/>'));
  const pulled = await (await fetch(`${base}/t/${cfg.token}/${NAME}.ppx`)).text();
  check(
    'the pull surface re-applies the DNS auto switch',
    /<AutoModeDetection enabled="false"\/>/.test(pulled),
    true,
  );
}

check('proxifier url with wrong token is hidden', (await fetch(`${base}/t/deadbeef/${NAME}.ppx`)).status, 404);

{
  const created = await asJson(await api(`/profiles/${NAME}/proxies`, {
    method: 'POST',
    body: JSON.stringify({ proxy: { type: 'SOCKS5', address: '127.0.0.1', port: 7890 } }),
  }));
  check('add proxy', [created.status, created.body?.id], [201, '100']);
  const patched = await asJson(await api(`/profiles/${NAME}/proxies/100`, {
    method: 'PATCH',
    body: JSON.stringify({ patch: { port: 7891 } }),
  }));
  check('update proxy', patched.body?.proxies?.[0]?.port, '7891');
  const bad = await api(`/profiles/${NAME}/proxies`, {
    method: 'POST',
    body: JSON.stringify({ proxy: { type: 'SOCKS5', address: 'x', port: 0 } }),
  });
  check('reject bad proxy port', bad.status, 400);
  check('delete proxy', (await api(`/profiles/${NAME}/proxies/100`, { method: 'DELETE' })).status, 200);
  check('deleted proxy is gone', (await api(`/profiles/${NAME}/proxies/100`, { method: 'DELETE' })).status, 404);
}

// Proxifier requests `default.ppx` for its built-in profile, so an unknown
// name must fall back to the designated active profile instead of 404ing.
check('unknown name 404s without an active profile', (await fetch(`${base}/t/${cfg.token}/default.ppx`)).status, 404);
check('set active profile', (await asJson(await api('/active', { method: 'POST', body: JSON.stringify({ name: NAME }) }))).status, 200);
const fallback = await fetch(`${base}/t/${cfg.token}/default.ppx`);
check('unknown name falls back to active profile', [fallback.status, (await fallback.text()).includes('<ProxifierProfile')], [200, true]);
check('unknown name still 404s when no active profile', (await asJson(await api('/active', { method: 'POST', body: JSON.stringify({ name: 'nope' }) }))).status, 404);

store.remove(NAME);
fs.rmSync(path.join(BACKUPS_DIR, NAME), { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
