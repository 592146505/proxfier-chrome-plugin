/**
 * Apply the rules recovered from the GUI onto a Proxifier-authored base
 * profile, then save the result into the bridge store.
 *
 * Using a real exported profile as the base is deliberate: it carries the
 * correct root attributes, <Options> subtree and <Encryption> block, none of
 * which we can safely invent.
 *
 *   node tools/apply-recovery.mjs --base ~/Documents/learn.ppx --name Bridge
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../bridge/store.js';
import { Profile } from '../bridge/ppx.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECOVERY = path.join(ROOT, 'recovery', 'proxifier-original-rules.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const has = (n) => process.argv.includes(`--${n}`);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function main() {
  const basePath = arg('base', path.join(process.env.HOME, 'Documents', 'learn.ppx'));
  const name = arg('name', 'Bridge');
  const proxyId = arg('proxy-id', '100');
  const chainId = arg('chain-id', null);

  const data = JSON.parse(fs.readFileSync(RECOVERY, 'utf8'));
  const profile = Profile.parse(fs.readFileSync(basePath, 'utf8'));

  const proxies = profile.proxies();
  if (!proxies.length) throw new Error(`base profile ${basePath} has no proxies`);

  // Replace the rule list wholesale, in the captured order. addRule() appends
  // unless a "Default" catch-all already exists, so adding in order is correct.
  const ruleList = profile._ruleList();
  for (const el of ruleList.childrenNamed('Rule')) ruleList.removeChild(el);

  const actionRef = chainId ?? proxyId;
  for (const r of data.rules) {
    const action = r.action.startsWith('Block')
      ? { type: 'Block' }
      : r.action.startsWith('Proxy')
        ? { type: 'Proxy', id: actionRef }
        : { type: 'Direct' };
    profile.addRule({
      name: r.name,
      enabled: r.enabled !== false,
      // ppx.js quotes entries containing whitespace itself — do not pre-quote.
      applications: r.applications ?? [],
      targets: r.targets ?? [],
      ports: r.ports ?? [],
      action,
    });
  }

  console.log(`base: ${basePath}`);
  console.log(`  proxies : ${JSON.stringify(proxies)}`);
  console.log(`  chains  : ${JSON.stringify(profile.chains())}`);
  console.log(`  Proxy action refers to ${chainId ? `chain ${chainId}` : `proxy ${proxyId}`}`);
  console.log(`  rules   : ${profile.rules().length}`);
  for (const r of profile.rules()) {
    const a = r.action.type === 'Proxy' ? `Proxy→${r.action.id}` : r.action.type;
    console.log(`    ${r.enabled ? ' ' : 'x'} ${r.name.padEnd(26)} ${a}`);
  }

  if (has('dry')) {
    const xml = profile.toXml();
    console.log('\n--- RuleList ---');
    console.log(xml.slice(xml.indexOf('<RuleList>'), xml.indexOf('</RuleList>') + 11));
    return;
  }
  store.save(name, profile, { reason: 'apply-recovery' });
  console.log(`\nwrote ${store.profilePath(name)}`);
}

main();
