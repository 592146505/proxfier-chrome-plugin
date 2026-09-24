/**
 * Rebuild a Proxifier profile from the rules captured out of the GUI.
 *
 * Options/RuleList/Action/Targets/enabled are confirmed against a profile
 * Proxifier actually accepted. The Proxy/Chain element shape is not confirmed
 * yet, so it is switchable via --variant so it can be found empirically.
 *
 *   node tools/rebuild-from-recovery.mjs --variant A [--name Bridge] [--dry]
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
const has = (name) => process.argv.includes(`--${name}`);

const PROXY = {
  host: arg('proxy-host', '127.0.0.1'),
  port: arg('proxy-port', '7890'),
  type: arg('proxy-type', 'SOCKS5'),
  name: arg('proxy-name', 'verge-mihomo'),
};

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Proxifier quotes list entries that contain whitespace. */
const quote = (entry) => (/\s/.test(entry) ? `"${entry}"` : entry);
const list = (values) => (values ?? []).map((v) => esc(quote(v))).join('; ');

/** Proxy/Chain syntax candidates. `action` is what <Action type="Proxy"> holds. */
const VARIANTS = {
  A: {
    note: 'Windows-documented: id/type/host/port attrs, chain referenced by id',
    xml: `
  <ProxyList>
    <Proxy id="100" type="${PROXY.type}" host="${PROXY.host}" port="${PROXY.port}"/>
  </ProxyList>
  <ChainList>
    <Chain id="1100" type="simple">
      <Name>${esc(PROXY.name)}</Name>
      <Proxy id="100"/>
    </Chain>
  </ChainList>`,
    action: '1100',
  },
  B: {
    note: 'address attr, chain referenced by name',
    xml: `
  <ProxyList>
    <Proxy type="${PROXY.type}" address="${PROXY.host}" port="${PROXY.port}"/>
  </ProxyList>
  <ChainList>
    <Chain type="simple">
      <Name>${esc(PROXY.name)}</Name>
    </Chain>
  </ChainList>`,
    action: PROXY.name,
  },
  C: {
    note: 'host:port as element text',
    xml: `
  <ProxyList>
    <Proxy type="${PROXY.type}">${PROXY.host}:${PROXY.port}</Proxy>
  </ProxyList>
  <ChainList>
    <Chain type="simple">
      <Name>${esc(PROXY.name)}</Name>
    </Chain>
  </ChainList>`,
    action: PROXY.name,
  },
};

function optionsXml() {
  return `  <Options>
    <Resolve>
      <AutoModeDetection enabled="true"/>
      <ViaProxy enabled="false"/>
      <TryLocalDnsFirst enabled="false"/>
      <ExclusionList>%ComputerName%; localhost; *.local</ExclusionList>
      <ExcludeSimpleHostnames enabled="true"/>
      <ExcludeLocalhost enabled="true"/>
      <ExcludeSelfHostname enabled="true"/>
      <ExcludeLocalDomain enabled="true"/>
    </Resolve>
    <Encryption mode="0"/>
  </Options>`;
}

function rulesXml(rules, actionRef) {
  const body = rules
    .map((r) => {
      const parts = [`      <Name>${esc(r.name)}</Name>`];
      if (r.applications?.length) parts.push(`      <Applications>${list(r.applications)}</Applications>`);
      if (r.targets?.length) parts.push(`      <Targets>${list(r.targets)}</Targets>`);
      if (r.ports?.length) parts.push(`      <Ports>${list(r.ports)}</Ports>`);

      const a = r.action.startsWith('Block')
        ? '      <Action type="Block"/>'
        : r.action.startsWith('Proxy')
          ? `      <Action type="Proxy">${esc(actionRef)}</Action>`
          : '      <Action type="Direct"/>';
      parts.push(a);

      const enabled = r.enabled === false ? 'false' : 'true';
      return `    <Rule enabled="${enabled}">\n${parts.join('\n')}\n    </Rule>`;
    })
    .join('\n');
  return `  <RuleList>\n${body}\n  </RuleList>`;
}

function buildXml(variantKey, rules) {
  const v = VARIANTS[variantKey];
  if (!v) throw new Error(`unknown variant "${variantKey}" (have ${Object.keys(VARIANTS).join(', ')})`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<ProxifierProfile version="102" platform="MacOSX" product_id="1" product_minver="310">
  ${optionsXml()}${v.xml}
  ${rulesXml(rules, v.action)}
</ProxifierProfile>
`;
}

function main() {
  const variant = arg('variant', 'A');
  const name = arg('name', 'Bridge');
  const data = JSON.parse(fs.readFileSync(RECOVERY, 'utf8'));

  const xml = buildXml(variant, data.rules);
  // Parse before writing: a malformed profile must never reach the store.
  const profile = Profile.parse(xml);

  console.log(`variant ${variant} — ${VARIANTS[variant].note}`);
  console.log(`  proxies : ${JSON.stringify(profile.proxies())}`);
  console.log(`  chains  : ${JSON.stringify(profile.chains())}`);
  console.log(`  rules   : ${profile.rules().length}`);
  for (const r of profile.rules()) {
    const act = r.action.type === 'Proxy' ? `Proxy→${r.action.id}` : r.action.type;
    console.log(`    ${r.enabled ? ' ' : 'x'} ${r.name.padEnd(26)} ${act}`);
  }

  if (has('dry')) {
    console.log('\n--- xml ---\n' + profile.toXml());
    return;
  }
  store.save(name, profile, { reason: `rebuild-${variant}` });
  console.log(`\nwrote ${store.profilePath(name)}`);
}

main();
