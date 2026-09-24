/**
 * Live end-to-end check against a running bridge + Proxifier.
 *
 * Adds a rule through the same API the extension uses, asks Proxifier to
 * re-pull, then (with --cleanup) removes it again.
 *
 *   node test/e2e-live.mjs              # add the marker rule + reload
 *   node test/e2e-live.mjs --cleanup    # remove it + reload
 */
import { loadConfig } from '../bridge/config.js';

const cfg = loadConfig();
const base = `http://127.0.0.1:${cfg.port}`;
const api = (p, o = {}) =>
  fetch(`${base}/api${p}`, {
    ...o,
    headers: { 'content-type': 'application/json', 'x-bridge-token': cfg.token, ...(o.headers ?? {}) },
  });

const NAME = cfg.activeProfile ?? 'Bridge';
const MARKER = 'E2E-VERIFY-TEMP';
const PROXY_ID = '100';
const CLEANUP = process.argv.includes('--cleanup');

async function rules() {
  const res = await api(`/profiles/${NAME}/rules`);
  if (!res.ok) throw new Error(`cannot read profile "${NAME}": HTTP ${res.status}`);
  return (await res.json()).rules;
}

async function reload() {
  return (await api('/reload', { method: 'POST' })).json();
}

async function cleanup() {
  let list = await rules();
  let removed = 0;
  while (list.some((r) => r.name === MARKER)) {
    const idx = list.findIndex((r) => r.name === MARKER);
    const res = await api(`/profiles/${NAME}/rules/${idx}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`delete failed: HTTP ${res.status}`);
    removed += 1;
    list = (await res.json()).rules;
  }
  console.log(`removed ${removed} marker rule(s) -> ${list.length} rules left`);
  console.log('reload    :', JSON.stringify(await reload()));
}

async function add() {
  const before = await rules();
  console.log(`profile "${NAME}" has ${before.length} rules before`);

  const created = await api(`/profiles/${NAME}/rules`, {
    method: 'POST',
    body: JSON.stringify({
      rule: { name: MARKER, targets: ['e2e-verify.invalid'], action: { type: 'Proxy', id: PROXY_ID } },
    }),
  });
  console.log('add rule  :', created.status);

  const after = await rules();
  console.log(`            -> ${after.length} rules, marker at index ${after.findIndex((r) => r.name === MARKER)}`);
  console.log('reload    :', JSON.stringify(await reload()));
  console.log(`\nConfirm Proxifier's rule list now contains ${MARKER}, then:`);
  console.log('  node test/e2e-live.mjs --cleanup');
}

await (CLEANUP ? cleanup() : add());
